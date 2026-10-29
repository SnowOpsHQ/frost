/**
 * Capturing a page into its versioned history, and reading that history back (Phase 6 Task 3;
 * acceptance `changes-capture.feature.md`). Plain values and types only: it imports other plain
 * specs (the rule catalog) and three types, so the chrome renderer can use it without bundling Zod.
 * The Zod schemas that check the inputs and answers are `changes.schema.ts` (main and the IPC
 * contract); each `satisfies` the type here.
 *
 * A capture joins the tab's ready audit (Phase 2) with a region extraction run in
 * `CAPTURE_WORLD_ID` (`capture.spec.ts`), builds a `CaptureSnapshot`, and appends it to the page's
 * lane (`capture-db.spec.ts`): a new version when the page changed, else one more capture of the
 * lane's latest version.
 */
import type { CaptureSnapshot, ChangeCounts, DiffRegion, PageRegion, SnapshotDiff } from './capture.spec';
import type { SearchParams } from './serp-search-params.schema';
import type { RenderProfile } from './render-profile.spec';
import { CHECKS_RULE_SPECS } from './seo-checks.spec';
import { SEO_RULE_SPECS, type SeoCategory, type SeoRuleId } from './seo-rules.spec';

/**
 * Why a capture was refused (`CaptureAnswer`):
 * - `no-tab`: the id names no open tab (or the tab has no page view);
 * - `not-active`: only the active tab is captured (Phase 2's rule: only it has a current audit);
 * - `no-audit`: the tab has no ready audit, or the audit is of another URL (fragment aside), or the
 *   page moved on while it was read;
 * - `busy`: a capture of this tab is already running;
 * - `no-project`: the project does not exist or was deleted;
 * - `extract-failed`: the region extraction failed, timed out, or answered something invalid;
 * - `invalid-page`: the snapshot built from the page does not fit `CaptureSnapshotSchema` (or the
 *   search parameters given do not fit theirs);
 * - `store-failed`: the database refused or failed the write (twice, on a lane that kept moving).
 */
export const CAPTURE_REFUSALS = ['no-tab', 'not-active', 'no-audit', 'busy', 'no-project', 'extract-failed', 'invalid-page', 'store-failed'] as const;
export type CaptureRefusal = (typeof CAPTURE_REFUSALS)[number];

/** How the Changes panel explains a refusal (frost's own wording). */
export const CAPTURE_REFUSAL_MESSAGES: Readonly<Record<CaptureRefusal, string>> = {
  'no-tab': 'That tab is no longer open.',
  'not-active': 'Only the tab in front can be captured.',
  'no-audit': 'Wait for the audit of this page to finish, then capture it.',
  busy: 'This page is already being captured.',
  'no-project': 'That project no longer exists.',
  'extract-failed': 'The page could not be read. Reload it and try again.',
  'invalid-page': 'This page could not be turned into a capture.',
  'store-failed': 'The capture could not be saved.',
};

/** The refusal a capture answers while another capture of the same tab runs. */
export const CAPTURE_BUSY: CaptureRefusal = 'busy';

/**
 * How many times a capture appends after its lane moved under it (`stale`: another capture made a
 * new version between its head read and its write). It reads the head again and retries once.
 */
export const CAPTURE_STALE_RETRIES = 1;

/**
 * The region extraction's own bounds, beside `CAPTURE_LIMITS`. `maxScanChars` caps the characters
 * the text walk reads from text nodes (a node is read only as far as the budget reaches), so one
 * huge text node cannot cost more than the budget; past it the walk stops and the capture is
 * `partial`. `maxMainScan` caps the elements looked at when deciding whether the page has a main
 * landmark. `maxLinkScan` caps the links counted for the totals (internal, external, nofollow).
 */
export const REGION_EXTRACT_LIMITS = {
  maxScanChars: 2_000_000,
  maxMainScan: 256,
  maxLinkScan: 100_000,
} as const;

/**
 * The elements a text block is the text of (`changes-capture.feature.md`, Text blocks): a text
 * node belongs to its nearest ancestor among these (or the body). `br` and `hr` end a block.
 */
export const CAPTURE_BLOCK_ELEMENTS = [
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul',
] as const;

// ---- Which audit findings a capture keeps -----------------------------------------------------

/**
 * Rule categories whose checks read only the page itself: the extracted snapshot, the recorded
 * response and robots.txt. A capture keeps their failing rules.
 */
export const CAPTURE_PAGE_CATEGORIES = [
  'title', 'meta-description', 'headings', 'canonical', 'indexing', 'indexability', 'hreflang', 'language', 'mobile', 'content', 'images', 'links', 'url', 'social', 'schema', 'security',
] as const satisfies readonly SeoCategory[];

/**
 * Rule categories whose checks read what varies between two loads of an unchanged page: the speed
 * measurement (`performance`), the accessibility check's run, and the served HTML fetched beside the
 * page (`javascript`). Together with `CAPTURE_PAGE_CATEGORIES` they are every `SEO_CATEGORIES` entry,
 * each once (`changes-capture.feature.md`, `every-rule-is-classified`).
 */
export const CAPTURE_CONTEXT_CATEGORIES = ['performance', 'accessibility', 'javascript'] as const satisfies readonly SeoCategory[];

/** Rules of a context category that still read only the page (the snapshot's render-blocking `<head>` scripts). */
export const CAPTURE_PAGE_RULES_IN_CONTEXT_CATEGORIES = ['render-blocking-scripts'] as const satisfies readonly SeoRuleId[];

/**
 * The rules a capture leaves out of `audit.findings` (and out of its score): every rule of a context
 * category but the page ones, and every rule of the link, sitemap and hreflang checks
 * (`CHECKS_RULE_SPECS`: they read what those checks fetched, whenever they last ran). Derived from
 * the catalog, so a new rule is classified by its category.
 */
export const CAPTURE_EXCLUDED_RULES: readonly SeoRuleId[] = SEO_RULE_SPECS.filter(
  (rule) =>
    ((CAPTURE_CONTEXT_CATEGORIES as readonly SeoCategory[]).includes(rule.category) && !(CAPTURE_PAGE_RULES_IN_CONTEXT_CATEGORIES as readonly string[]).includes(rule.id)) ||
    CHECKS_RULE_SPECS.some((check) => check.id === rule.id),
).map((rule) => rule.id);

/** Whether a capture keeps rule `id`'s finding (`CAPTURE_EXCLUDED_RULES`). */
export const isCapturedRule = (id: string): boolean => !(CAPTURE_EXCLUDED_RULES as readonly string[]).includes(id);

// ---- Inputs ------------------------------------------------------------------------------------

/** `changes.capture`: the tab (it must be the active one) and the project (default Unfiled). */
export interface CaptureInput {
  tabId: number;
  projectId?: string;
}

/** Where a newest-first page of history continues: after this version. */
export interface HistoryCursor {
  createdAt: number;
  id: string;
}

/** `changes.history`: a page's versions (one project's when given), newest first. */
export interface HistoryInput {
  url: string;
  projectId?: string;
  cursor?: HistoryCursor;
  limit?: number;
}

/** `changes.version`: one version's snapshot. */
export interface VersionInput {
  versionId: string;
}

/** `changes.diff`: the diff between two versions of one lane (older first). */
export interface DiffInput {
  fromVersionId: string;
  toVersionId: string;
}

/** `changes.pages`: captured pages (one project's when given), most recently captured first. */
export interface PagesInput {
  projectId?: string;
  limit?: number;
}

// ---- Answers -----------------------------------------------------------------------------------

/**
 * A capture: stored (`newVersion` when the page changed since its lane's latest version;
 * `changeCount` the changes against that version, `null` for a lane's first version), or refused.
 */
export type CaptureAnswer =
  | { status: 'captured'; captureId: string; versionId: string; newVersion: boolean; changeCount: number | null }
  | { status: 'refused'; reason: CaptureRefusal };

/** Counts of changes per diff region (`SnapshotDiff.summary`). */
export type DiffSummary = Record<DiffRegion, ChangeCounts>;

/**
 * One version in a page's history. `renderProfile` and `searchParams` (Phase 3's, `null` for a page
 * that is not a result page) say which lane it is in (`laneKey`); `summary` and `changeCount` are its stored diff against `parentVersionId` (`null`
 * for a first version, or when that diff is gone or unreadable).
 */
export interface HistoryVersion {
  versionId: string;
  createdAt: number;
  captureCount: number;
  lastCapturedAt: number | null;
  laneKey: string;
  renderProfile: RenderProfile | null;
  searchParams: SearchParams | null;
  parentVersionId: string | null;
  summary: DiffSummary | null;
  changeCount: number | null;
}

export interface HistoryAnswer {
  versions: HistoryVersion[];
  next: HistoryCursor | null;
}

/** A version's snapshot, or `null` (no such version, or its row does not read back). */
export type VersionAnswer = CaptureSnapshot | null;

/** The diff of two versions of one lane, or `null` (either is missing or unreadable, or they are in different lanes). */
export type DiffAnswer = SnapshotDiff | null;

export interface CapturedPageAnswer {
  url: string;
  captureCount: number;
  lastCapturedAt: number;
}

export interface PagesAnswer {
  pages: CapturedPageAnswer[];
}

// ---- The region extraction's answer ------------------------------------------------------------

/**
 * One region's text as the extraction answers it: `text` is H of the `textHash` rule
 * (`CaptureRegionText`), which main hashes; when `truncated` is false it is `blocks.join('\n')`.
 */
export interface RegionTextAnswer {
  words: number;
  blocks: string[];
  truncated: boolean;
  text: string;
}

/** What the region extraction answers (validated in main with `RegionAnswerSchema`). */
export interface RegionAnswer {
  /** `document.URL` when it ran, so main can tell the page moved on. */
  url: string;
  partial: boolean;
  headings: { level: number; text: string; region: PageRegion }[];
  links: { total: number; internal: number; external: number; nofollow: number; list: { href: string; text: string; rel: string; region: PageRegion }[] };
  regions: Record<PageRegion, RegionTextAnswer>;
}
