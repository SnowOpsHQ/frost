import type { SpeedResponse } from '@app/seo-core';
import { SPEED_LIMITS, SPEED_MEASURE_TIMEOUT_MS, SPEED_MIN_INTERVAL_MS, type SpeedUnavailableReason } from '@app/specs/seo-speed.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { displayUrl } from '../browser/address';
import { aliveContents, type Tab, type TabView } from '../browser/tab-model';
import type { SpeedAnalysisResult } from './analysis';
import { reportsUrl, withoutFragment } from './auditor';
import { withTimeout, type CollectOptions } from './vitals';
import type { ShownTimes } from './vitals-shown';

// Live page-speed measurements, per tab (spec `seo-speed.spec.ts`; acceptance `seo-speed.feature.md`,
// Main). `seo.measureSpeed` asks for the active tab's measurement: main runs the collector in the
// tab's speed world (`runVitals`), has the answer validated and summarised in the analysis worker,
// and answers the report, never page data it parsed itself. Bounded: only the active tab showing an
// http(s) page; at most one collection in flight per tab (concurrent requests share it); none
// sooner than `SPEED_MIN_INTERVAL_MS` after the last one of the same document (that one is
// answered again); a collection the page does not answer within `SPEED_MEASURE_TIMEOUT_MS` is
// `timeout`, and no other one starts until the page has answered it. A measurement belongs to one
// document and URL (fragment aside): a new document (`navigated`) or another URL drops what was
// measured and anything in flight, and a late answer for the old page is never shown.
//
// Each collection answers only the resources added since the ones main already holds
// (`CollectOptions.since` / `epoch`); main puts the list back together (`reassemble`: it only checks
// the answer's shape and caps the list, never reads a record) before the worker validates it. It
// also tells the collector when the document was first shown and hidden (`ShownTimes`).

type TabContents = TabView['webContents'];

export interface TabSpeedOptions {
  /** Runs the collector in the tab (`runVitals`) with `options`; resolves its raw, unvalidated answer. */
  readonly measure: (contents: TabContents, options: Partial<CollectOptions>) => Promise<unknown>;
  /** Validates and summarises an answer off the main thread (the analysis worker's `analyseSpeed`). Never rejects. */
  readonly analyse: (raw: unknown) => Promise<SpeedAnalysisResult>;
  /** When each tab's document was first shown and hidden (main's `createShownTimes`); without it, not known. */
  readonly times?: ShownTimes;
  readonly timeoutMs?: number;
  readonly minIntervalMs?: number;
  readonly now?: () => number;
}

export interface TabSpeedContext {
  /** Whether `tab` is the active tab of an attached window. */
  isActive(tab: Tab): boolean;
  /** Whether `tab` is still open. */
  isOpen(tab: Tab): boolean;
}

export interface TabSpeed {
  /** Measures `tab` (see above); never rejects. */
  measure(tab: Tab | undefined): Promise<SpeedResponse>;
  /** `tab` committed a new document: what was measured, and anything in flight, is dropped. */
  navigated(tab: Tab): void;
  /** `tab`'s view was attached to the window. */
  shown(tab: Tab): void;
  /** `tab`'s view was detached. */
  hidden(tab: Tab): void;
  /** `tab` closed, or its page went: forgotten. */
  forget(tab: Tab): void;
}

/** The resources main holds for a document: the records of one epoch, in order. */
export interface HeldResources {
  readonly epoch: number;
  readonly records: readonly unknown[];
}

/**
 * The collector's answer with its whole resource list: an answer from offset 0 replaces what is
 * held, one from the held list's end extends it (capped at `maxResources`); anything else cannot be
 * put together (`null`: ask again from 0). An answer of another shape passes through unchanged (the
 * worker rejects it). Only the shape is looked at, never a record.
 */
export function reassemble(raw: unknown, held: HeldResources | null, max: number = SPEED_LIMITS.maxResources): { readonly measurement: unknown; readonly held: HeldResources | null } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { measurement: raw, held: null };
  const answer = raw as { resources?: unknown; resourceOffset?: unknown; resourceEpoch?: unknown };
  if (!Array.isArray(answer.resources) || !Number.isInteger(answer.resourceOffset) || !Number.isInteger(answer.resourceEpoch)) return { measurement: raw, held: null };
  const offset = answer.resourceOffset as number;
  const epoch = answer.resourceEpoch as number;
  let records: readonly unknown[];
  if (offset === 0) records = answer.resources.slice(0, max);
  else if (held && held.epoch === epoch && held.records.length === offset) records = held.records.concat(answer.resources).slice(0, max);
  else return null;
  return { measurement: { ...raw, resources: records, resourceOffset: 0 }, held: { epoch, records } };
}

interface Entry {
  key: string;
  /** Bumped by every new document or URL: answers of an older generation are dropped. */
  generation: number;
  inflight: Promise<SpeedResponse> | null;
  /** A collection the page has not answered yet (it timed out): no other one starts meanwhile. */
  busy: object | null;
  last: { readonly at: number; readonly response: SpeedResponse } | null;
  held: HeldResources | null;
}

type Measurable = { readonly ok: true; readonly contents: TabContents; readonly url: string; readonly key: string } | { readonly ok: false; readonly reason: SpeedUnavailableReason };

function measurable(tab: Tab): Measurable {
  if (tab.crashed) return { ok: false, reason: 'crashed' };
  if (tab.error) return { ok: false, reason: 'load-error' };
  const contents = tab.view ? aliveContents(tab.view) : undefined;
  if (!contents) return { ok: false, reason: 'no-page' };
  const url = contents.getURL();
  return isWebUrl(url) ? { ok: true, contents, url, key: withoutFragment(url) } : { ok: false, reason: 'no-page' };
}

/** The WebContents id of `tab`'s view (`null`: none, or a test fake without one). */
function contentsIdOf(tab: Tab): number | null {
  const contents = tab.view ? aliveContents(tab.view) : undefined;
  const id = (contents as { id?: unknown } | undefined)?.id;
  return typeof id === 'number' ? id : null;
}

export function createTabSpeed(options: TabSpeedOptions | undefined, ctx: TabSpeedContext): TabSpeed {
  const timeoutMs = options?.timeoutMs ?? SPEED_MEASURE_TIMEOUT_MS;
  const minIntervalMs = options?.minIntervalMs ?? SPEED_MIN_INTERVAL_MS;
  const now = options?.now ?? Date.now;
  const times = options?.times;
  const entries = new Map<number, Entry>();

  const reset = (entry: Entry, key: string): void => {
    entry.key = key;
    entry.generation += 1;
    entry.inflight = null;
    entry.busy = null;
    entry.last = null;
    entry.held = null;
  };

  /** One collection and its analysis, for `key` in the entry's current generation. */
  const run = async (tab: Tab, entry: Entry, contents: TabContents, url: string, key: string): Promise<SpeedResponse> => {
    const generation = entry.generation;
    const shown = displayUrl(url);
    const token = {};
    entry.busy = token;
    const id = contentsIdOf(tab);
    const held = entry.held;
    const collectOptions: Partial<CollectOptions> = { ...(id !== null && times ? times.of(id) : {}), since: held?.records.length ?? 0, epoch: held?.epoch ?? -1 };
    let collection: Promise<unknown>;
    try {
      collection = options!.measure(contents, collectOptions);
    } catch (error) {
      collection = Promise.reject(error);
    }
    const TIMEOUT = {};
    const FAILED = {};
    const settled = collection.then(
      (value) => value,
      () => FAILED,
    );
    // The page answered (late or not): another collection may start.
    void settled.then(() => {
      if (entry.busy === token) entry.busy = null;
    });
    const raw = await withTimeout(settled, timeoutMs, TIMEOUT);
    const stillHere = () => entries.get(tab.id) === entry && entry.generation === generation;
    let response: SpeedResponse;
    if (raw === TIMEOUT) response = { status: 'unavailable', url: shown, reason: 'timeout' };
    else if (raw === FAILED) response = { status: 'unavailable', url: shown, reason: 'measurement-failed' };
    else {
      const whole = reassemble(raw, held);
      if (whole === null) {
        // Could not be put together (the page's list changed under us): ask from the start next time.
        if (stillHere()) entry.held = null;
        return entry.last?.response ?? { status: 'pending', url: shown };
      }
      if (stillHere()) entry.held = whole.held;
      let answer: SpeedAnalysisResult;
      try {
        answer = await options!.analyse(whole.measurement);
      } catch {
        answer = { ok: false, reason: 'analysis-failed' };
      }
      // A measurement of another URL (the document changed under it) is not this page's.
      if (answer.ok && !reportsUrl(answer.report.url, key)) answer = { ok: false, reason: 'invalid-measurement' };
      response = answer.ok ? { status: 'ready', url: shown, report: answer.report } : { status: 'unavailable', url: shown, reason: answer.reason };
    }
    const current = measurable(tab);
    if (!stillHere() || !ctx.isOpen(tab) || !current.ok || current.key !== key) {
      // The page moved on: this answer is dropped.
      return current.ok ? { status: 'pending', url: displayUrl(current.url) } : { status: 'unavailable', url: tab.state.url, reason: current.reason };
    }
    entry.last = { at: now(), response };
    return response;
  };

  return {
    measure(tab) {
      if (!tab) return Promise.resolve({ status: 'unavailable', url: '', reason: 'no-tab' });
      const target = measurable(tab);
      if (!target.ok) return Promise.resolve({ status: 'unavailable', url: tab.state.url, reason: target.reason });
      const shown = displayUrl(target.url);
      if (!ctx.isActive(tab)) return Promise.resolve({ status: 'unavailable', url: shown, reason: 'background' });
      if (!options) return Promise.resolve({ status: 'pending', url: shown });
      let entry = entries.get(tab.id);
      if (!entry) {
        entry = { key: target.key, generation: 0, inflight: null, busy: null, last: null, held: null };
        entries.set(tab.id, entry);
      } else if (entry.key !== target.key) reset(entry, target.key);
      if (entry.inflight) return entry.inflight;
      const last = entry.last;
      if (last && now() - last.at < minIntervalMs) return Promise.resolve({ ...last.response, url: shown } as SpeedResponse);
      if (entry.busy) return Promise.resolve(last ? ({ ...last.response, url: shown } as SpeedResponse) : { status: 'unavailable', url: shown, reason: 'timeout' });
      const own = entry;
      const inflight = run(tab, own, target.contents, target.url, target.key).finally(() => {
        if (own.inflight === inflight) own.inflight = null;
      });
      own.inflight = inflight;
      return inflight;
    },

    navigated(tab) {
      const entry = entries.get(tab.id);
      if (entry) reset(entry, '');
      const id = contentsIdOf(tab);
      if (id !== null) times?.committed(id);
    },

    shown(tab) {
      const id = contentsIdOf(tab);
      if (id !== null) times?.shown(id);
    },

    hidden(tab) {
      const id = contentsIdOf(tab);
      if (id !== null) times?.hidden(id);
    },

    forget(tab) {
      entries.delete(tab.id);
      const id = contentsIdOf(tab);
      if (id !== null) times?.forget(id);
    },
  };
}
