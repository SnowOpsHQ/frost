import webVitalsSource from 'virtual:web-vitals-iife';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { SPEED_LIMITS, SPEED_SETTLE_MS, SPEED_STATE_KEY, SPEED_WORLD_ID, type SpeedLimits } from '@app/specs/seo-speed.spec';

// The page-speed collector (spec `seo-speed.spec.ts`, `seo-speed.schema.spec.ts`; acceptance
// `seo-speed.feature.md`, Measurement). `measurePage` is one self-contained function, serialised
// with the web-vitals IIFE (bundled into main as a string, `vite.web-vitals.ts`) and its limits
// into `VITALS_SCRIPT`, and run in the tab's isolated world `SPEED_WORLD_ID`
// (`executeJavaScriptInIsolatedWorld`). Never in the main world: the page's scripts cannot see the
// library, its observers or its state, and cannot replace the `PerformanceObserver`, `performance`
// or DOM functions it uses (the isolated world has its own globals and prototypes). Performance
// entries are per document, so the isolated world observes the same paints, layout shifts,
// interactions and requests the page does. Verified in Electron 45 (Chromium 156): web-vitals runs
// unchanged in an isolated world.
//
// The first run in a document installs web-vitals (`reportAllChanges`, so every new value is kept;
// its observers are `buffered`, so a late start still sees LCP, CLS, FCP and TTFB) and a buffered
// `resource` observer, keeps their state in the world's global `SPEED_STATE_KEY`, and answers after
// `SPEED_SETTLE_MS` (the buffered entries arrive asynchronously). Later runs read that state at
// once. Every list and number is capped while it is read; main still has the answer validated in
// the analysis worker (`PerformanceMeasurementSchema`): it is page data.

/** The parts of the web-vitals library the collector calls. */
interface WebVitalsLibrary {
  onLCP(report: (metric: { value: number }) => void, options: { reportAllChanges: boolean }): void;
  onCLS(report: (metric: { value: number }) => void, options: { reportAllChanges: boolean }): void;
  onINP(report: (metric: { value: number }) => void, options: { reportAllChanges: boolean }): void;
  onFCP(report: (metric: { value: number }) => void, options: { reportAllChanges: boolean }): void;
  onTTFB(report: (metric: { value: number }) => void, options: { reportAllChanges: boolean }): void;
}

/** A Performance API entry as the collector reads it (structural: main needs no DOM lib). */
interface PageEntry {
  readonly name: string;
  readonly entryType: string;
  readonly startTime: number;
  readonly duration: number;
  readonly [field: string]: unknown;
}
interface PageNode {
  readonly firstElementChild: PageNode | null;
  readonly nextElementSibling: PageNode | null;
  readonly parentElement: PageNode | null;
}
/** The isolated world's globals the collector uses. */
export interface SpeedEnvironment {
  readonly performance: {
    now(): number;
    getEntriesByType(type: string): readonly PageEntry[];
    getEntriesByName(name: string): readonly PageEntry[];
  };
  readonly PerformanceObserver?: new (callback: (list: { getEntries(): readonly PageEntry[] }) => void) => { observe(options: { type: string; buffered: boolean }): void };
  readonly document: {
    readonly URL: string;
    readonly documentElement: PageNode | null;
    getElementsByTagName(name: string): { readonly length: number };
  };
  /** Where the state lives between runs (the isolated world's `globalThis`). */
  readonly global: Record<string, unknown>;
  setTimeout(callback: () => void, ms: number): unknown;
}

/**
 * Measures the page (`PerformanceMeasurementSchema`'s shape); installs the library and the observers
 * on its first run in the document. Runs in the isolated world only. Self-contained: it must not
 * reference anything outside this function.
 */
export function measurePage(env: SpeedEnvironment, loadLibrary: () => WebVitalsLibrary | undefined, L: SpeedLimits, settleMs: number, key: string, maxUrlChars: number): unknown {
  /** Chromium's default resource timing buffer size: a buffer this full may have dropped entries. */
  const DEFAULT_BUFFER = 250;
  const cut = (s: string, max: number): string => {
    if (s.length <= max) return s;
    let end = max;
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return s.slice(0, end);
  };
  const time = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, L.maxTimeMs) : 0);
  const bytes = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), L.maxBytes) : 0);
  const text = (v: unknown): string | null => (typeof v === 'string' ? cut(v, L.maxResourceFieldChars) : null);

  interface State {
    vitals: { lcp: number | null; cls: number | null; inp: number | null; fcp: number | null; ttfb: number | null };
    resources: unknown[];
    total: number;
    overflow: { transfer: number; encoded: number; decoded: number; weight: number };
    bufferFull: boolean;
  }
  let state = env.global[key] as State | undefined;
  const fresh = state === undefined;
  if (state === undefined) {
    const created: State = { vitals: { lcp: null, cls: null, inp: null, fcp: null, ttfb: null }, resources: [], total: 0, overflow: { transfer: 0, encoded: 0, decoded: 0, weight: 0 }, bufferFull: false };
    state = created;
    Object.defineProperty(env.global, key, { value: created, enumerable: false, configurable: false, writable: false });
    try {
      const lib = loadLibrary();
      if (lib) {
        const keep = (metric: keyof State['vitals'], max: number) => (m: { value: number }) => {
          if (typeof m.value === 'number' && Number.isFinite(m.value) && m.value >= 0) created.vitals[metric] = Math.min(m.value, max);
        };
        const options = { reportAllChanges: true };
        lib.onLCP(keep('lcp', L.maxTimeMs), options);
        lib.onCLS(keep('cls', 1_000), options);
        lib.onINP(keep('inp', L.maxTimeMs), options);
        lib.onFCP(keep('fcp', L.maxTimeMs), options);
        lib.onTTFB(keep('ttfb', L.maxTimeMs), options);
      }
    } catch {
      // No vitals (the values stay null); the resources are still measured.
    }
    const add = (entry: PageEntry): void => {
      created.total = Math.min(created.total + 1, L.maxCount);
      const transfer = bytes(entry['transferSize']);
      const encoded = bytes(entry['encodedBodySize']);
      const decoded = bytes(entry['decodedBodySize']);
      if (created.resources.length >= L.maxResources) {
        const o = created.overflow;
        o.transfer = Math.min(o.transfer + transfer, L.maxBytes);
        o.encoded = Math.min(o.encoded + encoded, L.maxBytes);
        o.decoded = Math.min(o.decoded + decoded, L.maxBytes);
        o.weight = Math.min(o.weight + (transfer > 0 ? transfer : encoded), L.maxBytes);
        return;
      }
      const name = typeof entry.name === 'string' ? entry.name : '';
      const status = entry['renderBlockingStatus'];
      created.resources.push({
        url: cut(name, L.maxResourceUrlChars),
        urlCut: name.length > L.maxResourceUrlChars,
        initiator: text(entry['initiatorType']) ?? '',
        contentType: text(entry['contentType']),
        contentEncoding: text(entry['contentEncoding']),
        transfer,
        encoded,
        decoded,
        start: time(entry.startTime),
        duration: time(entry.duration),
        blocking: status === 'blocking' ? true : status === 'non-blocking' ? false : null,
      });
    };
    try {
      created.bufferFull = env.performance.getEntriesByType('resource').length >= DEFAULT_BUFFER;
      if (env.PerformanceObserver) {
        const observer = new env.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) add(entry);
        });
        observer.observe({ type: 'resource', buffered: true });
      }
    } catch {
      // No resource observer: no resources.
    }
  }
  const s = state;

  const collect = () => {
    const begin = env.performance.now();
    const navEntry = env.performance.getEntriesByType('navigation')[0];
    const navigation = navEntry
      ? {
          type: typeof navEntry['type'] === 'string' ? cut(navEntry['type'] as string, 32) : '',
          redirectCount: Math.min(bytes(navEntry['redirectCount']), L.maxCount),
          redirectStart: time(navEntry['redirectStart']),
          redirectEnd: time(navEntry['redirectEnd']),
          fetchStart: time(navEntry['fetchStart']),
          domainLookupStart: time(navEntry['domainLookupStart']),
          domainLookupEnd: time(navEntry['domainLookupEnd']),
          connectStart: time(navEntry['connectStart']),
          secureConnectionStart: time(navEntry['secureConnectionStart']),
          connectEnd: time(navEntry['connectEnd']),
          requestStart: time(navEntry['requestStart']),
          responseStart: time(navEntry['responseStart']),
          responseEnd: time(navEntry['responseEnd']),
          domInteractive: time(navEntry['domInteractive']),
          domContentLoadedEventEnd: time(navEntry['domContentLoadedEventEnd']),
          loadEventEnd: time(navEntry['loadEventEnd']),
          activationStart: time(navEntry['activationStart']),
          transfer: bytes(navEntry['transferSize']),
          encoded: bytes(navEntry['encodedBodySize']),
          decoded: bytes(navEntry['decodedBodySize']),
          contentType: text(navEntry['contentType']),
          contentEncoding: text(navEntry['contentEncoding']),
        }
      : null;
    // Hidden before the first paint: the page loaded in the background (no paint metric is meaningful).
    let hiddenAt = Infinity;
    for (const entry of env.performance.getEntriesByType('visibility-state')) if (entry.name === 'hidden' && entry.startTime < hiddenAt) hiddenAt = entry.startTime;
    const paint = env.performance.getEntriesByName('first-contentful-paint')[0];
    const loadedHidden = hiddenAt < (paint ? paint.startTime : Infinity);
    // DOM size: the element count (native), and the depth from a bounded walk.
    const elements = Math.min(env.document.getElementsByTagName('*').length, L.maxCount);
    let depth = 0;
    let depthComplete = true;
    const root = env.document.documentElement;
    if (root) {
      const deadline = env.performance.now() + L.domWalkBudgetMs;
      let node: PageNode | null = root;
      let level = 1;
      let visited = 0;
      while (node) {
        visited += 1;
        if (level > depth) depth = level;
        if (visited >= L.maxDomWalk || ((visited & 1023) === 0 && env.performance.now() > deadline)) {
          depthComplete = false;
          break;
        }
        if (node.firstElementChild) {
          node = node.firstElementChild;
          level += 1;
          continue;
        }
        while (node && node !== root && !node.nextElementSibling) {
          node = node.parentElement;
          level -= 1;
        }
        node = node && node !== root ? node.nextElementSibling : null;
      }
    }
    const url = env.document.URL;
    return {
      url: cut(url, maxUrlChars),
      measuredAt: Date.now(),
      durationMs: Math.min(Math.max(0, env.performance.now() - begin), L.maxTimeMs),
      vitals: { ...s.vitals },
      loadedHidden,
      navigation,
      resources: s.resources.slice(),
      resourceTotal: Math.max(s.total, s.resources.length),
      overflow: { ...s.overflow },
      bufferFull: s.bufferFull,
      dom: { elements, depth: Math.min(depth, L.maxCount), depthComplete },
    };
  };
  if (!fresh) return collect();
  return new Promise((resolve) => {
    env.setTimeout(() => resolve(collect()), settleMs);
  });
}

/**
 * The script run in the speed world: `measurePage` with the isolated world's globals, the web-vitals
 * IIFE (wrapped in a function, so its `webVitals` stays local), the limits and the state key.
 */
export const VITALS_SCRIPT = `(${measurePage.toString()})({ performance, PerformanceObserver: globalThis.PerformanceObserver, document, global: globalThis, setTimeout: (callback, ms) => setTimeout(callback, ms) }, function () {
${webVitalsSource}
return webVitals;
}, ${JSON.stringify(SPEED_LIMITS)}, ${SPEED_SETTLE_MS}, ${JSON.stringify(SPEED_STATE_KEY)}, ${SNAPSHOT_LIMITS.maxUrlChars})`;

/** The part of a tab's WebContents the collector needs. */
export interface SpeedTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

/** Runs the collector in `contents`' speed world; resolves its (untrusted, unvalidated) answer. */
export function runVitals(contents: SpeedTarget): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SPEED_WORLD_ID, [{ code: VITALS_SCRIPT }]);
}

/** `promise`, or `onTimeout` after `ms` (the promise keeps running; its late answer is ignored). */
export function withTimeout<T, U>(promise: Promise<T>, ms: number, onTimeout: U): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<U>((resolve) => (timer = setTimeout(() => resolve(onTimeout), ms)))]).finally(() => clearTimeout(timer));
}
