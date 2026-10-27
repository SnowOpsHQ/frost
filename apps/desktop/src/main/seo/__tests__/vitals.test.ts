// Spec: specs/seo-speed.spec.ts (SPEED_WORLD_ID, SPEED_STATE_KEY, SPEED_LIMITS, SPEED_SETTLE_MS, SPEED_MEASURE_TIMEOUT_MS,
// SPEED_MIN_INTERVAL_MS, SPEED_UNAVAILABLE_REASONS), specs/seo-speed.schema.spec.ts (PerformanceMeasurementSchema, BlockingScriptsSchema)
// Acceptance: specs/seo-speed.feature.md (Measurement, Validation, Main)
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import webVitalsSource from 'virtual:web-vitals-iife';
import { EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SEO_WORLD_ID, SNAPSHOT_LIMITS, SOCIAL_TAGS, SOCIAL_URL_TAGS } from '@app/specs/seo-limits.spec';
import { PageSnapshotSchema } from '@app/specs/seo-snapshot.spec';
import { MAX_BLOCKING_SCRIPTS, SPEED_LIMITS, SPEED_MEASURE_TIMEOUT_MS, SPEED_MIN_INTERVAL_MS, SPEED_SETTLE_MS, SPEED_STATE_KEY, SPEED_WORLD_ID, type SpeedLimits } from '@app/specs/seo-speed.spec';
import { PerformanceMeasurementSchema, type PerformanceMeasurement } from '@app/specs/seo-speed.schema.spec';
import { commit, FakeHostWindow, FakeTabView } from '../../../test/controller-fakes';
import { rawSnapshot } from '../../../test/seo-fakes';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../../browser/controller';
import { analyseSnapshot, analyseSpeed } from '../analyse';
import { createAnalyzer, type AnalysisWorker, type SpeedAnalysisResult } from '../analysis';
import { extractPage, type PageDocument } from '../extract';
import { measurePage, runVitals, VITALS_SCRIPT, type SpeedEnvironment } from '../vitals';

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
    bufferFull: false,
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
function fakeWorld(options: { resources?: FakeEntry[]; visibility?: FakeEntry[]; paint?: FakeEntry[]; elements?: number; tree?: unknown } = {}) {
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
  const nav: FakeEntry = { name: A, entryType: 'navigation', startTime: 0, duration: 400, type: 'navigate', redirectCount: 0, responseStart: 90, responseEnd: 100, loadEventEnd: 400, transferSize: 5_000, encodedBodySize: 4_700, decodedBodySize: 20_000, contentType: 'text/html', contentEncoding: 'gzip', domainLookupStart: -5, connectEnd: Number.NaN };
  const leaf = { firstElementChild: null, nextElementSibling: null, parentElement: null };
  const env = {
    performance: {
      now: () => 1_000,
      getEntriesByType: (type: string) => (type === 'navigation' ? [nav] : type === 'resource' ? (options.resources ?? []) : type === 'visibility-state' ? (options.visibility ?? [{ name: 'visible', entryType: 'visibility-state', startTime: 0, duration: 0 }]) : []),
      getEntriesByName: (name: string) => (name === 'first-contentful-paint' ? (options.paint ?? []) : []),
    },
    PerformanceObserver: class {
      constructor(callback: (list: { getEntries(): FakeEntry[] }) => void) {
        observers.push({ callback, options: null });
      }
      observe(o: unknown) {
        observers.at(-1)!.options = o;
      }
    },
    document: { URL: A, documentElement: (options.tree ?? leaf) as never, getElementsByTagName: () => ({ length: options.elements ?? 1 }) },
    global: {} as Record<string, unknown>,
    setTimeout: (callback: () => void) => timers.push(callback),
  } satisfies SpeedEnvironment;
  return { env, library, observers, timers, reports, libraryOptions, deliver: (entries: FakeEntry[]) => observers[0]!.callback({ getEntries: () => entries }) };
}

const LIMITS: SpeedLimits = { ...SPEED_LIMITS, maxResources: 3, maxResourceUrlChars: 30 };
const entry = (name: string, fields: Partial<FakeEntry> = {}): FakeEntry => ({ name, entryType: 'resource', startTime: 10, duration: 20, initiatorType: 'script', transferSize: 1_300, encodedBodySize: 1_000, decodedBodySize: 4_000, contentType: 'text/javascript', contentEncoding: 'br', renderBlockingStatus: 'non-blocking', ...fields });

describe('collector', () => {
  test('vitals-script-runs-in-the-speed-world', async () => {
    const answer = { url: A };
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]) => answer) };
    await expect(runVitals(contents)).resolves.toBe(answer);
    const [world, scripts, ...rest] = contents.executeJavaScriptInIsolatedWorld.mock.calls[0]!;
    // Its own isolated world: never the main world (0), Electron's (999) or the extractor's.
    expect(world).toBe(SPEED_WORLD_ID);
    expect([0, 999, SEO_WORLD_ID]).not.toContain(world);
    expect(scripts).toEqual([{ code: VITALS_SCRIPT }]);
    expect(rest).toEqual([]);
  });

  test('vitals-script-bundles-web-vitals-and-is-self-contained', () => {
    // The library is in the script, as a local of a function (no `webVitals` global, even in the world).
    expect(webVitalsSource.startsWith('var webVitals=')).toBe(true);
    expect(VITALS_SCRIPT).toContain(webVitalsSource.trim());
    expect(VITALS_SCRIPT).toContain('function () {\nvar webVitals=');
    expect(VITALS_SCRIPT).toContain(JSON.stringify(SPEED_LIMITS));
    expect(VITALS_SCRIPT).toContain(JSON.stringify(SPEED_STATE_KEY));
    expect(() => new Function(VITALS_SCRIPT)).not.toThrow();
    const own = measurePage.toString();
    for (const forbidden of [/\brequire\s*\(/, /\bprocess\./, /\belectron\b/i, /\bipcRenderer\b/, /\binnerHTML\b/, /\.(appendChild|insertBefore|removeChild|setAttribute|remove)\(/, /\beval\s*\(/, /\bwindow\./]) expect(own, String(forbidden)).not.toMatch(forbidden);
  });

  test('collector-installs-once-and-waits-for-buffered-entries', async () => {
    const world = fakeWorld({ resources: [entry('https://example.com/early.js')] });
    const load = vi.fn(() => world.library);
    const first = measurePage(world.env, load, LIMITS, SPEED_SETTLE_MS, SPEED_STATE_KEY, SNAPSHOT_LIMITS.maxUrlChars);
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
    const second = measurePage(world.env, load, LIMITS, SPEED_SETTLE_MS, SPEED_STATE_KEY, SNAPSHOT_LIMITS.maxUrlChars) as PerformanceMeasurement;
    expect(second).not.toBeInstanceOf(Promise);
    expect(load).toHaveBeenCalledOnce();
    expect(world.observers).toHaveLength(1);
    expect(second.vitals).toMatchObject({ lcp: 2_000, inp: 240 });
  });

  test('collector-caps-resources-and-keeps-totals', async () => {
    const world = fakeWorld();
    const run = () => measurePage(world.env, () => world.library, LIMITS, 0, SPEED_STATE_KEY, SNAPSHOT_LIMITS.maxUrlChars);
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
    const first = measurePage(hidden.env, () => hidden.library, LIMITS, 0, SPEED_STATE_KEY, SNAPSHOT_LIMITS.maxUrlChars);
    hidden.timers[0]!();
    const m = (await first) as PerformanceMeasurement;
    expect(m.loadedHidden).toBe(true);
    expect(m.dom).toEqual({ elements: 6, depth: 4, depthComplete: true });
    // Hidden only after the first paint: not "loaded hidden".
    const later = fakeWorld({ visibility: [{ name: 'visible', entryType: 'visibility-state', startTime: 0, duration: 0 }, { name: 'hidden', entryType: 'visibility-state', startTime: 5_000, duration: 0 }], paint: [{ name: 'first-contentful-paint', entryType: 'paint', startTime: 300, duration: 0 }] });
    const second = measurePage(later.env, () => later.library, LIMITS, 0, SPEED_STATE_KEY, SNAPSHOT_LIMITS.maxUrlChars);
    later.timers[0]!();
    expect(((await second) as PerformanceMeasurement).loadedHidden).toBe(false);
    // The depth walk is bounded.
    const bounded = fakeWorld({ tree });
    const third = measurePage(bounded.env, () => bounded.library, { ...LIMITS, maxDomWalk: 3 }, 0, SPEED_STATE_KEY, SNAPSHOT_LIMITS.maxUrlChars);
    bounded.timers[0]!();
    expect(((await third) as PerformanceMeasurement).dom).toMatchObject({ depthComplete: false });
  });

  test('collector-survives-a-missing-library-or-observer', async () => {
    const world = fakeWorld();
    const env = { ...world.env, PerformanceObserver: undefined };
    const first = measurePage(env, () => {
      throw new Error('no');
    }, LIMITS, 0, SPEED_STATE_KEY, SNAPSHOT_LIMITS.maxUrlChars);
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
    const run = (max?: number) => PageSnapshotSchema.parse(extractPage(dom.window.document as unknown as PageDocument, SNAPSHOT_LIMITS, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SOCIAL_TAGS, SOCIAL_URL_TAGS, max));
    expect(run().blockingScripts).toEqual({ urls: ['https://example.com/blocking.js', 'https://cdn.example.net/also.js'], total: 2 });
    expect(run(1).blockingScripts).toEqual({ urls: ['https://example.com/blocking.js'], total: 2 });
    expect(MAX_BLOCKING_SCRIPTS).toBe(20);
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
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

describe('tab speed', () => {
  let views: FakeTabView[];
  let controller: BrowserController;
  let collections: Collection[];
  let analyse: (raw: unknown) => Promise<SpeedAnalysisResult>;

  beforeEach(() => {
    vi.useFakeTimers();
    views = [];
    collections = [];
    analyse = async (raw) => analyseSpeed(raw);
    controller = createBrowserController({
      createView: () => {
        const view = new FakeTabView();
        views.push(view);
        return view as unknown as TabView;
      },
      platform: 'linux',
      speed: {
        measure: () =>
          new Promise((resolve, reject) => {
            collections.push({ world: SPEED_WORLD_ID, resolve, reject });
          }),
        analyse: (raw) => analyse(raw),
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
