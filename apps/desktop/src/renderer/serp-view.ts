import { INTENT_DEFINITIONS, INTENT_LABEL_NAMES, INTENT_STATE_MESSAGES, type IntentAnswer, type IntentState } from '@app/specs/intent-classifier.spec';
import { PACK_UPDATE_MESSAGES, SERP_RESULT_TYPE_LABELS, SERP_RESULT_TYPES, type SerpResultType } from '@app/specs/serp-selector-pack.spec';
// Types only from the schema files (their Zod must stay out of this bundle: strict Trusted Types).
import type { PackStatus, SerpState, SerpTabState } from '@app/specs/serp-service.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { SerpComposition, SerpOwnership, SerpReady } from '@app/specs/serp-snapshot.schema';
import { SERP_NOT_SERP_MESSAGE, SERP_OUTLINE_STYLES } from '@app/specs/serp-service.spec';
import { SERP_DEVICE_LABELS, SERP_TRUNCATED_NOTE, SERP_UNREADABLE_MESSAGES, type SerpUnreadableReason } from '@app/specs/serp.spec';

// The SERP panel's view model (acceptance `serp-panels.feature.md`, SERP panel view model): pure
// functions from main's `SerpTabState` to what the panel shows. Page-derived strings pass through
// untouched (the panel renders them as inert text); every label is frost's own or a spec constant.

/** What a parameter the URL does not set shows. */
export const PARAM_NOT_SET = 'Not set';
/** What a result without a title shows. */
export const NO_TITLE = 'No title';
/** The heading of an unreadable result page. */
export const UNREADABLE_TITLE = 'Couldn’t read this layout';

export type SearchParamKey = 'engine' | 'query' | 'gl' | 'hl' | 'device' | 'page';

export interface SearchParamFact {
  readonly key: SearchParamKey;
  readonly label: string;
  readonly value: string;
}

/** The search parameters bar: engine, query, country, language, device and page. */
export function searchParamFacts(params: SearchParams): SearchParamFact[] {
  return [
    { key: 'engine', label: 'Engine', value: params.engineLabel },
    { key: 'query', label: 'Query', value: params.query },
    { key: 'gl', label: 'Country', value: params.gl ?? PARAM_NOT_SET },
    { key: 'hl', label: 'Language', value: params.hl ?? PARAM_NOT_SET },
    { key: 'device', label: 'Device', value: SERP_DEVICE_LABELS[params.device] },
    { key: 'page', label: 'Page', value: String(params.page) },
  ];
}

/** The search parameters a state knows (`null` for a page that is no result page, or none validated). */
export function serpParams(state: SerpState): SearchParams | null {
  switch (state.status) {
    case 'pending':
      return state.params;
    case 'ready':
      return state.snapshot.params;
    case 'unreadable':
      return state.params;
    default:
      return null;
  }
}

/** `value` (0–1) as a whole percent. */
export function percent(value: number): string {
  return `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%`;
}

export interface CompositionSegment {
  readonly type: SerpResultType;
  readonly label: string;
  readonly count: number;
  /** The type's outline colour (`SERP_OUTLINE_STYLES`), so the bar and the page's outlines agree. */
  readonly color: string;
  /** Where the segment starts and how wide it is, on a 0–100 bar. */
  readonly x: number;
  readonly width: number;
}

/** One segment per type with results, in `SERP_RESULT_TYPES` order, filling a 0–100 bar. */
export function compositionSegments(composition: SerpComposition): CompositionSegment[] {
  const present = SERP_RESULT_TYPES.filter((type) => composition.counts[type] > 0);
  const total = present.reduce((sum, type) => sum + composition.counts[type], 0);
  let x = 0;
  return present.map((type) => {
    const count = composition.counts[type];
    const width = (count / total) * 100;
    const segment = { type, label: SERP_RESULT_TYPE_LABELS[type], count, color: SERP_OUTLINE_STYLES[type].color, x, width };
    x += width;
    return segment;
  });
}

/** The composition bar's text equivalent: the total, then each type's count. */
export function compositionSummary(composition: SerpComposition): string {
  const segments = compositionSegments(composition);
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  if (total === 0) return 'No results read';
  return `${total} ${total === 1 ? 'result' : 'results'}: ${segments.map((segment) => `${segment.label} ${segment.count}`).join(', ')}`;
}

export interface OwnershipRow {
  readonly domain: string;
  readonly count: number;
  readonly share: string;
  readonly positions: string;
}

/** The ownership table's rows, in main's order (most results first). */
export function ownershipRows(ownership: SerpOwnership): OwnershipRow[] {
  return ownership.domains.map((domain) => ({ domain: domain.domain, count: domain.count, share: percent(domain.share), positions: domain.positions.join(', ') }));
}

export function ownershipTitle(ownership: SerpOwnership): string {
  return `Who owns page ${ownership.page}`;
}

/** `SERP_TRUNCATED_NOTE` when a reader cap cut organic results. */
export function ownershipNote(ownership: SerpOwnership): string | null {
  return ownership.complete ? null : SERP_TRUNCATED_NOTE;
}

export interface ResultRow {
  readonly rank: number;
  readonly type: SerpResultType;
  /** Organic results and ads numbered by their own count (`Organic 3`, `Ad 1`); a feature its type. */
  readonly typeLabel: string;
  readonly title: string;
  readonly domain: string | null;
}

export function resultRows(snapshot: SerpReady): ResultRow[] {
  return snapshot.results.map((result) => ({
    rank: result.rank,
    type: result.type,
    typeLabel: result.position === null ? SERP_OUTLINE_STYLES[result.type].label : `${SERP_OUTLINE_STYLES[result.type].label} ${result.position}`,
    title: result.title.trim() === '' ? NO_TITLE : result.title,
    domain: result.domain,
  }));
}

export type IntentChip =
  | { readonly kind: 'ready'; readonly label: string; readonly definition: string; readonly confidence: string }
  | { readonly kind: 'state'; readonly state: Exclude<IntentState, 'ready'>; readonly message: string; readonly enable: boolean }
  | { readonly kind: 'none' };

/** The intent chip for an answer: the label and its confidence, the classifier's state, or nothing. */
export function intentChip(answer: IntentAnswer | null): IntentChip {
  if (answer === null || answer.state === 'no-query') return { kind: 'none' };
  if (answer.state === 'ready') {
    const { label, confidence } = answer.result;
    return { kind: 'ready', label: INTENT_LABEL_NAMES[label], definition: INTENT_DEFINITIONS[label], confidence: percent(confidence) };
  }
  return { kind: 'state', state: answer.state, message: INTENT_STATE_MESSAGES[answer.state], enable: answer.state === 'model-missing' };
}

export interface SerpStateView {
  readonly kind: SerpState['status'];
  readonly title: string;
  readonly message: string | null;
  readonly reason?: SerpUnreadableReason;
  /** Whether the state offers "Check for selector updates" in place (an unreadable layout). */
  readonly offerUpdate: boolean;
}

/** What the panel says for a state (the `ready` reading itself is drawn by the panel). */
export function serpStateView(state: SerpState): SerpStateView {
  switch (state.status) {
    case 'not-serp':
      return { kind: 'not-serp', title: SERP_NOT_SERP_MESSAGE, message: 'Open a search on a supported engine and frost reads its result page here. frost never runs a search by itself.', offerUpdate: false };
    case 'pending':
      return { kind: 'pending', title: 'Reading this result page…', message: null, offerUpdate: false };
    case 'ready':
      return { kind: 'ready', title: 'Result page', message: null, offerUpdate: false };
    case 'unreadable':
      return { kind: 'unreadable', title: UNREADABLE_TITLE, message: SERP_UNREADABLE_MESSAGES[state.reason], reason: state.reason, offerUpdate: true };
    case 'disabled':
      return { kind: 'disabled', title: 'SERP reading is off', message: SERP_UNREADABLE_MESSAGES[state.reason], reason: state.reason, offerUpdate: false };
  }
}

const SOURCE_LABELS: Readonly<Record<NonNullable<PackStatus['source']>, string>> = { bundled: 'bundled with frost', remote: 'installed update' };

/** The pack in use, as one line. */
export function packStatusText(pack: PackStatus): string {
  if (pack.state === 'disabled' || pack.version === null) return 'Selectors disabled: the bundled pack failed verification';
  const parts = [`Selectors v${pack.version}`];
  if (pack.source !== null) parts.push(SOURCE_LABELS[pack.source]);
  if (pack.published !== null) parts.push(`published ${pack.published}`);
  return parts.join(' · ');
}

/** The update check's line: under way, or how the last one ended (`null` before one). */
export function packUpdateLine(pack: PackStatus): string | null {
  if (pack.checking) return 'Checking for selector updates…';
  return pack.lastUpdate === null ? null : PACK_UPDATE_MESSAGES[pack.lastUpdate.outcome];
}

// ---- What the palette knows (`serp-palette.ts`) ----------------------------------------------------

const latest = new Map<number, SerpTabState>();
let intentKnown: IntentState | undefined;

/** Keeps the last SERP state the chrome saw for a tab (the palette's availability reads it). */
export function rememberSerp(state: SerpTabState): void {
  latest.delete(state.tabId);
  latest.set(state.tabId, state);
  while (latest.size > 32) latest.delete(latest.keys().next().value!);
}

/** Forgets a tab's state once no panel watches it (stale is worse than unknown: main decides). */
export function forgetSerp(tabId: number): void {
  latest.delete(tabId);
}

export function knownSerp(tabId: number): SerpTabState | undefined {
  return latest.get(tabId);
}

/** Keeps where on-device intent stood when the chrome last asked. */
export function rememberIntent(state: IntentState): void {
  intentKnown = state;
}

export function knownIntent(): IntentState | undefined {
  return intentKnown;
}
