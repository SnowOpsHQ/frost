import webVitalsSource from 'virtual:web-vitals-iife';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import {
  DOM_REFRESH_EVERY,
  PAINT_GRACE_MS,
  SHOWN_TOLERANCE_MS,
  SPEED_LIMITS,
  SPEED_SETTLE_MS,
  SPEED_STATE_KEY,
  SPEED_WORLD_ID,
  TRUSTED_ONLY_EVENTS,
  type SpeedLimits,
} from '@app/specs/seo-speed.spec';

// The page-speed collector (spec `seo-speed.spec.ts`, `seo-speed.schema.spec.ts`; acceptance
// `seo-speed.feature.md`, Measurement). `measurePage` is one self-contained function, serialised
// with the web-vitals IIFE (bundled into main as a string, `vite.web-vitals.ts`), its limits and
// each run's options into `vitalsScript(…)`, and run in the tab's isolated world `SPEED_WORLD_ID`
// (`executeJavaScriptInIsolatedWorld`). Never in the main world: the page's scripts cannot see the
// library, its observers or its state, and cannot replace the `PerformanceObserver`, `performance`
// or DOM functions it uses (the isolated world has its own globals and prototypes). They still
// share the document: they can dispatch events, clear the timing buffers or change the DOM, which
// the collector guards against where it can (trusted-only lifecycle events, observers installed at
// `dom-ready`) and the panel notes where it cannot. Performance entries are per document, so the
// isolated world observes the same paints, layout shifts, interactions and requests the page does.
// Verified in Electron 45 (Chromium 156): web-vitals runs unchanged in an isolated world.
//
// The first run in a document (main primes it at `dom-ready` of the active tab) installs: a guard
// that lets only trusted `TRUSTED_ONLY_EVENTS` reach the world's listeners, web-vitals
// (`reportAllChanges`, buffered observers, so a late start still sees LCP, CLS, FCP and TTFB) and a
// buffered `resource` observer (and a `currententrychange` listener that marks a route change as it
// happens), keeping their state in the world's global `SPEED_STATE_KEY`. The
// buffered entries arrive asynchronously, so the state holds a settle promise for `SPEED_SETTLE_MS`
// that every run made meanwhile awaits. Every list and number is capped while it is read; main
// still has the answer validated in the analysis worker (`PerformanceMeasurementSchema`): it is
// page data.

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
type Listener = ((event: { readonly isTrusted: boolean }) => unknown) | { handleEvent(event: { readonly isTrusted: boolean }): unknown } | null;
interface ListenerTarget {
  addEventListener(type: string, listener: Listener, options?: unknown): void;
  removeEventListener(type: string, listener: Listener, options?: unknown): void;
}
/** The isolated world's globals the collector uses. */
export interface SpeedEnvironment {
  readonly performance: {
    readonly timeOrigin: number;
    now(): number;
    getEntriesByType(type: string): readonly PageEntry[];
    getEntriesByName(name: string): readonly PageEntry[];
    addEventListener?(type: string, listener: () => void): void;
  };
  readonly PerformanceObserver?: new (callback: (list: { getEntries(): readonly PageEntry[] }) => void) => { observe(options: { type: string; buffered: boolean }): void };
  /** The world's `EventTarget` (its prototype's listener methods are wrapped, `TRUSTED_ONLY_EVENTS`). */
  readonly EventTarget?: { readonly prototype: ListenerTarget };
  /** The Navigation API's `navigation`: its trusted `currententrychange` marks a route change as it happens. */
  readonly navigation?: { addEventListener(type: string, listener: (event: { readonly isTrusted: boolean }) => void): void };
  readonly document: {
    readonly URL: string;
    readonly documentElement: PageNode | null;
    getElementsByTagName(name: string): { readonly length: number };
    querySelectorAll(selectors: string): { readonly length: number };
  };
  /** Where the state lives between runs (the isolated world's `globalThis`). */
  readonly global: Record<string, unknown>;
  setTimeout(callback: () => void, ms: number): unknown;
}

/** What main tells one run of the collector (`seo-speed.spec.ts`). */
export interface CollectOptions {
  /** Install only (main's `dom-ready` priming): answer `null` at once. */
  readonly prime: boolean;
  /** When the tab first showed this document (epoch ms; `null`: not known). */
  readonly shownAt: number | null;
  /** When it was first hidden after that (epoch ms; `null`: not since). */
  readonly hiddenAt: number | null;
  /** How many itemised resources of `epoch` main already holds: only later ones are answered. */
  readonly since: number;
  readonly epoch: number;
  /** The app runs on a native Wayland ozone platform (Linux): say when no paint was ever reported. */
  readonly nativeWayland: boolean;
}

export const DEFAULT_COLLECT_OPTIONS: CollectOptions = { prime: false, shownAt: null, hiddenAt: null, since: 0, epoch: -1, nativeWayland: false };

/** The constants the collector needs, besides its limits. */
export interface CollectConstants {
  readonly settleMs: number;
  readonly key: string;
  readonly maxUrlChars: number;
  readonly shownToleranceMs: number;
  readonly paintGraceMs: number;
  readonly domRefreshEvery: number;
  readonly trustedOnly: readonly string[];
}

export const COLLECT_CONSTANTS: CollectConstants = {
  settleMs: SPEED_SETTLE_MS,
  key: SPEED_STATE_KEY,
  maxUrlChars: SNAPSHOT_LIMITS.maxUrlChars,
  shownToleranceMs: SHOWN_TOLERANCE_MS,
  paintGraceMs: PAINT_GRACE_MS,
  domRefreshEvery: DOM_REFRESH_EVERY,
  trustedOnly: TRUSTED_ONLY_EVENTS,
};

/**
 * Measures the page (`PerformanceMeasurementSchema`'s shape, with `resources` possibly only the
 * records after `options.since`); installs the guard, the library and the observers on its first run
 * in the document. Runs in the isolated world only. Self-contained: it must not reference anything
 * outside this function.
 */
export function measurePage(env: SpeedEnvironment, loadLibrary: () => WebVitalsLibrary | undefined, L: SpeedLimits, C: CollectConstants, options: CollectOptions): unknown {
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
  const withoutFragment = (url: string): string => {
    const hash = url.indexOf('#');
    return hash < 0 ? url : url.slice(0, hash);
  };

  interface DomSize {
    elements: number;
    depth: number;
    depthComplete: boolean;
    hints: number;
  }
  interface ResourceRecord {
    url: string;
    urlCut: boolean;
    initiator: string;
    contentType: string | null;
    contentEncoding: string | null;
    transfer: number;
    encoded: number;
    decoded: number;
    start: number;
    duration: number;
    blocking: boolean | null;
  }
  interface State {
    vitals: { lcp: number | null; cls: number | null; inp: number | null; fcp: number | null; ttfb: number | null };
    resources: ResourceRecord[];
    total: number;
    overflow: { transfer: number; encoded: number; decoded: number; weight: number };
    bufferFull: boolean;
    /** Bumped when the URL changes inside the document: the resources start again. */
    epoch: number;
    url: string;
    /** When `url` was last seen (`performance.now()`): a change found later happened after it. */
    seenAt: number;
    /** Where this epoch starts (`performance.now()`): requests that started earlier are the old route's. */
    boundary: number;
    soft: boolean;
    /** Pending while the first run's buffered entries arrive; every run meanwhile awaits it. */
    settling: Promise<void> | null;
    collections: number;
    dom: DomSize | null;
  }
  /**
   * A route change (the URL without its fragment changed): a new epoch, from the moment it happened
   * (`exact`: now, from the trusted `currententrychange`) or else from the last time the old URL was
   * seen. The requests already observed that started at or after it are kept (they are the new
   * route's, even if no collection ran in between); the earlier ones go with the old route.
   */
  const checkRoute = (st: State, exact: boolean): void => {
    const now = env.performance.now();
    const url = withoutFragment(env.document.URL);
    if (url !== st.url) {
      const boundary = exact ? now : st.seenAt;
      st.url = url;
      st.epoch += 1;
      st.boundary = boundary;
      st.resources = st.resources.filter((record) => record.start >= boundary);
      st.total = st.resources.length;
      st.overflow = { transfer: 0, encoded: 0, decoded: 0, weight: 0 };
      st.soft = true;
      st.dom = null;
    }
    st.seenAt = now;
  };
  let state = env.global[C.key] as State | undefined;
  if (state === undefined) {
    const created: State = {
      vitals: { lcp: null, cls: null, inp: null, fcp: null, ttfb: null },
      resources: [],
      total: 0,
      overflow: { transfer: 0, encoded: 0, decoded: 0, weight: 0 },
      bufferFull: false,
      epoch: 0,
      url: withoutFragment(env.document.URL),
      seenAt: env.performance.now(),
      boundary: 0,
      soft: false,
      settling: null,
      collections: 0,
      dom: null,
    };
    state = created;
    Object.defineProperty(env.global, C.key, { value: created, enumerable: false, configurable: false, writable: false });
    // Only the browser's own lifecycle events reach this world's listeners (a page can dispatch a
    // synthetic `pageshow` on the shared document, which would reset the library's metrics).
    try {
      const proto = env.EventTarget?.prototype;
      if (proto) {
        const add = proto.addEventListener;
        const remove = proto.removeEventListener;
        const guarded = new WeakMap<object, Listener>();
        const guard = (listener: Listener): Listener => {
          if (listener === null || (typeof listener !== 'function' && typeof listener !== 'object')) return listener;
          let wrapped = guarded.get(listener);
          if (!wrapped) {
            const own = listener;
            wrapped = function (this: unknown, event: { readonly isTrusted: boolean }) {
              if (!event || event.isTrusted !== true) return undefined;
              return typeof own === 'function' ? own.call(this, event) : own.handleEvent(event);
            };
            guarded.set(listener, wrapped);
          }
          return wrapped;
        };
        const trustedOnly = (type: unknown): boolean => typeof type === 'string' && C.trustedOnly.includes(type);
        Object.defineProperty(proto, 'addEventListener', {
          configurable: true,
          writable: true,
          value: function (this: ListenerTarget, type: string, listener: Listener, opts?: unknown) {
            return add.call(this, type, trustedOnly(type) ? guard(listener) : listener, opts);
          },
        });
        Object.defineProperty(proto, 'removeEventListener', {
          configurable: true,
          writable: true,
          value: function (this: ListenerTarget, type: string, listener: Listener, opts?: unknown) {
            const own = trustedOnly(type) && listener !== null && (typeof listener === 'object' || typeof listener === 'function') ? (guarded.get(listener) ?? listener) : listener;
            return remove.call(this, type, own, opts);
          },
        });
      }
    } catch {
      // No guard: the library still runs.
    }
    try {
      const lib = loadLibrary();
      if (lib) {
        const keep = (metric: keyof State['vitals'], max: number) => (m: { value: number }) => {
          if (typeof m.value === 'number' && Number.isFinite(m.value) && m.value >= 0) created.vitals[metric] = Math.min(m.value, max);
        };
        const reportAll = { reportAllChanges: true };
        lib.onLCP(keep('lcp', L.maxTimeMs), reportAll);
        lib.onCLS(keep('cls', 1_000), reportAll);
        lib.onINP(keep('inp', L.maxTimeMs), reportAll);
        lib.onFCP(keep('fcp', L.maxTimeMs), reportAll);
        lib.onTTFB(keep('ttfb', L.maxTimeMs), reportAll);
      }
    } catch {
      // No vitals (the values stay null); the resources are still measured.
    }
    const add = (entry: PageEntry): void => {
      // Started before this epoch's route change: the old route's request.
      if (time(entry.startTime) < created.boundary) return;
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
      env.performance.addEventListener?.('resourcetimingbufferfull', () => {
        created.bufferFull = true;
      });
      if (env.PerformanceObserver) {
        const observer = new env.PerformanceObserver((list) => {
          // A route change since the last look is found before its requests are added.
          checkRoute(created, false);
          for (const entry of list.getEntries()) add(entry);
        });
        observer.observe({ type: 'resource', buffered: true });
      }
    } catch {
      // No resource observer: no resources.
    }
    try {
      // Fired by the browser inside `pushState` / `replaceState` / a traversal, before the route's
      // own requests start; a page's synthetic one is ignored.
      env.navigation?.addEventListener('currententrychange', (event) => {
        if (event && event.isTrusted === true) checkRoute(created, true);
      });
    } catch {
      // No Navigation API: route changes are found by the observer and the collections.
    }
    created.settling = new Promise<void>((resolve) => {
      env.setTimeout(() => {
        created.settling = null;
        resolve();
      }, C.settleMs);
    });
  }
  const s = state;

  const domSize = (): DomSize => {
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
    let hints = 0;
    try {
      hints = Math.min(env.document.querySelectorAll('img[src], script[src], link[rel~="stylesheet" i][href]').length, L.maxCount);
    } catch {
      hints = 0;
    }
    return { elements, depth: Math.min(depth, L.maxCount), depthComplete, hints };
  };

  const collect = () => {
    const begin = env.performance.now();
    // The URL changed inside the document (a route change) and nothing noticed yet: a new epoch.
    const url = env.document.URL;
    checkRoute(s, false);
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
    // Hidden before the first paint: by the document's own visibility entries, or by main's
    // first-shown / first-hidden times (frost's background tabs report `visible`).
    const paint = env.performance.getEntriesByName('first-contentful-paint')[0];
    const paintAt = paint ? paint.startTime : Infinity;
    let hiddenAt = Infinity;
    for (const entry of env.performance.getEntriesByType('visibility-state')) if (entry.name === 'hidden' && entry.startTime < hiddenAt) hiddenAt = entry.startTime;
    const origin = env.performance.timeOrigin;
    const shownLate = options.shownAt !== null && Number.isFinite(origin) && options.shownAt - origin > C.shownToleranceMs;
    const hiddenEarly = options.hiddenAt !== null && Number.isFinite(origin) && options.hiddenAt - origin < paintAt;
    const loadedHidden = hiddenAt < paintAt || shownLate || hiddenEarly;
    const vitals = { ...s.vitals };
    if (loadedHidden) {
      vitals.fcp = null;
      vitals.lcp = null;
      vitals.cls = null;
    }
    // Native Wayland: no paint entry at all, some time after the load event.
    const painted = env.performance.getEntriesByType('paint').length > 0;
    const loadEnd = navigation ? navigation.loadEventEnd : 0;
    const paintUnavailable = options.nativeWayland && !loadedHidden && !painted && loadEnd > 0 && env.performance.now() - loadEnd >= C.paintGraceMs;
    // The DOM's size: on the first collection and every `domRefreshEvery` after.
    if (s.dom === null || s.collections % C.domRefreshEvery === 0) s.dom = domSize();
    s.collections += 1;
    // Only what main does not hold yet, when it holds this epoch's first `since` records.
    const offset = options.epoch === s.epoch && options.since > 0 && options.since <= s.resources.length ? options.since : 0;
    return {
      url: cut(url, C.maxUrlChars),
      measuredAt: Date.now(),
      durationMs: Math.min(Math.max(0, env.performance.now() - begin), L.maxTimeMs),
      vitals,
      loadedHidden,
      navigation,
      resources: s.resources.slice(offset),
      resourceTotal: Math.max(s.total, s.resources.length),
      overflow: { ...s.overflow },
      resourceOffset: offset,
      resourceEpoch: s.epoch,
      softNavigation: s.soft,
      bufferFull: s.bufferFull,
      paintUnavailable,
      resourceHints: s.dom.hints,
      dom: { elements: s.dom.elements, depth: s.dom.depth, depthComplete: s.dom.depthComplete },
    };
  };
  if (options.prime) return null;
  const settling = s.settling;
  return settling ? settling.then(collect) : collect();
}

/** The script's fixed part: `measurePage` called with the world's globals, the web-vitals IIFE (wrapped, so `webVitals` stays local), the limits and constants. */
const SCRIPT_HEAD = `(${measurePage.toString()})({ performance, PerformanceObserver: globalThis.PerformanceObserver, EventTarget: globalThis.EventTarget, navigation: globalThis.navigation, document, global: globalThis, setTimeout: (callback, ms) => setTimeout(callback, ms) }, function () {
${webVitalsSource}
return webVitals;
}, ${JSON.stringify(SPEED_LIMITS)}, ${JSON.stringify(COLLECT_CONSTANTS)}, `;

/** The script run in the speed world for one collection (`options`, as JSON, is its last argument). */
export function vitalsScript(options: Partial<CollectOptions> = {}): string {
  const all: CollectOptions = { ...DEFAULT_COLLECT_OPTIONS, ...options };
  const finite = (n: number | null) => (n === null || !Number.isFinite(n) ? null : n);
  const clean: CollectOptions = {
    prime: all.prime === true,
    shownAt: finite(all.shownAt),
    hiddenAt: finite(all.hiddenAt),
    since: Number.isInteger(all.since) && all.since > 0 ? all.since : 0,
    epoch: Number.isInteger(all.epoch) ? all.epoch : -1,
    nativeWayland: all.nativeWayland === true,
  };
  return `${SCRIPT_HEAD}${JSON.stringify(clean)})`;
}

/** The part of a tab's WebContents the collector needs. */
export interface SpeedTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

/** Runs the collector in `contents`' speed world; resolves its (untrusted, unvalidated) answer (`null` when priming). */
export function runVitals(contents: SpeedTarget, options: Partial<CollectOptions> = {}): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(SPEED_WORLD_ID, [{ code: vitalsScript(options) }]);
}

/**
 * Whether paint timing may never arrive: Linux on a Wayland ozone platform (`--ozone-platform=wayland`,
 * or `auto` / the hint / nothing in a Wayland session). `--ozone-platform=x11` (or `headless`) is not.
 */
export function nativeWayland(platform: string, ozonePlatform: string, ozoneHint: string, env: Readonly<Record<string, string | undefined>>): boolean {
  if (platform !== 'linux') return false;
  const chosen = ozonePlatform.trim().toLowerCase();
  if (chosen === 'wayland') return true;
  if (chosen !== '' && chosen !== 'auto') return false;
  const hint = ozoneHint.trim().toLowerCase();
  if (hint === 'x11') return false;
  if (hint === 'wayland') return true;
  return env['XDG_SESSION_TYPE'] === 'wayland' || (env['WAYLAND_DISPLAY'] ?? '') !== '';
}

/** `promise`, or `onTimeout` after `ms` (the promise keeps running; its late answer is ignored). */
export function withTimeout<T, U>(promise: Promise<T>, ms: number, onTimeout: U): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<U>((resolve) => (timer = setTimeout(() => resolve(onTimeout), ms)))]).finally(() => clearTimeout(timer));
}
