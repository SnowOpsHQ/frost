/**
 * The AI answers view and its storage (Phase 12 Task 9, SL-046/084; plan `docs/plans/phase-12-big-bets.md`,
 * Decision 9, Global constraints "Untrusted text" and "Database", the lead's L5 gate in "As built";
 * acceptance `ai-answers.feature.md`; Zod side `ai-answers.schema.ts`; Task 8's engines, vias and
 * settings in `ai-search.spec.ts`). Plain values, no Zod: the renderer imports this file.
 *
 * - **Storage.** Every AI answer (the agent's `run_ai_search`, and the view's own run) is kept in
 *   `ai_answers` (migration `0242_ai_answers`), device-local (never in `SYNC_TABLES`), as Task 8's
 *   `AiAnswer` plus where it came from (`origin`), the cited registrable domains and the chat
 *   (`chat_id`, nullable; `null` in this build: the tool's port carries no chat id). The answer text
 *   is at most `AI_SEARCH_LIMITS.maxAnswerChars`, the citations at most `maxCitations`.
 * - **Retention** (`AI_ANSWER_RETENTION_KEY` in `app_settings`; no migration): `off` (answers are not
 *   stored; choosing it deletes those kept), `7d`, `30d` (the default), `forever`. Main purges on every
 *   write, at start-up and when the setting changes; at most `AI_ANSWERS_LIMITS.maxStored` rows are
 *   kept whatever the setting. An answer inside a chat record follows the chat's retention; the table
 *   follows its own (the view says so: `AI_ANSWERS_VIEW_TEXT.chatRetentionNote`).
 * - **The view** lists the answers (newest first, paged), shows one as inert text (no `innerHTML`, no
 *   markdown; links are not clickable: "Open in tab" sends an `http(s)` URL through the address bar's
 *   path), its citations and the cited domains grouped, with a watched domain highlighted by
 *   registrable domain. It can run a query itself: a **user action** (no approval card), through Task
 *   8's service with the same gate, the same body, caps and parse, after the cost note
 *   (`DATA_SPEND_NOTE`) is shown. Main refuses with `unavailable` and `LEGAL_GATE_NOTE` while the
 *   engine's provider gate is closed (as shipped: both). It also writes Task 8's settings: each
 *   engine's via (`api` or `off`) and the default engine.
 * - **Phase 9 independence** (cross-plan ruling): nothing under Phase 9's AI-readiness score reads
 *   this table or imports `ai-answers*` or `main/ai-search/**`.
 */
import { DATA_SPEND_NOTE, LEGAL_GATE_NOTE } from './data-sources.spec';
import { AI_SEARCH_LIMITS, AI_SEARCH_UNAVAILABLE_MESSAGES, type AiSearchUnavailableReason } from './ai-search.spec';

// ---- Storage --------------------------------------------------------------------------------------

/** The table `0242_ai_answers` creates. Device-local: not in `SYNC_TABLES`. */
export const AI_ANSWERS_TABLES = ['ai_answers'] as const;
export const AI_ANSWERS_MIGRATION_IDS = ['0242_ai_answers'] as const;

/** Where a stored answer came from: the agent's `run_ai_search`, or the view's own run. */
export const AI_ANSWER_ORIGINS = ['agent', 'view'] as const;
export type AiAnswerOrigin = (typeof AI_ANSWER_ORIGINS)[number];

export function isAiAnswerOrigin(value: unknown): value is AiAnswerOrigin {
  return typeof value === 'string' && (AI_ANSWER_ORIGINS as readonly string[]).includes(value);
}

export const AI_ANSWER_ORIGIN_LABELS: Readonly<Record<AiAnswerOrigin, string>> = { agent: 'Asked by the agent', view: 'Asked here' };

export const AI_ANSWERS_LIMITS = {
  /** A stored query, at most (the tool's `AGENT_TOOL_INPUT_LIMITS.maxQueryChars`). */
  maxQueryChars: 256,
  /** A stored answer's text, at most (`AI_SEARCH_LIMITS.maxAnswerChars`). */
  maxAnswerChars: AI_SEARCH_LIMITS.maxAnswerChars,
  /** Citations per answer, at most (`AI_SEARCH_LIMITS.maxCitations`). */
  maxCitations: AI_SEARCH_LIMITS.maxCitations,
  /** The stored citations' JSON text, at most (20 × (500 + 300) characters, escaped, with room). */
  maxCitationsJsonChars: 40_000,
  /** Cited registrable domains per answer, at most (one per citation). */
  maxCitedDomains: AI_SEARCH_LIMITS.maxCitations,
  /** A cited domain, at most (a host name). */
  maxDomainChars: 253,
  /** The stored cited domains' JSON text, at most. */
  maxCitedDomainsJsonChars: 6_000,
  /** A chat id, at most. */
  maxChatIdChars: 64,
  /** Rows kept, at most, whatever the retention (the newest). */
  maxStored: 1_000,
  /** A list page: the default and the most rows one call answers. */
  defaultPageSize: 50,
  maxPageSize: 100,
  /** A list row's preview of the answer text (characters). */
  previewChars: 240,
} as const;

// ---- Retention (`app_settings`, `0005_app_settings`; no migration) -------------------------------

/**
 * How long main keeps AI answers:
 * - `off`: never stored (choosing it deletes the answers kept);
 * - `7d`, `30d`: an answer older than that is deleted;
 * - `forever`: kept until the user deletes it (at most `AI_ANSWERS_LIMITS.maxStored`).
 */
export const AI_ANSWER_RETENTIONS = ['off', '7d', '30d', 'forever'] as const;
export type AiAnswerRetention = (typeof AI_ANSWER_RETENTIONS)[number];

export function isAiAnswerRetention(value: unknown): value is AiAnswerRetention {
  return typeof value === 'string' && (AI_ANSWER_RETENTIONS as readonly string[]).includes(value);
}

/** The default: 30 days, like chats. */
export const DEFAULT_AI_ANSWER_RETENTION: AiAnswerRetention = '30d';

/** The `app_settings` key holding the retention (a tampered or missing row reads as the default). */
export const AI_ANSWER_RETENTION_KEY = 'ai_answer_retention' as const;

const DAY_MS = 86_400_000;

/** Days an answer is kept (`null`: no limit; `0`: never stored). */
export const AI_ANSWER_RETENTION_DAYS: Readonly<Record<AiAnswerRetention, number | null>> = { off: 0, '7d': 7, '30d': 30, forever: null };

/**
 * The oldest `created_at` an answer may have under `retention` at `now`: older ones are deleted.
 * `null` keeps every answer (`forever`); `off` answers `Infinity` (none is kept).
 */
export function aiAnswerRetentionCutoff(retention: AiAnswerRetention, now: number): number | null {
  const days = AI_ANSWER_RETENTION_DAYS[retention];
  if (days === null) return null;
  if (days === 0) return Number.POSITIVE_INFINITY;
  return now - days * DAY_MS;
}

/** Main purges at start-up, then this often while frost runs (ms; the chats' daily prune), and on every write and setting change. */
export const AI_ANSWER_PURGE_INTERVAL_MS = DAY_MS;

/** Whether choosing `next` over `current` deletes kept answers now (a shorter retention, or `off`), so the view asks first. */
export function aiAnswerRetentionDeletes(current: AiAnswerRetention, next: AiAnswerRetention): boolean {
  const days = (retention: AiAnswerRetention) => AI_ANSWER_RETENTION_DAYS[retention] ?? Number.POSITIVE_INFINITY;
  return days(next) < days(current);
}

export const AI_ANSWER_RETENTION_LABELS: Readonly<Record<AiAnswerRetention, string>> = {
  off: "Don't keep AI answers",
  '7d': 'Keep AI answers for 7 days',
  '30d': 'Keep AI answers for 30 days',
  forever: 'Keep AI answers until I delete them',
};

// ---- The view's run and settings -----------------------------------------------------------------

/**
 * Why the view's run sent nothing (or why its answer could not be had):
 * - `unavailable`: the engine's provider is gated off (`LEGAL_GATE_NOTE`; as shipped, both);
 * - `none-set-up`, `engine-off`, `no-api`, `setting-changed`, `request-failed`, `invalid-answer`: as
 *   Task 8's reasons (`AI_SEARCH_UNAVAILABLE_REASONS`);
 * - `cooldown`: that engine was asked by the view less than `perEngineCooldownMs` ago;
 * - `busy`: a view run is already in flight (one at a time).
 */
export const AI_ANSWERS_RUN_REFUSALS = ['unavailable', 'none-set-up', 'engine-off', 'no-api', 'setting-changed', 'cooldown', 'busy', 'request-failed', 'invalid-answer'] as const;
export type AiAnswersRunRefusal = (typeof AI_ANSWERS_RUN_REFUSALS)[number];

/** What each refusal says to the user (frost's own words; never a key, a URL or a provider's text). */
export const AI_ANSWERS_RUN_REFUSAL_TEXT: Readonly<Record<AiAnswersRunRefusal, string>> = {
  unavailable: LEGAL_GATE_NOTE,
  'none-set-up': AI_SEARCH_UNAVAILABLE_MESSAGES['none-set-up'],
  'engine-off': 'That AI engine is not set up. Add its key in Settings › Data sources, or switch it on here.',
  'no-api': 'frost has no API for that AI engine in this build.',
  'setting-changed': 'The AI search setting changed; ask again.',
  cooldown: `That AI engine was asked less than ${AI_SEARCH_LIMITS.perEngineCooldownMs / 1000} seconds ago, or is still answering, so nothing was sent. Try again shortly.`,
  busy: 'An AI search is already running.',
  'request-failed': AI_SEARCH_UNAVAILABLE_MESSAGES['request-failed'],
  'invalid-answer': AI_SEARCH_UNAVAILABLE_MESSAGES['invalid-answer'],
};

/** Task 8's reason as the view's refusal (`not-available` is the legal gate; `capped` is the agent's own per-turn bound). */
export function aiAnswersRunRefusalOf(reason: AiSearchUnavailableReason): AiAnswersRunRefusal {
  if (reason === 'not-available') return 'unavailable';
  if (reason === 'capped') return 'busy';
  return reason;
}

/** What the AI search setting writes answer. */
export const AI_SEARCH_SETTING_RESULTS = ['ok', 'unavailable', 'no-api', 'failed'] as const;
export type AiSearchSettingResult = (typeof AI_SEARCH_SETTING_RESULTS)[number];

// ---- The view's words ---------------------------------------------------------------------------

export const AI_ANSWERS_VIEW_TEXT = {
  title: 'AI answers',
  close: 'Close AI answers',
  askTitle: 'Ask AI engines',
  queryLabel: 'Question',
  engineLabel: 'Engine',
  defaultEngineChoice: 'The default engine',
  ask: 'Ask…',
  send: 'Send',
  cancel: 'Cancel',
  /** Shown before anything is sent (the cost note first). */
  costNote: `${DATA_SPEND_NOTE} The question is sent as typed, through your own API key. No approval card: asking here is your own action.`,
  answersTitle: 'Answers',
  noAnswers: 'No AI answers kept yet.',
  more: 'Show more',
  refresh: 'Refresh',
  delete: 'Delete',
  deleteConfirm: 'Delete this answer?',
  deleteAll: 'Delete all',
  deleteAllConfirm: 'Delete every kept AI answer? This cannot be undone.',
  /** Asked before a shorter retention is saved (it deletes now). */
  retentionShorterConfirm: 'Keep answers for less time? Answers older than that are deleted now. This cannot be undone.',
  /** Asked before `off` is saved (it deletes every kept answer now). */
  retentionOffConfirm: "Stop keeping AI answers? Every kept answer is deleted now. This cannot be undone.",
  retentionChange: 'Change',
  keep: 'Keep',
  settingsTitle: 'Settings',
  retentionLabel: 'Keep answers',
  viaLabel: 'Reach through',
  viaOff: 'Off',
  defaultEngineLabel: 'Default engine',
  noDefaultEngine: 'None (the first one set up)',
  watchLabel: 'Watch domain',
  watchPlaceholder: 'example.com',
  /** The table follows its own setting; an answer the agent read stays in its chat as long as the chat does. */
  /** Said beside a run's answer when it was not stored. */
  shownNotKept: 'Shown, not kept: keeping AI answers is off.',
  notKept: 'Shown, but the answer could not be kept.',
  chatRetentionNote: 'An answer the agent asked for also stays inside its chat, which follows the chat retention setting (Settings › Agent). Deleting it here does not change the chat.',
  untrustedNote: "The answer is the AI engine's text, shown as plain text. Links open only through Open in tab.",
  openInTab: 'Open in tab',
  citationsTitle: 'Sources',
  noCitations: 'No sources given.',
  domainsTitle: 'Cited domains',
  watched: 'watched',
  truncated: 'The answer was cut to fit.',
} as const;
