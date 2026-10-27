import type { SpeedResponse } from '@app/seo-core';
import { SPEED_MEASURE_TIMEOUT_MS, SPEED_MIN_INTERVAL_MS, type SpeedUnavailableReason } from '@app/specs/seo-speed.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { displayUrl } from '../browser/address';
import { aliveContents, type Tab, type TabView } from '../browser/tab-model';
import type { SpeedAnalysisResult } from './analysis';
import { withoutFragment } from './auditor';
import { withTimeout } from './vitals';

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

type TabContents = TabView['webContents'];

export interface TabSpeedOptions {
  /** Runs the collector in the tab (`runVitals`); resolves its raw, unvalidated answer. */
  readonly measure: (contents: TabContents) => Promise<unknown>;
  /** Validates and summarises an answer off the main thread (the analysis worker's `analyseSpeed`). Never rejects. */
  readonly analyse: (raw: unknown) => Promise<SpeedAnalysisResult>;
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
  /** `tab` closed, or its page went: forgotten. */
  forget(tab: Tab): void;
}

interface Entry {
  key: string;
  /** Bumped by every new document or URL: answers of an older generation are dropped. */
  generation: number;
  inflight: Promise<SpeedResponse> | null;
  /** A collection the page has not answered yet (it timed out): no other one starts meanwhile. */
  busy: object | null;
  last: { readonly at: number; readonly response: SpeedResponse } | null;
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

export function createTabSpeed(options: TabSpeedOptions | undefined, ctx: TabSpeedContext): TabSpeed {
  const timeoutMs = options?.timeoutMs ?? SPEED_MEASURE_TIMEOUT_MS;
  const minIntervalMs = options?.minIntervalMs ?? SPEED_MIN_INTERVAL_MS;
  const now = options?.now ?? Date.now;
  const entries = new Map<number, Entry>();

  const reset = (entry: Entry, key: string): void => {
    entry.key = key;
    entry.generation += 1;
    entry.inflight = null;
    entry.busy = null;
    entry.last = null;
  };

  /** One collection and its analysis, for `key` in generation `generation`. */
  const run = async (tab: Tab, entry: Entry, contents: TabContents, url: string, key: string): Promise<SpeedResponse> => {
    const generation = entry.generation;
    const shown = displayUrl(url);
    const token = {};
    entry.busy = token;
    let collection: Promise<unknown>;
    try {
      collection = options!.measure(contents);
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
    let response: SpeedResponse;
    if (raw === TIMEOUT) response = { status: 'unavailable', url: shown, reason: 'timeout' };
    else if (raw === FAILED) response = { status: 'unavailable', url: shown, reason: 'measurement-failed' };
    else {
      let answer: SpeedAnalysisResult;
      try {
        answer = await options!.analyse(raw);
      } catch {
        answer = { ok: false, reason: 'analysis-failed' };
      }
      // A measurement of another URL (the document changed under it) is not this page's.
      if (answer.ok && withoutFragment(answer.report.url) !== key) answer = { ok: false, reason: 'invalid-measurement' };
      response = answer.ok ? { status: 'ready', url: shown, report: answer.report } : { status: 'unavailable', url: shown, reason: answer.reason };
    }
    const current = measurable(tab);
    if (entries.get(tab.id) !== entry || entry.generation !== generation || !ctx.isOpen(tab) || !current.ok || current.key !== key) {
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
        entry = { key: target.key, generation: 0, inflight: null, busy: null, last: null };
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
    },

    forget(tab) {
      entries.delete(tab.id);
    },
  };
}
