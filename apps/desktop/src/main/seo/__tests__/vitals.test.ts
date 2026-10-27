// Spec: specs/seo-speed.spec.ts (SPEED_WORLD_ID, SPEED_STATE_KEY, SPEED_LIMITS, SPEED_SETTLE_MS, SPEED_MEASURE_TIMEOUT_MS,
// SPEED_MIN_INTERVAL_MS, SPEED_UNAVAILABLE_REASONS), specs/seo-speed.schema.spec.ts (PerformanceMeasurementSchema, BlockingScriptsSchema)
// Acceptance: specs/seo-speed.feature.md (Measurement, Validation, Main)
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import webVitalsSource from 'virtual:web-vitals-iife';
import { AUDIT_DEBOUNCE_MS, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SEO_WORLD_ID, SNAPSHOT_LIMITS, SOCIAL_TAGS, SOCIAL_URL_TAGS } from '@app/specs/seo-limits.spec';
import { A11Y_WORLD_ID, SECURITY_LIMITS } from '@app/specs/seo-compliance.spec';
import { PageSnapshotSchema } from '@app/specs/seo-snapshot.spec';
import { DOM_REFRESH_EVERY, MAX_BLOCKING_SCRIPTS, PAINT_GRACE_MS, SHOWN_TOLERANCE_MS, SPEED_LIMITS, TRUSTED_ONLY_EVENTS, SPEED_MEASURE_TIMEOUT_MS, SPEED_MIN_INTERVAL_MS, SPEED_SETTLE_MS, SPEED_STATE_KEY, SPEED_WORLD_ID, type SpeedLimits } from '@app/specs/seo-speed.spec';
import { PerformanceMeasurementSchema, type PerformanceMeasurement } from '@app/specs/seo-speed.schema.spec';
import { commit, FakeHostWindow, FakeTabView } from '../../../test/controller-fakes';
import { rawSnapshot } from '../../../test/seo-fakes';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../../browser/controller';
import { CONTEXT_TIMEOUT_MS } from '../auditor';
import { analyseSnapshot, analyseSpeed } from '../analyse';
import { createAnalyzer, type AnalysisResult, type AnalysisWorker, type SpeedAnalysisResult } from '../analysis';
import { contextSource, knownInput, laterInput } from '../context-source';
import { extractPage, type PageDocument } from '../extract';
import { pendingRobots } from '../robots-fetch';
import { extractSecurity, RESOURCE_SELECTOR, type SecurityDocument } from '../security-extract';
import { COLLECT_CONSTANTS, DEFAULT_COLLECT_OPTIONS, measurePage, nativeWayland, runVitals, vitalsScript, type CollectOptions, type SpeedEnvironment } from '../vitals';
import { createShownTimes } from '../vitals-shown';
import { reassemble } from '../vitals-tabs';

const A = 'https://example.com/a';
const B = 'https://example.com/b';

/** A valid measurement as the collector answers it. */
function rawMeasurement(url: string, changes: Partial<PerformanceMeasurement> = {}): PerformanceMeasurement {
  return {
    url,
    measuredAt: 1_760_000_000_000,
    durationMs: 2,
    vitals: { lcp: 1_000, cls: 0, inp: null, fcp: 800, ttfb: 90 },
    loadedHidden: false,
    navigation: {
      type: 'navigate',
      redirectCount: 0,
      redirectStart: 0,
      redirectEnd: 0,
      fetchStart: 1,
      domainLookupStart: 1,
      domainLookupEnd: 1,
      connectStart: 1,
      secureConnectionStart: 0,
      connectEnd: 1,
      requestStart: 2,
      responseStart: 90,
      responseEnd: 100,
      domInteractive: 200,
      domContentLoadedEventEnd: 210,
      loadEventEnd: 400,
      activationStart: 0,
      transfer: 5_000,
      encoded: 4_700,
      decoded: 20_000,
      contentType: 'text/html',
      contentEncoding: 'gzip',
    },
    resources: [{ url: `${url}.js`, urlCut: false, initiator: 'script', contentType: 'text/javascript', contentEncoding: 'gzip', transfer: 300, encoded: 200, decoded: 900, start: 120, duration: 30, blocking: false }],
    resourceTotal: 1,
    overflow: { transfer: 0, encoded: 0, decoded: 0, weight: 0 },
    resourceOffset: 0,
    resourceEpoch: 0,
    softNavigation: false,
    bufferFull: false,
    paintUnavailable: false,
    resourceHints: 1,
    dom: { elements: 50, depth: 6, depthComplete: true },
    ...changes,
  };
}

// ---- The collector in the page ---------------------------------------------------------------

interface FakeEntry {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  [field: string]: unknown;
}

/** A fake isolated world: its Performance API, its observers, a small DOM and timers. */
function fakeWorld(options: { resources?: FakeEntry[]; visibility?: FakeEntry[]; paint?: FakeEntry[]; elements?: number; tree?: unknown; hints?: number; navigation?: boolean } = {}) {
  const domReads = { count: 0 };
  const observers: { callback: (list: { getEntries(): FakeEntry[] }) => void; options: unknown }[] = [];
  const timers: (() => void)[] = [];
  const reports = new Map<string, (metric: { value: number }) => void>();
  const libraryOptions: unknown[] = [];
  const library = {
    onLCP: (report: (m: { value: number }) => void, o: unknown) => (reports.set('lcp', report), libraryOptions.push(o)),
    onCLS: (report: (m: { value: number }) => void, o: unknown) => (reports.set('cls', report), libraryOptions.push(o)),
    onINP: (report: (m: { value: number }) => void, o: unknown) => (reports.set('inp', report), libraryOptions.push(o)),
    onFCP: (report: (m: { value: number }) => void, o: unknown) => (reports.set('fcp', report), libraryOptions.push(o)),
    onTTFB: (report: (m: { value: number }) => void, o: unknown) => (reports.set('ttfb', report), libraryOptions.push(o)),
  };
  const listeners: { target: unknown; type: string; listener: (event: { isTrusted: boolean }) => unknown }[] = [];
  /** A world's EventTarget: its prototype's methods record listeners (the collector wraps them). */
  class Target {
    addEventListener(type: string, listener: (event: { isTrusted: boolean }) => unknown) {
      listeners.push({ target: this, type, listener });
    }
    removeEventListener(type: string, listener: (event: { isTrusted: boolean }) => unknown) {
      const at = listeners.findIndex((l) => l.target === this && l.type === type && l.listener === listener);
      if (at >= 0) listeners.splice(at, 1);
    }
  }
  /** Fires `type` at every listener registered for it, as the browser (trusted) or a page script would. */
  const fire = (type: string, isTrusted: boolean) => {
    for (const l of listeners.filter((x) => x.type === type)) l.listener({ isTrusted });
  };
  const clock = { now: 1_000, url: A };
  /** The world's `navigation` (Navigation API): its `currententrychange` listeners. */
  const navigationListeners: ((event: { isTrusted: boolean }) => unknown)[] = [];
  const navigation = { addEventListener: (type: string, listener: (event: { isTrusted: boolean }) => unknown) => void (type === 'currententrychange' && navigationListeners.push(listener)) };
  /** The URL changes in the document (`pushState`): `currententrychange` fires at once, as the browser (trusted) or a page script would. */
  const navigate = (url: string, isTrusted = true) => {
    if (isTrusted) clock.url = url;
    for (const listener of navigationListeners) listener({ isTrusted });
  };
  const nav: FakeEntry = { name: A, entryType: 'navigation', startTime: 0, duration: 400, type: 'navigate', redirectCount: 0, responseStart: 90, responseEnd: 100, loadEventEnd: 400, transferSize: 5_000, encodedBodySize: 4_700, decodedBodySize: 20_000, contentType: 'text/html', contentEncoding: 'gzip', domainLookupStart: -5, connectEnd: Number.NaN };
  const leaf = { firstElementChild: null, nextElementSibling: null, parentElement: null };
  const env = {
    performance: {
      timeOrigin: 1_760_000_000_000,
      now: () => clock.now,
      getEntriesByType: (type: string) =>
        type === 'navigation' ? [nav] : type === 'resource' ? (options.resources ?? []) : type === 'visibility-state' ? (options.visibility ?? [{ name: 'visible', entryType: 'visibility-state', startTime: 0, duration: 0 }]) : type === 'paint' ? (options.paint ?? []) : [],
      getEntriesByName: (name: string) => (name === 'first-contentful-paint' ? (options.paint ?? []) : []),
    },
    EventTarget: Target,
    ...(options.navigation === false ? {} : { navigation }),
    PerformanceObserver: class {
      constructor(callback: (list: { getEntries(): FakeEntry[] }) => void) {
        observers.push({ callback, options: null });
      }
      observe(o: unknown) {
        observers.at(-1)!.options = o;
      }
    },
    document: {
      get URL() {
        return clock.url;
      },
      documentElement: (options.tree ?? leaf) as never,
      getElementsByTagName: () => {
        domReads.count += 1;
        return { length: options.elements ?? 1 };
      },
      querySelectorAll: () => ({ length: options.hints ?? 2 }),
    },
    global: {} as Record<string, unknown>,
    setTimeout: (callback: () => void) => timers.push(callback),
  } satisfies SpeedEnvironment;
  return { env, library, observers, timers, reports, libraryOptions, fire, clock, domReads, navigate, navigationListeners, deliver: (entries: FakeEntry[]) => observers[0]!.callback({ getEntries: () => entries }) };
}

const LIMITS: SpeedLimits = { ...SPEED_LIMITS, maxResources: 3, maxResourceUrlChars: 30 };
const consts = (settleMs: number) => ({ ...COLLECT_CONSTANTS, settleMs });
const opts = (changes: Partial<CollectOptions> = {}): CollectOptions => ({ ...DEFAULT_COLLECT_OPTIONS, ...changes });
const entry = (name: string, fields: Partial<FakeEntry> = {}): FakeEntry => ({ name, entryType: 'resource', startTime: 10, duration: 20, initiatorType: 'script', transferSize: 1_300, encodedBodySize: 1_000, decodedBodySize: 4_000, contentType: 'text/javascript', contentEncoding: 'br', renderBlockingStatus: 'non-blocking', ...fields });

describe('collector', () => {
  test('vitals-script-runs-in-the-speed-world', async () => {
    const answer = { url: A };
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => answer) };
    await expect(runVitals(contents)).resolves.toBe(answer);
    const [world, scripts, ...rest] = contents.executeJavaScriptInIsolatedWorld.mock.calls[0]!;
    // Its own isolated world: never the main world (0), Electron's (999), the extractor's or the
    // accessibility check's (Task 6).
    expect(world).toBe(SPEED_WORLD_ID);
    expect([0, 999, SEO_WORLD_ID, A11Y_WORLD_ID]).not.toContain(world);
    expect(new Set([SEO_WORLD_ID, A11Y_WORLD_ID, SPEED_WORLD_ID]).size).toBe(3);
    expect(scripts).toEqual([{ code: vitalsScript() }]);
    expect(rest).toEqual([]);
  });

  test('vitals-script-bundles-web-vitals-and-is-self-contained', () => {
    // The library is in the script, as a local of a function (no `webVitals` global, even in the world).
    expect(webVitalsSource.startsWith('var webVitals=')).toBe(true);
    const script = vitalsScript();
    expect(script).toContain(webVitalsSource.trim());
    expect(script).toContain('function () {\nvar webVitals=');
    expect(script).toContain(JSON.stringify(SPEED_LIMITS));
    expect(script).toContain(JSON.stringify(SPEED_STATE_KEY));
    expect(() => new Function(script)).not.toThrow();
    // Each run's options are its last argument, as JSON, cleaned (never code).
    expect(vitalsScript({ shownAt: 5, since: 3, epoch: 2, nativeWayland: true }).endsWith(`, ${JSON.stringify({ prime: false, shownAt: 5, hiddenAt: null, since: 3, epoch: 2, nativeWayland: true })})`)).toBe(true);
    expect(vitalsScript({ shownAt: Number.NaN, since: -4, epoch: 1.5 } as Partial<CollectOptions>).endsWith(`, ${JSON.stringify(DEFAULT_COLLECT_OPTIONS)})`)).toBe(true);
    const own = measurePage.toString();
    for (const forbidden of [/\brequire\s*\(/, /\bprocess\./, /\belectron\b/i, /\bipcRenderer\b/, /\binnerHTML\b/, /\.(appendChild|insertBefore|removeChild|setAttribute|remove)\(/, /\beval\s*\(/, /\bwindow\./]) expect(own, String(forbidden)).not.toMatch(forbidden);
  });

  test('collector-installs-once-and-waits-for-buffered-entries', async () => {
    const world = fakeWorld({ resources: [entry('https://example.com/early.js')] });
    const load = vi.fn(() => world.library);
    const first = measurePage(world.env, load, LIMITS, consts(SPEED_SETTLE_MS), opts());
    // The first run answers only after the settle delay, once the buffered entries arrived.
    expect(first).toBeInstanceOf(Promise);
    expect(load).toHaveBeenCalledOnce();
    expect(world.libraryOptions).toEqual(Array(5).fill({ reportAllChanges: true }));
    expect(world.observers).toHaveLength(1);
    expect(world.observers[0]!.options).toEqual({ type: 'resource', buffered: true });
    world.deliver([entry('https://example.com/early.js')]);
    world.reports.get('lcp')!({ value: 1_234.5 });
    world.reports.get('cls')!({ value: 0.07 });
    world.reports.get('ttfb')!({ value: 88 });
    expect(world.timers).toHaveLength(1);
    world.timers[0]!();
    const measured = PerformanceMeasurementSchema.parse(await first);
    expect(measured.vitals).toEqual({ lcp: 1_234.5, cls: 0.07, inp: null, fcp: null, ttfb: 88 });
    expect(measured.resources).toEqual([{ url: 'https://example.com/early.js', urlCut: false, initiator: 'script', contentType: 'text/javascript', contentEncoding: 'br', transfer: 1_300, encoded: 1_000, decoded: 4_000, start: 10, duration: 20, blocking: false }]);
    // Bad numbers from the page's entries are clamped, never passed on.
    expect(measured.navigation).toMatchObject({ domainLookupStart: 0, connectEnd: 0, responseStart: 90, transfer: 5_000 });
    // The state lives in the world's global, hidden from enumeration and not replaceable.
    expect(Object.keys(world.env.global)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(world.env.global, SPEED_STATE_KEY)).toMatchObject({ enumerable: false, writable: false, configurable: false });

    // Later runs answer at once from the same state, with what arrived since.
    world.reports.get('inp')!({ value: 240 });
    world.reports.get('lcp')!({ value: 2_000 });
    const second = measurePage(world.env, load, LIMITS, consts(SPEED_SETTLE_MS), opts()) as PerformanceMeasurement;
    expect(second).not.toBeInstanceOf(Promise);
    expect(load).toHaveBeenCalledOnce();
    expect(world.observers).toHaveLength(1);
    expect(second.vitals).toMatchObject({ lcp: 2_000, inp: 240 });
  });

  test('collector-caps-resources-and-keeps-totals', async () => {
    const world = fakeWorld();
    const run = () => measurePage(world.env, () => world.library, LIMITS, consts(0), opts());
    const first = run();
    world.deliver([
      entry('https://example.com/a-very-long-url-that-is-cut-here.js'),
      entry('https://cdn.other.net/x.png', { initiatorType: 'img', transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, contentType: '', contentEncoding: '', renderBlockingStatus: undefined }),
      entry('https://example.com/c.css', { initiatorType: 'link', renderBlockingStatus: 'blocking' }),
      entry('https://example.com/d.js', { transferSize: 10, encodedBodySize: 20, decodedBodySize: 30 }),
      entry('https://example.com/e.js', { transferSize: 0, encodedBodySize: 500, decodedBodySize: 900 }),
    ]);
    world.timers[0]!();
    const m = PerformanceMeasurementSchema.parse(await first);
    expect(m.resources).toHaveLength(LIMITS.maxResources);
    expect(m.resourceTotal).toBe(5);
    expect(m.resources[0]).toMatchObject({ url: 'https://example.com/a-very-lon', urlCut: true });
    expect(m.resources[1]).toMatchObject({ transfer: 0, encoded: 0, decoded: 0, contentType: '', blocking: null });
    expect(m.resources[2]!.blocking).toBe(true);
    // The overflow: summed; a cached one weighs its encoded size.
    expect(m.overflow).toEqual({ transfer: 10, encoded: 520, decoded: 930, weight: 510 });
  });

  test('collector-reports-loaded-hidden-and-dom-size', async () => {
    // A small tree: html > (head, body > (div > p, span)): depth 4.
    const node = (children: object[] = []): { firstElementChild: object | null; nextElementSibling: object | null; parentElement: object | null } => {
      const self = { firstElementChild: children[0] ?? null, nextElementSibling: null as object | null, parentElement: null as object | null };
      children.forEach((child, i) => Object.assign(child, { parentElement: self, nextElementSibling: children[i + 1] ?? null }));
      return self;
    };
    const tree = node([node(), node([node([node()]), node()])]);
    const hidden = fakeWorld({ tree, elements: 6, visibility: [{ name: 'hidden', entryType: 'visibility-state', startTime: 0, duration: 0 }], paint: [{ name: 'first-contentful-paint', entryType: 'paint', startTime: 900, duration: 0 }] });
    const first = measurePage(hidden.env, () => hidden.library, LIMITS, consts(0), opts());
    hidden.timers[0]!();
    const m = (await first) as PerformanceMeasurement;
    expect(m.loadedHidden).toBe(true);
    expect(m.dom).toEqual({ elements: 6, depth: 4, depthComplete: true });
    // Hidden only after the first paint: not "loaded hidden".
    const later = fakeWorld({ visibility: [{ name: 'visible', entryType: 'visibility-state', startTime: 0, duration: 0 }, { name: 'hidden', entryType: 'visibility-state', startTime: 5_000, duration: 0 }], paint: [{ name: 'first-contentful-paint', entryType: 'paint', startTime: 300, duration: 0 }] });
    const second = measurePage(later.env, () => later.library, LIMITS, consts(0), opts());
    later.timers[0]!();
    expect(((await second) as PerformanceMeasurement).loadedHidden).toBe(false);
    // The depth walk is bounded.
    const bounded = fakeWorld({ tree });
    const third = measurePage(bounded.env, () => bounded.library, { ...LIMITS, maxDomWalk: 3 }, consts(0), opts());
    bounded.timers[0]!();
    expect(((await third) as PerformanceMeasurement).dom).toMatchObject({ depthComplete: false });
  });

  test('collector-survives-a-missing-library-or-observer', async () => {
    const world = fakeWorld();
    const env = { ...world.env, PerformanceObserver: undefined };
    const first = measurePage(env, () => {
      throw new Error('no');
    }, LIMITS, consts(0), opts());
    world.timers[0]!();
    const m = PerformanceMeasurementSchema.parse(await first);
    expect(m.vitals).toEqual({ lcp: null, cls: null, inp: null, fcp: null, ttfb: null });
    expect(m.resources).toEqual([]);
  });
});

describe('extractor', () => {
  test('extractor-reads-render-blocking-scripts', () => {
    const head = [
      '<script src="/blocking.js"></script>',
      '<script src="https://cdn.example.net/also.js" type="text/javascript"></script>',
      '<script src="/async.js" async></script>',
      '<script src="/defer.js" defer></script>',
      '<script src="/module.js" type="module"></script>',
      '<script src="/legacy.js" nomodule></script>',
      '<script src="/data.json" type="application/json"></script>',
      '<script>inline()</script>',
    ].join('');
    const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body><script src="/in-body.js"></script></body></html>`, { url: A });
    // One inserted by script: async by default (the property), so not blocking.
    const inserted = dom.window.document.createElement('script');
    inserted.src = '/inserted.js';
    // (jsdom lacks the "force async" default Chromium applies: model it.)
    Object.defineProperty(inserted, 'async', { value: true });
    dom.window.document.head.append(inserted);
    // With the security read beside it, as the extractor's script does (Task 6).
    const run = (max?: number) =>
      PageSnapshotSchema.parse({
        ...(extractPage(dom.window.document as unknown as PageDocument, SNAPSHOT_LIMITS, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SOCIAL_TAGS, SOCIAL_URL_TAGS, max) as object),
        security: extractSecurity(dom.window.document as unknown as SecurityDocument, SECURITY_LIMITS, RESOURCE_SELECTOR),
      });
    expect(run().blockingScripts).toEqual({ urls: ['https://example.com/blocking.js', 'https://cdn.example.net/also.js'], total: 2 });
    expect(run(1).blockingScripts).toEqual({ urls: ['https://example.com/blocking.js'], total: 2 });
    expect(MAX_BLOCKING_SCRIPTS).toBe(20);
  });
});

describe('collector guards and deltas', () => {
  test('collector-ignores-synthetic-lifecycle-events', async () => {
    const world = fakeWorld();
    const seen: string[] = [];
    // A library that listens for lifecycle events and something else.
    const library = {
      ...world.library,
      onLCP: (report: (m: { value: number }) => void) => {
        const target = new world.env.EventTarget();
        target.addEventListener('pageshow', () => void seen.push('pageshow'));
        target.addEventListener('click', () => void seen.push('click'));
        const handler = () => void seen.push('visibilitychange');
        target.addEventListener('visibilitychange', handler);
        target.removeEventListener('visibilitychange', handler);
        report({ value: 10 });
      },
    };
    const first = measurePage(world.env, () => library, LIMITS, consts(0), opts());
    world.timers[0]!();
    await first;
    // A page's synthetic pageshow reaches none of the world's handlers; the browser's does.
    world.fire('pageshow', false);
    world.fire('click', false);
    expect(seen).toEqual(['click']);
    world.fire('pageshow', true);
    expect(seen).toEqual(['click', 'pageshow']);
    // A guarded listener is still removable by its original function.
    world.fire('visibilitychange', true);
    expect(seen).toEqual(['click', 'pageshow']);
    expect(TRUSTED_ONLY_EVENTS).toEqual(['pageshow', 'visibilitychange', 'prerenderingchange']);
  });

  test('collector-runs-meanwhile-await-the-settle', async () => {
    const world = fakeWorld();
    const load = vi.fn(() => world.library);
    // Main primes at dom-ready: installed, nothing answered.
    expect(measurePage(world.env, load, LIMITS, consts(SPEED_SETTLE_MS), opts({ prime: true }))).toBeNull();
    expect(load).toHaveBeenCalledOnce();
    // Two runs while the buffered entries are still arriving both wait for them.
    const a = measurePage(world.env, load, LIMITS, consts(SPEED_SETTLE_MS), opts());
    const b = measurePage(world.env, load, LIMITS, consts(SPEED_SETTLE_MS), opts());
    expect(a).toBeInstanceOf(Promise);
    expect(b).toBeInstanceOf(Promise);
    world.deliver([entry('https://example.com/early.js')]);
    world.reports.get('fcp')!({ value: 300 });
    world.timers[0]!();
    for (const answer of [await a, await b]) expect(answer).toMatchObject({ resourceTotal: 1, vitals: { fcp: 300 } });
    expect(load).toHaveBeenCalledOnce();
    expect(world.timers).toHaveLength(1);
    // Afterwards: at once.
    expect(measurePage(world.env, load, LIMITS, consts(SPEED_SETTLE_MS), opts())).not.toBeInstanceOf(Promise);
  });

  test('collector-drops-paint-metrics-for-background-loads', async () => {
    const paint = [{ name: 'first-contentful-paint', entryType: 'paint', startTime: 300, duration: 0 }];
    const run = async (o: Partial<CollectOptions>) => {
      const world = fakeWorld({ paint });
      const first = measurePage(world.env, () => world.library, LIMITS, consts(0), opts(o));
      world.reports.get('lcp')!({ value: 2_000 });
      world.reports.get('fcp')!({ value: 2_000 });
      world.reports.get('cls')!({ value: 0.2 });
      world.reports.get('ttfb')!({ value: 50 });
      world.timers[0]!();
      return PerformanceMeasurementSchema.parse(await first);
    };
    const origin = 1_760_000_000_000;
    // Shown before the document began (an active tab): measured as is.
    expect(await run({ shownAt: origin - 5_000 })).toMatchObject({ loadedHidden: false, vitals: { lcp: 2_000, fcp: 2_000, cls: 0.2 } });
    expect(await run({ shownAt: origin + SHOWN_TOLERANCE_MS })).toMatchObject({ loadedHidden: false });
    // First shown seconds after it began (opened in a background tab): FCP, LCP and CLS dropped.
    expect(await run({ shownAt: origin + 4_000 })).toMatchObject({ loadedHidden: true, vitals: { lcp: null, fcp: null, cls: null, ttfb: 50 } });
    // Hidden before its first paint (the user switched away while it loaded).
    expect(await run({ shownAt: origin - 10, hiddenAt: origin + 100 })).toMatchObject({ loadedHidden: true, vitals: { lcp: null } });
    // Hidden only after it painted: kept.
    expect(await run({ shownAt: origin - 10, hiddenAt: origin + 5_000 })).toMatchObject({ loadedHidden: false, vitals: { lcp: 2_000 } });
  });

  test('collector-says-when-paint-is-unavailable-under-wayland', async () => {
    const run = async (o: Partial<CollectOptions>, now: number, paint: FakeEntry[] = []) => {
      const world = fakeWorld({ paint });
      world.clock.now = now;
      const first = measurePage(world.env, () => world.library, LIMITS, consts(0), opts(o));
      world.timers[0]!();
      return ((await first) as PerformanceMeasurement).paintUnavailable;
    };
    // The load event ended at 400 ms: only after the grace period, only without any paint entry, only on native Wayland.
    expect(await run({ nativeWayland: true }, 400 + PAINT_GRACE_MS)).toBe(true);
    expect(await run({ nativeWayland: true }, 400 + PAINT_GRACE_MS - 1)).toBe(false);
    expect(await run({ nativeWayland: false }, 400 + PAINT_GRACE_MS)).toBe(false);
    expect(await run({ nativeWayland: true }, 400 + PAINT_GRACE_MS, [{ name: 'first-paint', entryType: 'paint', startTime: 50, duration: 0 }])).toBe(false);
  });

  test('collector-answers-only-new-resources-and-restarts-on-route-change', async () => {
    const world = fakeWorld();
    const run = (o: Partial<CollectOptions>) => measurePage(world.env, () => world.library, { ...SPEED_LIMITS }, consts(0), opts(o)) as PerformanceMeasurement;
    const first = measurePage(world.env, () => world.library, { ...SPEED_LIMITS }, consts(0), opts());
    world.deliver([entry('https://example.com/1.js'), entry('https://example.com/2.js')]);
    world.timers[0]!();
    expect(await first).toMatchObject({ resourceOffset: 0, resourceEpoch: 0, resourceTotal: 2, softNavigation: false });
    world.deliver([entry('https://example.com/3.js')]);
    // Main holds two of epoch 0: only the third comes back.
    const delta = run({ since: 2, epoch: 0 });
    expect(delta.resources.map((r) => r.url)).toEqual(['https://example.com/3.js']);
    expect(delta).toMatchObject({ resourceOffset: 2, resourceTotal: 3 });
    // Another epoch, or more than there is: the whole list.
    expect(run({ since: 2, epoch: 5 })).toMatchObject({ resourceOffset: 0, resourceTotal: 3 });
    expect(run({ since: 9, epoch: 0 })).toMatchObject({ resourceOffset: 0 });
    // A fragment is no route change; another path is: a new epoch, the requests start again.
    world.clock.url = `${A}#section`;
    expect(run({ since: 3, epoch: 0 })).toMatchObject({ resourceEpoch: 0, resourceOffset: 3 });
    world.clock.now = 1_500;
    world.clock.url = `${A}/route`;
    const routed = run({ since: 3, epoch: 0 });
    expect(routed).toMatchObject({ resourceEpoch: 1, resourceOffset: 0, resourceTotal: 0, resources: [], softNavigation: true });
    world.deliver([entry('https://example.com/route.json', { initiatorType: 'fetch', startTime: 1_600 })]);
    expect(run({ since: 0, epoch: 1 })).toMatchObject({ resourceTotal: 1, softNavigation: true });
  });

  test('collector-keeps-route-resources-observed-before-the-next-collection', async () => {
    // Without the Navigation API: the observer sees the URL change when the route's request arrives.
    const plain = fakeWorld({ navigation: false });
    const runIn = (world: ReturnType<typeof fakeWorld>, o: Partial<CollectOptions> = {}) => measurePage(world.env, () => world.library, { ...SPEED_LIMITS }, consts(0), opts(o)) as PerformanceMeasurement;
    const first = measurePage(plain.env, () => plain.library, { ...SPEED_LIMITS }, consts(0), opts());
    plain.deliver([entry('https://example.com/1.js'), entry('https://example.com/2.js')]);
    plain.timers[0]!();
    expect(await first).toMatchObject({ resourceEpoch: 0, resourceTotal: 2 });
    // The SPA changes its URL and finishes the route's request, all before the next collection.
    plain.clock.now = 1_200;
    plain.clock.url = `${A}/route`;
    plain.clock.now = 1_350;
    plain.deliver([entry('https://example.com/route.json', { initiatorType: 'fetch', startTime: 1_300 })]);
    const routed = runIn(plain, { since: 2, epoch: 0 });
    expect(routed).toMatchObject({ resourceEpoch: 1, resourceOffset: 0, resourceTotal: 1, softNavigation: true });
    expect(routed.resources.map((r) => r.url)).toEqual(['https://example.com/route.json']);

    // With it: the boundary is the moment the URL changed (trusted `currententrychange`).
    const world = fakeWorld();
    const primed = measurePage(world.env, () => world.library, { ...SPEED_LIMITS }, consts(0), opts());
    world.timers[0]!();
    await primed;
    expect(world.navigationListeners).toHaveLength(1);
    world.clock.now = 2_000;
    world.navigate(`${A}/next`);
    world.clock.now = 2_400;
    // An old route's request still in flight at the change is not the new route's; one starting at the change is.
    world.deliver([entry('https://example.com/old.json', { startTime: 1_900 }), entry('https://example.com/next.json', { startTime: 2_000 })]);
    const next = runIn(world);
    expect(next).toMatchObject({ url: `${A}/next`, resourceEpoch: 1, resourceTotal: 1, softNavigation: true });
    expect(next.resources.map((r) => r.url)).toEqual(['https://example.com/next.json']);
    // A page's synthetic event moves no boundary: the next change is found from the last time the
    // old URL was seen (that collection, at 2 400 ms), so a request at 2 550 ms is the new route's.
    world.clock.now = 2_500;
    world.clock.url = `${A}/third`;
    world.clock.now = 2_600;
    world.navigate(`${A}/ignored`, false);
    world.clock.now = 2_700;
    world.deliver([entry('https://example.com/third.json', { startTime: 2_550 })]);
    const third = runIn(world);
    expect(third).toMatchObject({ url: `${A}/third`, resourceEpoch: 2, resourceTotal: 1 });
    expect(third.resources.map((r) => r.url)).toEqual(['https://example.com/third.json']);
  });

  test('collector-refreshes-the-dom-every-n-collections', async () => {
    const world = fakeWorld({ hints: 7 });
    const first = measurePage(world.env, () => world.library, LIMITS, consts(0), opts());
    world.timers[0]!();
    expect(await first).toMatchObject({ resourceHints: 7, dom: { elements: 1 } });
    expect(world.domReads.count).toBe(1);
    for (let i = 1; i < DOM_REFRESH_EVERY; i++) measurePage(world.env, () => world.library, LIMITS, consts(0), opts());
    expect(world.domReads.count).toBe(1);
    measurePage(world.env, () => world.library, LIMITS, consts(0), opts());
    expect(world.domReads.count).toBe(2);
  });

  test('collector-notes-a-full-timing-buffer', async () => {
    const full = fakeWorld({ resources: Array.from({ length: 250 }, (_, i) => entry(`https://example.com/${i}.js`)) });
    const first = measurePage(full.env, () => full.library, LIMITS, consts(0), opts());
    full.timers[0]!();
    expect(((await first) as PerformanceMeasurement).bufferFull).toBe(true);
    // Or the browser says so later.
    const world = fakeWorld();
    const listeners: Record<string, () => void> = {};
    const env = { ...world.env, performance: { ...world.env.performance, addEventListener: (type: string, listener: () => void) => void (listeners[type] = listener) } };
    const second = measurePage(env, () => world.library, LIMITS, consts(0), opts());
    world.timers[0]!();
    expect(((await second) as PerformanceMeasurement).bufferFull).toBe(false);
    listeners['resourcetimingbufferfull']!();
    expect((measurePage(env, () => world.library, LIMITS, consts(0), opts()) as PerformanceMeasurement).bufferFull).toBe(true);
  });
});

describe('main side', () => {
  test('native-wayland-detection', () => {
    expect(nativeWayland('linux', 'wayland', '', {})).toBe(true);
    expect(nativeWayland('linux', 'x11', '', { XDG_SESSION_TYPE: 'wayland' })).toBe(false);
    expect(nativeWayland('linux', '', '', { XDG_SESSION_TYPE: 'wayland' })).toBe(true);
    expect(nativeWayland('linux', '', '', { WAYLAND_DISPLAY: 'wayland-1' })).toBe(true);
    expect(nativeWayland('linux', 'auto', '', { WAYLAND_DISPLAY: 'wayland-1' })).toBe(true);
    expect(nativeWayland('linux', '', 'x11', { WAYLAND_DISPLAY: 'wayland-1' })).toBe(false);
    expect(nativeWayland('linux', '', '', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).toBe(false);
    expect(nativeWayland('linux', 'headless', '', { WAYLAND_DISPLAY: 'wayland-1' })).toBe(false);
    expect(nativeWayland('darwin', 'wayland', '', { WAYLAND_DISPLAY: 'x' })).toBe(false);
  });

  test('shown-times', () => {
    let now = 1_000;
    const times = createShownTimes(() => now);
    expect(times.of(1)).toEqual({ shownAt: null, hiddenAt: null });
    // Attached at 1000, then a document commits: shown since 1000.
    times.shown(1);
    now = 2_000;
    times.committed(1);
    expect(times.of(1)).toEqual({ shownAt: 1_000, hiddenAt: null });
    // Hidden at 3000, shown again at 4000, hidden again: the first hide is kept.
    now = 3_000;
    times.hidden(1);
    now = 4_000;
    times.shown(1);
    now = 4_500;
    times.hidden(1);
    expect(times.of(1)).toEqual({ shownAt: 1_000, hiddenAt: 3_000 });
    // A document committed while detached: not shown until attached.
    times.committed(1);
    expect(times.of(1)).toEqual({ shownAt: null, hiddenAt: null });
    now = 9_000;
    times.shown(1);
    expect(times.of(1)).toEqual({ shownAt: 9_000, hiddenAt: null });
    times.forget(1);
    expect(times.of(1)).toEqual({ shownAt: null, hiddenAt: null });
  });

  test('reassemble-puts-the-list-back-together', () => {
    const r = (n: number) => ({ url: `https://example.com/${n}.js` });
    const full = reassemble({ x: 1, resources: [r(1), r(2)], resourceOffset: 0, resourceEpoch: 0 }, null)!;
    expect(full.held).toEqual({ epoch: 0, records: [r(1), r(2)] });
    const more = reassemble({ x: 2, resources: [r(3)], resourceOffset: 2, resourceEpoch: 0 }, full.held)!;
    expect(more.measurement).toEqual({ x: 2, resources: [r(1), r(2), r(3)], resourceOffset: 0, resourceEpoch: 0 });
    // Capped at maxResources.
    expect(reassemble({ resources: [r(9)], resourceOffset: 2, resourceEpoch: 0 }, full.held, 2)!.held!.records).toHaveLength(2);
    // Another epoch or a gap cannot be put together; another shape passes through for the worker to reject.
    expect(reassemble({ resources: [r(3)], resourceOffset: 2, resourceEpoch: 1 }, full.held)).toBeNull();
    expect(reassemble({ resources: [r(3)], resourceOffset: 5, resourceEpoch: 0 }, full.held)).toBeNull();
    expect(reassemble('garbage', full.held)).toEqual({ measurement: 'garbage', held: null });
    expect(reassemble({ resources: 'x', resourceOffset: 0, resourceEpoch: 0 }, null)).toEqual({ measurement: { resources: 'x', resourceOffset: 0, resourceEpoch: 0 }, held: null });
    // The worker only ever accepts a whole list.
    expect(analyseSpeed(rawMeasurement(A, { resourceOffset: 1 as 0 }))).toEqual({ ok: false, reason: 'invalid-measurement' });
  });
});

// ---- Validation in the worker ----------------------------------------------------------------

describe('validation', () => {
  test('speed-analysis-validates-and-summarises', () => {
    const answer = analyseSpeed(rawMeasurement(A));
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.report.url).toBe(A);
      expect(answer.report.requests.total).toBe(2);
      expect(answer.report.findings).toEqual([]);
    }
    const bad: unknown[] = [
      undefined,
      null,
      'x',
      { url: A },
      rawMeasurement('file:///etc/passwd'),
      rawMeasurement(A, { resources: Array.from({ length: SPEED_LIMITS.maxResources + 1 }, () => rawMeasurement(A).resources[0]!), resourceTotal: SPEED_LIMITS.maxResources + 1 }),
      rawMeasurement(A, { resourceTotal: 0 }),
      rawMeasurement(A, { vitals: { lcp: Number.NaN, cls: 0, inp: null, fcp: null, ttfb: null } }),
      rawMeasurement(A, { vitals: { lcp: -1, cls: 0, inp: null, fcp: null, ttfb: null } }),
      rawMeasurement(A, { vitals: { lcp: SPEED_LIMITS.maxTimeMs + 1, cls: 0, inp: null, fcp: null, ttfb: null } }),
      rawMeasurement(A, { resources: [{ ...rawMeasurement(A).resources[0]!, url: 'x'.repeat(SPEED_LIMITS.maxResourceUrlChars + 1) }] }),
      rawMeasurement(A, { resources: [{ ...rawMeasurement(A).resources[0]!, transfer: 1.5 }] }),
      rawMeasurement(A, { dom: { elements: -1, depth: 1, depthComplete: true } }),
      { ...rawMeasurement(A), extra: true },
      { ...rawMeasurement(A), vitals: { ...rawMeasurement(A).vitals, tbt: 4 } },
      Object.defineProperty(rawMeasurement(A), 'url', {
        get() {
          throw new Error('boom');
        },
      }),
    ];
    for (const [index, raw] of bad.entries()) expect(analyseSpeed(raw), `bad #${index}`).toEqual({ ok: false, reason: 'invalid-measurement' });
  });

  test('audit-takes-the-measurement-from-the-context', () => {
    const context = { response: null, robots: null, performance: rawMeasurement(A, { vitals: { lcp: 6_000, cls: 0, inp: null, fcp: 800, ttfb: 90 } }) };
    const answer = analyseSnapshot(rawSnapshot(A), context);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.audit.performance?.vitals.find((v) => v.metric === 'lcp')?.band).toBe('poor');
    expect(answer.audit.findings.map((f) => f.ruleId)).toContain('lcp-poor');
    // An invalid measurement is left out; the audit still runs.
    const invalid = analyseSnapshot(rawSnapshot(A), { response: null, robots: null, performance: { url: A, lcp: 1 } });
    expect(invalid.ok && invalid.audit.performance).toBeNull();
    expect(invalid.ok && invalid.audit.findings.some((f) => f.category === 'performance')).toBe(false);
    // The rest of the context is still strict.
    expect(analyseSnapshot(rawSnapshot(A), { response: null, robots: null, performance: null, extra: 1 })).toEqual({ ok: false, reason: 'invalid-snapshot' });
    // The snapshot cannot carry a measurement of its own (strict), but its blocking scripts are read.
    expect(analyseSnapshot({ ...rawSnapshot(A), performance: rawMeasurement(A) })).toEqual({ ok: false, reason: 'invalid-snapshot' });
    const blocking = analyseSnapshot(rawSnapshot(A, { blockingScripts: { urls: [`${A}.js`], total: 1 } }));
    expect(blocking.ok && blocking.audit.findings.map((f) => f.ruleId)).toContain('render-blocking-scripts');
    expect(analyseSnapshot(rawSnapshot(A, { blockingScripts: { urls: Array(MAX_BLOCKING_SCRIPTS + 1).fill(A), total: 99 } }))).toEqual({ ok: false, reason: 'invalid-snapshot' });
  });

  test('speed-jobs-run-in-the-analysis-worker', async () => {
    vi.useFakeTimers();
    try {
      class Worker extends EventEmitter implements AnalysisWorker {
        readonly posted: { id: number; kind?: string; raw: unknown }[] = [];
        terminated = false;
        postMessage(message: unknown) {
          this.posted.push(message as { id: number; raw: unknown });
        }
        terminate() {
          this.terminated = true;
          return Promise.resolve(1);
        }
        unref() {}
      }
      const workers: Worker[] = [];
      const analyzer = createAnalyzer({
        spawn: () => {
          const w = new Worker();
          workers.push(w);
          return w;
        },
      });
      const speed = analyzer.analyseSpeed(rawMeasurement(A));
      const message = workers[0]!.posted[0]!;
      expect(message).toEqual({ id: message.id, kind: 'speed', raw: rawMeasurement(A) });
      workers[0]!.emit('message', { id: message.id, result: analyseSpeed(message.raw) });
      await expect(speed).resolves.toMatchObject({ ok: true, report: { url: A } });
      // An answer of the wrong shape is a failure, never passed on; so is a timeout.
      const odd = analyzer.analyseSpeed(rawMeasurement(A));
      workers[0]!.emit('message', { id: workers[0]!.posted[1]!.id, result: { ok: true, audit: {} } });
      await expect(odd).resolves.toEqual({ ok: false, reason: 'analysis-failed' });
      const slow = analyzer.analyseSpeed(rawMeasurement(A));
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(slow).resolves.toEqual({ ok: false, reason: 'analysis-timeout' });
      expect(workers[0]!.terminated).toBe(true);
      analyzer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- Per tab, through the controller ---------------------------------------------------------

interface Collection {
  readonly world: number;
  readonly options: Partial<CollectOptions>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

describe('tab speed', () => {
  let views: FakeTabView[];
  let controller: BrowserController;
  let collections: Collection[];
  let analyse: (raw: unknown) => Promise<SpeedAnalysisResult>;
  let times: ReturnType<typeof createShownTimes>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    views = [];
    collections = [];
    times = createShownTimes();
    analyse = async (raw) => analyseSpeed(raw);
    controller = createBrowserController({
      createView: () => {
        const view = new FakeTabView();
        Object.assign(view.contents, { id: 100 + views.length });
        views.push(view);
        return view as unknown as TabView;
      },
      platform: 'linux',
      speed: {
        measure: (_contents, options) =>
          new Promise((resolve, reject) => {
            collections.push({ world: SPEED_WORLD_ID, options, resolve, reject });
          }),
        analyse: (raw) => analyse(raw),
        times,
      },
    });
    controller.attach(new FakeHostWindow() as unknown as HostWindow);
  });
  afterEach(() => vi.useRealTimers());

  const activeId = () => controller.getState().activeTabId!;
  const load = (url: string) => {
    controller.navigate(url);
    const contents = views.at(-1)!.contents;
    commit(contents, url, url);
    contents.emit('did-finish-load');
    return contents;
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);

  test('speed-measures-the-active-tab-once-at-a-time', async () => {
    load(A);
    const first = controller.seo.measureSpeed(activeId());
    const again = controller.seo.measureSpeed(activeId());
    // Shared: one collection in flight.
    expect(collections).toHaveLength(1);
    collections[0]!.resolve(rawMeasurement(A));
    const answer = await first;
    expect(answer).toMatchObject({ status: 'ready', url: A, report: { url: A } });
    await expect(again).resolves.toBe(answer);
    // Sooner than the minimum interval: the last measurement again, nothing run.
    await vi.advanceTimersByTimeAsync(SPEED_MIN_INTERVAL_MS - 1);
    await expect(controller.seo.measureSpeed(activeId())).resolves.toMatchObject({ status: 'ready' });
    expect(collections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const next = controller.seo.measureSpeed(activeId());
    expect(collections).toHaveLength(2);
    collections[1]!.resolve(rawMeasurement(A, { vitals: { lcp: 5_000, cls: 0, inp: null, fcp: 800, ttfb: 90 } }));
    await expect(next).resolves.toMatchObject({ status: 'ready', report: { findings: [{ ruleId: 'lcp-poor' }] } });
  });

  test('speed-only-for-active-web-pages', async () => {
    await expect(controller.seo.measureSpeed(999)).resolves.toEqual({ status: 'unavailable', url: '', reason: 'no-tab' });
    // An empty tab.
    await expect(controller.seo.measureSpeed(activeId())).resolves.toMatchObject({ status: 'unavailable', reason: 'no-page' });
    const first = load(A);
    const firstId = activeId();
    const backgroundId = controller.openTabFromPage(first, B)!;
    commit(views.at(-1)!.contents, B, 'B');
    await expect(controller.seo.measureSpeed(backgroundId)).resolves.toMatchObject({ status: 'unavailable', url: B, reason: 'background' });
    expect(collections).toHaveLength(0);
    // A crashed tab.
    first.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await expect(controller.seo.measureSpeed(firstId)).resolves.toMatchObject({ status: 'unavailable', reason: 'crashed' });
  });

  test('speed-times-out-and-waits-for-a-busy-page', async () => {
    load(A);
    const slow = controller.seo.measureSpeed(activeId());
    await vi.advanceTimersByTimeAsync(SPEED_MEASURE_TIMEOUT_MS);
    await expect(slow).resolves.toEqual({ status: 'unavailable', url: A, reason: 'timeout' });
    // The page has not answered: no second collection is stacked on it.
    await vi.advanceTimersByTimeAsync(SPEED_MIN_INTERVAL_MS);
    await expect(controller.seo.measureSpeed(activeId())).resolves.toMatchObject({ reason: 'timeout' });
    expect(collections).toHaveLength(1);
    // Once it answers (late, ignored), the next request measures again.
    collections[0]!.resolve(rawMeasurement(A));
    await flush();
    const next = controller.seo.measureSpeed(activeId());
    expect(collections).toHaveLength(2);
    collections[1]!.reject(new Error('Script failed to execute'));
    await expect(next).resolves.toEqual({ status: 'unavailable', url: A, reason: 'measurement-failed' });
  });

  test('speed-answers-bad-data-as-unavailable', async () => {
    load(A);
    const garbage = controller.seo.measureSpeed(activeId());
    collections[0]!.resolve({ url: A, vitals: 'fast' });
    await expect(garbage).resolves.toEqual({ status: 'unavailable', url: A, reason: 'invalid-measurement' });
    // A measurement of another URL is not this page's.
    await vi.advanceTimersByTimeAsync(SPEED_MIN_INTERVAL_MS);
    const other = controller.seo.measureSpeed(activeId());
    collections[1]!.resolve(rawMeasurement(B));
    await expect(other).resolves.toMatchObject({ status: 'unavailable', reason: 'invalid-measurement' });
    // A worker that fails.
    analyse = async () => ({ ok: false, reason: 'analysis-timeout' });
    await vi.advanceTimersByTimeAsync(SPEED_MIN_INTERVAL_MS);
    const failed = controller.seo.measureSpeed(activeId());
    collections[2]!.resolve(rawMeasurement(A));
    await expect(failed).resolves.toEqual({ status: 'unavailable', url: A, reason: 'analysis-timeout' });
  });

  test('speed-measurements-stop-at-navigation', async () => {
    const contents = load(A);
    const old = controller.seo.measureSpeed(activeId());
    // The tab moves on to B before A's collection answers.
    commit(contents, B, 'B');
    collections[0]!.resolve(rawMeasurement(A));
    // A's answer is dropped: never shown against B.
    await expect(old).resolves.toEqual({ status: 'pending', url: B });
    // B is measured afresh at once (no interval carried over from A).
    const fresh = controller.seo.measureSpeed(activeId());
    expect(collections).toHaveLength(2);
    collections[1]!.resolve(rawMeasurement(B));
    await expect(fresh).resolves.toMatchObject({ status: 'ready', url: B, report: { url: B } });
    // A reload (a new document of the same URL) drops B's measurement too.
    commit(contents, B, 'B');
    const reloaded = controller.seo.measureSpeed(activeId());
    expect(collections).toHaveLength(3);
    collections[2]!.resolve(rawMeasurement(B));
    await expect(reloaded).resolves.toMatchObject({ status: 'ready' });
    // An SPA route change: another URL, measured afresh, the old answer dropped.
    await vi.advanceTimersByTimeAsync(SPEED_MIN_INTERVAL_MS);
    const before = controller.seo.measureSpeed(activeId());
    contents.url = `${B}/route`;
    contents.emit('did-navigate-in-page', {}, `${B}/route`, true, 1, 1);
    collections[3]!.resolve(rawMeasurement(B));
    await expect(before).resolves.toEqual({ status: 'pending', url: `${B}/route` });
  });

  test('speed-passes-shown-times-and-asks-for-new-resources-only', async () => {
    const contents = load(A);
    // The tab was attached before its document loaded: shown since then, never hidden.
    const first = controller.seo.measureSpeed(activeId());
    expect(collections[0]!.options).toMatchObject({ shownAt: 1_760_000_000_000, hiddenAt: null, since: 0, epoch: -1 });
    const resource = rawMeasurement(A).resources[0]!;
    collections[0]!.resolve({ ...rawMeasurement(A), resources: [resource], resourceTotal: 1 });
    await expect(first).resolves.toMatchObject({ status: 'ready', report: { requests: { total: 2 } } });
    // The next collection asks only for what came after the one record main holds; main puts the list back together.
    await vi.advanceTimersByTimeAsync(SPEED_MIN_INTERVAL_MS);
    const second = controller.seo.measureSpeed(activeId());
    expect(collections[1]!.options).toMatchObject({ since: 1, epoch: 0 });
    collections[1]!.resolve({ ...rawMeasurement(A), resources: [{ ...resource, url: `${A}/2.js` }], resourceTotal: 2, resourceOffset: 1 });
    await expect(second).resolves.toMatchObject({ status: 'ready', report: { requests: { total: 3, itemised: 3 } } });
    // A background tab opened from the page: its document loads while detached, then it is shown.
    const firstId = activeId();
    const backgroundId = controller.openTabFromPage(contents, B)!;
    const background = views.at(-1)!.contents;
    commit(background, B, 'B');
    await vi.advanceTimersByTimeAsync(4_000);
    controller.activateTab(backgroundId);
    const late = controller.seo.measureSpeed(backgroundId);
    expect(collections[2]!.options).toMatchObject({ shownAt: 1_760_000_000_000 + SPEED_MIN_INTERVAL_MS + 4_000, hiddenAt: null, since: 0 });
    collections[2]!.resolve(rawMeasurement(B));
    await late;
    // Back on the first tab: hidden since it was left (its document was shown before, so not reset).
    controller.activateTab(firstId);
    await vi.advanceTimersByTimeAsync(SPEED_MIN_INTERVAL_MS);
    const back = controller.seo.measureSpeed(firstId);
    expect(collections[3]!.options).toMatchObject({ shownAt: 1_760_000_000_000, hiddenAt: 1_760_000_000_000 + SPEED_MIN_INTERVAL_MS + 4_000 });
    collections[3]!.resolve(rawMeasurement(A));
    await back;
  });

  test('speed-forgets-closed-tabs', async () => {
    load(A);
    const id = activeId();
    const pending = controller.seo.measureSpeed(id);
    controller.closeTab(id);
    collections[0]!.resolve(rawMeasurement(A));
    await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
    await expect(controller.seo.measureSpeed(id)).resolves.toEqual({ status: 'unavailable', url: '', reason: 'no-tab' });
  });
});

// ---- The audit's own measurement: an input that may arrive later -----------------------------

describe('audit measurement', () => {
  const ROBOTS = { url: 'https://example.com/robots.txt', outcome: 'ok', status: 200, finalUrl: 'https://example.com/robots.txt', redirects: 0, body: new TextEncoder().encode('User-agent: *\nAllow: /\n'), truncated: false } as const;
  const SLOW = rawMeasurement(A, { vitals: { lcp: 6_000, cls: 0, inp: null, fcp: 800, ttfb: 90 } });
  let views: FakeTabView[];
  let analysed: unknown[];
  let measurements: ((value: unknown) => void)[];
  let fetches: ((value: unknown) => void)[];
  let controller: BrowserController;

  beforeEach(() => {
    vi.useFakeTimers();
    views = [];
    analysed = [];
    measurements = [];
    fetches = [];
    controller = createBrowserController({
      createView: () => {
        const view = new FakeTabView();
        views.push(view);
        return view as unknown as TabView;
      },
      platform: 'linux',
      seo: {
        extract: async (contents) => rawSnapshot((contents as unknown as { url: string }).url),
        analyse: async (raw, context): Promise<AnalysisResult> => {
          analysed.push(context);
          return analyseSnapshot(raw, context);
        },
        // As main collects it: robots.txt and the measurement both arrive when the test says.
        context: (contents) => {
          const url = (contents as unknown as { url: string }).url;
          return contextSource({
            response: knownInput(null),
            robots: laterInput(new Promise((resolve) => fetches.push(resolve)), pendingRobots(url)),
            performance: laterInput(new Promise((resolve) => measurements.push(resolve))),
          });
        },
      },
    });
    controller.attach(new FakeHostWindow() as unknown as HostWindow);
  });
  afterEach(() => vi.useRealTimers());

  const status = () => controller.seo.getAudit(controller.getState().activeTabId!);
  const lcpRule = () => {
    const answer = status();
    return answer.status === 'ready' ? answer.audit.findings.some((f) => f.ruleId === 'lcp-poor') : answer.status;
  };
  const version = () => controller.getState().tabs[0]!.auditVersion;

  test('audit-does-not-wait-for-the-measurement', async () => {
    controller.navigate(A);
    const contents = views.at(-1)!.contents;
    commit(contents, A, 'A');
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    // Ready at once: no measurement (no measured rule), robots.txt pending.
    expect(analysed).toHaveLength(1);
    expect(analysed[0]).toEqual({ response: null, robots: pendingRobots(A) });
    const ready = status();
    expect(ready.status === 'ready' && ready.audit.performance).toBeNull();
    expect(lcpRule()).toBe(false);
    const first = version();
    // The measurement alone does not re-analyse: robots.txt is still on its way.
    measurements[0]!(SLOW);
    await vi.advanceTimersByTimeAsync(0);
    expect(analysed).toHaveLength(1);
    // Once both settled: analysed once more with everything, and the chrome is told.
    fetches[0]!(ROBOTS);
    await vi.advanceTimersByTimeAsync(0);
    expect(analysed).toHaveLength(2);
    expect(analysed[1]).toEqual({ response: null, robots: ROBOTS, performance: SLOW });
    expect(lcpRule()).toBe(true);
    expect(version()).toBeGreaterThan(first);

    // A reload of the same URL keeps the shown audit until the final one (the score never flickers
    // to an audit without the measurement).
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    expect(analysed).toHaveLength(3);
    const shown = version();
    expect(lcpRule()).toBe(true);
    fetches[1]!(ROBOTS);
    measurements[1]!(rawMeasurement(A));
    await vi.advanceTimersByTimeAsync(0);
    expect(analysed).toHaveLength(4);
    expect(lcpRule()).toBe(false);
    expect(version()).toBeGreaterThan(shown);
  });

  test('audit-measurement-that-never-comes-keeps-the-first-audit', async () => {
    controller.navigate(A);
    const contents = views.at(-1)!.contents;
    commit(contents, A, 'A');
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    fetches[0]!(ROBOTS);
    await vi.advanceTimersByTimeAsync(0);
    expect(status().status).toBe('ready');
    // A reload whose measurement never settles: the shown audit stays, then the provisional one
    // replaces it once the auditor gives up on the final context.
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    const shown = version();
    fetches[1]!(ROBOTS);
    await vi.advanceTimersByTimeAsync(CONTEXT_TIMEOUT_MS + 1);
    expect(version()).toBeGreaterThan(shown);
    expect(status().status).toBe('ready');
  });
});
