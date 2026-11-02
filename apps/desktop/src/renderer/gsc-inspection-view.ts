// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { GscInspectInput, GscInspectionAnswer, GscInspectionCode, GscInspectionOk, GscRichIssue } from '@app/specs/gsc-inspection.schema';
import {
  GSC_CANONICAL_MATCH,
  GSC_CRAWLED_AS,
  GSC_INDEXING_STATES,
  GSC_INSPECTION_COPY,
  GSC_INSPECTION_HELD_PAGES,
  GSC_INSPECTION_VERDICTS,
  GSC_PAGE_FETCH_STATES,
  GSC_RICH_SEVERITIES,
  GSC_RICH_SEVERITY_ORDER,
  GSC_ROBOTS_TXT_STATES,
  gscCanonicalMatch,
  type GscCanonicalMatch,
  type GscInspectionState,
  type GscInspectionStateCopy,
  type GscRichSeverity,
} from '@app/specs/gsc-inspection.spec';
import type { GscStatus, GscUnavailableReason } from '@app/specs/gsc.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { withoutFragment } from './gsc-view';
import { hostOf } from './security';

// Google's URL Inspection as the cards show it (Phase 9 Task 4; spec `gsc-inspection.spec.ts`;
// acceptance `gsc-inspection.feature.md`, Card). Pure: main's connection (`gsc.watch`), the page and the
// shared entry for it become what the Indexability card ("Google's view") and the Schema card ("Detected
// by Google") show. The store keeps one entry per page for every tab and both cards and asks main only
// when told to (a click): nothing here reads on its own. Strings from Google pass through unchanged, to
// be rendered as inert, bidi-isolated text; the Search Console link is never part of a view (only
// whether there is one).

// ---- Codes --------------------------------------------------------------------------------------

/** A code as shown: its label, or "Not recognised" with Google's raw code (inert text; `null`: none). */
export type GscCodeView = { readonly known: true; readonly label: string } | { readonly known: false; readonly label: string; readonly code: string | null };

/** `code` read against `table`'s labels. */
export function gscCodeView<K extends string>(table: Readonly<Record<K, string>>, code: GscInspectionCode<NoInfer<K>>): GscCodeView {
  if (code.value !== 'unknown' && Object.prototype.hasOwnProperty.call(table, code.value)) return { known: true, label: table[code.value as K] };
  return { known: false, label: GSC_INSPECTION_COPY.text.unknown, code: 'code' in code ? code.code : null };
}

// ---- Times --------------------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RELATIVE = new Intl.RelativeTimeFormat('en-US', { numeric: 'always' });

/** "3 days ago" (under a minute, or ahead of the clock: "just now"). */
export function relativeTime(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return GSC_INSPECTION_COPY.text.justNow;
  if (elapsed < HOUR) return RELATIVE.format(-Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return RELATIVE.format(-Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 30 * DAY) return RELATIVE.format(-Math.floor(elapsed / DAY), 'day');
  if (elapsed < 365 * DAY) return RELATIVE.format(-Math.floor(elapsed / (30 * DAY)), 'month');
  return RELATIVE.format(-Math.floor(elapsed / (365 * DAY)), 'year');
}

/** "Oct 30, 2026, 2:05 PM" in `timeZone` (default: the system's). */
export function absoluteTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
}

/** The last crawl: "3 days ago (Oct 30, 2026, 2:05 PM)", or "Not crawled yet". */
export function lastCrawlText(iso: string | null, now: number, timeZone?: string): string {
  if (iso === null) return GSC_INSPECTION_COPY.text.notCrawled;
  return GSC_INSPECTION_COPY.text.lastCrawl.replace('{relative}', relativeTime(iso, now)).replace('{absolute}', absoluteTime(iso, timeZone));
}

// ---- Rich results -------------------------------------------------------------------------------

export interface GscRichIssueGroup {
  readonly severity: GscRichSeverity | 'unknown';
  readonly label: string;
  /** Google's message; `code`: Google's raw severity code for an unknown one. */
  readonly issues: readonly { readonly message: string; readonly code?: string | null }[];
}

/** `issues` by severity (`GSC_RICH_SEVERITY_ORDER`), each in Google's order; empty groups left out. */
export function richIssueGroups(issues: readonly GscRichIssue[]): GscRichIssueGroup[] {
  const groups: GscRichIssueGroup[] = [];
  for (const severity of GSC_RICH_SEVERITY_ORDER) {
    const mine = issues.filter((issue) => issue.severity.value === severity || (severity === 'unknown' && !Object.prototype.hasOwnProperty.call(GSC_RICH_SEVERITIES, issue.severity.value)));
    if (mine.length === 0) continue;
    groups.push({
      severity,
      label: severity === 'unknown' ? GSC_INSPECTION_COPY.text.unknown : GSC_RICH_SEVERITIES[severity],
      issues: mine.map((issue) => (severity === 'unknown' ? { message: issue.message, code: 'code' in issue.severity ? issue.severity.code : null } : { message: issue.message })),
    });
  }
  return groups;
}

export interface GscRichItemView {
  /** Google's item name (`null`: none). */
  readonly name: string | null;
  readonly issueCount: number;
  readonly groups: readonly GscRichIssueGroup[];
}

export interface GscRichView {
  /** `null`: Google reported no rich results. */
  readonly verdict: GscCodeView | null;
  readonly types: readonly { readonly type: string; readonly items: readonly GscRichItemView[] }[];
  readonly errors: number;
  readonly warnings: number;
}

function richView(answer: GscInspectionOk): GscRichView {
  const rich = answer.richResults;
  if (rich === null) return { verdict: null, types: [], errors: 0, warnings: 0 };
  let errors = 0;
  let warnings = 0;
  const types = rich.types.map((type) => ({
    type: type.type,
    items: type.items.map((item) => {
      for (const issue of item.issues) {
        if (issue.severity.value === 'ERROR') errors += 1;
        else if (issue.severity.value === 'WARNING') warnings += 1;
      }
      return { name: item.name === '' ? null : item.name, issueCount: item.issues.length, groups: richIssueGroups(item.issues) };
    }),
  }));
  return { verdict: gscCodeView(GSC_INSPECTION_VERDICTS, rich.verdict), types, errors, warnings };
}

// ---- Index status -------------------------------------------------------------------------------

export interface GscCanonicalRow {
  readonly url: string | null;
  /** How it compares with Google's (`null`: Google reported none). */
  readonly match: GscCanonicalMatch | null;
  readonly matchLabel: string | null;
}

export interface GscIndexView {
  readonly verdict: GscCodeView;
  /** Google's coverage text (`null`: none sent). */
  readonly coverage: string | null;
  readonly indexing: GscCodeView;
  readonly robotsTxt: GscCodeView;
  readonly pageFetch: GscCodeView;
  readonly lastCrawl: string;
  readonly crawledAs: GscCodeView | null;
  readonly googleCanonical: string | null;
  /** The canonical the page declares, as Google read it. */
  readonly userCanonical: GscCanonicalRow;
  /** The canonical frost read in its audit (`null`: no audit given). */
  readonly auditCanonical: GscCanonicalRow | null;
}

function canonicalRow(google: string | null, url: string | null, base: string): GscCanonicalRow {
  const match = gscCanonicalMatch(google, url, base);
  return { url, match, matchLabel: match === null ? null : GSC_CANONICAL_MATCH[match] };
}

function indexView(answer: GscInspectionOk, auditCanonical: string | null | undefined, now: number, timeZone: string | undefined): GscIndexView {
  const index = answer.index;
  return {
    verdict: gscCodeView(GSC_INSPECTION_VERDICTS, index.verdict),
    coverage: index.coverageState === '' ? null : index.coverageState,
    indexing: gscCodeView(GSC_INDEXING_STATES, index.indexingState),
    robotsTxt: gscCodeView(GSC_ROBOTS_TXT_STATES, index.robotsTxtState),
    pageFetch: gscCodeView(GSC_PAGE_FETCH_STATES, index.pageFetchState),
    lastCrawl: lastCrawlText(index.lastCrawlTime, now, timeZone),
    crawledAs: index.crawledAs === null ? null : gscCodeView(GSC_CRAWLED_AS, index.crawledAs),
    googleCanonical: index.googleCanonical,
    userCanonical: canonicalRow(index.googleCanonical, index.userCanonical, answer.url),
    auditCanonical: auditCanonical === undefined ? null : canonicalRow(index.googleCanonical, auditCanonical, answer.url),
  };
}

// ---- The view -----------------------------------------------------------------------------------

/** One page's shared entry: a request is running (`inspecting`), and the last answer (`null`: none yet). */
export interface GscInspectionEntry {
  readonly inspecting: boolean;
  readonly answer: GscInspectionAnswer | null;
}

export interface GscInspectionViewInput {
  /** `gsc.watch` (`null` until main answers). */
  readonly gsc: GscStatus | null;
  /** The page (`''`: none). */
  readonly url: string;
  readonly entry: GscInspectionEntry | null;
  readonly now: number;
  /** The canonical frost read for the page (Indexability only; `undefined`: not compared). */
  readonly auditCanonical?: string | null;
  /** For the absolute times (tests); default: the system's. */
  readonly timeZone?: string;
}

export interface GscInspectionView {
  readonly state: GscInspectionState;
  readonly copy: GscInspectionStateCopy;
  /** An earlier answer is shown while the page is inspected again. */
  readonly pending: boolean;
  /** Google's index status (an `ok` answer only). */
  readonly index: GscIndexView | null;
  /** Google's rich results (an `ok` answer only). */
  readonly rich: GscRichView | null;
  /** "Inspected 2 minutes ago" (an `ok` answer only). */
  readonly inspected: string | null;
  /** The answer has a Search Console link (main opens it; the chrome never sees more than this). */
  readonly canOpen: boolean;
}

/** Each unavailable reason as a card state (`null`: the card is hidden). */
const REASON_STATES: Readonly<Record<GscUnavailableReason, GscInspectionState | null>> = Object.freeze({
  unconfigured: null,
  'not-entitled': null,
  'not-connected': 'not-connected',
  'no-property': 'no-property',
  'auth-expired': 'auth-expired',
  quota: 'quota',
  network: 'network',
  invalid: 'invalid',
  'not-a-web-page': 'not-a-web-page',
});

/** The state before anything is asked: `undefined` when it can be asked, `null` when the card is hidden. */
function gate(gsc: GscStatus | null, url: string): GscInspectionState | null | undefined {
  if (gsc === null || !gsc.configured) return null;
  // `gsc.entitled` is not read: always true from main (Search Console is not gated).
  if (!gsc.connected) return gsc.error === 'auth-expired' ? 'auth-expired' : 'not-connected';
  if (!isWebUrl(url)) return 'not-a-web-page';
  return undefined;
}

/** What a card shows for `input`, or `null` (hidden: main has not answered, or Search Console is unconfigured). */
export function gscInspectionView(input: GscInspectionViewInput): GscInspectionView | null {
  const blocked = gate(input.gsc, input.url);
  if (blocked === null) return null;
  const entry = blocked === undefined ? input.entry : null;
  const answer = entry?.answer ?? null;
  let state: GscInspectionState;
  if (blocked !== undefined) state = blocked;
  else if (entry?.inspecting) state = 'inspecting';
  else if (answer === null) state = 'idle';
  else if (answer.status === 'ok') state = 'ok';
  else {
    const mapped = REASON_STATES[answer.reason];
    if (mapped === null) return null;
    state = mapped;
  }
  const ok = answer?.status === 'ok' ? answer : null;
  const copy = GSC_INSPECTION_COPY.states[state];
  const message = copy.message.replace('{host}', hostOf(input.url) || input.url);
  return {
    state,
    copy: message === copy.message ? copy : { ...copy, message },
    pending: state === 'inspecting' && ok !== null,
    index: ok ? indexView(ok, input.auditCanonical, input.now, input.timeZone) : null,
    rich: ok ? richView(ok) : null,
    inspected: ok ? GSC_INSPECTION_COPY.text.inspectedAt.replace('{relative}', relativeTime(ok.inspectedAt, input.now)) : null,
    canOpen: ok !== null && ok.link !== null,
  };
}

// ---- The shared store ---------------------------------------------------------------------------

/** What identifies a page: its URL without the fragment (main drops it too). */
export const gscInspectionKey = (url: string): string => withoutFragment(url);

const FAILED: GscInspectionAnswer = { status: 'unavailable', reason: 'invalid' };

export interface GscInspectionStore {
  /** The page's entry (`null`: nothing asked). */
  get(url: string): GscInspectionEntry | null;
  /**
   * Asks main about the page: `{ url }`, or `{ url, fresh: true }` to skip main's cache. Nothing is sent
   * while a request for the page runs, or for a page that is not `http(s)`.
   */
  inspect(url: string, fresh: boolean): void;
  /** Main's connection (`gsc.watch`'s version): a new one drops every entry and every running answer. */
  sync(connection: number): void;
  subscribe(listener: () => void): () => void;
}

/**
 * One entry per page, shared by every tab and both cards, for at most `held` pages (the oldest goes
 * first). `send` is `gsc.inspect`; a failed call reads as `invalid`.
 */
export function createGscInspectionStore(send: (input: GscInspectInput) => Promise<GscInspectionAnswer>, held: number = GSC_INSPECTION_HELD_PAGES): GscInspectionStore {
  const entries = new Map<string, GscInspectionEntry>();
  const listeners = new Set<() => void>();
  let connection: number | null = null;
  // Bumped by a new connection: answers asked under an older one are dropped.
  let generation = 0;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const put = (key: string, entry: GscInspectionEntry) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > held) entries.delete(entries.keys().next().value!);
    notify();
  };
  return {
    get: (url) => entries.get(gscInspectionKey(url)) ?? null,
    inspect(url, fresh) {
      const key = gscInspectionKey(url);
      if (!isWebUrl(key) || entries.get(key)?.inspecting) return;
      const asked = generation;
      put(key, { inspecting: true, answer: entries.get(key)?.answer ?? null });
      void send(fresh ? { url: key, fresh: true } : { url: key })
        .catch(() => FAILED)
        .then((answer) => {
          if (asked !== generation) return;
          put(key, { inspecting: false, answer });
        });
    },
    sync(next) {
      if (next === connection) return;
      // The first connection seen adopts what was asked before main answered (the palette).
      const first = connection === null;
      connection = next;
      if (first) return;
      generation += 1;
      entries.clear();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
