/**
 * The agent's data the user governs (Phase 5 Task 9; acceptance `agent-data.feature.md`): the
 * grants page, stored chats and their retention, chat export, the user's own skills, and (Phase 8
 * Task 6) skills files to export and import them. Plain
 * values and types with no Zod, so the chrome renderer imports them as they are (strict Trusted
 * Types), and `@app/db` reads the bounds and preference keys. The procedures' inputs are in
 * `agent-ipc.schema.ts`; a skill's schema is `skills-schema.ts` (main validates every skill with it).
 *
 * Nothing here ever holds a key: chats are stored and exported from what main already keeps (the
 * messages, and tool output as the bounded previews and untrusted-wrapped results), never a key,
 * an approval id or an input hash.
 */
import type { AgentToolName } from './agent-tools.spec';
import type { SkillInputSlot } from './skills.spec';
import { SKILL_LIMITS } from './skills.spec';

// ---- Grants page -----------------------------------------------------------------------------

/** A standing grant as the grants page lists it (`agent.listGrants`). */
export interface AgentGrantView {
  readonly tool: string;
  /** The catalogue's label for the tool. */
  readonly label: string;
  /** The public `https:` origin it covers. */
  readonly origin: string;
  /** When it was given (Unix milliseconds). */
  readonly createdAt: number;
}

/** What the grants page says about every grant, plainly (the plan's Task 9 wording). */
export const AGENT_GRANTS_EXPLAINER =
  'A grant lets the agent use this tool on this site without asking. Text on that site can steer what it does there — for example, which element it clicks.';
export const AGENT_GRANTS_EMPTY = 'No site grants. When you choose "Always allow on this site" on a request, it is listed here.';
export const AGENT_GRANTS_REVOKE_ALL_CONFIRM = 'Revoke every site grant? The agent will ask again before it opens pages or clicks on any site.';
/** The read tools' switch on the grants page (`agent.setReadToolsAllowed`). */
export const AGENT_READ_TOOLS_LABEL = 'Let reading tools run without asking on public pages';
export const AGENT_READ_TOOLS_HINT =
  "Reading the page, its audit and search data never changes anything, but what they read (the page's text included) is sent to the model provider you chose. Turn this off to approve every read too.";

// ---- Chat retention --------------------------------------------------------------------------

/**
 * How long main keeps chats on disk:
 * - `off`: never stored; chats live only in memory and end when frost quits;
 * - `7d`, `30d`: a chat not updated for that long is deleted;
 * - `forever`: kept until the user deletes it.
 */
export const CHAT_RETENTIONS = ['off', '7d', '30d', 'forever'] as const;
export type ChatRetention = (typeof CHAT_RETENTIONS)[number];

export function isChatRetention(value: unknown): value is ChatRetention {
  return typeof value === 'string' && (CHAT_RETENTIONS as readonly string[]).includes(value);
}

/**
 * The default: 30 days. Chats then survive a restart (the point of storing them) without piling up:
 * what the agent read on a page expires on its own, the file is the local profile's (owner-only),
 * and it never holds a key. `off` would make every chat vanish at quit by surprise; `forever` would
 * keep page text indefinitely without the user asking for it.
 */
export const DEFAULT_CHAT_RETENTION: ChatRetention = '30d';

/** The `agent_preferences` key (migration `0030_agent_grants`'s table) holding the retention. */
export const CHAT_RETENTION_PREFERENCE_KEY = 'chat_retention';

const DAY_MS = 86_400_000;

/** Days a chat is kept after its last update (`null`: no limit; `0`: never stored). */
export const CHAT_RETENTION_DAYS: Readonly<Record<ChatRetention, number | null>> = { off: 0, '7d': 7, '30d': 30, forever: null };

/**
 * The oldest `updatedAt` a stored chat may have under `retention` at `now`: older ones are deleted.
 * `null` keeps every chat (`forever`); `off` answers `Infinity` (none is kept).
 */
export function retentionCutoff(retention: ChatRetention, now: number): number | null {
  const days = CHAT_RETENTION_DAYS[retention];
  if (days === null) return null;
  if (days === 0) return Number.POSITIVE_INFINITY;
  return now - days * DAY_MS;
}

/** Main prunes at startup, then this often while it runs (milliseconds), and at once when the retention changes. */
export const CHAT_PRUNE_INTERVAL_MS = DAY_MS;

export const CHAT_RETENTION_LABELS: Readonly<Record<ChatRetention, string>> = {
  off: "Don't keep chats (until frost quits)",
  '7d': 'Keep chats for 7 days',
  '30d': 'Keep chats for 30 days',
  forever: 'Keep chats until I delete them',
};

/** What the chat list says about where chats live, per retention. */
export const CHAT_RETENTION_HINTS: Readonly<Record<ChatRetention, string>> = {
  off: 'Chats are not saved: they are kept until frost quits.',
  '7d': 'Chats are saved on this computer and deleted 7 days after their last message.',
  '30d': 'Chats are saved on this computer and deleted 30 days after their last message.',
  forever: 'Chats are saved on this computer until you delete them.',
};

// ---- Stored chats (`@app/db`, migration `0031_agent_chats`) ----------------------------------

/**
 * Chats kept on disk: the most recently updated `MAX_STORED_CHATS` (the same as kept in memory,
 * `MAX_CHATS_KEPT_IN_MEMORY`, so what is listed is what is stored). Saving one more deletes the oldest.
 */
export const MAX_STORED_CHATS = 50;
/** Rows (history messages, or display entries) stored per chat: twice what a turn sends or the panel shows. */
export const MAX_STORED_ROWS_PER_CHAT = 400;
/** One stored row's JSON text (characters); longer rows are refused, and skipped if found. */
export const STORED_CHAT_ROW_MAX_CHARS = 4_000_000;
/** A stored chat's id and title (characters). */
export const STORED_CHAT_ID_MAX_CHARS = 64;
export const STORED_CHAT_TITLE_MAX_CHARS = 200;

/** The `@app/db` tables of this task (migrations `0031_agent_chats`, `0032_agent_skills`). */
export const AGENT_CHAT_TABLES = ['agent_chat_entries', 'agent_chat_messages', 'agent_chats'] as const;
export const AGENT_SKILL_TABLES = ['agent_skills'] as const;
/** Phase 8 Task 5's table (migration `0200_agent_skill_prefs`): one row per skill the user switched on or off. */
export const AGENT_SKILL_PREF_TABLES = ['agent_skill_prefs'] as const;

/** "Delete all chats" asks first, in a native message box main shows. Only `confirmIndex` confirms. */
export const DELETE_ALL_CHATS = {
  dialog: {
    type: 'warning',
    message: 'Delete all agent chats?',
    detail: 'This deletes every chat with the agent, the ones saved on this computer and the ones open now. It cannot be undone.',
    buttons: ['Delete All Chats', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  },
  confirmIndex: 0,
} as const;

/**
 * Changing the retention so that stored chats would be deleted (`off`, or a shorter window with
 * older chats) asks first, in a native message box main shows; only `confirmIndex` confirms. A
 * change that deletes nothing (a longer window, or no chat that old) applies at once.
 */
export function changeRetentionDialog(retention: ChatRetention, chats: number) {
  const which = retention === 'off' ? 'every saved chat' : chats === 1 ? 'the saved chat older than that' : `the ${chats} saved chats older than that`;
  return {
    dialog: {
      type: 'warning' as const,
      message: retention === 'off' ? 'Stop saving agent chats?' : `${CHAT_RETENTION_LABELS[retention]}?`,
      detail: `This deletes ${which} now. It cannot be undone.`,
      buttons: ['Delete and Change', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    },
    confirmIndex: 0,
  };
}

/** `agent.setChatRetention`'s answer: `saved`, `cancelled` (the user kept the old setting in main's dialog), `failed`. */
export const AGENT_SET_RETENTION_RESULTS = ['saved', 'cancelled', 'failed'] as const;
export type AgentSetRetentionResult = (typeof AGENT_SET_RETENTION_RESULTS)[number];

/** `agent.deleteAllChats`'s answer. */
export const AGENT_DELETE_ALL_CHATS_RESULTS = ['deleted', 'cancelled', 'failed'] as const;
export type AgentDeleteAllChatsResult = (typeof AGENT_DELETE_ALL_CHATS_RESULTS)[number];

// ---- Export ----------------------------------------------------------------------------------

export const CHAT_EXPORT_FORMATS = ['markdown', 'json'] as const;
export type ChatExportFormat = (typeof CHAT_EXPORT_FORMATS)[number];

export const CHAT_EXPORT_EXTENSIONS: Readonly<Record<ChatExportFormat, string>> = { markdown: 'md', json: 'json' };
export const CHAT_EXPORT_FILTER_NAMES: Readonly<Record<ChatExportFormat, string>> = { markdown: 'Markdown', json: 'JSON' };

/** The save dialog's default file name: `frost-chat-<YYYY-MM-DD>.md` (or `.json`), in local time. */
export function chatExportFileName(format: ChatExportFormat, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `frost-chat-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.${CHAT_EXPORT_EXTENSIONS[format]}`;
}

/**
 * `agent.exportChat`'s answer: `saved` (written where the user chose), `cancelled` (the dialog was
 * dismissed: nothing written), `failed` (no such chat, or the file could not be written).
 */
export const CHAT_EXPORT_RESULTS = ['saved', 'cancelled', 'failed'] as const;
export type ChatExportResult = (typeof CHAT_EXPORT_RESULTS)[number];

export const CHAT_EXPORT_MESSAGES: Readonly<Record<ChatExportResult, string>> = {
  saved: 'Chat exported.',
  cancelled: 'Export cancelled.',
  failed: 'The chat could not be exported. Try again.',
};

/**
 * The JSON export's shape, version `CHAT_EXPORT_FORMAT_VERSION`:
 *
 * ```ts
 * {
 *   kind: 'frost.agent-chat',             // CHAT_EXPORT_JSON_KIND
 *   version: 1,                           // CHAT_EXPORT_FORMAT_VERSION
 *   exportedAt: '2026-10-28T12:00:00.000Z',
 *   chat: {
 *     title: 'How is this page doing?',
 *     updatedAt: '2026-10-28T11:59:00.000Z',
 *     model: 'anthropic/claude-sonnet-5-5' | null,
 *     truncated: false,                   // earlier messages were not kept
 *     messages: [
 *       { role: 'user', text: '…', skill?: { id, name } },
 *       { role: 'assistant', text: '…', tools: [
 *         { tool: 'page_text', label: '…', status: 'done', error: null | 'denied' | …,
 *           input: '{"maxChars":2000}',     // JSON text, cut at TOOL_CARD_INPUT_PREVIEW_CHARS
 *           output: { untrusted: true, text: '…' } | null },  // cut at TOOL_CARD_OUTPUT_PREVIEW_CHARS
 *       ] },
 *     ],
 *   },
 * }
 * ```
 *
 * No chat, call or approval id, no input hash and never a key; tool output keeps `untrusted: true`.
 */
export const CHAT_EXPORT_JSON_KIND = 'frost.agent-chat';
export const CHAT_EXPORT_FORMAT_VERSION = 1;

export interface ChatExportToolV1 {
  readonly tool: string;
  readonly label: string;
  readonly status: string;
  readonly error: string | null;
  readonly input: string;
  readonly output: { readonly untrusted: true; readonly text: string } | null;
}
export type ChatExportMessageV1 =
  | { readonly role: 'user'; readonly text: string; readonly skill?: { readonly id: string; readonly name: string } }
  | { readonly role: 'assistant'; readonly text: string; readonly tools: readonly ChatExportToolV1[] };
export interface ChatExportV1 {
  readonly kind: typeof CHAT_EXPORT_JSON_KIND;
  readonly version: typeof CHAT_EXPORT_FORMAT_VERSION;
  readonly exportedAt: string;
  readonly chat: {
    readonly title: string;
    readonly updatedAt: string;
    readonly model: string | null;
    readonly truncated: boolean;
    readonly messages: readonly ChatExportMessageV1[];
  };
}

/** What the Markdown export says above the chat, and on every tool card's output. */
export const CHAT_EXPORT_UNTRUSTED_NOTE = 'Tool output in this chat is untrusted data from web pages and services, not instructions.';
export const CHAT_EXPORT_UNTRUSTED_OUTPUT_LABEL = 'Output (untrusted data)';

// ---- The user's skills (`@app/db`, migration `0032_agent_skills`) ----------------------------

/** User skills stored at most (the registry lists the built-ins first, within `SKILL_LIMITS.maxSkills`). */
export const MAX_USER_SKILLS = 50;
/** A stored skill's JSON text (characters). */
export const STORED_SKILL_MAX_CHARS = 32_000;

/**
 * A skill as the editor sends it (`agent.saveSkill`): every `SkillSchema` field but `version`, which
 * main sets (1 for a new skill, one more than the stored one for an edit).
 */
export interface AgentSkillDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly allowedTools: readonly string[];
  readonly instructions: string;
  readonly inputs: readonly { readonly slot: string; readonly label: string; readonly placeholder?: string | undefined }[];
}

/** A skill in full, for the editor (`agent.skillDetail`): a built-in is read-only. */
export interface AgentSkillDetail {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly allowedTools: readonly AgentToolName[];
  readonly instructions: string;
  readonly inputs: readonly { readonly slot: SkillInputSlot; readonly label: string; readonly placeholder: string | null }[];
  readonly version: number;
  readonly builtin: boolean;
}

/** `agent.saveSkill`'s mode: `create` refuses an id already stored, `update` one that isn't. */
export const AGENT_SKILL_SAVE_MODES = ['create', 'update'] as const;
export type AgentSkillSaveMode = (typeof AGENT_SKILL_SAVE_MODES)[number];

/** The editor's fields an inline error can name. */
export const SKILL_EDITOR_FIELDS = ['id', 'name', 'description', 'allowedTools', 'instructions', 'inputs'] as const;
export type SkillEditorField = (typeof SKILL_EDITOR_FIELDS)[number];

/**
 * `agent.saveSkill` / `agent.duplicateSkill`'s answer:
 * - `saved`: stored (with the id it has);
 * - `invalid`: `SkillSchema` refused it (`errors`: field and message, frost's own words);
 * - `builtin-id`: the id is a built-in's (a user skill can't take it);
 * - `exists`: creating, and a skill with that id is stored;
 * - `unknown-skill`: updating (or duplicating) a skill that isn't there;
 * - `limit`: `MAX_USER_SKILLS` are stored;
 * - `failed`: it could not be written.
 */
export const AGENT_SAVE_SKILL_RESULTS = ['saved', 'invalid', 'builtin-id', 'exists', 'unknown-skill', 'limit', 'failed'] as const;
export type AgentSaveSkillResultKind = (typeof AGENT_SAVE_SKILL_RESULTS)[number];
export type AgentSaveSkillResult =
  | { readonly result: 'saved'; readonly id: string }
  | { readonly result: 'invalid'; readonly errors: readonly { readonly field: SkillEditorField; readonly message: string }[] }
  | { readonly result: Exclude<AgentSaveSkillResultKind, 'saved' | 'invalid'> };

/** Inline errors shown at most (the first ones). */
export const MAX_SKILL_ERRORS = 12;

export const AGENT_SAVE_SKILL_MESSAGES: Readonly<Record<AgentSaveSkillResultKind, string>> = {
  saved: 'Skill saved.',
  invalid: 'Fix the fields marked below, then save again.',
  'builtin-id': 'That id belongs to a built-in skill. Choose another id.',
  exists: 'You already have a skill with that id. Choose another id.',
  'unknown-skill': 'That skill is no longer stored.',
  limit: `You can keep up to ${MAX_USER_SKILLS} skills. Delete one first.`,
  failed: 'The skill could not be saved. Try again.',
};

/**
 * What an inline error says for a field when the schema's own message isn't one of frost's
 * sentences (a length or format check).
 */
export const SKILL_FIELD_MESSAGES: Readonly<Record<SkillEditorField, string>> = {
  id: `Use ${SKILL_LIMITS.minIdChars} to ${SKILL_LIMITS.maxIdChars} lower-case letters and digits, joined by single hyphens (for example: my-audit).`,
  name: `Give the skill a name on one line, up to ${SKILL_LIMITS.maxNameChars} characters.`,
  description: `Describe the skill on one line, up to ${SKILL_LIMITS.maxDescriptionChars} characters.`,
  allowedTools: 'Choose at least one tool.',
  instructions: `Write the instructions, up to ${SKILL_LIMITS.maxInstructionChars} characters, using only the listed {{slot}} placeholders.`,
  inputs: 'Each input needs a label on one line, and its slot must appear in the instructions.',
};

/** What a user skill whose name is a built-in's (ignoring case and spacing) is refused with. */
export const SKILL_NAME_TAKEN_MESSAGE = "A built-in skill already has this name. Choose another, so the two can't be confused.";

/** How the skills list marks each kind. */
export const SKILL_BUILTIN_LABEL = 'Built-in (read-only)';
export const SKILL_USER_LABEL = 'Your skill';
export const SKILL_DUPLICATE_LABEL = 'Duplicate to edit';

/** The suffix `duplicateSkillId` adds, and a duplicate's name's. */
export const SKILL_DUPLICATE_ID_SUFFIX = '-copy';
export const SKILL_DUPLICATE_NAME_SUFFIX = ' (copy)';

/**
 * A free id for a copy of `id`: `<id>-copy`, else `<id>-copy-2`, `-copy-3` …, the base cut so the
 * whole stays within `SKILL_LIMITS.maxIdChars` (and kebab-case). `null` if none is free in 100 tries.
 */
export function duplicateSkillId(id: string, taken: (candidate: string) => boolean): string | null {
  for (let n = 1; n <= 100; n += 1) {
    const suffix = n === 1 ? SKILL_DUPLICATE_ID_SUFFIX : `${SKILL_DUPLICATE_ID_SUFFIX}-${n}`;
    const base = id.slice(0, SKILL_LIMITS.maxIdChars - suffix.length).replace(/-+$/, '');
    const candidate = `${base}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return null;
}

/** A copy's name: `<name> (copy)`, the name cut so the whole fits `SKILL_LIMITS.maxNameChars`. */
export function duplicateSkillName(name: string): string {
  return `${name.slice(0, SKILL_LIMITS.maxNameChars - SKILL_DUPLICATE_NAME_SUFFIX.length).trimEnd()}${SKILL_DUPLICATE_NAME_SUFFIX}`;
}

// ---- The skills library: search and switches (Phase 8 Task 5; `agent-data.feature.md`, Skills library) ----

/**
 * What the skills library says around its search box and each skill's switch. A skill with no row
 * in `agent_skill_prefs` is on; a switched-off skill stays listed (switch "Off"), but is left out of
 * the composer's picker and the palette, and `agent.send` refuses it (`unknown-skill`).
 */
export const SKILL_LIBRARY_WORDS = {
  searchPlaceholder: 'Search skills',
  on: 'On',
  off: 'Off',
  noMatch: 'No skills match',
} as const;

/** The text a search compares: NFKC (width and compatibility forms folded), lower-cased, spaces collapsed. */
function foldSkillText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The skills whose name, description or id contain every word of `query` (NFKC-folded, case-folded;
 * order kept). A blank query keeps them all. Pure: the library and the composer's picker filter in
 * the renderer, with no IPC.
 */
export function filterSkills<T extends { readonly id: string; readonly name: string; readonly description: string }>(skills: readonly T[], query: string): T[] {
  const words = foldSkillText(typeof query === 'string' ? query : '')
    .split(' ')
    .filter((word) => word !== '');
  if (words.length === 0) return [...skills];
  return skills.filter((skill) => {
    const haystack = foldSkillText(`${skill.name} ${skill.description} ${skill.id}`);
    return words.every((word) => haystack.includes(word));
  });
}

// ---- Skill files: export and import (Phase 8 Task 6; `agent-data.feature.md`, Import and export) ----

/**
 * A skills file (`SkillFileSchema` in `skills-schema.ts`): `{ format: SKILL_FILE_FORMAT, version:
 * SKILL_FILE_VERSION, exportedAt, skills }`, 1 to `MAX_USER_SKILLS` of the user's skills. Main writes it
 * only where the user chose in its own save dialog, owner-only (mode `0600`, as a chat export), as a
 * new file renamed into place; and reads one only from the file the user chose in its own open
 * dialog: at most `SKILL_FILE_MAX_BYTES`, strict UTF-8, JSON, frost's format and version, each skill
 * checked on its own with `SkillSchema` (an invalid one is listed, never stored).
 */
export const SKILL_FILE_FORMAT = 'frost-skills';
export const SKILL_FILE_VERSION = 1;
/** The largest skills file import reads (bytes): 2 MiB, well past 50 skills at their caps. */
export const SKILL_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const SKILL_FILE_EXTENSION = 'json';
export const SKILL_FILE_FILTER_NAME = 'frost skills (JSON)';

/** The save dialog's default file name: `frost-skills-<YYYY-MM-DD>.json`, in local time. */
export function skillExportFileName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `frost-skills-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.${SKILL_FILE_EXTENSION}`;
}

/**
 * How long an import's review stays open (milliseconds): `agent.previewSkillImport`'s token can be
 * spent once (`agent.importSkills`) within 10 minutes, then it is gone; a new preview replaces it.
 */
export const SKILL_IMPORT_TOKEN_TTL_MS = 10 * 60_000;

/**
 * Why an entry would not keep its id or name: `none`; `builtin-id` (a built-in has the id);
 * `exists` (one of the user's skills, or an earlier valid entry of the same file, has the id); `builtin-name` (a built-in has the name, ignoring
 * case and spacing). An entry with a conflict is imported as a copy: a clashing id becomes a free
 * `duplicateSkillId`, and its name `duplicateSkillName`. Nothing stored is ever replaced.
 */
export const SKILL_IMPORT_CONFLICTS = ['none', 'builtin-id', 'exists', 'builtin-name'] as const;
export type SkillImportConflict = (typeof SKILL_IMPORT_CONFLICTS)[number];

export const SKILL_IMPORT_CONFLICT_MESSAGES: Readonly<Record<SkillImportConflict, string | null>> = {
  none: null,
  'builtin-id': 'A built-in skill has this id: it is imported as a copy, with a new id and name.',
  exists: 'You already have a skill with this id: it is imported as a copy, with a new id and name. Yours is kept.',
  'builtin-name': 'A built-in skill has this name: it is imported with "(copy)" added to its name.',
};

/**
 * `agent.previewSkillImport` and `agent.importSkills`' answers:
 * - `ready`: the file was read; the review lists its entries (`AgentSkillImportPreview`);
 * - `imported`: the selected skills were stored (`count` of them);
 * - `cancelled`: the open dialog was dismissed (nothing read), or one was already open;
 * - `too-large`: over `SKILL_FILE_MAX_BYTES`; `not-utf8`: not UTF-8 text; `not-json`: not JSON;
 *   `wrong-format`: not a frost skills file of `SKILL_FILE_VERSION` (or no skill, or too many);
 * - `expired`: the review's token was spent, cancelled, replaced or older than `SKILL_IMPORT_TOKEN_TTL_MS`;
 * - `invalid-selection`: an index names no importable entry (nothing stored);
 * - `limit`: storing them all would pass `MAX_USER_SKILLS` (nothing stored);
 * - `failed`: the file could not be read, or a skill could not be stored.
 */
export const SKILL_IMPORT_RESULTS = ['ready', 'imported', 'cancelled', 'too-large', 'not-utf8', 'not-json', 'wrong-format', 'expired', 'invalid-selection', 'limit', 'failed'] as const;
export type SkillImportResultKind = (typeof SKILL_IMPORT_RESULTS)[number];

export const SKILL_IMPORT_MESSAGES: Readonly<Record<SkillImportResultKind, string>> = {
  ready: 'Review the skills below before importing them.',
  imported: 'Skills imported.',
  cancelled: 'Import cancelled.',
  'too-large': 'That file is too large to be a frost skills file.',
  'not-utf8': 'That file is not text frost can read.',
  'not-json': 'That file is not a frost skills file (it is not JSON).',
  'wrong-format': 'That file is not a frost skills file, or it is from a newer version of frost.',
  expired: 'This review has expired. Choose the file again.',
  'invalid-selection': 'Choose only skills that can be imported.',
  limit: `You can keep up to ${MAX_USER_SKILLS} skills. Select fewer, or delete some first.`,
  failed: 'The skills could not be imported. Try again.',
};

/** What an entry that is not a skill at all (or holds fields a skill has not) is listed with. */
export const SKILL_IMPORT_ENTRY_INVALID = 'This entry is not a skill frost can read.';

/** One entry of a skills file, as the review lists it. */
export type AgentSkillImportItem =
  | {
      /** The entry's position in the file (what `agent.importSkills` selects). */
      readonly index: number;
      readonly valid: true;
      readonly id: string;
      readonly name: string;
      readonly description: string;
      /** The catalogue tools it may use. */
      readonly tools: readonly AgentToolName[];
      /** It lists one of `SKILL_ACTING_TOOLS`: the review shows `SKILL_WARNINGS.actingTools`. */
      readonly actingTools: boolean;
      readonly conflict: SkillImportConflict;
      /** The instructions in full, as they will be stored (shown as text, never run, before import). */
      readonly instructions: string;
      readonly inputs: readonly { readonly slot: SkillInputSlot; readonly label: string; readonly placeholder: string | null }[];
      readonly error: null;
    }
  | {
      readonly index: number;
      readonly valid: false;
      /** The entry's id and name only when each is well-formed on its own (else `null`: never echoed). */
      readonly id: string | null;
      readonly name: string | null;
      /** frost's own sentence (`SKILL_FIELD_MESSAGES`, a schema refinement's, or `SKILL_IMPORT_ENTRY_INVALID`). */
      readonly error: string;
    };

/** `agent.previewSkillImport`'s review: a single-use token, the file's entries in order, and how many more skills fit. */
export interface AgentSkillImportPreview {
  readonly token: string;
  readonly items: readonly AgentSkillImportItem[];
  /** `MAX_USER_SKILLS` less the user's skills now. */
  readonly room: number;
}

export type AgentSkillImportPreviewResult =
  | { readonly result: 'ready'; readonly preview: AgentSkillImportPreview }
  | { readonly result: Exclude<SkillImportResultKind, 'ready' | 'imported'> };

export type AgentSkillImportResult = { readonly result: 'imported'; readonly count: number } | { readonly result: Exclude<SkillImportResultKind, 'ready' | 'imported'> };

/**
 * `agent.exportSkills`' answer: `saved` (written where the user chose), `cancelled` (the dialog was
 * dismissed, or one was already open: nothing written), `nothing-to-export` (the user has no skills),
 * `failed` (an id is not one of the user's skills, or the file could not be written).
 */
export const SKILL_EXPORT_RESULTS = ['saved', 'cancelled', 'nothing-to-export', 'failed'] as const;
export type SkillExportResult = (typeof SKILL_EXPORT_RESULTS)[number];

export const SKILL_EXPORT_MESSAGES: Readonly<Record<SkillExportResult, string>> = {
  saved: 'Skills exported.',
  cancelled: 'Export cancelled.',
  'nothing-to-export': 'You have no skills of your own to export.',
  failed: 'The skills could not be exported. Try again.',
};

/** The skills library's import and export words, and the review sheet's. */
export const SKILL_FILE_WORDS = {
  export: 'Export',
  exportAll: 'Export all',
  import: 'Import…',
  reviewTitle: 'Review skills to import',
  reviewExplainer:
    "When you run an imported skill, its instructions are sent as your own message, and it may use the tools listed. Read each skill's instructions before you import it.",
  showInstructions: 'Show instructions',
  hideInstructions: 'Hide instructions',
  confirm: 'Import selected',
  cancel: 'Cancel',
  openEveryFirst: 'Open the instructions of every selected skill to import them.',
  overRoom: `Select fewer skills: you can keep up to ${MAX_USER_SKILLS}.`,
  invalidLabel: 'Cannot be imported',
  toolsLabel: 'Tools it may use',
  inputsLabel: 'Asks you for',
} as const;
