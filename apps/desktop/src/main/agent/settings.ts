import { DEFAULT_AGENT_MODEL_SETTINGS, isValidModelSettings, type AgentModelSettings } from '@app/specs/agent-proxy.spec';
import { syncDirectoryOf, type DirectorySync } from './durable';

// The agent's model settings (Phase 5 Task 3, plan decision 1; acceptance
// `specs/agent-host.feature.md`, Settings): the route (bring-your-own-key Anthropic or OpenAI, or the
// gateway) and the model id, defaulting to the gateway and `DEFAULT_MODEL_ID`. Kept in a small JSON
// file in `userData` (`AGENT_SETTINGS_FILE`), not the browser-session database: the database's
// settings repository is typed per setting (`packages/db`), and Phase 5 adds no columns or keys to
// another phase's tables. A pair is validated both ways (`isValidModelSettings`: an allowed model
// the route serves); a missing, unreadable or tampered file reads as the defaults.

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
  /** The route and model in effect (the defaults until `load` has read the file). */
  current(): AgentModelSettings;
  /**
   * Changes the route and/or model (merged with the current ones); `false`, nothing changed, when the
   * pair isn't valid or the file can't be written.
   */
  set(next: Partial<AgentModelSettings>): Promise<boolean>;
  onChange(listener: (settings: AgentModelSettings) => void): () => void;
}

const MAX_FILE_BYTES = 4096;

function parseSettings(bytes: Uint8Array): AgentModelSettings | null {
  if (bytes.byteLength > MAX_FILE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null) return null;
    const { route, modelId } = value as { route?: unknown; modelId?: unknown };
    const candidate = { route, modelId };
    return isValidModelSettings(candidate) ? { route: candidate.route, modelId: candidate.modelId } : null;
  } catch {
    return null;
  }
}

export function createAgentSettings(deps: AgentSettingsDeps): AgentSettings {
  const log = deps.log ?? (() => undefined);
  const tempSuffix = deps.tempSuffix ?? (() => `${process.pid}-${crypto.randomUUID()}`);
  let current: AgentModelSettings = DEFAULT_AGENT_MODEL_SETTINGS;
  let loading: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(settings: AgentModelSettings) => void>();

  const load = () => {
    loading ??= deps.fs.readFile(deps.file).then(
      (bytes) => {
        const stored = parseSettings(bytes);
        if (stored === null) log('agent settings: the stored settings are not valid; using the defaults');
        else current = stored;
      },
      (error: unknown) => {
        if ((error as { code?: unknown }).code !== 'ENOENT') log('agent settings: the settings file could not be read');
      },
    );
    return loading;
  };

  return {
    load,
    current: () => current,
    set(next) {
      const run = queue.then(async () => {
        await load();
        const merged = { route: next.route ?? current.route, modelId: next.modelId ?? current.modelId };
        if (!isValidModelSettings(merged)) return false;
        const temp = `${deps.file}.${tempSuffix()}.tmp`;
        try {
          await deps.fs.writeFile(temp, `${JSON.stringify({ route: merged.route, modelId: merged.modelId })}\n`, { mode: 0o600, flag: 'wx', flush: true });
          await deps.fs.rename(temp, deps.file);
          await syncDirectoryOf(deps.fs, deps.file);
        } catch {
          log('agent settings: the settings file could not be written');
          await deps.fs.rm(temp, { force: true }).catch(() => undefined);
          return false;
        }
        const changed = merged.route !== current.route || merged.modelId !== current.modelId;
        current = { route: merged.route, modelId: merged.modelId };
        if (changed) {
          for (const listener of [...listeners]) {
            try {
              listener(current);
            } catch {
              log('agent settings: a change listener failed');
            }
          }
        }
        return true;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
