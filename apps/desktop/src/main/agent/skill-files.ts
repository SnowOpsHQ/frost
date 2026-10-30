import type { Skill } from '@app/ai-skills/skills';
import {
  MAX_USER_SKILLS,
  SKILL_EDITOR_FIELDS,
  SKILL_FILE_FORMAT,
  SKILL_FILE_MAX_BYTES,
  SKILL_FILE_VERSION,
  SKILL_IMPORT_ENTRY_INVALID,
  SKILL_IMPORT_TOKEN_TTL_MS,
  skillExportFileName,
  type AgentSkillImportItem,
  type AgentSkillImportPreviewResult,
  type AgentSkillImportResult,
  type SkillExportResult,
} from '@app/specs/agent-data.spec';
import { SkillFileEnvelopeSchema, SkillFileSchema, SkillIdSchema, SkillSchema } from '@app/specs/skills-schema';
import { SKILL_ACTING_TOOLS } from '@app/specs/skills.spec';
import { syncDirectoryOf } from './durable';
import { skillErrors, type UserSkills } from './user-skills';

// Skill files (Phase 8 Task 6; spec `specs/agent-data.spec.ts`, Skill files; acceptance
// `specs/agent-data.feature.md`, Import and export). Main moves the user's skills between installs as
// files, and only through its own dialogs: the renderer never names a path.
//
// Export: the user's skills (never a built-in) as a `SkillFileSchema` envelope, checked before it is
// written, written owner-only (mode 0600, as a chat export) to a new file beside the one the user
// chose, flushed, then renamed over it (as the agent's settings file), so a failed write leaves no
// half file.
//
// Import is in two steps, because an imported skill's instructions become the user's own turn when it
// runs. `previewImport` reads the file the user chose (a regular file, at most `SKILL_FILE_MAX_BYTES`,
// strict UTF-8, JSON, frost's format and version), checks each entry on its own with `SkillSchema`,
// and answers the review: every valid entry in full (its tools and instructions, shown as text), every
// invalid one with frost's sentence only, and a single-use token. Nothing is stored or run until
// `importSkills` spends that token (within `SKILL_IMPORT_TOKEN_TTL_MS`) on entries the review listed
// as valid; `UserSkills.importSkills` stores them as copies where an id or name clashes.

/** The dialogs import and export ask in (`dialogs.ts` with Electron; fakes in tests). */
export interface SkillFileDialogs {
  /** Asks where to save a skills file (`defaultName` offered): the chosen file, or `null` if cancelled. */
  chooseSkillExportPath(defaultName: string): Promise<string | null>;
  /** Asks which skills file to import: the chosen file, or `null` if cancelled. */
  chooseSkillImportFile(): Promise<string | null>;
}

/** An open file, as `node:fs/promises`' `FileHandle` gives it. */
export interface SkillFileHandle {
  stat(): Promise<{ isFile(): boolean; readonly size: number }>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The file operations used here (`node:fs/promises` in main). */
export interface SkillFilesFs {
  stat(file: string): Promise<{ isFile(): boolean }>;
  open(file: string, flags: 'r'): Promise<SkillFileHandle>;
  /** Writes a new file (`wx`) and flushes it to disk before resolving (`flush`). */
  writeFile(file: string, data: string, options: { readonly mode: number; readonly flag: 'wx'; readonly flush: true }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string, options: { readonly force: true }): Promise<void>;
}

export interface SkillFilesDeps {
  readonly skills: Pick<UserSkills, 'mine' | 'importConflict' | 'importSkills'>;
  readonly dialogs: SkillFileDialogs;
  readonly fs: SkillFilesFs;
  readonly now?: () => number;
  /** A review's token (default `crypto.randomUUID`). */
  readonly randomToken?: () => string;
  /** The temporary file's suffix (default: the process id and a random UUID). */
  readonly tempSuffix?: () => string;
  /** One line per event; never a path, a skill's text or a token. */
  readonly log?: (line: string) => void;
}

export interface SkillFiles {
  /** Exports the user's skills (`ids`, each the user's, or all of them) to the file chosen in the save dialog. */
  exportSkills(ids: readonly string[] | 'all-mine'): Promise<SkillExportResult>;
  /** Reads the file chosen in the open dialog and answers its review (a new review replaces the last). */
  previewImport(): Promise<AgentSkillImportPreviewResult>;
  /** Spends the review's token: stores the valid entries at `indices`. */
  importSkills(token: string, indices: readonly number[]): Promise<AgentSkillImportResult>;
  /** Drops the review's token; `false` if it is not the open review's. */
  cancelImport(token: string): boolean;
}

type ImportRefusal = Exclude<AgentSkillImportPreviewResult['result'], 'ready'>;

/** The skills file's text: the envelope checked with `SkillFileSchema`, or `null` if it doesn't pass or is over `SKILL_FILE_MAX_BYTES`. */
export function skillFileText(skills: readonly Skill[], exportedAt: number): string | null {
  const parsed = SkillFileSchema.safeParse({ format: SKILL_FILE_FORMAT, version: SKILL_FILE_VERSION, exportedAt: new Date(exportedAt).toISOString(), skills });
  if (!parsed.success) return null;
  const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
  // Never written if import would refuse it.
  return Buffer.byteLength(text, 'utf8') > SKILL_FILE_MAX_BYTES ? null : text;
}

/** Writes `text` to `file` atomically: a new owner-only file beside it, flushed, renamed over it. Removes the temporary file on failure. */
export async function writeFileAtomically(fs: SkillFilesFs, file: string, text: string, suffix: string): Promise<boolean> {
  const temp = `${file}.${suffix}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx', flush: true });
    await fs.rename(temp, file);
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    return false;
  }
  await syncDirectoryOf(fs, file);
  return true;
}

/** At most `max` bytes of a regular file: its bytes, `too-large`, or `failed` (not a regular file, or unreadable). */
export async function readBoundedFile(fs: SkillFilesFs, file: string, max: number): Promise<Uint8Array | 'too-large' | 'failed'> {
  let handle: SkillFileHandle | undefined;
  try {
    // A regular file before it is opened (opening a pipe would wait for a writer), and again once open.
    if (!(await fs.stat(file)).isFile()) return 'failed';
    handle = await fs.open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return 'failed';
    if (info.size > max) return 'too-large';
    // One byte past the cap, so a file that grew after `stat` is still caught.
    const buffer = new Uint8Array(max + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead <= 0) break;
      total += bytesRead;
    }
    return total > max ? 'too-large' : buffer.subarray(0, total);
  } catch {
    return 'failed';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The file's text and the entries of its envelope, or why it is not a skills file. */
export function parseSkillFile(bytes: Uint8Array): { readonly entries: readonly unknown[] } | { readonly refused: 'not-utf8' | 'not-json' | 'wrong-format' } {
  let text: string;
  try {
    // Strict: a malformed sequence is refused, never replaced. A leading byte-order mark is dropped.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { refused: 'not-utf8' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { refused: 'not-json' };
  }
  const envelope = SkillFileEnvelopeSchema.safeParse(value);
  return envelope.success ? { entries: envelope.data.skills } : { refused: 'wrong-format' };
}

const isEditorField = (head: unknown) => typeof head === 'string' && (SKILL_EDITOR_FIELDS as readonly string[]).includes(head);

/** An invalid entry's sentence: the first field's, in frost's words; else (not an object, an unknown field, the version) `SKILL_IMPORT_ENTRY_INVALID`. */
function entryError(entry: unknown, issues: readonly { readonly code: string; readonly path: readonly PropertyKey[]; readonly message: string }[]): string {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return SKILL_IMPORT_ENTRY_INVALID;
  if (issues.some((issue) => !isEditorField(issue.path[0]))) return SKILL_IMPORT_ENTRY_INVALID;
  return skillErrors(issues)[0]?.message ?? SKILL_IMPORT_ENTRY_INVALID;
}

export function createSkillFiles(deps: SkillFilesDeps): SkillFiles {
  const now = deps.now ?? Date.now;
  const randomToken = deps.randomToken ?? (() => crypto.randomUUID());
  const tempSuffix = deps.tempSuffix ?? (() => `${process.pid}-${crypto.randomUUID()}`);
  const log = deps.log ?? (() => undefined);
  /** The open review: its token, when it was made, and the valid entries by index. */
  let pending: { readonly token: string; readonly at: number; readonly skills: ReadonlyMap<number, Skill> } | null = null;
  /** One of main's dialogs at a time. */
  let dialogOpen = false;

  const itemOf = (entry: unknown, index: number, valid: Map<number, Skill>): AgentSkillImportItem => {
    const parsed = SkillSchema.safeParse(entry);
    if (parsed.success) {
      const skill = parsed.data;
      valid.set(index, skill);
      return {
        index,
        valid: true,
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tools: [...skill.allowedTools],
        actingTools: skill.allowedTools.some((tool) => (SKILL_ACTING_TOOLS as readonly string[]).includes(tool)),
        conflict: deps.skills.importConflict(skill),
        instructions: skill.instructions,
        inputs: (skill.inputs ?? []).map((input) => ({ slot: input.slot, label: input.label, placeholder: input.placeholder ?? null })),
        error: null,
      };
    }
    const fields = (typeof entry === 'object' && entry !== null ? entry : {}) as { id?: unknown; name?: unknown };
    const id = SkillIdSchema.safeParse(fields.id);
    const name = SkillSchema.shape.name.safeParse(fields.name);
    return { index, valid: false, id: id.success ? id.data : null, name: name.success ? name.data : null, error: entryError(entry, parsed.error.issues) };
  };

  /** Asks in one of main's dialogs (`null`: cancelled, or another dialog is open; `undefined`: it failed). */
  const ask = async (dialog: () => Promise<string | null>): Promise<string | null | undefined> => {
    if (dialogOpen) return null;
    dialogOpen = true;
    try {
      const file = await dialog();
      return typeof file === 'string' && file !== '' ? file : null;
    } catch {
      return undefined;
    } finally {
      dialogOpen = false;
    }
  };

  return {
    async exportSkills(ids) {
      const mine = deps.skills.mine();
      let chosen: readonly Skill[];
      if (ids === 'all-mine') {
        if (mine.length === 0) return 'nothing-to-export';
        chosen = mine;
      } else {
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_USER_SKILLS) return 'failed';
        const wanted = new Set(ids);
        chosen = mine.filter((skill) => wanted.has(skill.id));
        // Every id must be one of the user's skills (never a built-in): else no dialog opens.
        if (chosen.length !== wanted.size) return 'failed';
      }
      const text = skillFileText(chosen, now());
      if (text === null) {
        log('agent skills: an export did not pass the skills file schema');
        return 'failed';
      }
      const file = await ask(() => deps.dialogs.chooseSkillExportPath(skillExportFileName(new Date(now()))));
      if (file === undefined) return 'failed';
      if (file === null) return 'cancelled';
      if (!(await writeFileAtomically(deps.fs, file, text, tempSuffix()))) {
        log('agent skills: a skills file could not be written');
        return 'failed';
      }
      return 'saved';
    },

    async previewImport() {
      // A new review replaces the open one, whatever comes of it.
      pending = null;
      const file = await ask(() => deps.dialogs.chooseSkillImportFile());
      if (file === undefined) return { result: 'failed' };
      if (file === null) return { result: 'cancelled' };
      const bytes = await readBoundedFile(deps.fs, file, SKILL_FILE_MAX_BYTES);
      if (bytes === 'too-large' || bytes === 'failed') return { result: bytes satisfies ImportRefusal };
      const parsed = parseSkillFile(bytes);
      if ('refused' in parsed) return { result: parsed.refused };
      const valid = new Map<number, Skill>();
      let items: AgentSkillImportItem[];
      let room: number;
      try {
        items = parsed.entries.map((entry, index) => itemOf(entry, index, valid));
        room = Math.max(0, MAX_USER_SKILLS - deps.skills.mine().length);
      } catch {
        return { result: 'failed' };
      }
      const token = randomToken();
      pending = { token, at: now(), skills: valid };
      return { result: 'ready', preview: { token, items, room } };
    },

    async importSkills(token, indices) {
      const held = pending;
      if (held === null || typeof token !== 'string' || token !== held.token) return { result: 'expired' };
      // Spent, whatever comes of it.
      pending = null;
      if (now() - held.at >= SKILL_IMPORT_TOKEN_TTL_MS) return { result: 'expired' };
      if (!Array.isArray(indices) || indices.length === 0 || new Set(indices).size !== indices.length) return { result: 'invalid-selection' };
      // In file order; every index must name an entry the review listed as valid.
      const selected: Skill[] = [];
      for (const index of [...indices].sort((a, b) => a - b)) {
        const skill = held.skills.get(index);
        if (skill === undefined) return { result: 'invalid-selection' };
        selected.push(skill);
      }
      try {
        return await deps.skills.importSkills(selected);
      } catch {
        return { result: 'failed' };
      }
    },

    cancelImport(token) {
      if (pending === null || typeof token !== 'string' || token !== pending.token) return false;
      pending = null;
      return true;
    },
  };
}
