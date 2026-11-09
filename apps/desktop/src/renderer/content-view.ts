import type { Readability, SentenceReport, SerpPreviewFacts, SerpRating, SnippetCut } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { HIGHLIGHT_PHRASE_MAX_CHARS } from '@app/specs/seo-limits.spec';
import {
  MAX_SNIPPET_VARIANTS,
  READABILITY_FORMULAS,
  SENTENCE_LIMITS,
  SERP_PREVIEW_LIMITS,
  SERP_PREVIEW_TOGGLES,
  SERP_PREVIEW_VARIANT_LABELS,
  SERP_PREVIEW_VARIANT_MISSING,
  SERP_PREVIEW_VARIANTS,
  SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS,
  SNIPPET_VARIANT_TITLE_MAX_CHARS,
  TARGET_QUERY_MAX_CHARS,
  type DifficultSentenceReason,
  type ReadabilityFormulaId,
  type SerpPreviewToggle,
  type SerpPreviewVariant,
} from '@app/specs/seo-content.spec';

// Pure helpers behind the Content panel (spec `seo-content.spec.ts`; acceptance
// `seo-content.feature.md`, Panel). No styles are computed here: bar and meter lengths are SVG
// attribute values, never `style`.

/** An n-gram row's bar length (0–100, one decimal) relative to the most frequent row: SVG `width`. */
export function ngramBar(count: number, max: number): number {
  if (max <= 0 || count <= 0) return 0;
  return Math.max(2, Math.round((Math.min(count, max) / max) * 1000) / 10);
}

export type MeterState = 'empty' | 'fits' | 'over';

/** A width meter against its budget: its state, the fill (0–100 of a track 1.25 × the budget wide) and the budget mark. */
export interface WidthMeter {
  readonly state: MeterState;
  readonly fill: number;
  readonly mark: number;
  readonly label: string;
}

const METER_SCALE = 1.25;

/** The meter of `cut` (`null`: nothing to measure). */
export function widthMeter(cut: SnippetCut | null): WidthMeter {
  const mark = Math.round((1 / METER_SCALE) * 1000) / 10;
  if (cut === null || cut.width === 0) return { state: 'empty', fill: 0, mark, label: 'Nothing to measure' };
  const fill = Math.max(2, Math.round((Math.min(cut.width, cut.budget * METER_SCALE) / (cut.budget * METER_SCALE)) * 1000) / 10);
  const px = (n: number) => `${Math.round(n).toLocaleString('en-US')} px`;
  return cut.truncated
    ? { state: 'over', fill, mark, label: `${px(cut.width)} of about ${px(cut.budget)}: cut` }
    : { state: 'fits', fill, mark, label: `${px(cut.width)} of about ${px(cut.budget)}: fits` };
}

/** The first slot no draft uses, or `null` when every `MAX_SNIPPET_VARIANTS` slot is taken. */
export function firstFreeSlot(used: readonly number[]): number | null {
  for (let slot = 0; slot < MAX_SNIPPET_VARIANTS; slot++) if (!used.includes(slot)) return slot;
  return null;
}

/** `value` cut to `max` UTF-16 code units, never splitting a surrogate pair. */
export function capInput(value: string, max: number): string {
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

export const capQuery = (value: string): string => capInput(value, TARGET_QUERY_MAX_CHARS);
export const capTitle = (value: string): string => capInput(value, SNIPPET_VARIANT_TITLE_MAX_CHARS);
export const capDescription = (value: string): string => capInput(value, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS);

/** `n` words / sentences etc. with a unit, singular for one. */
export function countLabel(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * On-Page's length verdict since the width rules (`seo-content.spec.ts`): `missing`, `long` when a
 * result cuts it by width (`truncated`), `short` when it is narrower than `minWidth` px
 * (`minSnippetWidth`, as the rules), else `ok`.
 */
export function snippetIndicator(length: number | null | undefined, cut: { readonly width: number; readonly truncated: boolean } | null, minWidth: number): 'missing' | 'short' | 'ok' | 'long' {
  if (length === null || length === undefined || length === 0 || cut === null) return 'missing';
  if (cut.truncated) return 'long';
  return cut.width < minWidth ? 'short' : 'ok';
}

/** A ratio with one decimal (`0` for nothing to divide by). */
export function ratio(a: number, b: number): string {
  return b > 0 ? (Math.round((a / b) * 10) / 10).toLocaleString('en-US') : '0';
}

/** A scored readability as the panel shows it: the formula's name, the score (one decimal) and its band. */
export function readabilityView(r: Extract<Readability, { status: 'ok' }>): { readonly formula: string; readonly score: string; readonly band: string } {
  return { formula: formulaName(r.formula), score: r.score.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), band: r.band };
}

/** The name of a readability formula (`READABILITY_FORMULAS`). */
export function formulaName(id: ReadabilityFormulaId): string {
  return Object.values(READABILITY_FORMULAS).find((formula) => formula.id === id)?.name ?? id;
}

/** The sentence statistics as label / value rows; `null` when not available. The complex-word share only where the language has a syllable heuristic. */
export function sentenceStatsView(report: SentenceReport): { readonly label: string; readonly value: string }[] | null {
  if (report.status !== 'ok') return null;
  const rows = [
    { label: 'Sentences', value: report.sentences.toLocaleString('en-US') },
    { label: 'Words per sentence', value: report.averageWords.toLocaleString('en-US', { maximumFractionDigits: 1 }) },
    { label: 'Longest sentence', value: countLabel(report.longestWords, 'word', 'words') },
    { label: `Over ${SENTENCE_LIMITS.longSentenceWords} words`, value: report.longCount.toLocaleString('en-US') },
  ];
  if (report.complexWordShare !== null) rows.push({ label: 'Complex words', value: `${(Math.round(report.complexWordShare * 1000) / 10).toLocaleString('en-US')}%` });
  return rows;
}

const REASON_CHIP: Readonly<Record<DifficultSentenceReason, string>> = { long: 'Long', complex: 'Complex' };

/** One difficult sentence as a row: its excerpt (page text: render as inert text), its reason chip and word count. */
export interface DifficultSentenceRow {
  readonly text: string;
  readonly reason: DifficultSentenceReason;
  readonly chip: string;
  readonly words: string;
}

/** The difficult-sentence list: a heading counting them all, the listed rows, and how many it leaves out (`null`: none); `null` without any. */
export function difficultSentenceItems(report: SentenceReport): { readonly heading: string; readonly items: DifficultSentenceRow[]; readonly more: string | null } | null {
  if (report.status !== 'ok' || report.difficult.total === 0) return null;
  const { total, items } = report.difficult;
  const rest = total - items.length;
  return {
    heading: `Difficult sentences (${total.toLocaleString('en-US')})`,
    items: items.map((item) => ({ text: item.text, reason: item.reason, chip: REASON_CHIP[item.reason], words: countLabel(item.words, 'word', 'words') })),
    more: rest > 0 ? `and ${rest.toLocaleString('en-US')} more` : null,
  };
}

/**
 * A keyphrase highlight toggle (an n-gram row's, the target query's; `seo-content.feature.md`,
 * Keyphrase highlight): pressed while `phrase` is the tab's `keyphrase` (`TabState.highlightPhrase`);
 * pressing it asks main for `keyphrase` with `phrase`, or for `off` when pressed. `available`: the
 * phrase can be named at all (1 to `HIGHLIGHT_PHRASE_MAX_CHARS` characters on one line; main still
 * checks it against its own audit and notes).
 */
export function keyphraseToggle(tab: Pick<TabState, 'highlight' | 'highlightPhrase'>, phrase: string): { readonly pressed: boolean; readonly available: boolean; readonly next: { readonly mode: 'keyphrase'; readonly phrase: string } | { readonly mode: 'off' } } {
  const pressed = tab.highlight === 'keyphrase' && tab.highlightPhrase === phrase;
  const available = phrase.length >= 1 && phrase.length <= HIGHLIGHT_PHRASE_MAX_CHARS && !/[\r\n\v\f\u0085\u2028\u2029]/.test(phrase);
  return { pressed, available, next: pressed ? { mode: 'off' } : { mode: 'keyphrase', phrase } };
}

// ---- Result preview facts (Phase 11 Task 3; spec `seo-content.spec.ts`, Result preview facts) -----

/** The editor's session-only display toggles (`SERP_PREVIEW_TOGGLES`): kept in the panel's state, never stored. */
export type SerpToggles = Readonly<Record<SerpPreviewToggle, boolean>>;
export const SERP_TOGGLES_ON: SerpToggles = Object.fromEntries(SERP_PREVIEW_TOGGLES.map((toggle) => [toggle, true])) as Record<SerpPreviewToggle, boolean>;

/** The site-name override as typed: control characters and line breaks dropped, cut to `maxSiteNameChars` code points. */
export function cleanSiteName(value: string): string {
  return [...value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')].slice(0, SERP_PREVIEW_LIMITS.maxSiteNameChars).join('');
}

/** The override the preview and a suggested JSON-LD take (`SiteNameOverrideSchema`): `undefined` when blank. */
export function siteNameOverride(value: string): string | undefined {
  const cleaned = cleanSiteName(value);
  return cleaned.trim() === '' ? undefined : cleaned;
}

/** A rating as text: whole stars of five (`★` / `☆`) and its label. */
export function ratingView(rating: SerpRating): { readonly stars: string; readonly label: string } {
  const stars = Math.min(5, Math.max(0, rating.stars));
  const count = rating.count === null ? '' : ` · ${countLabel(rating.count, rating.countOf === 'reviews' ? 'review' : 'rating', rating.countOf === 'reviews' ? 'reviews' : 'ratings')}`;
  return { stars: `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}`, label: `Rating: ${rating.shown}${rating.best === 5 ? '' : ` of ${rating.best}`}${count}` };
}

/** What the standard previews draw, after the toggles: `null` parts are hidden or absent. */
export interface StandardPreviewView {
  /** The site-name line (the host without `www.` when the site name is off). */
  readonly siteName: string;
  readonly monogram: string;
  /** The address line: `host › step …` (the host alone when the breadcrumb is off), cut by width. */
  readonly trail: string;
  readonly trailTruncated: boolean;
  readonly date: string | null;
  readonly rating: { readonly stars: string; readonly label: string } | null;
}

export function standardPreview(facts: SerpPreviewFacts, toggles: SerpToggles): StandardPreviewView {
  const { host } = facts.breadcrumb;
  // Without the site name, the host as the host fallback names it (no `www.`).
  const site = host.startsWith('www.') ? host.slice(4) : host;
  return {
    siteName: toggles['site-name'] ? facts.siteName.shown.shown : site,
    monogram: toggles['site-name'] ? facts.siteName.monogram : (/[\p{L}\p{N}]/u.exec(site)?.[0]?.toLocaleUpperCase() ?? '•'),
    trail: toggles.breadcrumb ? facts.breadcrumb.line.shown : host,
    trailTruncated: toggles.breadcrumb && facts.breadcrumb.line.truncated,
    date: toggles.date && facts.date !== null ? facts.date.shown : null,
    rating: toggles.rating && facts.rating !== null ? ratingView(facts.rating) : null,
  };
}

/** A variant button: whether the page has its facts, and why not. */
export interface VariantChoice {
  readonly variant: SerpPreviewVariant;
  readonly label: string;
  readonly available: boolean;
  readonly reason: string | null;
}

export function variantChoices(facts: SerpPreviewFacts): VariantChoice[] {
  return SERP_PREVIEW_VARIANTS.map((variant) => {
    const available = facts.variants[variant];
    return { variant, label: SERP_PREVIEW_VARIANT_LABELS[variant], available, reason: available || variant === 'standard' ? null : SERP_PREVIEW_VARIANT_MISSING[variant] };
  });
}

export type VariantCardLineKind = 'badge' | 'site' | 'title' | 'rating' | 'meta';
/** One line of a rich result card: page text (render as inert, bidi-isolated text). */
export interface VariantCardLine {
  readonly kind: VariantCardLineKind;
  readonly text: string;
}
export interface VariantCard {
  readonly variant: Exclude<SerpPreviewVariant, 'standard'>;
  readonly heading: string;
  readonly monogram: string;
  readonly lines: readonly VariantCardLine[];
}

/**
 * A rich result card frost draws in its own layout (an approximation, under `SERP_PREVIEW_NOTE`):
 * Top stories (site, headline, date), Video (a duration badge on a drawn frame, name, site and upload
 * date) or Recipe (name, site, rating, time and yield). `null` when the page lacks the variant's node.
 * `title` is the page's title (or the draft's), used when the node has no name of its own.
 */
export function variantCard(variant: Exclude<SerpPreviewVariant, 'standard'>, facts: SerpPreviewFacts, title: string): VariantCard | null {
  if (!facts.variants[variant]) return null;
  const site = facts.siteName.text;
  const named = (name: string | null | undefined): string => (name ?? '') || title || 'No title';
  const line = (kind: VariantCardLineKind, text: string | null | undefined): VariantCardLine[] => (text ? [{ kind, text }] : []);
  const meta = (...parts: (string | null | undefined)[]): VariantCardLine[] => line('meta', parts.filter((part): part is string => !!part).join(' · '));
  let lines: VariantCardLine[];
  if (variant === 'top-stories') {
    lines = [...line('site', site), ...line('title', named(facts.article?.headline)), ...meta(facts.date?.shown)];
  } else if (variant === 'video') {
    const video = facts.video!;
    lines = [...line('badge', video.duration ?? 'Video'), ...line('title', named(video.name)), ...meta(site, video.uploadDate?.shown)];
  } else {
    const recipe = facts.recipe!;
    const rating = recipe.rating === null ? null : ratingView(recipe.rating);
    lines = [...line('title', named(recipe.name)), ...line('site', site), ...line('rating', rating ? `${rating.stars} ${rating.label}` : null), ...meta(recipe.totalTime, recipe.yield ? `Makes ${recipe.yield}` : null)];
  }
  return { variant, heading: SERP_PREVIEW_VARIANT_LABELS[variant], monogram: facts.siteName.monogram, lines };
}
