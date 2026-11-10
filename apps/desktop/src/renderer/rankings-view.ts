import type { RetentionMode } from '@app/specs/capture-db.spec';
import { DATA_CHECK_TEXT, DATA_PROVIDER_LABELS } from '@app/specs/data-sources.spec';
import {
  COMPARE_MOVEMENT_LABELS,
  DEFAULT_RANK_RANGE,
  RANKINGS_REFUSAL_MESSAGES,
  RANK_HISTORY_NOTE,
  RANK_RANGES,
  RANK_RANGE_LABELS,
  RANK_VIEW_TEXT,
  changeLabel,
  rankHistoryNote,
  rankLabel,
  type CompareMovement,
  type RankOutcome,
  type RankPoint,
  type RankRange,
  type RankRow,
  type RankTableRow,
  type RankingsRefusal,
  type ReadingDate,
  type SaveCsvAnswer,
  type SearchParamsShape,
  type SerpComparison,
  type SerpComparisonSide,
  type SerpFeatureType,
} from '@app/specs/rankings.spec';
import { SERP_RESULT_TYPE_LABELS, type SerpResultType } from '@app/specs/serp-selector-pack.spec';
import { SERP_DEVICE_LABELS, type SerpDevice } from '@app/specs/serp.spec';
import { isWebUrl } from '@app/specs/web-url.spec';

// The Rankings and Compare views' pure view model (Phase 10 Task 6; acceptance `rankings.feature.md`,
// The views). Rows, trend geometry, filters, notes, the series, export outcomes and the comparison
// as the components show them. No React, no IPC. Every reading's text (queries, URLs, domains) is
// passed through as data for React to render as text; the trend's SVG `points` are built from
// numbers only.

// ---- Small helpers ------------------------------------------------------------------------------

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;
/** Keeps the items of a list that are objects (a list from main is checked, but the views never throw). */
const present = <T,>(value: T): value is NonNullable<T> => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const featureLabel = (type: unknown): string => (typeof type === 'string' && Object.hasOwn(SERP_RESULT_TYPE_LABELS, type) ? SERP_RESULT_TYPE_LABELS[type as SerpResultType] : text(type));

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const WHEN_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const WHEN_TIME = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** The "no readings yet" notice: names Check rankings only when it is offered (`shown`: `rankCheckShown()`, L1), else Capture now. */
export const noReadingsText = (shown: boolean): string => (shown ? RANK_VIEW_TEXT.noReadings : RANK_VIEW_TEXT.noReadingsWithoutRankCheck);

/** A reading's time as the views show it (`—` for a time that is not a date). */
export function formatWhen(at: number): string {
  return typeof at === 'number' && Number.isFinite(at) && !Number.isNaN(new Date(at).getTime()) ? WHEN.format(at) : RANK_VIEW_TEXT.none;
}

/** A reading's time on two lines, the date then the time (the rank table's narrow column); `—` alone for a time that is not a date. */
function whenLines(at: number): readonly string[] {
  return typeof at === 'number' && Number.isFinite(at) && !Number.isNaN(new Date(at).getTime()) ? [WHEN_DATE.format(at), WHEN_TIME.format(at)] : [RANK_VIEW_TEXT.none];
}

/** "Also in Featured snippet, AI overview" for a point's `alsoIn` (empty with none). */
function alsoInText(alsoIn: unknown): string {
  if (!Array.isArray(alsoIn) || alsoIn.length === 0) return '';
  return `${RANK_VIEW_TEXT.alsoIn} ${alsoIn.map(featureLabel).filter((label) => label !== '').join(', ')}`;
}

/** The search's canonical result page URL when it may be opened (`http(s)` only); else `null`. */
export function resultPageUrl(params: Pick<SearchParamsShape, 'url'> | null | undefined): string | null {
  const url = isObject(params) ? params.url : undefined;
  return typeof url === 'string' && isWebUrl(url) ? url : null;
}

/** "DE · en", "DE", "en", or `—` with neither. */
function localeText(params: SearchParamsShape): string {
  const parts = [typeof params.gl === 'string' ? params.gl.toUpperCase() : '', text(params.hl)].filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' · ') : RANK_VIEW_TEXT.none;
}

const deviceText = (device: unknown): string => (typeof device === 'string' && Object.hasOwn(SERP_DEVICE_LABELS, device) ? SERP_DEVICE_LABELS[device as SerpDevice] : text(device));

/** A search in a line, as the Projects sheet says a query (`“green tea” on Google (DE, en, desktop)`). */
export function searchSummary(params: SearchParamsShape): string {
  const settings = [typeof params.gl === 'string' ? params.gl.toUpperCase() : '', text(params.hl), deviceText(params.device).toLowerCase()].filter((part) => part !== '');
  return `“${text(params.query)}” on ${text(params.engineLabel)}${settings.length > 0 ? ` (${settings.join(', ')})` : ''}`;
}

// ---- The table ----------------------------------------------------------------------------------

/** How a row's change reads at a glance. */
export type ChangeDirection = 'up' | 'down' | 'same' | 'new' | 'lost' | 'none';

function directionOf(change: RankRow['change']): ChangeDirection {
  if (change === 'new' || change === 'lost') return change;
  if (typeof change !== 'number' || !Number.isFinite(change)) return 'none';
  return change > 0 ? 'up' : change < 0 ? 'down' : 'same';
}

/** One table row as the view shows it (columns `RANK_TABLE_COLUMNS`, then the competitors). */
export interface RankRowView {
  readonly key: string;
  readonly search: string;
  readonly engine: string;
  readonly locale: string;
  readonly device: string;
  readonly filters: string;
  readonly tags: readonly string[];
  readonly position: string;
  /** The latest point's outcome (`none`: no reading). */
  readonly outcome: RankOutcome | 'none';
  readonly change: string;
  readonly direction: ChangeDirection;
  readonly best: string;
  readonly lastChecked: string;
  /** `lastChecked` as the table shows it: the date, then the time (one line when never checked). */
  readonly lastCheckedLines: readonly string[];
  readonly competitors: readonly { readonly host: string; readonly position: string }[];
  readonly alsoIn: string;
  /** `RANK_VIEW_TEXT.capped` when main read only the newest of the range's readings; else `null`. */
  readonly capped: string | null;
  /** The canonical result page "Open this result page" loads (`null`: not `http(s)`). */
  readonly url: string | null;
  /** Where the latest point came from (`rankSourceLabel`; empty with no reading). */
  readonly source: string;
}

/**
 * Where a point came from, as the views say it (Phase 12 Task 4; `projects.feature.md`, Checking
 * searches via a data API): "Tab capture", or "<Vendor> API" for a SERP API reading ("Data API" when
 * the reading names no vendor frost knows). Empty for no point.
 */
export function rankSourceLabel(point: Pick<RankPoint, 'source' | 'provider'> | null): string {
  if (point === null) return '';
  if (point.source !== 'serp-api') return DATA_CHECK_TEXT.sourceCapture;
  const provider = point.provider;
  return provider !== undefined && Object.hasOwn(DATA_PROVIDER_LABELS, provider) ? DATA_CHECK_TEXT.sourceApi(DATA_PROVIDER_LABELS[provider]) : DATA_CHECK_TEXT.sourceApiUnknown;
}

/** A rank table row as the view shows it; `competitors` are the project's competitor domains, in its order. */
export function rankRowView(row: RankTableRow, competitors: readonly string[]): RankRowView {
  const { params, latest } = row;
  const filters = Object.entries(isObject(row.filters) ? row.filters : {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  return {
    key: row.searchKey,
    search: text(params.query),
    engine: text(params.engineLabel),
    locale: localeText(params),
    device: deviceText(params.device),
    filters,
    tags: row.saved?.tags ?? [],
    position: rankLabel(latest),
    outcome: latest?.outcome ?? 'none',
    change: changeLabel(row.change),
    direction: directionOf(row.change),
    best: typeof row.best === 'number' ? String(row.best) : RANK_VIEW_TEXT.none,
    lastChecked: latest ? formatWhen(latest.at) : RANK_VIEW_TEXT.noReading,
    lastCheckedLines: latest ? whenLines(latest.at) : [RANK_VIEW_TEXT.noReading],
    competitors: competitors.map((host) => {
      const point = isObject(row.competitors) ? row.competitors[host] : undefined;
      return { host, position: point ? rankLabel(point) : RANK_VIEW_TEXT.none };
    }),
    alsoIn: latest ? alsoInText(latest.alsoIn) : '',
    capped: row.capped === true ? RANK_VIEW_TEXT.capped : null,
    url: resultPageUrl(params),
    source: rankSourceLabel(latest),
  };
}

/** Which notices the table shows: no site set, and no reading in any row. */
export function emptyStates(answer: { readonly site: unknown; readonly rows: readonly Pick<RankRow, 'latest'>[] }): ('no-site' | 'no-readings')[] {
  const states: ('no-site' | 'no-readings')[] = [];
  if (answer.site === null) states.push('no-site');
  if (!answer.rows.some((row) => row.latest !== null)) states.push('no-readings');
  return states;
}

/** The history note (Decision 15): the horizon when the project keeps limited history, and whose view a position is, always. */
export function historyNote(retention: { readonly mode: RetentionMode; readonly value: number | null }): { readonly limited: boolean; readonly text: string } {
  const limited = retention.mode === 'versions' || retention.mode === 'days';
  return { limited, text: limited ? rankHistoryNote(retention) : RANK_HISTORY_NOTE.profile };
}

// ---- Filters ------------------------------------------------------------------------------------

/** The view's range and tag (`null`: all searches). */
export interface RankFilter {
  readonly range: RankRange;
  readonly tag: string | null;
}

/** The range filter's options. */
export function rangeOptions(): { readonly value: RankRange; readonly label: string }[] {
  return RANK_RANGES.map((range) => ({ value: range, label: RANK_RANGE_LABELS[range] }));
}

/** The tag filter's options: all searches, then the project's tags. */
export function tagOptions(tags: readonly string[]): { readonly value: string; readonly label: string }[] {
  return [{ value: '', label: RANK_VIEW_TEXT.allTags }, ...tags.map((tag) => ({ value: tag, label: tag }))];
}

/** `rankings.table`'s input: a known range (else the default) and the tag only while the project has it. */
export function rankTableInput(projectId: string, filter: RankFilter, knownTags: readonly string[]): { projectId: string; range: RankRange; tag?: string } {
  const range = (RANK_RANGES as readonly string[]).includes(filter.range) ? filter.range : DEFAULT_RANK_RANGE;
  const tag = filter.tag !== null && filter.tag !== '' && knownTags.includes(filter.tag) ? filter.tag : null;
  return tag === null ? { projectId, range } : { projectId, range, tag };
}

/** The rows shown for a tag (`null`: all): only saved searches carrying it. */
export function rowsForTag<T extends Pick<RankRow, 'saved'>>(rows: readonly T[], tag: string | null): T[] {
  return tag === null || tag === '' ? [...rows] : rows.filter((row) => row.saved !== null && row.saved.tags.includes(tag));
}

// ---- The trend ----------------------------------------------------------------------------------

/** The trend's box, in SVG user units. */
export const TREND_GEOMETRY = { width: 52, height: 22, pad: 3 } as const;

export interface TrendModel {
  readonly width: number;
  readonly height: number;
  /** No position to draw. */
  readonly empty: boolean;
  /** `points` of each run of two or more consecutive positions (`x,y x,y …`, numbers only). */
  readonly segments: readonly string[];
  /** Positions with no positioned neighbour. */
  readonly dots: readonly { readonly x: number; readonly y: number }[];
  /** The SVG's accessible name, from numbers only. */
  readonly label: string;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * The trend line of a series (oldest first): x by the point's index among all points (so a reading
 * without a position leaves a gap), y by its position, best at the top. Only `ranked` points with a
 * whole positive position count; nothing of a reading's text is read.
 */
export function trendPoints(points: readonly RankPoint[], geometry: { readonly width: number; readonly height: number; readonly pad: number } = TREND_GEOMETRY): TrendModel {
  const { width, height, pad } = geometry;
  const list = Array.isArray(points) ? points : [];
  const positions: (number | null)[] = list.map((point) => (isObject(point) && point.outcome === 'ranked' && typeof point.position === 'number' && Number.isInteger(point.position) && point.position >= 1 ? point.position : null));
  const ranked = positions.filter((position): position is number => position !== null);
  if (ranked.length === 0) return { width, height, empty: true, segments: [], dots: [], label: 'No positions in this range.' };
  const min = Math.min(...ranked);
  const max = Math.max(...ranked);
  const n = positions.length;
  const xOf = (index: number) => round(n === 1 ? width / 2 : pad + (index * (width - 2 * pad)) / (n - 1));
  const yOf = (position: number) => round(max === min ? height / 2 : pad + ((position - min) * (height - 2 * pad)) / (max - min));
  const segments: string[] = [];
  const dots: { x: number; y: number }[] = [];
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length === 1) dots.push(run[0]!);
    else if (run.length > 1) segments.push(run.map((at) => `${at.x},${at.y}`).join(' '));
    run = [];
  };
  positions.forEach((position, index) => {
    if (position === null) flush();
    else run.push({ x: xOf(index), y: yOf(position) });
  });
  flush();
  return { width, height, empty: false, segments, dots, label: `${ranked.length} ${ranked.length === 1 ? 'position' : 'positions'} over ${n} ${n === 1 ? 'reading' : 'readings'}; best ${min}, worst ${max}.` };
}

// ---- The series ---------------------------------------------------------------------------------

export interface SeriesRowView {
  readonly readingId: string;
  readonly when: string;
  readonly position: string;
  /** The site's result URL as text (`—` with none). */
  readonly url: string;
  readonly alsoIn: string;
  /** Where the point came from (`rankSourceLabel`). */
  readonly source: string;
}

/** A search's points as the series lists them: newest first, with date, position and URL. */
export function seriesRows(points: readonly RankPoint[]): SeriesRowView[] {
  return [...points]
    .filter(present)
    .reverse()
    .map((point) => ({ readingId: point.readingId, when: formatWhen(point.at), position: rankLabel(point), url: typeof point.url === 'string' && point.url !== '' ? point.url : RANK_VIEW_TEXT.none, alsoIn: alsoInText(point.alsoIn), source: rankSourceLabel(point) }));
}

// ---- Refusals and export ------------------------------------------------------------------------

/** A rankings answer's refusal in words; `null` when it answered. An IPC failure (`null`) reads as `store-failed`. */
export function rankingsRefusalText(answer: { readonly status: string; readonly reason?: unknown } | null): string | null {
  if (answer === null) return RANKINGS_REFUSAL_MESSAGES['store-failed'];
  if (answer.status !== 'refused') return null;
  const { reason } = answer;
  return typeof reason === 'string' && Object.hasOwn(RANKINGS_REFUSAL_MESSAGES, reason) ? RANKINGS_REFUSAL_MESSAGES[reason as RankingsRefusal] : RANKINGS_REFUSAL_MESSAGES['store-failed'];
}

/** What Copy CSV did. */
export function copyCsvText(rows: number | null): string {
  return typeof rows === 'number' ? RANK_VIEW_TEXT.copied.replace('{n}', String(rows)) : RANK_VIEW_TEXT.notCopied;
}

/** What Save CSV… did. */
export function saveCsvText(answer: SaveCsvAnswer | null): string {
  if (answer === null) return RANKINGS_REFUSAL_MESSAGES['store-failed'];
  if (answer.status === 'saved') return RANK_VIEW_TEXT.saved.replace('{n}', String(answer.rows));
  if (answer.status === 'cancelled') return RANK_VIEW_TEXT.saveCancelled;
  return rankingsRefusalText(answer) ?? RANKINGS_REFUSAL_MESSAGES['store-failed'];
}

// ---- Compare ------------------------------------------------------------------------------------

export interface CompareRowView {
  readonly domain: string;
  readonly a: string;
  readonly b: string;
  readonly movement: CompareMovement;
  readonly movementLabel: string;
  readonly role: 'site' | 'competitor' | null;
  readonly roleLabel: string;
}

function movementLabel(movement: CompareMovement, change: number | null): string {
  const label = COMPARE_MOVEMENT_LABELS[movement] ?? '';
  return label.includes('{n}') ? (typeof change === 'number' && Number.isFinite(change) ? label.replace('{n}', String(Math.abs(change))) : label.replace(' {n}', '')) : label;
}

/** The comparison's domains as the Compare view lists them. */
export function compareViewRows(comparison: SerpComparison): CompareRowView[] {
  const rows = Array.isArray(comparison.rows) ? comparison.rows : [];
  return rows.filter(present).map((row) => ({
    domain: row.domain,
    a: row.a ? String(row.a.position) : RANK_VIEW_TEXT.none,
    b: row.b ? String(row.b.position) : RANK_VIEW_TEXT.none,
    movement: row.movement,
    movementLabel: movementLabel(row.movement, row.change),
    role: row.role,
    roleLabel: row.role === 'site' ? RANK_VIEW_TEXT.siteRole : row.role === 'competitor' ? RANK_VIEW_TEXT.competitorRole : '',
  }));
}

/** The SERP features on either side, with whether each side has it. */
export function compareFeatureRows(comparison: SerpComparison): { readonly type: SerpFeatureType; readonly label: string; readonly a: string; readonly b: string }[] {
  const features = Array.isArray(comparison.features) ? comparison.features : [];
  return features.filter(present).map((feature) => ({ type: feature.type, label: featureLabel(feature.type), a: feature.a ? RANK_VIEW_TEXT.present : RANK_VIEW_TEXT.absent, b: feature.b ? RANK_VIEW_TEXT.present : RANK_VIEW_TEXT.absent }));
}

/** One side's heading: its search, its date and whether it was read. */
export function compareSideLabel(side: SerpComparisonSide): { readonly search: string; readonly when: string; readonly status: 'ready' | 'unreadable' } {
  return { search: side.params ? searchSummary(side.params) : 'Unreadable', when: formatWhen(side.at), status: side.status };
}

/** A search's readings as the date picker lists them (newest first, as main answers). */
export function readingDateOptions(dates: readonly ReadingDate[]): { readonly value: string; readonly label: string }[] {
  return dates.map((date) => ({ value: date.readingId, label: date.status === 'unreadable' ? `${formatWhen(date.at)} (${RANK_VIEW_TEXT.unreadableDate})` : formatWhen(date.at) }));
}

/** The pickers' first choice for one search: A the second-newest reading, B the newest. */
export function defaultComparePicks(dates: readonly ReadingDate[]): { readonly a: string | null; readonly b: string | null } {
  const newest = dates[0]?.readingId ?? null;
  return { a: dates[1]?.readingId ?? newest, b: newest };
}

/** Why Compare cannot run yet (`null`: it can). */
export function compareProblem(a: string | null, b: string | null): string | null {
  if (a === null || b === null || a === '' || b === '') return RANK_VIEW_TEXT.compareNeedsTwo;
  return a === b ? RANK_VIEW_TEXT.compareSame : null;
}
