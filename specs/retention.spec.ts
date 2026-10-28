/**
 * Retention and disk usage (Phase 6 Task 7; acceptance `retention.feature.md`). The rules of what a
 * purge removes are `capture-db.feature.md` (Retention planning) and the plan's "The purge path";
 * the bounds of N are `MAX_RETENTION_VERSIONS` and `MAX_RETENTION_DAYS` of `capture-db.spec.ts`.
 * Plain values and types with no Zod, so the chrome renderer can use them; the Zod schemas of the
 * retention procedures' inputs and answers are `retention.schema.ts`, each `satisfies` a type here.
 *
 * A project's policy is enforced automatically (a recorded `retention` purge, no dialog: the user set
 * the policy): after a capture run of the project ends; after a manual capture or screenshot into it,
 * at most once per `RETENTION_ENFORCE_MIN_INTERVAL_MS`; and at startup for each project not enforced
 * within that interval. "Purge now" shows its plan in main's dialog first (`PURGE_NOW`).
 */
import { MAX_RETENTION_DAYS, MAX_RETENTION_VERSIONS, type PurgeReason, type RetentionMode } from './capture-db.spec';

// ---- Cadence and bounds --------------------------------------------------------------------------

/** A project's policy is enforced after a manual capture or screenshot at most this often (and at startup once this old). */
export const RETENTION_ENFORCE_MIN_INTERVAL_MS = 86_400_000;

/** The purge log shows this many `ci_purges` rows, newest first. */
export const PURGE_LOG_LIMIT = 20;

/** The orphan sweep leaves a file younger than this alone: a write under way may own it. */
export const ORPHAN_TMP_MIN_AGE_MS = 3_600_000;

/** A screenshot file's name: its own SHA-256 (the only files the sweep may remove as orphans). */
export const SCREENSHOT_FILE_NAME_PATTERN = /^[0-9a-f]{64}\.png$/;

/** A screenshot write's temporary name (`<sha>.png.tmp-<16 hex>`): a leftover of a crash once old. */
export const SCREENSHOT_TMP_NAME_PATTERN = /^[0-9a-f]{64}\.png\.tmp-[0-9a-f]{16}$/;

/** N's bounds per mode (`forever` takes none). */
export const RETENTION_VALUE_BOUNDS = {
  versions: { min: 1, max: MAX_RETENTION_VERSIONS },
  days: { min: 1, max: MAX_RETENTION_DAYS },
} as const satisfies Readonly<Record<Exclude<RetentionMode, 'forever'>, { min: number; max: number }>>;

/** A project's retention as the procedures carry it. */
export type RetentionPolicyInput = { mode: 'forever'; value: null } | { mode: 'versions' | 'days'; value: number };

/** Whether `mode` and `value` are a policy: `forever` with `null`, else a whole N within its bounds. */
export function isRetentionPolicy(mode: unknown, value: unknown): mode is RetentionMode {
  if (mode === 'forever') return value === null;
  if (mode !== 'versions' && mode !== 'days') return false;
  const { min, max } = RETENTION_VALUE_BOUNDS[mode];
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// ---- Answers -------------------------------------------------------------------------------------

export const RETENTION_REFUSALS = ['not-found', 'invalid-retention', 'running', 'declined', 'unavailable', 'store-failed'] as const;
export type RetentionRefusal = (typeof RETENTION_REFUSALS)[number];

export const RETENTION_REFUSAL_MESSAGES: Readonly<Record<RetentionRefusal, string>> = {
  'not-found': 'That project no longer exists.',
  'invalid-retention': 'Enter a whole number within the limits shown.',
  running: 'A capture run is under way. Try again once it is done.',
  declined: 'Nothing was deleted.',
  unavailable: 'This session keeps its database in memory; there is no file to compact.',
  'store-failed': 'The change database could not be read.',
};

export type RetentionRefused = { status: 'refused'; reason: RetentionRefusal };

/** Rows a purge removes (or would). */
export interface PurgeCountsView {
  captures: number;
  versions: number;
  diffs: number;
  screenshots: number;
}

export type SetRetentionAnswer = { status: 'ok' } | RetentionRefused;

/** `retentionPreview`: what "Purge now" would remove under the project's policy now (nothing is written). */
export type RetentionPreviewAnswer = { status: 'ok'; policy: RetentionPolicyInput; counts: PurgeCountsView; bytes: number } | RetentionRefused;

/**
 * `purgeNow`: `purged` with what went (the purge record's counts and bytes, and how many files were
 * removed); `empty` when there was nothing to purge; `changed` when the rows moved twice between the
 * dialog and the purge (nothing was deleted).
 */
export type PurgeNowAnswer = { status: 'purged'; counts: PurgeCountsView; bytes: number; files: number } | { status: 'empty' } | { status: 'changed' } | RetentionRefused;

/** Disk usage: the rows' stored sizes, and measured files. */
export interface RetentionUsage {
  /** Of one project, or of everything (`null` asked). */
  projectId: string | null;
  captures: number;
  versions: number;
  /** Of `versions`, the ones another project also captured (without a project: two or more projects'). */
  sharedVersions: number;
  /** Stored UTF-8 bytes of the versions' snapshots and of their diffs. */
  snapshotBytes: number;
  diffBytes: number;
  screenshots: number;
  /** The screenshot files the rows name, each once, measured with `lstat`; a missing or non-regular one is `missing`. */
  files: { count: number; bytes: number; missing: number };
  /** The session database file and its `-wal`, by `stat`; `null` when it is in memory. Always the whole file. */
  database: { bytes: number; walBytes: number } | null;
}

export type UsageAnswer = { status: 'ok'; usage: RetentionUsage } | RetentionRefused;

/** One `ci_purges` row as the purge log shows it. */
export interface PurgeLogEntry {
  id: string;
  reason: PurgeReason;
  projectId: string | null;
  /** The policy it ran with (`all`: a deleted project's), `null` when it does not read back. */
  policy: { mode: RetentionMode | 'all'; value: number | null } | null;
  counts: PurgeCountsView;
  bytes: number;
  createdAt: number;
}

export interface PurgeLogAnswer {
  entries: PurgeLogEntry[];
}

/** `compact`: the database file (with its `-wal`) before and after `VACUUM`. */
export type CompactAnswer = { status: 'compacted'; before: number; after: number } | RetentionRefused;

// ---- Wording -------------------------------------------------------------------------------------

/** The policy choices, as the project view lists them. */
export const RETENTION_LABELS: Readonly<Record<RetentionMode, string>> = {
  forever: 'Keep everything',
  versions: 'Keep the last N versions of each page',
  days: 'Keep N days',
};

/** One line on what each policy keeps (the repository's rules, `capture-db.feature.md`). */
export const RETENTION_RULE_NOTES: Readonly<Record<RetentionMode, string>> = {
  forever: 'Captures and screenshots stay until you purge them or delete the project.',
  versions: 'Each page keeps the captures of its newest N versions, and the newest N screenshots of each kind.',
  days: 'Each page always keeps its newest version, and the newest screenshot of each kind.',
};

export const PURGE_REASON_LABELS: Readonly<Record<PurgeReason, string>> = {
  retention: 'Retention',
  'purge-now': 'Purge now',
  'project-deleted': 'Project deleted',
};

/** Said with the usage figures: deleting does not shrink the file by itself. */
export const USAGE_NOTE = 'Deleting frees space inside the database file; the file itself shrinks only after Compact.' as const;

/** Said when a usage reading finds files its rows name missing (`{n}` files). */
export const FILES_MISSING = '{n} missing' as const;

const NUMBER = new Intl.NumberFormat('en-US');

/** A size: "512 B", "1.5 kB", "2.4 MB", "1.2 GB" (decimal units). */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${NUMBER.format(bytes)} B`;
  const [value, unit] = bytes < 1_000_000 ? [bytes / 1_000, 'kB'] : bytes < 1_000_000_000 ? [bytes / 1_000_000, 'MB'] : [bytes / 1_000_000_000, 'GB'];
  return `${(Math.round(value * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
}

/** "1 capture", "2 captures". */
export function plural(n: number, one: string, many: string): string {
  return `${NUMBER.format(n)} ${n === 1 ? one : many}`;
}

/** "3 captures, 2 versions, 1 diff and 0 screenshots". */
export function purgeCountsText(counts: PurgeCountsView): string {
  return `${plural(counts.captures, 'capture', 'captures')}, ${plural(counts.versions, 'version', 'versions')}, ${plural(counts.diffs, 'diff', 'diffs')} and ${plural(counts.screenshots, 'screenshot', 'screenshots')}`;
}

/** "Purge now": the confirmation main shows (Cancel is the default and the cancel answer). */
export const PURGE_NOW = {
  dialog: {
    type: 'warning',
    message: 'Purge this project now?',
    detail: 'This removes {counts} from the project {name} (about {bytes}), as its retention policy says. Each purge is recorded in the purge log. It cannot be undone.',
    buttons: ['Purge Now', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  },
  confirmIndex: 0,
} as const;

type MessageBox = { type: 'warning'; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: boolean };

/** `PURGE_NOW.dialog` for the project `name` (quoted, bidi-isolated) and the plan's counts and bytes. */
export function purgeNowDialog(name: string, counts: PurgeCountsView, bytes: number): MessageBox {
  const { dialog } = PURGE_NOW;
  const detail = dialog.detail.replace('{counts}', purgeCountsText(counts)).replace('{bytes}', formatBytes(bytes)).replace('{name}', `“⁨${name}⁩”`);
  return { ...dialog, detail, buttons: [...dialog.buttons] };
}

/** "Compact the change database": the confirmation main shows. */
export const COMPACT_DATABASE = {
  dialog: {
    type: 'warning',
    message: 'Compact the change database?',
    detail:
      'Compacting rewrites the session database file so the space that deleted captures left inside it is given back to the disk. Nothing is deleted. On a large database it takes a while, and frost waits until it is done.',
    buttons: ['Compact', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  },
  confirmIndex: 0,
} as const;

/** `COMPACT_DATABASE.dialog`, a copy main can hand to Electron. */
export function compactDialog(): MessageBox {
  const { dialog } = COMPACT_DATABASE;
  return { ...dialog, buttons: [...dialog.buttons] };
}
