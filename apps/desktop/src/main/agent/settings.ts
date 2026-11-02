import { CHATGPT_EFFORTS_ENTRY_MAX_BYTES, CHATGPT_LIMITS, CHATGPT_MODEL_PREFIX, isChatgptModelView, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { DEFAULT_AGENT_MODEL_SETTINGS, isUsableModelSettings, type AgentModelSettings } from '@app/specs/agent-proxy.spec';
import { DEFAULT_REASONING_EFFORT, isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from '@app/specs/agent-reasoning.spec';
import { syncDirectoryOf, type DirectorySync } from './durable';

// The agent's model settings (Phase 5 Task 3, plan decision 1; acceptance
// `specs/agent-host.feature.md`, Settings): the route (bring-your-own-key Anthropic or OpenAI, or the
// gateway) and the model id, defaulting to the gateway and `DEFAULT_MODEL_ID`, and the reasoning
// level (Phase 8 Task 8a, Decision 8; `agent-reasoning.spec.ts`), defaulting to `auto`: stored as
// chosen (whether the model offers it is `effectiveEffort`'s question), read as `auto` from a file
// without it or with a value that isn't a level (the route and model are kept). Kept in a small JSON
// file in `userData` (`AGENT_SETTINGS_FILE`), not the browser-session database: the database's
// settings repository is typed per setting (`packages/db`), and Phase 5 adds no columns or keys to
// another phase's tables. A pair is validated both ways (`isUsableModelSettings`: an allowed model
// the route serves; on the `chatgpt` route a model from the account's last list, which the file
// also keeps, so a restart without network keeps the choice); a missing, unreadable or tampered
// file reads as the defaults.

/** The file operations the settings use (`node:fs/promises` in main; a memory fake in tests). */
export interface SettingsFs extends DirectorySync {
  readFile(file: string): Promise<Uint8Array>;
  /** Writes a new file (`wx`) and flushes it to disk before resolving (`flush`). */
  writeFile(file: string, data: string, options: { readonly mode: number; readonly flag: 'wx'; readonly flush: true }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string, options: { readonly force: true }): Promise<void>;
}

export interface AgentSettingsDeps {
  /** The settings file (`<userData>/agent-settings.json`). */
  readonly file: string;
  readonly fs: SettingsFs;
  readonly log?: (line: string) => void;
  readonly tempSuffix?: () => string;
}

export interface AgentSettings {
  /** Reads the file once (later calls share the first read). Never rejects. */
  load(): Promise<void>;
  /** The route, model and reasoning level in effect (the defaults until `load` has read the file); the level is always present. */
  current(): AgentModelSettings;
  /**
   * Changes the route, model and/or reasoning level (merged with the current ones); `false`, nothing
   * changed, when the result isn't valid or the file can't be written.
   */
  set(next: Partial<AgentModelSettings>): Promise<boolean>;
  /** A change of the route, model or reasoning level: the new settings and the ones they replaced (never called by `load`). */
  onChange(listener: (settings: AgentModelSettings, previous: AgentModelSettings) => void): () => void;
  /** The ChatGPT account's last model list (persisted; `[]` before one was fetched). */
  chatgptModels(): readonly ChatgptModelView[];
  /**
   * Replaces the persisted model list (well-formed entries, first of each id, at most
   * `CHATGPT_LIMITS.maxModels`). A ChatGPT choice the new list lacks moves to its first model (an
   * empty list keeps it, unusable until listed again). `false`, nothing changed, if not written.
   */
  setChatgptModels(models: readonly ChatgptModelView[]): Promise<boolean>;
}

/**
 * The file: the route, the model, the reasoning level and up to `maxModels` listed ChatGPT models.
 * Derived from the list's own bounds, so the largest list `cleanModels` keeps always fits: per entry
 * the longest id (`chatgpt/` and a 64-character slug), a label of `maxDisplayNameChars` UTF-16 units
 * at 3 bytes each in UTF-8 (an escaped `"` or `\` takes 2), the keys and punctuation, and the
 * advertised levels (`CHATGPT_EFFORTS_ENTRY_MAX_BYTES`); plus the route and model, and the
 * `"reasoningEffort"` key with its longest value. A write over it is refused (nothing changes), so a
 * file frost wrote is never one it ignores.
 */
const MAX_ENTRY_BYTES = CHATGPT_MODEL_PREFIX.length + 64 + CHATGPT_LIMITS.maxDisplayNameChars * 3 + 32 + CHATGPT_EFFORTS_ENTRY_MAX_BYTES;
const MAX_REASONING_FIELD_BYTES = `,"reasoningEffort":"${REASONING_EFFORTS.reduce((longest, effort) => (effort.length > longest.length ? effort : longest))}"`.length;
export const MAX_SETTINGS_FILE_BYTES = 1024 + MAX_REASONING_FIELD_BYTES + CHATGPT_LIMITS.maxModels * MAX_ENTRY_BYTES;

type Settings = AgentModelSettings & { readonly reasoningEffort: ReasoningEffort };

/** Well-formed entries (with their advertised levels), the first of each id, at most `maxModels` (copies). */
function cleanModels(value: unknown): ChatgptModelView[] {
  if (!Array.isArray(value)) return [];
  const models: ChatgptModelView[] = [];
  for (const entry of value) {
    if (models.length >= CHATGPT_LIMITS.maxModels) break;
    if (!isChatgptModelView(entry) || models.some((model) => model.id === entry.id)) continue;
    models.push({ id: entry.id, label: entry.label, ...(entry.efforts !== undefined ? { efforts: [...entry.efforts] } : {}) });
  }
  return models;
}

function parseSettings(bytes: Uint8Array): { readonly settings: Settings | null; readonly models: ChatgptModelView[]; readonly effortValid: boolean } | null {
  if (bytes.byteLength > MAX_SETTINGS_FILE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null) return null;
    const { route, modelId, chatgptModels, reasoningEffort } = value as { route?: unknown; modelId?: unknown; chatgptModels?: unknown; reasoningEffort?: unknown };
    const models = cleanModels(chatgptModels);
    const candidate = { route, modelId };
    // A file from before the level has none (`auto`); a value that isn't a level reads as `auto` too.
    const effortValid = reasoningEffort === undefined || isReasoningEffort(reasoningEffort);
    const effort = isReasoningEffort(reasoningEffort) ? reasoningEffort : DEFAULT_REASONING_EFFORT;
    return { settings: isUsableModelSettings(candidate, models) ? { route: candidate.route, modelId: candidate.modelId, reasoningEffort: effort } : null, models, effortValid };
  } catch {
    return null;
  }
}

export function createAgentSettings(deps: AgentSettingsDeps): AgentSettings {
  const log = deps.log ?? (() => undefined);
  const tempSuffix = deps.tempSuffix ?? (() => `${process.pid}-${crypto.randomUUID()}`);
  let current: Settings = { route: DEFAULT_AGENT_MODEL_SETTINGS.route, modelId: DEFAULT_AGENT_MODEL_SETTINGS.modelId, reasoningEffort: DEFAULT_REASONING_EFFORT };
  let models: readonly ChatgptModelView[] = [];
  let loading: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(settings: AgentModelSettings, previous: AgentModelSettings) => void>();

  const load = () => {
    loading ??= deps.fs.readFile(deps.file).then(
      (bytes) => {
        const stored = parseSettings(bytes);
        if (stored !== null) models = stored.models;
        if (stored?.settings == null) log('agent settings: the stored settings are not valid; using the defaults');
        else {
          current = stored.settings;
          if (!stored.effortValid) log('agent settings: the stored reasoning level is not valid; using auto');
        }
      },
      (error: unknown) => {
        if ((error as { code?: unknown }).code !== 'ENOENT') log('agent settings: the settings file could not be read');
      },
    );
    return loading;
  };

  /** Writes `next` and `nextModels` atomically, then makes them current; `false` (nothing changed) if the write failed. */
  const write = async (next: Settings, nextModels: readonly ChatgptModelView[]): Promise<boolean> => {
    const temp = `${deps.file}.${tempSuffix()}.tmp`;
    const text = JSON.stringify({ route: next.route, modelId: next.modelId, reasoningEffort: next.reasoningEffort, ...(nextModels.length > 0 ? { chatgptModels: nextModels } : {}) });
    if (Buffer.byteLength(`${text}\n`, 'utf8') > MAX_SETTINGS_FILE_BYTES) {
      // Never written: the next start would read it as unreadable and fall back to the defaults.
      log('agent settings: the settings are too large to store');
      return false;
    }
    try {
      await deps.fs.writeFile(temp, `${text}\n`, { mode: 0o600, flag: 'wx', flush: true });
      await deps.fs.rename(temp, deps.file);
      await syncDirectoryOf(deps.fs, deps.file);
    } catch {
      log('agent settings: the settings file could not be written');
      await deps.fs.rm(temp, { force: true }).catch(() => undefined);
      return false;
    }
    const changed = next.route !== current.route || next.modelId !== current.modelId || next.reasoningEffort !== current.reasoningEffort;
    const before = current;
    current = { route: next.route, modelId: next.modelId, reasoningEffort: next.reasoningEffort };
    models = nextModels;
    if (changed) {
      for (const listener of [...listeners]) {
        try {
          listener(current, before);
        } catch {
          log('agent settings: a change listener failed');
        }
      }
    }
    return true;
  };

  /** Runs `task` after every earlier change (one write at a time, in call order). */
  const queued = (task: () => Promise<boolean>): Promise<boolean> => {
    const run = queue.then(async () => {
      await load();
      return task();
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    load,
    current: () => current,
    set(next) {
      return queued(async () => {
        const merged = { route: next.route ?? current.route, modelId: next.modelId ?? current.modelId, reasoningEffort: next.reasoningEffort === undefined ? current.reasoningEffort : next.reasoningEffort };
        if (!isUsableModelSettings(merged, models)) return false;
        return write(merged, models);
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    chatgptModels: () => models,
    setChatgptModels(list) {
      return queued(async () => {
        const nextModels = cleanModels(list);
        let next = current;
        // A ChatGPT choice the account no longer lists moves to the list's first model (the level is kept).
        if (current.route === 'chatgpt' && nextModels.length > 0 && !nextModels.some((model) => model.id === current.modelId)) next = { route: 'chatgpt', modelId: nextModels[0]!.id, reasoningEffort: current.reasoningEffort };
        return write(next, nextModels);
      });
    },
  };
}
