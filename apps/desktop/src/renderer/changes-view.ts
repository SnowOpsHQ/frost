import type { SeoAuditResponse } from '@app/seo-core';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import { searchEngine } from '@app/specs/browser-polish.spec';
import { DIFF_REGIONS, DIFF_REGION_LABELS, type Change, type ChangeCounts, type ChangeKind, type DiffField, type DiffRegion, type SnapshotDiff } from '@app/specs/capture.spec';
// Type-only: the schema file holds Zod, which must stay out of the chrome's bundle (strict Trusted Types).
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { MAX_HISTORY_PAGE, type ScreenshotKind } from '@app/specs/capture-db.spec';
import { CAPTURE_REFUSAL_MESSAGES, type CaptureAnswer, type CaptureInput, type DiffSummary, type HistoryVersion } from '@app/specs/changes.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { QUICK_RENDER_PROFILES, isDefaultRenderProfile, renderProfileSummary, sameRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import { SCREENSHOT_KIND_LABELS, SCREENSHOT_REFUSAL_MESSAGES, type ScreenshotEntry, type TakeScreenshotAnswer, type TakeScreenshotInput } from '@app/specs/screenshot.spec';

// The Changes panel's pure helpers (acceptance `changes-panel.feature.md`): lanes and their labels,
// version summaries, the diff grouped by region, and the capture outcome's wording; and the
// screenshots' (`screenshot.feature.md`): sizes, bytes, kinds and outcomes. No React, no IPC.

/** Versions read per `changes.history` page (and per "Load more"). */
export const HISTORY_PAGE_SIZE = 20;

/** How a change's kind is written (shown beside its colour, never colour alone). */
export const CHANGE_KIND_LABELS: Readonly<Record<ChangeKind, string>> = { added: 'Added', removed: 'Removed', changed: 'Changed' };

const count = (n: number) => n.toLocaleString('en-US');

/** "1 capture", "3 captures". */
export function captureCountText(n: number): string {
  return `${count(n)} ${n === 1 ? 'capture' : 'captures'}`;
}

/**
 * Whether Capture now is offered: the tab shows a web page that has finished loading, and its audit
 * is ready and settled (robots.txt no longer `pending`: that audit is provisional). Main's refusal
 * stays the authority (`changes-capture.feature.md`); this only keeps the button from promising a
 * capture main would refuse.
 */
export function canCapture(tab: Pick<TabState, 'url' | 'loading' | 'error' | 'crashed'> | undefined, response: SeoAuditResponse | null): boolean {
  if (!tab || !isWebUrl(tab.url) || tab.error !== null || tab.crashed || tab.loading) return false;
  return response?.status === 'ready' && response.audit.indexability.robots?.outcome !== 'pending';
}

/** The page a URL is the history of: the URL without its `#fragment` (main stores pages without one). */
export function pageUrlOf(url: string): string {
  const at = url.indexOf('#');
  return at < 0 ? url : url.slice(0, at);
}

/** A count badge: `n`, or `n+` while more versions are still to be read. */
export function countBadge(n: number, more: boolean): string {
  return `${count(n)}${more ? '+' : ''}`;
}

/** The capture procedure's input: the tab, and the project when one is chosen (Task 6's picker; Unfiled otherwise). */
export function captureInput(tabId: number, projectId?: string): CaptureInput {
  return projectId === undefined ? { tabId } : { tabId, projectId };
}

/** What a capture's outcome says (`null`: the call itself failed). */
export function captureOutcomeText(answer: CaptureAnswer | null): string {
  if (answer === null) return CAPTURE_REFUSAL_MESSAGES['store-failed'];
  if (answer.status === 'refused') return CAPTURE_REFUSAL_MESSAGES[answer.reason];
  if (!answer.newVersion) return 'No change since the last capture.';
  if (answer.changeCount === null) return 'Captured the first version of this page.';
  return `Captured a new version: ${count(answer.changeCount)} ${answer.changeCount === 1 ? 'change' : 'changes'}.`;
}

/** The outcome's kind, for styling and tests: `first`, `new`, `same`, `refused` or `failed`. */
export function captureOutcomeKind(answer: CaptureAnswer | null): 'first' | 'new' | 'same' | 'refused' | 'failed' {
  if (answer === null) return 'failed';
  if (answer.status === 'refused') return 'refused';
  if (!answer.newVersion) return 'same';
  return answer.changeCount === null ? 'first' : 'new';
}

// ---- Lanes ---------------------------------------------------------------------------------------

/** A render profile in a few words: "Default", a quick profile's label, or its summary. */
export function profileLabel(profile: RenderProfile | null): string {
  if (profile === null || isDefaultRenderProfile(profile)) return 'Default';
  return QUICK_RENDER_PROFILES.find((quick) => sameRenderProfile(quick.profile, profile))?.label ?? renderProfileSummary(profile);
}

/** Search parameters in a few words (`null`: none). */
export function searchParamsLabel(params: SearchParams | null): string | null {
  if (params === null) return null;
  const parts = [`“${params.query}”`, searchEngine(params.engine).label];
  for (const value of [params.country, params.language, params.location, params.device]) if (value !== null) parts.push(value);
  return parts.join(' · ');
}

/** A lane's label: its profile, then its search parameters. */
export function laneLabel(version: Pick<HistoryVersion, 'renderProfile' | 'searchParams'>): string {
  const params = searchParamsLabel(version.searchParams);
  const profile = profileLabel(version.renderProfile);
  return params === null ? profile : `${profile} · ${params}`;
}

export interface Lane {
  readonly key: string;
  readonly label: string;
  /** Newest first. */
  readonly versions: readonly HistoryVersion[];
}

/** Versions (newest first) grouped by lane, lanes in the order of their newest version. */
export function groupByLane(versions: readonly HistoryVersion[]): Lane[] {
  const lanes = new Map<string, HistoryVersion[]>();
  for (const version of versions) {
    const lane = lanes.get(version.laneKey);
    if (lane) lane.push(version);
    else lanes.set(version.laneKey, [version]);
  }
  return [...lanes].map(([key, list]) => ({ key, label: laneLabel(list[0]!), versions: list }));
}

/** The lane to show: the chosen one while it is listed, else the newest version's (`null`: no versions). */
export function shownLane(lanes: readonly Lane[], chosen: string | null): Lane | null {
  return lanes.find((lane) => lane.key === chosen) ?? lanes[0] ?? null;
}

/** The lane's versions older than `versionId` (newest first; none if it is not in the lane). */
export function olderInLane(lane: Lane, versionId: string): HistoryVersion[] {
  const at = lane.versions.findIndex((version) => version.versionId === versionId);
  return at < 0 ? [] : lane.versions.slice(at + 1);
}

/** The version `versionId` is compared with: `chosen` while it is older in the lane, else the previous one (`null`: none listed). */
export function compareFrom(lane: Lane, versionId: string, chosen: string | null): HistoryVersion | null {
  const older = olderInLane(lane, versionId);
  return older.find((version) => version.versionId === chosen) ?? older[0] ?? null;
}

/**
 * What a history read must cover: at least `want` versions (as many as were listed before a capture,
 * so "Load more" is not undone) and the version `include` (the one just captured, so its lane stays
 * shown even when its head is past the first page), or the end of the history.
 */
export interface HistoryGoal {
  readonly want: number;
  readonly include: string | null;
}

/** The first read of a page's history. */
export const FIRST_HISTORY_GOAL: HistoryGoal = { want: HISTORY_PAGE_SIZE, include: null };

/** Pages one history read follows at most, whatever its goal. */
export const MAX_HISTORY_READS = 10;

/** The `limit` of the next page of a read that has `have` versions so far. */
export function historyReadLimit(have: number, goal: HistoryGoal): number {
  return Math.min(MAX_HISTORY_PAGE, Math.max(HISTORY_PAGE_SIZE, goal.want - have));
}

/** Whether a read that has `versions` (and `more` to follow) has met its goal. */
export function historyGoalMet(versions: readonly HistoryVersion[], more: boolean, goal: HistoryGoal): boolean {
  if (!more) return true;
  return versions.length >= goal.want && (goal.include === null || versions.some((version) => version.versionId === goal.include));
}

/** `existing` followed by the versions of `more` it does not list yet. */
export function mergeHistory(existing: readonly HistoryVersion[], more: readonly HistoryVersion[]): HistoryVersion[] {
  const seen = new Set(existing.map((version) => version.versionId));
  return [...existing, ...more.filter((version) => !seen.has(version.versionId))];
}

// ---- Summaries and the diff --------------------------------------------------------------------

/** All of one region's changes. */
export function regionCount(counts: ChangeCounts): number {
  return counts.added + counts.removed + counts.changed;
}

/** Each region with changes, in `DIFF_REGIONS` order (`Head 1 · Main content 2`); "No visible changes" when none. */
export function summaryText(summary: DiffSummary): string {
  const parts = DIFF_REGIONS.filter((region) => regionCount(summary[region]) > 0).map((region) => `${DIFF_REGION_LABELS[region]} ${count(regionCount(summary[region]))}`);
  return parts.length === 0 ? 'No visible changes' : parts.join(' · ');
}

/** A version's summary against its parent. */
export function versionSummaryText(version: Pick<HistoryVersion, 'parentVersionId' | 'summary'>): string {
  if (version.summary !== null) return summaryText(version.summary);
  return version.parentVersionId === null ? 'First capture' : 'Earlier versions removed';
}

export interface RegionGroup {
  readonly region: DiffRegion;
  readonly label: string;
  readonly changes: readonly Change[];
}

/** The changes grouped by region, in `DIFF_REGIONS` order (each region's in the diff's order); empty regions left out. */
export function groupChangesByRegion(changes: readonly Change[]): RegionGroup[] {
  return DIFF_REGIONS.map((region) => ({ region, label: DIFF_REGION_LABELS[region], changes: changes.filter((change) => change.region === region) })).filter((group) => group.changes.length > 0);
}

/** The regions the diff found no change in, in `DIFF_REGIONS` order. */
export function unchangedRegions(diff: Pick<SnapshotDiff, 'summary'>): DiffRegion[] {
  return DIFF_REGIONS.filter((region) => regionCount(diff.summary[region]) === 0);
}

/** What a change's `context` names (`changes-diff.feature.md`, How each part is compared). */
const CONTEXT_LABELS: Partial<Readonly<Record<DiffField, string>>> = {
  text: 'Follows',
  heading: 'Tag',
  link: 'URL',
  hreflang: 'Code',
  'structured-data-block': 'Types',
  'links-total': 'Counter',
  images: 'Counter',
};

/** The label of a change's context line. */
export function contextLabel(field: DiffField): string {
  return CONTEXT_LABELS[field] ?? 'Where';
}

// ---- Screenshots (Task 5, `screenshot.feature.md`, The Changes panel) ---------------------------

/** Screenshots read per `screenshots.list` page (and per "Load more"). */
export const SCREENSHOTS_PAGE_SIZE = 12;

/**
 * Whether the Screenshot buttons are offered: the tab shows a web page (loading or not; no error
 * panel, no crash). Main's refusal stays the authority (only the active tab, `screenshot.feature.md`).
 */
export function canScreenshot(tab: Pick<TabState, 'url' | 'error' | 'crashed'> | undefined): boolean {
  return !!tab && isWebUrl(tab.url) && tab.error === null && !tab.crashed;
}

/** The take procedure's input: the tab, the kind, and the project when one is chosen (Unfiled otherwise). */
export function screenshotInput(tabId: number, kind: ScreenshotKind, projectId?: string): TakeScreenshotInput {
  return projectId === undefined ? { tabId, kind } : { tabId, kind, projectId };
}

/** "1,280 × 800 px". */
export function pixelSizeText(width: number, height: number): string {
  return `${count(width)} × ${count(height)} px`;
}

/** A file's size: "512 B", "1.5 kB", "2.4 MB" (decimal units). */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${count(bytes)} B`;
  const [value, unit] = bytes < 1_000_000 ? [bytes / 1_000, 'kB'] : [bytes / 1_000_000, 'MB'];
  return `${(Math.round(value * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
}

/** A kind's name (`SCREENSHOT_KIND_LABELS`). */
export function screenshotKindLabel(kind: ScreenshotKind): string {
  return SCREENSHOT_KIND_LABELS[kind];
}

/** What a saved screenshot is of, in a sentence. */
const SAVED_WHAT: Readonly<Record<ScreenshotKind, string>> = {
  viewport: 'a screenshot of the viewport',
  full: 'a full-page screenshot',
  area: 'a screenshot of the selected area',
};

/** What a screenshot's outcome says (`null`: the call itself failed). */
export function screenshotOutcomeText(answer: TakeScreenshotAnswer | null): string {
  if (answer === null) return SCREENSHOT_REFUSAL_MESSAGES['store-failed'];
  if (answer.status === 'refused') return SCREENSHOT_REFUSAL_MESSAGES[answer.reason];
  const saved = `Saved ${SAVED_WHAT[answer.kind]} (${pixelSizeText(answer.width, answer.height)}).`;
  return answer.truncated ? `${saved} The page is taller than a screenshot keeps, so it was cut at the bottom.` : saved;
}

/** The outcome's kind, for styling and tests: `saved`, `cancelled`, `refused` or `failed`. */
export function screenshotOutcomeKind(answer: TakeScreenshotAnswer | null): 'saved' | 'cancelled' | 'refused' | 'failed' {
  if (answer === null) return 'failed';
  if (answer.status === 'saved') return 'saved';
  return answer.reason === 'cancelled' ? 'cancelled' : 'refused';
}

/** A screenshot image's alt text: "Full page screenshot, 800 × 2,000 px". */
export function screenshotAlt(entry: Pick<ScreenshotEntry, 'kind' | 'width' | 'height'>): string {
  return `${screenshotKindLabel(entry.kind)} screenshot, ${pixelSizeText(entry.width, entry.height)}`;
}
