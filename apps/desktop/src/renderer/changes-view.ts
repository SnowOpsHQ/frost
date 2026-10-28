import { searchEngine } from '@app/specs/browser-polish.spec';
import { DIFF_REGIONS, DIFF_REGION_LABELS, type Change, type ChangeCounts, type ChangeKind, type DiffField, type DiffRegion, type SnapshotDiff } from '@app/specs/capture.spec';
// Type-only: the schema file holds Zod, which must stay out of the chrome's bundle (strict Trusted Types).
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { CAPTURE_REFUSAL_MESSAGES, type CaptureAnswer, type CaptureInput, type DiffSummary, type HistoryVersion } from '@app/specs/changes.spec';
import { QUICK_RENDER_PROFILES, isDefaultRenderProfile, renderProfileSummary, sameRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';

// The Changes panel's pure helpers (acceptance `changes-panel.feature.md`): lanes and their labels,
// version summaries, the diff grouped by region, and the capture outcome's wording. No React, no IPC.

/** Versions read per `changes.history` page (and per "Load more"). */
export const HISTORY_PAGE_SIZE = 20;

/** How a change's kind is written (shown beside its colour, never colour alone). */
export const CHANGE_KIND_LABELS: Readonly<Record<ChangeKind, string>> = { added: 'Added', removed: 'Removed', changed: 'Changed' };

const count = (n: number) => n.toLocaleString('en-US');

/** "1 capture", "3 captures". */
export function captureCountText(n: number): string {
  return `${count(n)} ${n === 1 ? 'capture' : 'captures'}`;
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
  text: 'After',
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
