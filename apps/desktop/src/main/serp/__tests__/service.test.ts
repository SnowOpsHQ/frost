// Spec: specs/serp-service.spec.ts (SERP_INPAGE_DEBOUNCE_MS, MAX_PENDING_SERP_WATCHES, SERP_INTENT_CACHE_SIZE,
// SERP_OUTLINE_ACTIVE_POLL_MS), specs/serp-service.schema.ts (SerpStateSchema, SerpTabStateSchema, PackStatusSchema),
// specs/serp.spec.ts (SERP_READ_TIMEOUT_MS), specs/browser.spec.ts (WATCH_TIMEOUT_MS)
// Acceptance: specs/serp-overlay.feature.md (Service, Outlines)
import { afterEach, describe, expect, test, vi } from 'vitest';
import { appRouter, createSenderPolicy, type IpcContext } from '@app/ipc-contract';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { SERP_PACK_PUBLIC_KEYS } from '@app/specs/serp-selector-pack.spec';
import type { EngineLayout } from '@app/specs/serp-selector-pack.schema';
import { SerpStateSchema, SerpTabStateSchema, type SerpTabState } from '@app/specs/serp-service.schema';
import { MAX_PENDING_SERP_WATCHES, SERP_INPAGE_DEBOUNCE_MS, SERP_OUTLINE_ACTIVE_POLL_MS } from '@app/specs/serp-service.spec';
import { SERP_READ_TIMEOUT_MS, type SerpDevice } from '@app/specs/serp.spec';
import { createFakeIntentClassifier } from '../../intent/fake';
import { BUNDLED_PACK } from '../bundled';
import { createPackStore, type PackFiles } from '../pack-store';
import { analyseSerp } from '../serp-analyse';
import { createSerpService, type SerpTab, type SerpTabs } from '../service';
import { encode, packObject, signBytes, signedPack, testKey } from './pack-keys';

afterEach(() => vi.useRealTimers());

const GOOGLE = 'https://www.google.com/search?q=running+shoes&gl=us&hl=en';
const GOOGLE_2 = 'https://www.google.com/search?q=trail+shoes&gl=us&hl=en';
const BING = 'https://www.bing.com/search?q=coffee+grinder';
const NOT_SERP = 'https://www.example.com/article';

/** A reader answer: organic results with boxes (or `override`). */
const answer = (n = 3) => ({
  ok: true,
  blocks: [{ type: 'organic', items: Array.from({ length: n }, (_, i) => ({ title: `Result ${i + 1}`, url: `https://site${i + 1}.example/page`, rect: { x: 10, y: 100 * i, width: 600, height: 80 } })) }],
  stats: { nodes: 20, elapsedMs: 1, truncated: false, organicCut: false },
});

/** Tabs the test drives: each with its page (a fake `executeJavaScriptInIsolatedWorld` target). */
function fakeTabs() {
  const list = new Map<number, { contentsId: number; url: string; documentSeq: number; loading: boolean; device: SerpDevice; page: { executeJavaScriptInIsolatedWorld: () => Promise<unknown> } }>();
  let active: number | null = null;
  const tabs: SerpTabs = {
    tab: (tabId) => {
      const tab = list.get(tabId);
      return tab ? ({ ...tab } satisfies SerpTab) : null;
    },
    tabOf: (contentsId) => [...list.entries()].find(([, tab]) => tab.contentsId === contentsId)?.[0] ?? null,
    activeTabId: () => active,
  };
  return {
    tabs,
    add(tabId: number, url: string, options: { device?: SerpDevice; loading?: boolean; active?: boolean } = {}) {
      list.set(tabId, { contentsId: 100 + tabId, url, documentSeq: 1, loading: options.loading ?? false, device: options.device ?? 'desktop', page: { executeJavaScriptInIsolatedWorld: async () => undefined } });
      if (options.active ?? active === null) active = tabId;
      return list.get(tabId)!;
    },
    get: (tabId: number) => list.get(tabId)!,
    /** A new document at `url` (did-navigate: the document sequence goes up). */
    navigate(tabId: number, url: string) {
      const tab = list.get(tabId)!;
      tab.url = url;
      tab.documentSeq += 1;
    },
    remove: (tabId: number) => list.delete(tabId),
    activate: (tabId: number | null) => (active = tabId),
  };
}

function setup(options: { packs?: Parameters<typeof createSerpService>[0]['packs']; intent?: Parameters<typeof createFakeIntentClassifier>[0]; read?: (page: unknown, layout: EngineLayout) => Promise<unknown> } = {}) {
  const t = fakeTabs();
  const packs = options.packs ?? createPackStore({ bundled: BUNDLED_PACK, publicKeys: SERP_PACK_PUBLIC_KEYS, storage: { read: async () => null, write: async () => undefined }, fetchPack: null, url: 'https://example.invalid/serp-selectors.json' });
  const read = vi.fn(options.read ?? (async (_page: unknown, _layout: EngineLayout) => answer()));
  const analyzer = { analyse: vi.fn(async (raw: unknown, context: { params: unknown; packVersion: number; redirects: unknown }) => analyseSerp(raw, context)) };
  let endOutline: (reason: string) => void = () => undefined;
  const outline = {
    paint: vi.fn(async (_page: unknown, layout: EngineLayout | null) => (layout ? { on: true, boxes: 3 } : { on: false, boxes: 0 })),
    ended: vi.fn(() => new Promise<unknown>((resolve) => (endOutline = resolve))),
  };
  const classifier = createFakeIntentClassifier(options.intent ?? { state: 'ready' });
  const classify = vi.spyOn(classifier, 'classify');
  const ensureModel = vi.spyOn(classifier, 'ensureModel');
  let clock = 1_700_000_000_000;
  const serp = createSerpService({ packs, analyzer, read, outline, classifier, tabs: t.tabs, now: () => clock++ });
  /** Lets the read, the analysis and any classification settle. */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { t, serp, read, analyzer, outline, classifier, classify, ensureModel, settle, endOutline: (reason: string) => endOutline(reason) };
}

/** Loads `url` as a new document in `tabId` and lets the read settle. */
async function load(s: ReturnType<typeof setup>, tabId: number, url: string) {
  s.t.navigate(tabId, url);
  s.serp.navigated(s.t.get(tabId).contentsId);
  s.serp.loaded(s.t.get(tabId).contentsId);
  await s.settle();
}

const valid = (state: SerpTabState) => {
  const parsed = SerpTabStateSchema.safeParse(state);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return state;
};

describe('SERP service', () => {
  test('serp-service-reads-serp-loads', async () => {
    const s = setup();
    s.t.add(1, 'about:blank');
    await load(s, 1, GOOGLE);
    // One read, in the tab's page, with the Google layout of the pack in use; analysed with the parameters.
    expect(s.read).toHaveBeenCalledTimes(1);
    expect(s.read.mock.calls[0]![0]).toBe(s.t.get(1).page);
    expect(s.read.mock.calls[0]![1]!.results).toBeTruthy();
    expect(s.analyzer.analyse.mock.calls[0]![1]).toMatchObject({ params: { engine: 'google', query: 'running shoes', gl: 'us', hl: 'en', device: 'desktop' }, packVersion: expect.any(Number) });
    const state = valid(s.serp.state(1));
    expect(state.serp).toMatchObject({ status: 'ready', tabId: 1, documentSeq: 2, url: GOOGLE, snapshot: { status: 'ready', composition: { counts: { organic: 3 } } } });
    expect(state.serp.status === 'ready' && state.serp.readAt).toBeGreaterThan(0);
    // Another page is never read.
    await load(s, 1, NOT_SERP);
    expect(s.read).toHaveBeenCalledTimes(1);
    expect(valid(s.serp.state(1)).serp).toEqual({ status: 'not-serp', tabId: 1, url: NOT_SERP });
    // A tab id that names no tab: not a result page, no URL.
    expect(valid(s.serp.state(9)).serp).toEqual({ status: 'not-serp', tabId: 9, url: '' });
    // A loading result page is pending (its parameters known), and read only once it has loaded.
    s.t.add(2, GOOGLE_2, { loading: true, active: false });
    expect(valid(s.serp.state(2)).serp).toMatchObject({ status: 'pending', params: { query: 'trail shoes' } });
    expect(s.read).toHaveBeenCalledTimes(1);
    s.t.get(2).loading = false;
    s.serp.loaded(s.t.get(2).contentsId);
    await s.settle();
    expect(s.serp.state(2).serp.status).toBe('ready');
    expect(s.read).toHaveBeenCalledTimes(2);
  });

  test('serp-service-state-per-tab', async () => {
    const s = setup();
    s.t.add(1, 'about:blank');
    s.t.add(2, 'about:blank', { device: 'mobile', active: false });
    await load(s, 1, GOOGLE);
    await load(s, 2, BING);
    const one = s.serp.state(1).serp;
    const two = s.serp.state(2).serp;
    expect(one.status === 'ready' && one.snapshot.params).toMatchObject({ engine: 'google', query: 'running shoes', device: 'desktop' });
    expect(two.status === 'ready' && two.snapshot.params).toMatchObject({ engine: 'bing', query: 'coffee grinder', device: 'mobile' });
    // A new document drops the tab's reading at once (the other tab keeps its own).
    s.t.navigate(1, GOOGLE);
    s.serp.navigated(s.t.get(1).contentsId);
    s.t.get(1).loading = true;
    expect(s.serp.state(1).serp.status).toBe('pending');
    expect(s.serp.state(2).serp.status).toBe('ready');
    // A read that answers after its document went is dropped.
    let release: (value: unknown) => void = () => undefined;
    s.read.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    s.t.get(1).loading = false;
    s.serp.loaded(s.t.get(1).contentsId);
    s.t.navigate(1, NOT_SERP);
    s.serp.navigated(s.t.get(1).contentsId);
    release(answer());
    await s.settle();
    expect(s.serp.state(1).serp).toEqual({ status: 'not-serp', tabId: 1, url: NOT_SERP });
    expect(s.analyzer.analyse).toHaveBeenCalledTimes(2);
    // A closed tab's reading goes.
    s.serp.closed(s.t.get(2).contentsId);
    s.t.remove(2);
    expect(s.serp.state(2).serp).toEqual({ status: 'not-serp', tabId: 2, url: '' });
    // A render profile change (another device) reads the page again when it is next asked for.
    await load(s, 1, GOOGLE);
    s.t.get(1).device = 'tablet';
    expect(s.serp.state(1).serp.status).toBe('pending');
    await s.settle();
    const tablet = s.serp.state(1).serp;
    expect(tablet.status === 'ready' && tablet.snapshot.params.device).toBe('tablet');
  });

  test('serp-service-read-failures', async () => {
    vi.useFakeTimers();
    const s = setup({ read: () => new Promise(() => undefined) });
    s.t.add(1, GOOGLE);
    s.serp.loaded(s.t.get(1).contentsId);
    await vi.advanceTimersByTimeAsync(SERP_READ_TIMEOUT_MS - 1);
    expect(s.serp.state(1).serp.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(valid(s.serp.state(1)).serp).toMatchObject({ status: 'unreadable', reason: 'timeout', params: { query: 'running shoes' } });
    expect(s.analyzer.analyse).not.toHaveBeenCalled();
    // The reader failing (the page went away under it) is `invalid-answer`; a layout it cannot read keeps its reason.
    s.read.mockRejectedValueOnce(new Error('frame gone'));
    s.serp.loaded(s.t.get(1).contentsId);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.serp.state(1).serp).toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
    s.read.mockResolvedValueOnce({ ok: false, reason: 'no-container', stats: { nodes: 1, elapsedMs: 0, truncated: false, organicCut: false } });
    s.serp.loaded(s.t.get(1).contentsId);
    await vi.advanceTimersByTimeAsync(0);
    expect(valid(s.serp.state(1)).serp).toMatchObject({ status: 'unreadable', reason: 'no-container', packVersion: expect.any(Number) });
    // Unreadable is never read again on its own.
    const reads = s.read.mock.calls.length;
    s.serp.state(1);
    expect(s.read).toHaveBeenCalledTimes(reads);
  });

  test('serp-service-inpage-debounced', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.t.add(1, GOOGLE);
    s.serp.loaded(s.t.get(1).contentsId);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.read).toHaveBeenCalledTimes(1);
    // A result page that updates in place: two quick moves, one read once it has been quiet.
    const move = (url: string) => {
      s.t.get(1).url = url;
      s.serp.navigatedInPage(s.t.get(1).contentsId, url);
    };
    move('https://www.google.com/search?q=trail&gl=us&hl=en');
    expect(s.serp.state(1).serp).toMatchObject({ status: 'pending', params: { query: 'trail' } });
    await vi.advanceTimersByTimeAsync(SERP_INPAGE_DEBOUNCE_MS - 50);
    move(GOOGLE_2);
    await vi.advanceTimersByTimeAsync(SERP_INPAGE_DEBOUNCE_MS - 1);
    // Asking for the state does not read early.
    expect(s.serp.state(1).serp.status).toBe('pending');
    expect(s.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.read).toHaveBeenCalledTimes(2);
    const ready = s.serp.state(1).serp;
    expect(ready.status === 'ready' && ready.snapshot.params.query).toBe('trail shoes');
    // The same search (a fragment, a tracking parameter): the reading stays.
    move(`${GOOGLE_2}&ved=abc#top`);
    await vi.advanceTimersByTimeAsync(SERP_INPAGE_DEBOUNCE_MS * 2);
    expect(s.read).toHaveBeenCalledTimes(2);
    expect(s.serp.state(1).serp).toMatchObject({ status: 'ready', url: `${GOOGLE_2}&ved=abc#top` });
    // In place to a page that is not a result page: at once, nothing read.
    move('https://www.google.com/maps?q=x');
    expect(s.serp.state(1).serp.status).toBe('not-serp');
    await vi.advanceTimersByTimeAsync(SERP_INPAGE_DEBOUNCE_MS * 2);
    expect(s.read).toHaveBeenCalledTimes(2);
  });

  test('serp-service-watch-wakes-times-out-capped', async () => {
    const s = setup();
    s.t.add(1, 'about:blank');
    const first = s.serp.state(1);
    // Wakes on a change.
    const waiting = s.serp.watch(1, first.version);
    await load(s, 1, GOOGLE);
    const woken = await waiting;
    expect(woken.version).toBeGreaterThan(first.version);
    // At once when already newer; an abort answers the current state.
    await expect(s.serp.watch(1, -1)).resolves.toMatchObject({ tabId: 1 });
    const aborted = new AbortController();
    const parked = s.serp.watch(1, s.serp.state(1).version, aborted.signal);
    aborted.abort();
    await expect(parked).resolves.toMatchObject({ version: s.serp.state(1).version });
    // Capped: one more than MAX_PENDING_SERP_WATCHES answers the oldest early.
    const version = s.serp.state(1).version;
    let oldestDone = false;
    const oldest = s.serp.watch(1, version).then((state) => {
      oldestDone = true;
      return state;
    });
    const rest = Array.from({ length: MAX_PENDING_SERP_WATCHES }, () => s.serp.watch(1, version));
    await s.settle();
    expect(oldestDone).toBe(true);
    await expect(oldest).resolves.toMatchObject({ version });
    expect(s.serp.pendingWatches()).toBe(MAX_PENDING_SERP_WATCHES);
    s.serp.forget();
    await Promise.all(rest);
    expect(s.serp.pendingWatches()).toBe(0);
    // Through `serp.watch`: nothing changes, so the current state after WATCH_TIMEOUT_MS.
    vi.useFakeTimers();
    const ctx: IpcContext = {
      sender: { origin: APP_ORIGIN, live: true, windowId: 7, isWindowContents: true, isMainFrame: true },
      policy: createSenderPolicy({ knownWindowIds: new Set([7]) }),
      services: { serp: s.serp },
    };
    const idle = appRouter.createCaller(ctx).serp.watch({ tabId: 1, sinceVersion: s.serp.state(1).version });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS);
    await expect(idle).resolves.toMatchObject({ tabId: 1, version: s.serp.state(1).version });
    expect(s.serp.pendingWatches()).toBe(0);
  });

  test('serp-service-pack-update-swaps-live', async () => {
    const key = testKey();
    const bundled: PackFiles = signedPack(key, { version: 2 });
    const v3 = packObject({ version: 3 });
    (v3.engines as { layout: EngineLayout }[])[0]!.layout = { results: '#results-v3', blocks: [{ type: 'organic', container: '#results-v3', item: '.r', link: 'a[href]', required: true }] };
    const v3Bytes = encode(v3);
    const fetchPack = vi.fn(async (url: string) => ({ ok: true as const, bytes: url.endsWith('.sig') ? encode(signBytes(v3Bytes, key)) : v3Bytes }));
    const write = vi.fn(async () => undefined);
    const packs = createPackStore({ bundled, publicKeys: [key.spki], storage: { read: async () => null, write }, fetchPack, url: 'https://packs.example/serp-selectors.json' });
    const s = setup({ packs });
    expect(s.serp.packStatus()).toEqual({ state: 'ready', version: 2, source: 'bundled', published: '2026-10-28', lastUpdate: null, checking: false });
    s.t.add(1, 'about:blank');
    s.t.add(2, 'about:blank', { active: false });
    await load(s, 1, 'https://search.example.com/search?q=one');
    await load(s, 2, 'https://search.example.com/search?q=two');
    expect(s.serp.setOutlines(1, true)).toBe(true);
    expect(s.read).toHaveBeenCalledTimes(2);
    expect(fetchPack).not.toHaveBeenCalled();
    // The user's check: installed, live at once.
    const watcher = s.serp.watch(2, s.serp.state(2).version);
    const checking = s.serp.checkPackUpdate();
    expect(s.serp.packStatus().checking).toBe(true);
    // A watcher woken by the check's start sees it running.
    expect((await watcher).pack.checking).toBe(true);
    await expect(checking).resolves.toBe('installed');
    await s.settle();
    expect(valid(s.serp.state(1)).pack).toMatchObject({ state: 'ready', version: 3, source: 'remote', lastUpdate: { outcome: 'installed', at: expect.any(Number) }, checking: false });
    // Outlines go; the active tab is read again at once with the new layout; the other when asked.
    expect(s.outline.paint).toHaveBeenLastCalledWith(s.t.get(1).page, null, null);
    expect(s.serp.state(1).outlines).toBe(false);
    expect(s.read).toHaveBeenCalledTimes(3);
    expect(s.read.mock.calls[2]![1]).toMatchObject({ results: '#results-v3' });
    const one = s.serp.state(1).serp;
    expect(one.status === 'ready' && one.snapshot.packVersion).toBe(3);
    expect(s.serp.state(2).serp.status).toBe('pending');
    await s.settle();
    const two = s.serp.state(2).serp;
    expect(two.status === 'ready' && two.snapshot.packVersion).toBe(3);
    expect(s.read).toHaveBeenCalledTimes(4);
    // Checked again: not newer, nothing changes.
    await expect(s.serp.checkPackUpdate()).resolves.toBe('not-newer');
    expect(s.serp.packStatus().lastUpdate?.outcome).toBe('not-newer');
    expect(s.read).toHaveBeenCalledTimes(4);
  });

  test('serp-service-disabled-pack', async () => {
    const broken = { bytes: BUNDLED_PACK.bytes, signature: BUNDLED_PACK.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) };
    const packs = createPackStore({ bundled: broken, publicKeys: SERP_PACK_PUBLIC_KEYS, storage: { read: async () => null, write: async () => undefined }, fetchPack: async () => ({ ok: false, reason: 'unreachable' }), url: 'https://example.invalid/p.json' });
    const s = setup({ packs });
    s.t.add(1, GOOGLE);
    s.serp.loaded(s.t.get(1).contentsId);
    await s.settle();
    expect(s.read).not.toHaveBeenCalled();
    expect(valid(s.serp.state(1)).serp).toEqual({ status: 'disabled', tabId: 1, reason: 'pack-invalid' });
    expect(s.serp.packStatus()).toMatchObject({ state: 'disabled', version: null, source: null, published: null });
    await expect(s.serp.checkPackUpdate()).resolves.toBe('disabled');
    expect(s.serp.setOutlines(1, true)).toBe(false);
  });

  test('serp-service-outlines-active-tab-only', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.t.add(1, GOOGLE);
    s.t.add(2, BING, { active: false });
    s.t.add(3, NOT_SERP, { active: false });
    for (const tabId of [1, 2]) s.serp.loaded(s.t.get(tabId).contentsId);
    await vi.advanceTimersByTimeAsync(0);
    // Not for a background tab, a page that is not a result page, or one still being read.
    expect(s.serp.setOutlines(2, true)).toBe(false);
    s.t.activate(3);
    expect(s.serp.setOutlines(3, true)).toBe(false);
    s.t.activate(1);
    expect(s.outline.paint).not.toHaveBeenCalled();
    // On: drawn in the active tab's page with the engine's layout; the state says so.
    expect(s.serp.setOutlines(1, true)).toBe(true);
    // On the document at the reading's URL only.
    expect(s.outline.paint).toHaveBeenCalledExactlyOnceWith(s.t.get(1).page, expect.objectContaining({ results: expect.any(String) }), GOOGLE);
    await vi.advanceTimersByTimeAsync(0);
    expect(valid(s.serp.state(1)).outlines).toBe(true);
    expect(s.serp.setOutlines(1, true)).toBe(true);
    expect(s.outline.paint).toHaveBeenCalledTimes(1);
    // Off by the toggle.
    expect(s.serp.setOutlines(1, false)).toBe(false);
    expect(s.outline.paint).toHaveBeenLastCalledWith(s.t.get(1).page, null, null);
    expect(s.serp.state(1).outlines).toBe(false);
    // Off on a tab switch (checked while one is drawn).
    s.serp.setOutlines(1, true);
    await vi.advanceTimersByTimeAsync(0);
    s.t.activate(2);
    await vi.advanceTimersByTimeAsync(SERP_OUTLINE_ACTIVE_POLL_MS);
    expect(s.serp.state(1).outlines).toBe(false);
    expect(s.outline.paint).toHaveBeenLastCalledWith(s.t.get(1).page, null, null);
    // Off on an in-page navigation (removed from the page), and on a new document (gone with it).
    s.t.activate(1);
    s.serp.setOutlines(1, true);
    await vi.advanceTimersByTimeAsync(0);
    s.t.get(1).url = GOOGLE_2;
    s.serp.navigatedInPage(s.t.get(1).contentsId, GOOGLE_2);
    expect(s.serp.state(1).outlines).toBe(false);
    expect(s.outline.paint).toHaveBeenLastCalledWith(s.t.get(1).page, null, null);
    await vi.advanceTimersByTimeAsync(SERP_INPAGE_DEBOUNCE_MS);
    s.serp.setOutlines(1, true);
    await vi.advanceTimersByTimeAsync(0);
    const paints = s.outline.paint.mock.calls.length;
    s.t.navigate(1, GOOGLE);
    s.serp.navigated(s.t.get(1).contentsId);
    expect(s.serp.state(1).outlines).toBe(false);
    // An off paint goes to the page even so (harmless on the fresh document).
    expect(s.outline.paint).toHaveBeenCalledTimes(paints + 1);
    expect(s.outline.paint).toHaveBeenLastCalledWith(s.t.get(1).page, null, null);
    // The page removed the overlay (`ended`): off.
    s.serp.loaded(s.t.get(1).contentsId);
    await vi.advanceTimersByTimeAsync(0);
    s.serp.setOutlines(1, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.serp.state(1).outlines).toBe(true);
    s.endOutline('removed');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.serp.state(1).outlines).toBe(false);
    // A paint that did not draw (an answer of the wrong shape) is off.
    s.outline.paint.mockResolvedValueOnce('nonsense' as never);
    s.serp.setOutlines(1, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.serp.state(1).outlines).toBe(false);
  });

  test('serp-service-intent-only-when-ready', async () => {
    const s = setup({ intent: { state: 'model-missing' } });
    s.t.add(1, 'about:blank');
    s.t.add(2, 'about:blank', { active: false });
    await load(s, 1, GOOGLE);
    // The model is missing: the answer says so; nothing is classified, nothing downloads.
    expect(valid(s.serp.state(1)).intent).toEqual({ state: 'model-missing' });
    expect(s.serp.intentState()).toBe('model-missing');
    await expect(s.serp.readApi.classifyIntent('buy shoes')).resolves.toEqual({ state: 'model-missing' });
    await expect(s.serp.classify('buy shoes')).resolves.toEqual({ state: 'model-missing' });
    expect(s.ensureModel).not.toHaveBeenCalled();
    expect(s.classify).toHaveBeenCalledTimes(2);
    // Not a result page: no intent at all.
    await load(s, 2, NOT_SERP);
    expect(s.serp.state(2).intent).toBeNull();
    // The user enables it: the model is fetched once, then the current query is classified, locally.
    const before = s.serp.state(1).version;
    await expect(s.serp.enableIntent()).resolves.toBe('ready');
    expect(s.ensureModel).toHaveBeenCalledTimes(1);
    expect(s.serp.state(1).version).toBeGreaterThan(before);
    await s.settle();
    const ready = valid(s.serp.state(1)).intent;
    expect(ready).toMatchObject({ state: 'ready', result: { label: expect.any(String), model: 'fake' } });
    expect(s.classify).toHaveBeenLastCalledWith('running shoes');
    // The same query in another tab is answered from the session's answers.
    const calls = s.classify.mock.calls.length;
    await load(s, 2, GOOGLE);
    expect(s.serp.state(2).intent).toEqual(ready);
    expect(s.classify).toHaveBeenCalledTimes(calls);
    // A classifier that becomes unavailable is asked once per reading (its process restarts on a
    // request), never in a loop.
    s.classifier.setState('unavailable');
    await load(s, 1, GOOGLE_2);
    expect(s.serp.state(1).intent).toEqual({ state: 'unavailable' });
    expect(s.classify).toHaveBeenCalledTimes(calls + 1);
    for (let i = 0; i < 3; i++) s.serp.state(1);
    await s.settle();
    expect(s.classify).toHaveBeenCalledTimes(calls + 1);
    // A restarted process recovers: the next reading's one attempt succeeds.
    s.classify.mockImplementationOnce(async (query: string) => {
      s.classifier.setState('ready');
      return s.classifier.classify(query);
    });
    await load(s, 1, 'https://www.google.com/search?q=hiking+boots');
    await s.settle();
    expect(s.serp.state(1).intent).toMatchObject({ state: 'ready' });
    expect(s.ensureModel).toHaveBeenCalledTimes(1);
  });

  test('serp-service-clear-browsing-data', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.t.add(1, GOOGLE);
    s.serp.loaded(s.t.get(1).contentsId);
    await vi.advanceTimersByTimeAsync(0);
    s.serp.setOutlines(1, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.serp.state(1).intent).toMatchObject({ state: 'ready' });
    const classified = s.classify.mock.calls.length;
    s.serp.forget();
    // The reading, the outline and the session's intent answers go; the page is read afresh when next asked for.
    expect(s.outline.paint).toHaveBeenLastCalledWith(s.t.get(1).page, null, null);
    const after = s.serp.state(1);
    expect(after.serp.status).toBe('pending');
    expect(after.outlines).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.serp.state(1).intent).toMatchObject({ state: 'ready' });
    expect(s.classify.mock.calls.length).toBe(classified + 1);
  });

  test('serp-service-forget-drops-inflight-intent', async () => {
    const s = setup();
    s.t.add(1, 'about:blank');
    let answer: (value: Awaited<ReturnType<typeof s.classifier.classify>>) => void = () => undefined;
    s.classify.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await load(s, 1, GOOGLE);
    expect(s.classify).toHaveBeenCalledTimes(1);
    // Clear Browsing Data while the query is being classified: its answer is not kept.
    s.serp.forget();
    answer({ state: 'ready', result: { label: 'commercial', confidence: 0.9, scores: { informational: 0.05, navigational: 0.03, commercial: 0.9, transactional: 0.02 }, model: 'fake' } });
    await s.settle();
    // Read afresh, the query is classified again (nothing was remembered from before the clear).
    s.serp.state(1);
    await s.settle();
    expect(s.classify).toHaveBeenCalledTimes(2);
    expect(s.serp.state(1).intent).toMatchObject({ state: 'ready', result: { model: 'fake' } });
    expect(s.serp.state(1).intent).not.toMatchObject({ result: { label: 'commercial', confidence: 0.9 } });
  });

  test('serp-service-analysis-drop-is-transient', async () => {
    const s = setup();
    s.t.add(1, 'about:blank');
    const dropped = (_raw: unknown, context: { params: unknown; packVersion: number }) => Promise.resolve({ status: 'unreadable' as const, reason: 'timeout' as const, params: context.params as never, packVersion: context.packVersion });
    // Dropped once (a full queue): read again at once, and ready.
    s.analyzer.analyse.mockImplementationOnce(dropped);
    await load(s, 1, GOOGLE);
    expect(s.read).toHaveBeenCalledTimes(2);
    expect(s.serp.state(1).serp.status).toBe('ready');
    // Dropped twice: still pending (never "couldn't read"), and read afresh when next asked for.
    s.analyzer.analyse.mockImplementationOnce(dropped).mockImplementationOnce(dropped);
    await load(s, 1, GOOGLE_2);
    expect(s.read).toHaveBeenCalledTimes(4);
    expect(s.serp.state(1).serp.status).toBe('pending');
    await s.settle();
    expect(s.read).toHaveBeenCalledTimes(5);
    expect(s.serp.state(1).serp.status).toBe('ready');
    // The reader's own timeout (it did not finish reading) is a real "couldn't read".
    s.read.mockResolvedValueOnce({ ok: false, reason: 'timeout', stats: { nodes: 20_000, elapsedMs: 150, truncated: false, organicCut: false } });
    await load(s, 1, GOOGLE);
    expect(s.serp.state(1).serp).toMatchObject({ status: 'unreadable', reason: 'timeout' });
    expect(s.read).toHaveBeenCalledTimes(6);
  });

  test('serp-service-paint-across-navigation', async () => {
    const s = setup();
    s.t.add(1, 'about:blank');
    await load(s, 1, GOOGLE);
    // A paint in flight when the tab navigates (a reload, the same URL): the off paint follows it,
    // and once it answers that it drew anyway, it is removed again.
    let drew: (value: { on: boolean; boxes: number }) => void = () => undefined;
    s.outline.paint.mockImplementationOnce(() => new Promise((resolve) => (drew = resolve)));
    expect(s.serp.setOutlines(1, true)).toBe(true);
    expect(s.outline.paint).toHaveBeenLastCalledWith(s.t.get(1).page, expect.anything(), GOOGLE);
    s.t.navigate(1, GOOGLE);
    s.serp.navigated(s.t.get(1).contentsId);
    expect(s.outline.paint).toHaveBeenLastCalledWith(s.t.get(1).page, null, null);
    const calls = s.outline.paint.mock.calls.length;
    drew({ on: true, boxes: 3 });
    await s.settle();
    expect(s.outline.paint).toHaveBeenCalledTimes(calls + 1);
    expect(s.outline.paint).toHaveBeenLastCalledWith(s.t.get(1).page, null, null);
    expect(s.outline.ended).not.toHaveBeenCalled();
    expect(s.serp.state(1).outlines).toBe(false);
  });

  test('serp-service-watch-abort-is-passive', async () => {
    const s = setup();
    s.t.add(1, GOOGLE, { loading: true });
    const aborted = new AbortController();
    const parked = s.serp.watch(1, s.serp.state(1).version, aborted.signal);
    // Loaded meanwhile, with no event yet: an aborted watch answers without starting a read.
    s.t.get(1).loading = false;
    aborted.abort();
    await expect(parked).resolves.toMatchObject({ serp: { status: 'pending' } });
    expect(s.read).not.toHaveBeenCalled();
    s.serp.state(1);
    expect(s.read).toHaveBeenCalledTimes(1);
  });

  test('serp-read-api', async () => {
    const s = setup();
    s.t.add(1, 'about:blank');
    await load(s, 1, GOOGLE);
    const snapshot = s.serp.readApi.snapshot(1);
    expect(SerpStateSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toEqual(s.serp.state(1).serp);
    expect(s.serp.readApi.snapshot(5)).toEqual({ status: 'not-serp', tabId: 5, url: '' });
    await expect(s.serp.readApi.classifyIntent('weather today')).resolves.toMatchObject({ state: 'ready' });
    expect(s.ensureModel).not.toHaveBeenCalled();
    // Disposed: waiters answer, nothing else runs.
    const waiting = s.serp.watch(1, s.serp.state(1).version);
    s.serp.dispose();
    await expect(waiting).resolves.toMatchObject({ tabId: 1 });
  });
});
