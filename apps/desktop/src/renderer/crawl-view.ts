import { LEGAL_GATE_NOTE } from '@app/specs/data-sources.spec';
import { SEO_CATEGORY_LABELS, SEO_RULE_SPECS, type SeoCategory } from '@app/specs/seo-rules.spec';
// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { CrawlCsvAnswer, CrawlPageFilter, CrawlPageListRow, CrawlRunView, CrawlStartInput, CrawlStatusView, CrawlTreeNode, CrawlWatchView } from '@app/specs/site-crawl.schema';
import {
  CRAWL_EXCLUDED_CATEGORIES,
  CRAWL_EXCLUDED_RULES,
  CRAWL_INTERVAL_MS,
  CRAWL_LIMITS,
  CRAWL_PAGE_FLAGS,
  CRAWL_PAGES_LIMITS,
  CRAWL_REFUSAL_TEXT,
  CRAWL_REFRESH_MS,
  CRAWL_RULE_IDS,
  CRAWL_SCORE_LABEL,
  CRAWL_SLOW_DOWN_MESSAGE,
  crawlPageFlags,
  type CrawlPageSort,
  type CrawlRobotsVerdict,
  type CrawlRunReason,
  type CrawlRunState,
  type CrawlScope,
  type CrawlServiceAnswer,
  type CrawlSortDirection,
} from '@app/specs/site-crawl.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// The site crawl sheet's view model (Phase 12 Task 7; spec `site-crawl.spec.ts`; acceptance
// `site-crawl.feature.md`, Pages and Site structure: The crawl sheet, Pages, Site structure). Pure: the
// sheet (`components/crawl/*`) renders what this answers and sends what it builds. Whether a crawl may
// start comes from main's view (`available`), never from `CRAWL_AVAILABLE`: while it is `false`, Start and
// Resume are disabled with `LEGAL_GATE_NOTE`. Viewing, exporting and deleting runs never are. The score is
// `CRAWL_SCORE_LABEL`, never the sidebar's health score, and the sheet names the crawl's rule set.

// ---- The start form -----------------------------------------------------------------------------

/** The start form as typed (prefixes one per line, max pages as text). */
export interface CrawlForm {
  readonly startUrl: string;
  readonly scope: CrawlScope;
  readonly include: string;
  readonly exclude: string;
  readonly maxPages: string;
  readonly intervalMs: number;
  readonly sitemaps: boolean;
}

/** The intervals the form offers (ms), within `CRAWL_INTERVAL_MS`. */
export const CRAWL_INTERVAL_CHOICES: readonly number[] = [500, 1_000, 2_000, 4_000].filter((ms) => ms >= CRAWL_INTERVAL_MS.min && ms <= CRAWL_INTERVAL_MS.max);

export const CRAWL_SCOPE_LABELS: Readonly<Record<CrawlScope, string>> = {
  host: 'This host',
  site: 'The whole domain',
  path: 'This folder',
};

/** The site of a page: its origin's root (`https://example.com/`), or `null` for anything but an `http(s)` page. */
export function crawlSiteOf(url: string | undefined | null): string | null {
  const parsed = parseWebUrl(url);
  return parsed === null ? null : `${parsed.origin}/`;
}

/**
 * The form's first values: the start URL is the active tab's site (or `startUrl` when the sheet was asked
 * for one), the scope `host` unless asked (a project covering its subdomains asks for `site`).
 */
export function crawlFormFor(startUrl: string | undefined | null, scope: CrawlScope = 'host'): CrawlForm {
  return { startUrl: crawlSiteOf(startUrl) ?? '', scope, include: '', exclude: '', maxPages: String(CRAWL_LIMITS.defaultMaxPages), intervalMs: CRAWL_INTERVAL_MS.default, sitemaps: true };
}

const PREFIX_FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f]/;

/** One prefix per line, trimmed, blank lines dropped; `null` when one is not a literal path prefix or there are too many. */
function prefixesOf(text: string): string[] | null {
  const prefixes = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (prefixes.length > CRAWL_LIMITS.maxPrefixes) return null;
  return prefixes.every((prefix) => prefix.startsWith('/') && prefix.length <= CRAWL_LIMITS.maxPrefixChars && !PREFIX_FORBIDDEN.test(prefix)) ? prefixes : null;
}

/**
 * The form as main's `crawl.start` input, or what is wrong with it (frost's own words). Main checks it
 * again with `CrawlSettingsSchema` (a private start's scope, too).
 */
export function crawlStartInput(form: CrawlForm, projectId: string | null): { readonly ok: true; readonly input: CrawlStartInput } | { readonly ok: false; readonly problem: string } {
  const start = parseWebUrl(form.startUrl.trim());
  if (start === null || start.username !== '' || start.password !== '' || form.startUrl.trim().length > CRAWL_LIMITS.maxUrlChars) return { ok: false, problem: 'Type an http or https address to start from.' };
  const include = prefixesOf(form.include);
  const exclude = prefixesOf(form.exclude);
  if (include === null || exclude === null) return { ok: false, problem: `Prefixes are paths starting with /, one per line, at most ${CRAWL_LIMITS.maxPrefixes}.` };
  const maxPages = /^\d+$/.test(form.maxPages.trim()) ? Number(form.maxPages.trim()) : Number.NaN;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > CRAWL_LIMITS.maxPagesCap) return { ok: false, problem: `Max pages is a number from 1 to ${CRAWL_LIMITS.maxPagesCap}.` };
  const intervalMs = Math.min(CRAWL_INTERVAL_MS.max, Math.max(CRAWL_INTERVAL_MS.min, Math.round(form.intervalMs)));
  return { ok: true, input: { settings: { startUrl: form.startUrl.trim(), scope: form.scope, include, exclude, maxPages, intervalMs, sitemaps: form.sitemaps }, projectId } };
}

/** The Start button: disabled while main's view is not here yet, while the L6 gate is closed (with its note), or while a crawl runs. */
export function startControl(view: CrawlStatusView | null): { readonly disabled: boolean; readonly note: string | null } {
  if (view === null) return { disabled: true, note: null };
  if (!view.available) return { disabled: true, note: LEGAL_GATE_NOTE };
  if (view.activeRunId !== null) return { disabled: true, note: CRAWL_REFUSAL_TEXT.busy };
  return { disabled: false, note: null };
}

// ---- Runs ---------------------------------------------------------------------------------------

export const CRAWL_RUN_STATE_LABELS: Readonly<Record<CrawlRunState, string>> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

const REASON_TEXT: Readonly<Partial<Record<CrawlRunReason, string>>> = {
  quit: 'frost quit while it ran',
  interrupted: 'frost closed while it ran',
  'slow-down': CRAWL_SLOW_DOWN_MESSAGE,
  'max-pages': 'it reached its page limit',
  'project-deleted': 'its project was deleted',
  error: 'it could not go on',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Bytes as KB or MB, one decimal. */
function bytesText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** A run's size: the bytes its fetches read (its page count is already in the run's progress line). */
export function runSizeText(counts: CrawlRunView['counts']): string {
  return `${bytesText(counts.bytes)} fetched`;
}

/** One run as the sheet lists it: what it says and which controls it offers. */
export interface CrawlRunRow {
  readonly state: string;
  readonly progress: string;
  readonly size: string;
  readonly canPause: boolean;
  readonly canCancel: boolean;
  readonly canDelete: boolean;
  readonly canExport: boolean;
  /** Resume: offered for a paused run whose settings still parse; disabled with the gate's note while main says `available: false`, or while another crawl runs. */
  readonly resume: { readonly shown: boolean; readonly disabled: boolean; readonly note: string | null };
}

export function runRowOf(run: CrawlRunView, view: CrawlStatusView): CrawlRunRow {
  const running = view.activeRunId === run.id || run.state === 'running';
  const reason = run.reason === null || run.reason === 'user' ? undefined : REASON_TEXT[run.reason];
  const { pages, queued, refused, failed } = run.counts;
  const resumable = run.state === 'paused' && run.settings !== null && !running;
  const resume = !resumable
    ? { shown: false, disabled: true, note: null }
    : !view.available
      ? { shown: true, disabled: true, note: LEGAL_GATE_NOTE }
      : view.activeRunId !== null
        ? { shown: true, disabled: true, note: CRAWL_REFUSAL_TEXT.busy }
        : { shown: true, disabled: false, note: null };
  return {
    state: reason === undefined ? CRAWL_RUN_STATE_LABELS[run.state] : `${CRAWL_RUN_STATE_LABELS[run.state]}: ${reason}`,
    progress: `${plural(pages, 'page')} recorded · ${queued} queued · ${refused} refused · ${failed} failed`,
    size: runSizeText(run.counts),
    canPause: running,
    canCancel: running || run.state === 'paused' || run.state === 'queued',
    canDelete: true,
    canExport: true,
    resume,
  };
}

/** What main's answer to a run action says (`null`: nothing to say). `unavailable` is the gate's note as main sent it. */
export function answerText(answer: CrawlServiceAnswer | null): string | null {
  if (answer === null) return CRAWL_REFUSAL_TEXT['store-failed'];
  if (answer.status !== 'refused') return null;
  if (answer.reason === 'unavailable') return answer.note ?? LEGAL_GATE_NOTE;
  return CRAWL_REFUSAL_TEXT[answer.reason];
}

// ---- The sheet's status line ----------------------------------------------------------------------

/**
 * A line the sheet says (its `crawl-status`) and, when it is about one run, the states it holds through:
 * once main's view shows that run in any other state the line is stale and clears (so "Crawl started."
 * never sits above a run that is Done). `run: null`: it holds until the next line replaces it.
 */
export interface CrawlSaid {
  readonly text: string;
  readonly run: { readonly id: string; readonly holds: readonly CrawlRunState[] } | null;
}

export const CRAWL_STARTED_TEXT = 'Crawl started.';

/** What the sheet says for Start's answer: "Crawl started." holds while the run is queued or running. */
export function startSaid(answer: CrawlServiceAnswer | null): CrawlSaid | null {
  if (answer?.status === 'started') return { text: CRAWL_STARTED_TEXT, run: { id: answer.runId, holds: ['queued', 'running'] } };
  return saidOf(answerText(answer), null);
}

/** What the sheet says for a run action's answer (pause, resume, cancel, delete): it holds while the run stays in `run.state`. */
export function runActionSaid(answer: CrawlServiceAnswer | null, run: Pick<CrawlRunView, 'id' | 'state'>): CrawlSaid | null {
  return saidOf(answerText(answer), { id: run.id, holds: [run.state] });
}

/** A line not about a run (`run: null`), or about one; `null` text says nothing. */
export function saidOf(text: string | null, run: CrawlSaid['run']): CrawlSaid | null {
  return text === null ? null : { text, run };
}

/** Whether `said` still holds in main's view: one about a run clears once the view shows that run outside `holds`. */
export function crawlSaidHolds(said: CrawlSaid, view: CrawlStatusView | null): boolean {
  if (said.run === null || view === null) return true;
  const { id, holds } = said.run;
  const run = view.runs.find((entry) => entry.id === id);
  // Not in the view (yet, or any more): nothing has moved on that the line could contradict.
  return run === undefined || holds.includes(run.state);
}

/** What the CSV export's answer says. */
export function csvAnswerText(answer: CrawlCsvAnswer | null): string | null {
  if (answer === null) return CRAWL_REFUSAL_TEXT['write-failed'];
  if (answer.status === 'saved') return `Saved ${plural(answer.rows, 'page')} as CSV.`;
  if (answer.status === 'cancelled') return null;
  return CRAWL_REFUSAL_TEXT[answer.reason];
}

// ---- The rule-set note --------------------------------------------------------------------------

const RULE_TITLES: ReadonlyMap<string, string> = new Map(SEO_RULE_SPECS.map((rule) => [rule.id, rule.title] as const));
const RULE_CATEGORIES: ReadonlyMap<string, SeoCategory> = new Map(SEO_RULE_SPECS.map((rule) => [rule.id, rule.category] as const));

/**
 * The sheet's note on the crawl's rule set (Decision 6): the categories `CRAWL_RULE_IDS` come from, in
 * catalogue order, and what is left out and why (whole categories, then single rules by title).
 */
export function crawlRuleSetNote(): { readonly categories: string[]; readonly excluded: { readonly label: string; readonly reason: string }[] } {
  const used = new Set(CRAWL_RULE_IDS.map((id) => RULE_CATEGORIES.get(id)).filter((category): category is SeoCategory => category !== undefined));
  const categories = (Object.keys(SEO_CATEGORY_LABELS) as SeoCategory[]).filter((category) => used.has(category)).map((category) => SEO_CATEGORY_LABELS[category]);
  const excluded = [
    ...Object.entries(CRAWL_EXCLUDED_CATEGORIES).map(([category, reason]) => ({ label: SEO_CATEGORY_LABELS[category as SeoCategory], reason })),
    ...Object.entries(CRAWL_EXCLUDED_RULES).map(([id, reason]) => ({ label: RULE_TITLES.get(id) ?? id, reason })),
  ];
  return { categories, excluded };
}

// ---- Pages --------------------------------------------------------------------------------------

/** The Pages table's columns; the score column is `CRAWL_SCORE_LABEL`. */
export const CRAWL_PAGE_COLUMNS = [
  { id: 'url', label: 'URL' },
  { id: 'status', label: 'Status' },
  { id: 'indexable', label: 'Indexable' },
  { id: 'depth', label: 'Depth' },
  { id: 'inlinks', label: 'In-links' },
  { id: 'words', label: 'Words' },
  { id: 'robots', label: 'robots.txt' },
  { id: 'score', label: CRAWL_SCORE_LABEL },
  { id: 'findings', label: 'Findings' },
  { id: 'notes', label: 'Notes' },
] as const;

/** What the Pages view asks main for. */
export interface CrawlPagesQuery {
  readonly filter: CrawlPageFilter;
  readonly sort: CrawlPageSort;
  readonly direction: CrawlSortDirection;
  readonly offset: number;
  readonly limit: number;
}

export const DEFAULT_PAGES_QUERY: CrawlPagesQuery = Object.freeze({ filter: {}, sort: 'order', direction: 'asc', offset: 0, limit: CRAWL_PAGES_LIMITS.defaultPageSize });

/** A filter change (a value `undefined` drops that filter), a sort change or a page move; a filter or sort change goes back to the first page. */
export function pagesQueryWith(
  query: CrawlPagesQuery,
  change: { readonly filter?: { readonly [K in keyof CrawlPageFilter]?: CrawlPageFilter[K] | undefined }; readonly sort?: CrawlPageSort; readonly direction?: CrawlSortDirection; readonly offset?: number },
): CrawlPagesQuery {
  if (change.filter === undefined && change.sort === undefined && change.direction === undefined) return { ...query, offset: Math.max(0, change.offset ?? query.offset) };
  const merged: Record<string, unknown> = { ...query.filter, ...change.filter };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return { ...query, filter: merged as CrawlPageFilter, sort: change.sort ?? query.sort, direction: change.direction ?? query.direction, offset: 0 };
}

/** The table's place in the filtered pages, and the offsets of the pages before and after (`null`: none). */
export function pagingOf(query: CrawlPagesQuery, total: number): { readonly text: string; readonly prev: number | null; readonly next: number | null } {
  if (total <= 0) return { text: 'No pages', prev: null, next: null };
  const first = Math.min(query.offset, total - 1);
  const last = Math.min(first + query.limit, total);
  return { text: `${first + 1}–${last} of ${total}`, prev: first > 0 ? Math.max(0, first - query.limit) : null, next: last < total ? last : null };
}

/** The marks a page row shows (`CRAWL_PAGE_FLAGS`). */
export function pageFlagsText(row: CrawlPageListRow): string[] {
  return crawlPageFlags(row).map((flag) => CRAWL_PAGE_FLAGS[flag]);
}

const VERDICT_TEXT: Readonly<Record<CrawlRobotsVerdict, string>> = { allowed: 'allowed', blocked: 'blocked', unknown: 'unknown' };

/**
 * The robots.txt cell (Decision 6): the crawl's own verdict (`frost-crawl`) and Googlebot's, both from the
 * same robots.txt (nothing was fetched as Googlebot).
 */
export function robotsText(row: Pick<CrawlPageListRow, 'robotsCrawl' | 'robotsGooglebot'>): string {
  return `frost-crawl: ${VERDICT_TEXT[row.robotsCrawl]} · Googlebot: ${VERDICT_TEXT[row.robotsGooglebot]}`;
}

/** A finding's title for the Findings cell. */
export const findingTitle = (id: string): string => RULE_TITLES.get(id) ?? id;

/** The page "Open in tab" opens: the crawled URL, when it is an `http(s)` page (`null`: none). */
export function openTargetOf(row: Pick<CrawlPageListRow, 'url'>): string | null {
  return parseWebUrl(row.url) === null ? null : row.url;
}

/**
 * "Open in tab": the sheet closes, then the URL goes the address bar's path (`browser.navigate`, with its
 * browse guards) into the active tab. Anything but an `http(s)` URL opens nothing (`false`).
 */
export async function openInTab(url: string, deps: { readonly close: () => void; readonly navigate: (url: string) => Promise<boolean> }): Promise<boolean> {
  if (parseWebUrl(url) === null) return false;
  deps.close();
  return deps.navigate(url);
}

// ---- Site structure -----------------------------------------------------------------------------

/** The click-depth histogram's bars, each as a share of the tallest (0–100). */
export function depthBars(depths: readonly { readonly depth: number; readonly pages: number }[]): { depth: number; pages: number; percent: number }[] {
  const tallest = Math.max(0, ...depths.map((bar) => bar.pages));
  return depths.map(({ depth, pages }) => ({ depth, pages, percent: tallest === 0 ? 0 : Math.round((pages / tallest) * 100) }));
}

/** A tree node's label: an origin as is, a folder with its `/`, a folder's own page as `/ (this folder)`. */
export function treeNodeLabel(node: CrawlTreeNode): string {
  if (node.label === '') return '/ (this folder)';
  if (node.prefix !== null && node.label.includes('://')) return node.label;
  return node.prefix !== null ? `${node.label}/` : node.label;
}

// ---- Refreshing the run's views -----------------------------------------------------------------

/** What the Pages and Site structure views were last read for. */
export interface CrawlRefreshMark {
  readonly runId: string;
  readonly state: CrawlRunState;
  readonly pages: number;
  readonly at: number;
}

/**
 * When the run's views read again (`CRAWL_REFRESH_MS`): at once for another run or another state; for
 * new pages, not sooner than `intervalMs` after the last read (answered as the wait left, in ms); never
 * when nothing changed (`null`).
 */
export function refreshDelay(last: CrawlRefreshMark | null, next: Omit<CrawlRefreshMark, 'at'>, now: number, intervalMs: number = CRAWL_REFRESH_MS): number | null {
  if (last === null || last.runId !== next.runId || last.state !== next.state) return 0;
  if (last.pages === next.pages) return null;
  return Math.max(0, last.at + intervalMs - now);
}

// ---- Progress: `crawl.watch` --------------------------------------------------------------------

/**
 * The sheet's long-poll: asks main for the view newer than the last version seen, hands each answer to
 * `onView`, and rests `retryMs` before asking again after a failed poll or an answer with an unchanged
 * version (a timeout, or main answering an evicted poll), so it never spins; until `isLive()` is false
 * (the sheet closed: the poll in flight is abandoned, its answer dropped).
 */
export async function runCrawlWatch(deps: {
  readonly watch: (sinceVersion: number) => Promise<CrawlWatchView>;
  readonly onView: (view: CrawlWatchView) => void;
  readonly isLive: () => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly retryMs: number;
}): Promise<void> {
  let since = 0;
  while (deps.isLive()) {
    try {
      const next = await deps.watch(since);
      if (!deps.isLive()) return;
      if (next.version === since) {
        await deps.sleep(deps.retryMs);
        continue;
      }
      deps.onView(next);
      since = next.version;
    } catch {
      await deps.sleep(deps.retryMs);
    }
  }
}
