import {
  JS_DIFF_LIMITS,
  JS_FIELD_LABELS,
  JS_FIELDS,
  JS_KEY_FIELDS,
  JS_VERDICT_THRESHOLDS,
  WORD_COUNT_TOLERANCE,
  type JsFieldId,
  type JsFieldStatus,
  type JsVerdict,
  type ServedUnavailableReason,
} from '@app/specs/seo-javascript.spec';
// Types only: the served snapshot's Zod schema stays in main (it is the page's server's data).
import type { ServedFetch, ServedSnapshot } from '@app/specs/seo-javascript.schema';
import type { PageSnapshot } from '../types';

// Served HTML vs the rendered DOM (spec `seo-javascript.spec.ts`; acceptance
// `seo-javascript.feature.md`, Comparison): built by `runAudit`, so in the analysis worker, from the
// validated rendered and served snapshots only. Both are read the same way, field by field.

export interface JsFieldDiff {
  readonly id: JsFieldId;
  readonly label: string;
  readonly status: JsFieldStatus;
  /** The value shown for each side (`null`: absent), cut to `maxValueChars`. */
  readonly served: string | null;
  readonly rendered: string | null;
}

/** One entry of an added / removed list. */
export interface JsListItem {
  /** What it is compared by. */
  readonly key: string;
  /** What is shown (a URL, a heading's text, a JSON-LD block's types). */
  readonly label: string;
  /** A second line (the anchor text, the heading level, a block's start). */
  readonly detail: string;
  /** How many more times the rendered (added) or served (removed) side has it than the other. */
  readonly count: number;
  /** An http(s) URL the panel may open (links only). */
  readonly url: string | null;
}

/** A list's difference: what JavaScript added (only after rendering) and removed (only in served), each capped (`maxListItems`) with its total. */
export interface JsListDiff {
  readonly added: readonly JsListItem[];
  readonly addedTotal: number;
  readonly removed: readonly JsListItem[];
  readonly removedTotal: number;
  /** Entries compared on each side. */
  readonly served: number;
  readonly rendered: number;
}

export interface JsMetrics {
  readonly servedWords: number;
  readonly renderedWords: number;
  /** `max(0, rendered − served) / rendered` (`JS_VERDICT_THRESHOLDS`). */
  readonly wordShare: number;
  /** Distinct http(s) links on each side, and how many are only in the rendered page. */
  readonly servedLinks: number;
  readonly renderedLinks: number;
  readonly linksAdded: number;
  readonly linkShare: number;
}

export type JavascriptReport =
  | { readonly status: 'pending' }
  | { readonly status: 'unavailable'; readonly reason: ServedUnavailableReason; readonly httpStatus: number | null; readonly finalUrl: string | null }
  | {
      readonly status: 'ready' | 'identical';
      readonly fetch: ServedFetch;
      readonly verdict: JsVerdict;
      readonly metrics: JsMetrics;
      readonly fields: readonly JsFieldDiff[];
      /** How many fields are not `same`. */
      readonly changed: number;
      readonly links: JsListDiff;
      readonly headings: JsListDiff;
      readonly structuredData: JsListDiff;
      readonly noscript: ServedSnapshot['noscript'];
      /** The served snapshot is partial (a parse cap, or the body cut at `maxBytes`): rules are not checked. */
      readonly partial: boolean;
    };
export type JavascriptComparison = Extract<JavascriptReport, { status: 'ready' | 'identical' }>;

/** The parts both snapshots share. */
type Side = Pick<ServedSnapshot, 'titles' | 'metaDescriptions' | 'metaRobots' | 'canonicals' | 'ogUrl' | 'lang' | 'viewport' | 'headings' | 'headingTotal' | 'hreflang' | 'wordCount' | 'links' | 'linkTotal' | 'imageTotal' | 'jsonLd' | 'jsonLdTotal'>;

const cutValue = (value: string): string => (value.length > JS_DIFF_LIMITS.maxValueChars ? `${value.slice(0, JS_DIFF_LIMITS.maxValueChars - 1)}…` : value);

/** A field's values on one side: a list (empty: absent), or a count (zero: absent). */
type Values = { readonly kind: 'list'; readonly values: readonly string[]; readonly set: boolean } | { readonly kind: 'count'; readonly value: number };

function valuesOf(side: Side, id: JsFieldId): Values {
  const list = (values: readonly string[], set = false): Values => ({ kind: 'list', values, set });
  const one = (value: string | null): Values => list(value === null || value === '' ? [] : [value]);
  switch (id) {
    case 'title':
      return list(side.titles.map((t) => t.text));
    case 'meta-description':
      return list(side.metaDescriptions.map((d) => d.text));
    case 'robots':
      return list(
        side.metaRobots.map((m) => `${m.name}: ${m.content}`),
        true,
      );
    case 'canonical':
      return list(
        side.canonicals.map((c) => c.resolved ?? c.href),
        true,
      );
    case 'og-url':
      return one(side.ogUrl);
    case 'lang':
      return one(side.lang);
    case 'viewport':
      return one(side.viewport);
    case 'h1':
      return list(
        side.headings.filter((h) => h.level === 1).map((h) => h.text),
        true,
      );
    case 'hreflang':
      return list(
        side.hreflang.map((h) => `${h.hreflang} → ${h.resolved ?? h.href}`),
        true,
      );
    case 'word-count':
      return { kind: 'count', value: side.wordCount };
    case 'links':
      return { kind: 'count', value: side.linkTotal };
    case 'headings':
      return { kind: 'count', value: side.headingTotal };
    case 'images':
      return { kind: 'count', value: side.imageTotal };
    case 'structured-data':
      return { kind: 'count', value: side.jsonLdTotal };
  }
}

/** Whether two word counts are the same within `WORD_COUNT_TOLERANCE`. */
export function sameWordCount(served: number, rendered: number): boolean {
  return Math.abs(served - rendered) <= Math.max(WORD_COUNT_TOLERANCE.words, WORD_COUNT_TOLERANCE.share * Math.max(served, rendered));
}

function sameValues(id: JsFieldId, a: Values, b: Values): boolean {
  if (a.kind === 'count' && b.kind === 'count') return id === 'word-count' ? sameWordCount(a.value, b.value) : a.value === b.value;
  if (a.kind !== 'list' || b.kind !== 'list') return false;
  const left = a.set ? [...new Set(a.values)].sort() : a.values;
  const right = b.set ? [...new Set(b.values)].sort() : b.values;
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

const shown = (values: Values): string | null => {
  if (values.kind === 'count') return values.value === 0 ? null : values.value.toLocaleString('en-US');
  return values.values.length === 0 ? null : cutValue(values.values.join(' · '));
};
const present = (values: Values): boolean => (values.kind === 'count' ? values.value > 0 : values.values.length > 0);

/** The per-field comparison (`JS_FIELDS`, in order). */
export function compareFields(served: Side, rendered: Side): JsFieldDiff[] {
  return JS_FIELDS.map((id) => {
    const s = valuesOf(served, id);
    const r = valuesOf(rendered, id);
    const status: JsFieldStatus = sameValues(id, s, r) ? 'same' : !present(s) ? 'only-rendered' : !present(r) ? 'only-served' : 'changed';
    return { id, label: JS_FIELD_LABELS[id], status, served: shown(s), rendered: shown(r) };
  });
}

/** An entry to compare: its key and how it is shown. */
interface Entry {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly url: string | null;
}

/**
 * The multiset difference of `served` and `rendered` (by key; `set`: each key once): entries the
 * rendered side has more of (added), and the served side has more of (removed), in their order.
 */
export function diffEntries(served: readonly Entry[], rendered: readonly Entry[], set = false): JsListDiff {
  const tally = (entries: readonly Entry[]) => {
    const counts = new Map<string, { entry: Entry; n: number }>();
    for (const entry of entries) {
      const seen = counts.get(entry.key);
      if (seen) seen.n = set ? 1 : seen.n + 1;
      else counts.set(entry.key, { entry, n: 1 });
    }
    return counts;
  };
  const s = tally(served);
  const r = tally(rendered);
  const extra = (from: typeof s, other: typeof s): JsListItem[] => {
    const out: JsListItem[] = [];
    for (const { entry, n } of from.values()) {
      const more = n - (other.get(entry.key)?.n ?? 0);
      if (more > 0) out.push({ ...entry, label: cutValue(entry.label), detail: cutValue(entry.detail), count: more });
    }
    return out;
  };
  const added = extra(r, s);
  const removed = extra(s, r);
  return {
    added: added.slice(0, JS_DIFF_LIMITS.maxListItems),
    addedTotal: added.length,
    removed: removed.slice(0, JS_DIFF_LIMITS.maxListItems),
    removedTotal: removed.length,
    served: set ? s.size : served.length,
    rendered: set ? r.size : rendered.length,
  };
}

const isWebLink = (link: Side['links'][number]): boolean => link.kind !== 'other' && (link.scheme === 'http:' || link.scheme === 'https:') && link.href !== '';

/** The http(s) links, by resolved URL. */
function linkEntries(side: Side): Entry[] {
  return side.links.filter(isWebLink).map((link) => ({ key: link.href, label: link.href, detail: [link.text, link.rel].filter((part) => part !== '').join(' · '), url: link.href }));
}

function headingEntries(side: Side): Entry[] {
  return side.headings.map((h) => ({ key: `${h.level}\u0000${h.text}`, label: h.text === '' ? '(empty heading)' : h.text, detail: `H${h.level}`, url: null }));
}

/** The `@type` values of a parsed JSON-LD value (top level and its `@graph`), at most 8. */
function typesOf(value: unknown): string[] {
  const out: string[] = [];
  const add = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || out.length >= 8) return;
    const type = (node as Record<string, unknown>)['@type'];
    for (const t of Array.isArray(type) ? type : [type]) if (typeof t === 'string' && out.length < 8) out.push(t);
  };
  const nodes = Array.isArray(value) ? value : [value];
  for (const node of nodes) {
    add(node);
    const graph = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)['@graph'] : undefined;
    if (Array.isArray(graph)) for (const item of graph) add(item);
  }
  return out;
}

/** JSON-LD blocks, by their JSON when it parses (so formatting does not count), else their trimmed text. */
function structuredEntries(side: Side): Entry[] {
  return side.jsonLd.map((block) => {
    const text = block.text.trim();
    let key = `text:${text}`;
    let label = 'JSON-LD block (not valid JSON)';
    if (block.length <= block.text.length) {
      try {
        const value: unknown = JSON.parse(text);
        key = `json:${JSON.stringify(value)}`;
        const types = typesOf(value);
        label = types.length > 0 ? types.join(', ') : 'JSON-LD block';
      } catch {
        // Not JSON: compared by its text.
      }
    }
    return { key, label, detail: text.slice(0, 120), url: null };
  });
}

/** The verdict for `metrics` and the differences (`JS_VERDICT_THRESHOLDS`). */
export function jsVerdict(metrics: JsMetrics, fields: readonly JsFieldDiff[], structuredData: JsListDiff): JsVerdict {
  const t = JS_VERDICT_THRESHOLDS;
  const enoughWords = metrics.renderedWords >= t.minWords;
  if ((enoughWords && metrics.wordShare >= t.heavyShare) || (metrics.renderedLinks >= t.minLinks && metrics.linkShare >= t.heavyShare)) return 'heavily';
  const keyChanged = fields.some((field) => (JS_KEY_FIELDS as readonly string[]).includes(field.id) && field.status !== 'same');
  if ((enoughWords && metrics.wordShare >= t.partlyShare) || (metrics.linksAdded > 0 && metrics.linkShare >= t.partlyShare) || keyChanged || structuredData.addedTotal > 0 || structuredData.removedTotal > 0) return 'partly';
  return 'independent';
}

/** The comparison of a served snapshot with the rendered one. */
export function compareServed(served: ServedSnapshot, fetch: ServedFetch, renderedPage: Side & { readonly hiddenHeadings?: Side['headings'] }): JavascriptComparison {
  // The served HTML has no layout: its headings are compared with the rendered page's shown and
  // hidden ones together (`hiddenHeadings`, the extractor's first few).
  const rendered: Side = { ...renderedPage, headings: [...renderedPage.headings, ...(renderedPage.hiddenHeadings ?? [])] };
  const fields = compareFields(served, rendered);
  const links = diffEntries(linkEntries(served), linkEntries(rendered), true);
  const headings = diffEntries(headingEntries(served), headingEntries(rendered));
  const structuredData = diffEntries(structuredEntries(served), structuredEntries(rendered));
  const renderedWords = rendered.wordCount;
  const metrics: JsMetrics = {
    servedWords: served.wordCount,
    renderedWords,
    wordShare: renderedWords > 0 ? Math.max(0, renderedWords - served.wordCount) / renderedWords : 0,
    servedLinks: links.served,
    renderedLinks: links.rendered,
    linksAdded: links.addedTotal,
    linkShare: links.rendered > 0 ? links.addedTotal / links.rendered : 0,
  };
  const changed = fields.filter((field) => field.status !== 'same').length;
  const lists = [links, headings, structuredData];
  const identical = changed === 0 && lists.every((list) => list.addedTotal === 0 && list.removedTotal === 0);
  return {
    status: identical ? 'identical' : 'ready',
    fetch,
    verdict: jsVerdict(metrics, fields, structuredData),
    metrics,
    fields,
    changed,
    links,
    headings,
    structuredData,
    noscript: served.noscript,
    partial: served.partial || fetch.truncated,
  };
}

const reports = new WeakMap<object, JavascriptReport>();

/** The JavaScript panel's report of `snapshot` (its `served` context; computed once per snapshot). */
export function javascriptReport(snapshot: PageSnapshot): JavascriptReport {
  const cached = reports.get(snapshot);
  if (cached) return cached;
  const served = snapshot.served;
  let report: JavascriptReport;
  if (served === undefined || served === null) report = { status: 'unavailable', reason: 'not-fetched', httpStatus: null, finalUrl: null };
  else if (served.status === 'pending') report = { status: 'pending' };
  else if (served.status === 'unavailable') report = { status: 'unavailable', reason: served.reason, httpStatus: served.httpStatus, finalUrl: served.finalUrl };
  else report = compareServed(served.snapshot, served.fetch, snapshot);
  reports.set(snapshot, report);
  return report;
}

/** The comparison when rules may be checked on it (complete, `ready` or `identical`), else `null`. */
export function comparableReport(snapshot: PageSnapshot): JavascriptComparison | null {
  const report = javascriptReport(snapshot);
  return (report.status === 'ready' || report.status === 'identical') && !report.partial ? report : null;
}
