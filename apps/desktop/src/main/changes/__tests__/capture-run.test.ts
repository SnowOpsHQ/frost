// Spec: specs/projects.spec.ts (PROJECT_RUN_LIMITS, RUN_STATES, RUN_TARGET_OUTCOMES, RUN_RETRY_REFUSALS, RUN_SCOPES,
// MOBILE_QUERY_PROFILE, TABLET_QUERY_PROFILE, RUN_SCREENSHOT_KIND, SERP_SETTLE_WAIT_MS; Phase 10 Task 8:
// RANK_RUN_QUERY_SPACING_MS, RUN_BLOCK_REASONS), specs/rankings.spec.ts (SERP_RUN_VERDICTS), specs/rankings-url.spec.ts (sameRunSearch)
// Acceptance: specs/projects.feature.md (Capture now; Searches in a run; Scenarios: capture run, searches in a run),
// specs/changes-capture.feature.md (SERP reading: a run's search target waits for the reading; Scenario:
// capture-run-waits-for-the-serp-verdict)
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { CaptureAnswer } from '@app/specs/changes.spec';
import { MOBILE_QUERY_PROFILE, PROJECT_RUN_LIMITS, RANK_RUN_QUERY_SPACING_MS, SERP_SETTLE_WAIT_MS, TABLET_QUERY_PROFILE, type RunBlockReason, type RunState } from '@app/specs/projects.spec';
import type { SerpRunVerdict } from '@app/specs/rankings.spec';
import { DEFAULT_RENDER_PROFILE, isDefaultRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import type { TakeScreenshotAnswer } from '@app/specs/screenshot.spec';
import { serpFiltersOf } from '@app/specs/rankings-url.spec';
import { SERP_DEVICE_OF_PRESET } from '@app/specs/serp.spec';
import { createCaptureRuns, queriesAnEngine, runSearchOf, stopRunOnQuit, type CaptureRunDeps, type RunPlan, type RunTab } from '../capture-run';
import { searchKeyOf } from '../search-key';
import { searchParamsForUrl } from '../serp-params';
import { storedPageUrl } from '../snapshot';
import { readySerpFor } from './fakes';

const PROJECT = '01920000-0000-7000-8000-0000000000aa';
const ID = '01920000-0000-7000-8000-000000000001';
const A = 'https://example.com/a';
const B = 'https://example.com/b';
const PHONE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
const NO_JS: RenderProfile = { ...DEFAULT_RENDER_PROFILE, javascriptDisabled: true };
const PARAMS: SearchParams = { engine: 'google', engineLabel: 'Google', query: 'green tea', gl: 'de', hl: 'de', device: 'mobile', page: 1, offset: null, url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de' };
const SEARCH = 'https://www.google.com/search?q=green%20tea&hl=de&gl=de';
const { captureRetryMs: RETRY, targetActiveTimeoutMs: TIMEOUT } = PROJECT_RUN_LIMITS;
const CAPTURED: CaptureAnswer = { status: 'captured', captureId: ID, versionId: ID, newVersion: true, changeCount: 2 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const originOf = (url: string): string | null => (url.startsWith('http') ? new URL(url).origin : null);

/**
 * A browser with tab 1 open and active; a navigation commits at once (a new document, not loading).
 * Its render profiles are modelled on the controller's: a tab's own profile, else its site's pin; the
 * default profile is a Reset, which also removes the pin of the site the tab shows.
 */
function fakeBrowser() {
  type Tab = { -readonly [K in keyof RunTab]: RunTab[K] } & { own: RenderProfile | null };
  const tabs: Tab[] = [{ id: 1, loading: false, documentSeq: 3, error: null, crashed: false, url: 'https://example.com/start', own: null }];
  const pins = new Map<string, RenderProfile>();
  const state = { activeTabId: 1 as number | null, nextId: 10, commit: true, fail: false, tabLimit: false };
  const active = () => tabs.find((tab) => tab.id === state.activeTabId);
  const browser = {
    getState: vi.fn(() => ({ activeTabId: state.activeTabId, tabs: tabs.map(({ own: _o, ...tab }) => ({ ...tab, error: tab.error === null ? null : { ...(tab.error as object) } })) })),
    newTab: vi.fn(() => {
      if (state.tabLimit) return null;
      const id = state.nextId++;
      tabs.push({ id, loading: false, documentSeq: 0, error: null, crashed: false, url: '', own: null });
      state.activeTabId = id;
      return id;
    }),
    navigate: vi.fn((url: string) => {
      const tab = active();
      if (!tab) return false;
      if (state.fail) {
        // A fast failure: the error panel at once, nothing committed.
        tab.error = { code: -105, description: 'ERR_NAME_NOT_RESOLVED', url };
        return true;
      }
      tab.url = url;
      tab.error = null;
      if (state.commit) tab.documentSeq += 1;
      return true;
    }),
    activateTab: vi.fn((id: number) => {
      if (!tabs.some((tab) => tab.id === id)) return false;
      state.activeTabId = id;
      return true;
    }),
    closeTab: vi.fn((id: number) => {
      const at = tabs.findIndex((tab) => tab.id === id);
      if (at < 0) return false;
      tabs.splice(at, 1);
      if (state.activeTabId === id) state.activeTabId = tabs[Math.min(at, tabs.length - 1)]?.id ?? null;
      return true;
    }),
    setRenderProfile: vi.fn((id: number, profile: RenderProfile) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return false;
      if (isDefaultRenderProfile(profile)) {
        const origin = originOf(tab.url);
        if (origin !== null) pins.delete(origin);
        tab.own = null;
      } else tab.own = profile;
      return true;
    }),
  };
  /** The profile in effect in a tab: its own, else its site's pin, else the default. */
  const effective = (tab: Tab): RenderProfile => tab.own ?? pins.get(originOf(tab.url) ?? '') ?? DEFAULT_RENDER_PROFILE;
  return { browser, tabs, state, pins, effective, tab: (id: number) => tabs.find((t) => t.id === id) };
}

function setup(deps: Partial<CaptureRunDeps> = {}) {
  const fake = fakeBrowser();
  /** The tab, URL and profile each capture saw. */
  const seen: { tabId: number; url: string; profile: RenderProfile; options: Parameters<CaptureRunDeps['capture']>[1] }[] = [];
  const capture = vi.fn(async (tabId: number, options: Parameters<CaptureRunDeps['capture']>[1]): Promise<CaptureAnswer> => {
    const tab = fake.tab(tabId)!;
    seen.push({ tabId, url: tab.url, profile: fake.effective(tab), options });
    return CAPTURED;
  });
  const screenshot = vi.fn(async (_tabId: number, _options: Parameters<CaptureRunDeps['screenshot']>[1]): Promise<TakeScreenshotAnswer> => ({ status: 'saved', id: ID, kind: 'viewport', width: 800, height: 600, bytes: 10, truncated: false }));
  // Every landed result page reads `ready` unless a test says otherwise: no settle wait.
  const runs = createCaptureRuns({ browser: fake.browser, capture, screenshot, uuidv7: () => ID, serpVerdictOf: () => 'ready', ...deps });
  return { ...fake, runs, capture, screenshot, seen };
}

const pages = (...urls: string[]): RunPlan['targets'] => urls.map((url) => ({ kind: 'page', label: url, url, searchParams: null }));
const query = (params: SearchParams, url = SEARCH, label = 'q'): RunPlan['targets'][number] => ({ kind: 'query', label, url, searchParams: params });
const plan = (targets: RunPlan['targets'], changes: Partial<RunPlan> = {}): RunPlan => ({ projectId: PROJECT, profile: null, screenshot: false, targets, ...changes });
/** Lets the run go on for `ms` of (fake) time. */
const run = (ms = RETRY * 4) => vi.advanceTimersByTimeAsync(ms);
const outcomes = (state: RunState) => state.targets.map((target) => target.outcome);

describe('capture run', () => {
  test('capture-run-visits-each-target-in-its-own-tab', async () => {
    const { runs, browser, state, seen, tabs } = setup();
    expect(runs.state()).toMatchObject({ state: 'idle', runId: null, targets: [] });
    expect(await runs.start(plan(pages(A, B)))).toEqual({ status: 'started', runId: ID });
    // A new tab, made active; the previous one remembered.
    expect(browser.newTab).toHaveBeenCalledOnce();
    expect(state.activeTabId).toBe(10);
    expect(runs.state()).toMatchObject({ state: 'running', projectId: PROJECT, total: 2, omitted: 0, current: 1 });
    await run();
    expect(seen.map((s) => s.url)).toEqual([A, B]);
    // The capture must be of the page the navigation landed on.
    expect(seen[0]!.options).toEqual({ projectId: PROJECT, source: 'project', searchParams: null, pageUrl: A });
    const done = runs.state();
    expect(done.state).toBe('done');
    expect(done.targets).toEqual([
      { kind: 'page', label: A, outcome: 'captured', changeCount: 2, screenshot: null },
      { kind: 'page', label: B, outcome: 'captured', changeCount: 2, screenshot: null },
    ]);
    expect(tabs.map((t) => t.id)).toEqual([1]);
    expect(runs.running()).toBeNull();
    // A default-profile run sets no profile at all.
    expect(browser.setRenderProfile).not.toHaveBeenCalled();
  });

  test('capture-run-reports-its-end', async () => {
    // Retention enforces the project's policy once its run ends (done, cancelled or its tab closed).
    const afterRun = vi.fn((_projectId: string) => undefined);
    const { runs } = setup({ afterRun });
    await runs.start(plan(pages(A)));
    expect(afterRun).not.toHaveBeenCalled();
    await run();
    expect(runs.state().state).toBe('done');
    expect(afterRun).toHaveBeenCalledExactlyOnceWith(PROJECT);
    await runs.start(plan(pages(A, B)));
    runs.cancel();
    await run();
    expect(afterRun).toHaveBeenCalledTimes(2);
  });

  test('capture-run-waits-for-active-tab', async () => {
    const { runs, browser, state, capture } = setup();
    capture.mockResolvedValueOnce({ status: 'refused', reason: 'no-audit' });
    await runs.start(plan(pages(A, B)));
    await run(RETRY);
    expect(capture).toHaveBeenCalledOnce();
    // The user brings their own tab to the front: the run neither captures nor loads anything into it.
    state.activeTabId = 1;
    await run(TIMEOUT * 3);
    expect(browser.navigate.mock.calls).toEqual([[A]]);
    expect(capture).toHaveBeenCalledOnce();
    expect(runs.state().state).toBe('waiting-for-tab');
    // Waiting never counts against the target: far past the timeout, it is still running.
    expect(outcomes(runs.state())).toEqual(['running', 'pending']);
    // Back in front, it goes on.
    state.activeTabId = 10;
    await run();
    expect(browser.navigate.mock.calls).toEqual([[A], [B]]);
    expect(runs.state().state).toBe('done');
    expect(outcomes(runs.state())).toEqual(['captured', 'captured']);
  });

  test('capture-run-retries-until-settled', async () => {
    const { runs, capture } = setup();
    const answers: CaptureAnswer[] = [{ status: 'refused', reason: 'no-audit' }, { status: 'refused', reason: 'busy' }, { status: 'refused', reason: 'no-audit' }];
    capture.mockImplementation(async () => answers.shift() ?? CAPTURED);
    await runs.start(plan(pages(A)));
    await run(RETRY);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(outcomes(runs.state())).toEqual(['running']);
    // Every `captureRetryMs` while it answers no-audit or busy.
    await run(RETRY * 3);
    expect(capture).toHaveBeenCalledTimes(4);
    expect(outcomes(runs.state())).toEqual(['captured']);
    // Any other refusal fails the target at once.
    const other = setup();
    other.capture.mockResolvedValue({ status: 'refused', reason: 'extract-failed' });
    await other.runs.start(plan(pages(A, B)));
    await run();
    expect(other.capture).toHaveBeenCalledTimes(2);
    expect(outcomes(other.runs.state())).toEqual(['failed', 'failed']);
    expect(other.runs.state().state).toBe('done');
  });

  test('capture-run-waits-for-its-navigation', async () => {
    const { runs, state, tab, capture } = setup();
    state.commit = false;
    await runs.start(plan(pages(A)));
    await run(RETRY * 3);
    // The tab still shows its old document: no capture of it.
    expect(capture).not.toHaveBeenCalled();
    tab(10)!.documentSeq += 1;
    tab(10)!.loading = true;
    await run(RETRY * 2);
    expect(capture).not.toHaveBeenCalled();
    tab(10)!.loading = false;
    await run(RETRY * 2);
    expect(capture).toHaveBeenCalledOnce();
    expect(outcomes(runs.state())).toEqual(['captured']);
  });

  test('capture-run-refuses-a-moved-tab', async () => {
    const { runs, capture, tab } = setup();
    capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    await runs.start(plan(pages(A, B)));
    await run(RETRY * 2);
    expect(capture).toHaveBeenLastCalledWith(10, expect.objectContaining({ pageUrl: A }));
    // The user navigates the run's tab elsewhere: that target fails at once, and the run goes on.
    tab(10)!.url = 'https://elsewhere.example/';
    tab(10)!.documentSeq += 1;
    capture.mockResolvedValue(CAPTURED);
    await run(RETRY * 3);
    expect(outcomes(runs.state())).toEqual(['failed', 'captured']);
    expect(capture.mock.calls.filter(([, options]) => options.pageUrl !== A).map(([, options]) => options.pageUrl)).toEqual([B]);
    // A redirect before the first commit is allowed: the capture is of where it landed.
    const other = setup();
    other.browser.navigate.mockImplementationOnce((url: string) => {
      const t = other.tab(10)!;
      t.url = `${url}?redirected`;
      t.documentSeq += 1;
      return true;
    });
    await other.runs.start(plan(pages(A)));
    await run();
    expect(other.capture).toHaveBeenCalledWith(10, expect.objectContaining({ pageUrl: `${A}?redirected` }));
    expect(outcomes(other.runs.state())).toEqual(['captured']);
  });

  test('capture-run-fails-fast-on-a-load-error', async () => {
    const { runs, state, capture } = setup();
    state.fail = true;
    await runs.start(plan(pages(A, B)));
    // Both fail within a few looks, not after the timeout; the second's error is a new one.
    await run(RETRY * 5);
    expect(outcomes(runs.state())).toEqual(['failed', 'failed']);
    expect(runs.state().state).toBe('done');
    expect(capture).not.toHaveBeenCalled();
  });

  test('capture-run-records-query-params', async () => {
    const desktop = { ...PARAMS, device: 'desktop' as const };
    const targets = [...pages(A), query(desktop)];
    const { runs, seen, screenshot } = setup(readySerpFor(targets));
    await runs.start(plan(targets, { screenshot: true }));
    await run();
    expect(seen.map((s) => s.url)).toEqual([A, SEARCH]);
    expect(seen[1]!.options).toEqual({ projectId: PROJECT, source: 'project', searchParams: desktop, pageUrl: SEARCH });
    // Each captured target's viewport screenshot is linked to its capture, with the same parameters.
    expect(screenshot).toHaveBeenNthCalledWith(1, 10, { kind: 'viewport', projectId: PROJECT, captureId: ID, searchParams: null });
    expect(screenshot).toHaveBeenNthCalledWith(2, 10, { kind: 'viewport', projectId: PROJECT, captureId: ID, searchParams: desktop });
    expect(runs.state().targets.map((t) => [t.kind, t.screenshot])).toEqual([
      ['page', 'saved'],
      ['query', 'saved'],
    ]);
    // The run tab's own parameters from the SERP service win (for a page too; a page with none has none).
    const serp = { ...desktop, engineLabel: 'Google (tab)' };
    const asked: [number, string][] = [];
    const read = setup({
      searchParamsOf: (tabId, pageUrl) => {
        asked.push([tabId, pageUrl]);
        return pageUrl === A ? null : serp;
      },
    });
    await read.runs.start(plan([...pages(A), query(desktop)], { screenshot: true }));
    await run();
    expect(asked).toEqual([
      [10, A],
      [10, SEARCH],
    ]);
    expect(read.seen.map((s) => s.options.searchParams)).toEqual([null, serp]);
    expect(read.screenshot).toHaveBeenNthCalledWith(2, 10, { kind: 'viewport', projectId: PROJECT, captureId: ID, searchParams: serp });
    const page = setup({ searchParamsOf: () => serp });
    await page.runs.start(plan(pages(A)));
    await run();
    expect(page.seen[0]!.options.searchParams).toEqual(serp);
    // A refused screenshot is said, and the capture still counts.
    const other = setup();
    other.screenshot.mockResolvedValue({ status: 'refused', reason: 'capture-failed' });
    await other.runs.start(plan(pages(A), { screenshot: true }));
    await run();
    expect(other.runs.state().targets[0]).toMatchObject({ outcome: 'captured', screenshot: 'failed' });
  });

  test('capture-run-waits-for-the-serp-verdict', async () => {
    const desktop = { ...PARAMS, device: 'desktop' as const };
    let verdict: SerpRunVerdict = 'pending';
    const asked: [number, string][] = [];
    const serpVerdictOf = vi.fn((tabId: number, pageUrl: string): SerpRunVerdict => {
      asked.push([tabId, pageUrl]);
      return verdict;
    });
    const { runs, capture } = setup({ serpVerdictOf, searchParamsOf: readySerpFor([query(desktop)]).searchParamsOf });
    await runs.start(plan([...pages(A), query(desktop)]));
    await run(RETRY * 6);
    // The page target is captured without a verdict; the search target landed and waits while it is pending.
    expect(capture).toHaveBeenCalledOnce();
    expect(outcomes(runs.state())).toEqual(['captured', 'running']);
    expect(asked.length).toBeGreaterThan(1);
    // Asked of the run's tab and its landed page (stored form), never of the page target.
    expect(new Set(asked.map(([tabId, pageUrl]) => `${tabId} ${pageUrl}`))).toEqual(new Set([`10 ${storedPageUrl(SEARCH)}`]));
    verdict = 'ready';
    await run(RETRY * 2);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenLastCalledWith(10, { projectId: PROJECT, source: 'project', searchParams: desktop, pageUrl: storedPageUrl(SEARCH) });
    expect(runs.state()).toMatchObject({ state: 'done' });
    expect(outcomes(runs.state())).toEqual(['captured', 'captured']);

    // A reading that stays pending: after SERP_SETTLE_WAIT_MS of active time the run stops there
    // (Task 8: `no-reading`, nothing captured); time behind another tab does not count.
    const slow = setup({ serpVerdictOf: () => 'pending' });
    await slow.runs.start(plan([query(desktop)]));
    await run(SERP_SETTLE_WAIT_MS / 2);
    slow.state.activeTabId = 1;
    await run(SERP_SETTLE_WAIT_MS * 2);
    expect(slow.capture).not.toHaveBeenCalled();
    slow.state.activeTabId = 10;
    await run(SERP_SETTLE_WAIT_MS / 2 - RETRY * 2);
    expect(slow.capture).not.toHaveBeenCalled();
    expect(outcomes(slow.runs.state())).toEqual(['running']);
    await run(SERP_SETTLE_WAIT_MS / 2);
    expect(slow.capture).not.toHaveBeenCalled();
    expect(slow.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'no-reading' });
    expect(outcomes(slow.runs.state())).toEqual(['blocked']);

    // The wait counts toward the target's active timeout: a settle wait longer than it stops the run (`timed-out`).
    const late = setup({ serpVerdictOf: () => 'pending', limits: { serpSettleWaitMs: TIMEOUT * 2 } });
    await late.runs.start(plan([query(desktop), ...pages(A)]));
    await run(TIMEOUT - RETRY * 4);
    expect(outcomes(late.runs.state())).toEqual(['running', 'pending']);
    await run(RETRY * 8);
    expect(outcomes(late.runs.state())).toEqual(['blocked', 'cancelled']);
    expect(late.capture).not.toHaveBeenCalled();
    expect(late.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'timed-out' });

    // Cancel during the wait: at once, the target cancelled, nothing captured.
    const cancelled = setup({ serpVerdictOf: () => 'pending' });
    await cancelled.runs.start(plan([query(desktop), ...pages(A)]));
    await run(RETRY * 4);
    expect(outcomes(cancelled.runs.state())).toEqual(['running', 'pending']);
    expect(cancelled.runs.cancel()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled.runs.state().state).toBe('cancelled');
    expect(outcomes(cancelled.runs.state())).toEqual(['cancelled', 'cancelled']);
    expect(cancelled.capture).not.toHaveBeenCalled();
    expect(cancelled.tabs.map((t) => t.id)).toEqual([1]);
  });

  test('capture-run-retries-a-screenshot-behind-another-tab', async () => {
    const { runs, screenshot, state } = setup();
    screenshot.mockResolvedValueOnce({ status: 'refused', reason: 'not-active' });
    await runs.start(plan(pages(A), { screenshot: true }));
    await run(RETRY);
    state.activeTabId = 1;
    await run(RETRY * 4);
    // Not asked again while the tab is behind.
    expect(screenshot).toHaveBeenCalledTimes(1);
    state.activeTabId = 10;
    await run(RETRY * 2);
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(runs.state().targets[0]).toMatchObject({ outcome: 'captured', screenshot: 'saved' });
  });

  test('capture-run-retries-a-busy-screenshot', async () => {
    // Another screenshot of the tab under way (`busy`): asked again while the target's time lasts.
    const { runs, screenshot } = setup();
    screenshot.mockResolvedValueOnce({ status: 'refused', reason: 'busy' }).mockResolvedValueOnce({ status: 'refused', reason: 'busy' });
    await runs.start(plan(pages(A), { screenshot: true }));
    await run(RETRY * 6);
    expect(screenshot).toHaveBeenCalledTimes(3);
    expect(runs.state()).toMatchObject({ state: 'done', targets: [{ outcome: 'captured', screenshot: 'saved' }] });

    // While it stays busy, the target's time runs out: captured, its screenshot failed.
    const busy = setup();
    busy.screenshot.mockResolvedValue({ status: 'refused', reason: 'busy' });
    await busy.runs.start(plan(pages(A), { screenshot: true }));
    await run(TIMEOUT + RETRY * 4);
    expect(busy.runs.state()).toMatchObject({ state: 'done', targets: [{ outcome: 'captured', screenshot: 'failed' }] });
  });

  test('capture-run-stops-on-quit', async () => {
    // Quitting while a capture is under way: the run's tab closes at once (before the session store's
    // flush), the user's tab is in front again, and the run ends cancelled once its capture returns.
    const app = new EventEmitter();
    const { runs, capture, tabs, state, browser } = setup();
    stopRunOnQuit(app as never, runs);
    let answer: (value: CaptureAnswer) => void = () => undefined;
    capture.mockImplementationOnce(() => new Promise<CaptureAnswer>((resolve) => (answer = resolve)));
    await runs.start(plan(pages(A, B)));
    await run(RETRY * 2);
    expect(capture).toHaveBeenCalledOnce();
    expect(tabs.map((t) => t.id)).toEqual([1, 10]);
    app.emit('before-quit');
    expect(tabs.map((t) => t.id)).toEqual([1]);
    expect(state.activeTabId).toBe(1);
    answer(CAPTURED);
    await run();
    expect(runs.state()).toMatchObject({ state: 'cancelled', targets: [{ outcome: 'captured' }, { outcome: 'cancelled' }] });
    expect(browser.closeTab).toHaveBeenCalledOnce();
    expect(runs.running()).toBeNull();
    // With no run under way, quitting does nothing.
    app.emit('before-quit');
    expect(browser.closeTab).toHaveBeenCalledOnce();

    // A window closing (the last one quits the app on Linux and Windows only after it closed): the
    // listener is registered as the window is created, ahead of the controller's own.
    const other = setup();
    const quitting = new EventEmitter();
    stopRunOnQuit(quitting as never, other.runs);
    const window = new EventEmitter();
    quitting.emit('browser-window-created', {}, window);
    await other.runs.start(plan(pages(A, B)));
    expect(other.tabs.map((t) => t.id)).toEqual([1, 10]);
    window.emit('close');
    expect(other.tabs.map((t) => t.id)).toEqual([1]);
    expect(other.state.activeTabId).toBe(1);
    await run();
    expect(other.runs.state().state).toBe('cancelled');

    // Stopped during its screenshot, which then finds no tab: cancelled, the capture kept without it.
    const shooting = setup();
    const stopping = new EventEmitter();
    stopRunOnQuit(stopping as never, shooting.runs);
    shooting.screenshot.mockImplementationOnce(async () => {
      stopping.emit('before-quit');
      return { status: 'refused', reason: 'no-tab' };
    });
    await shooting.runs.start(plan(pages(A, B), { screenshot: true }));
    await run();
    expect(shooting.runs.state()).toMatchObject({ state: 'cancelled', targets: [{ outcome: 'captured', screenshot: null }, { outcome: 'cancelled' }] });
    expect(shooting.tabs.map((t) => t.id)).toEqual([1]);

    // Stopped while the project is checked again, as a run starts: no tab is opened for it.
    let live: (value: boolean) => void = () => undefined;
    const starting = setup({ isLive: () => new Promise<boolean>((resolve) => (live = resolve)) });
    const started = starting.runs.start(plan(pages(A)));
    starting.runs.stop();
    live(true);
    expect(await started).toEqual({ status: 'refused', reason: 'no-tab' });
    expect(starting.browser.newTab).not.toHaveBeenCalled();
    expect(starting.runs.running()).toBeNull();
  });

  test('capture-run-applies-profiles', async () => {
    const desktop = { ...PARAMS, device: 'desktop' as const };
    const targets = [...pages(A), query(PARAMS, SEARCH, 'mobile'), query(desktop, `${SEARCH}&x`, 'desktop'), ...pages(B)];
    const { runs, seen, browser, pins } = setup({ ...readySerpFor(targets), limits: { querySpacingMs: 0, serpSettleWaitMs: 0 } });
    await runs.start(plan(targets, { profile: PHONE }));
    await run(RETRY * 12);
    // Grouped by profile: the project's pages in one tab, the mobile query in a fresh one, each set before
    // its first navigation; the desktop query in a third with the default (never the project's phone).
    expect(runs.state().targets.map((t) => t.label)).toEqual([A, B, 'mobile', 'desktop']);
    expect(seen.map((s) => [s.tabId, s.profile])).toEqual([
      [10, PHONE],
      [10, PHONE],
      [11, MOBILE_QUERY_PROFILE],
      [12, DEFAULT_RENDER_PROFILE],
    ]);
    expect(browser.setRenderProfile.mock.calls).toEqual([
      [10, PHONE],
      [11, MOBILE_QUERY_PROFILE],
    ]);
    expect(runs.state().state).toBe('done');
    expect(pins.size).toBe(0);
    // A tablet query is visited as a tablet.
    const tabletTargets = [query({ ...PARAMS, device: 'tablet' }, SEARCH, 'tablet')];
    const tablet = setup({ ...readySerpFor(tabletTargets), limits: { querySpacingMs: 0, serpSettleWaitMs: 0 } });
    await tablet.runs.start(plan(tabletTargets));
    await run(RETRY * 6);
    expect(tablet.browser.setRenderProfile.mock.calls).toEqual([[10, TABLET_QUERY_PROFILE]]);
    expect(tablet.seen.map((s) => s.profile)).toEqual([TABLET_QUERY_PROFILE]);
  });

  test('capture-run-never-removes-a-pin', async () => {
    // The user pinned profiles to the search engine and to a page's site.
    const desktop = { ...PARAMS, device: 'desktop' as const };
    const targets = [query(PARAMS, SEARCH, 'mobile'), query(desktop, `${SEARCH}&x`, 'desktop'), ...pages(A)];
    const { runs, seen, browser, pins } = setup({ ...readySerpFor(targets), limits: { querySpacingMs: 0, serpSettleWaitMs: 0 } });
    pins.set('https://www.google.com', NO_JS);
    pins.set('https://example.com', PHONE);
    await runs.start(plan(targets));
    await run(RETRY * 12);
    expect(runs.state().state).toBe('done');
    // A mobile query, then a desktop one on the same site: the default profile is never set on a tab.
    for (const [, profile] of browser.setRenderProfile.mock.calls) expect(isDefaultRenderProfile(profile)).toBe(false);
    expect(pins).toEqual(
      new Map([
        ['https://www.google.com', NO_JS],
        ['https://example.com', PHONE],
      ]),
    );
    // Pins still apply in a run tab without a profile of its own (the user's choice); the capture records what was in effect.
    expect(seen.map((s) => s.profile)).toEqual([MOBILE_QUERY_PROFILE, NO_JS, PHONE]);
  });

  test('capture-run-cancels-on-tab-close', async () => {
    const { runs, state, browser, capture } = setup();
    capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    await runs.start(plan(pages(A, B)));
    await run(RETRY * 2);
    browser.closeTab(10);
    await run(RETRY * 2);
    const ended = runs.state();
    expect(ended.state).toBe('tab-closed');
    expect(outcomes(ended)).toEqual(['cancelled', 'cancelled']);
    expect(runs.running()).toBeNull();
    // The browser chose the next tab in front; the run closed nothing else.
    expect(state.activeTabId).toBe(1);
    expect(browser.closeTab).toHaveBeenCalledTimes(1);
    // Closed while a capture was under way (it answers no-tab): cancelled, not failed.
    const other = setup();
    other.capture.mockImplementationOnce(async (tabId) => {
      other.browser.closeTab(tabId);
      return { status: 'refused', reason: 'no-tab' };
    });
    await other.runs.start(plan(pages(A, B)));
    await run();
    expect(other.runs.state().state).toBe('tab-closed');
    expect(outcomes(other.runs.state())).toEqual(['cancelled', 'cancelled']);
  });

  test('capture-run-cancels', async () => {
    const { runs, capture, tabs, state } = setup();
    capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    expect(runs.cancel()).toBe(false);
    await runs.start(plan(pages(A, B)));
    await run(RETRY * 2);
    expect(runs.cancel()).toBe(true);
    // At once: the wait is woken, not left to run out.
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.state().state).toBe('cancelled');
    expect(outcomes(runs.state())).toEqual(['cancelled', 'cancelled']);
    expect(tabs.map((t) => t.id)).toEqual([1]);
    expect(state.activeTabId).toBe(1);
  });

  test('capture-run-cancel-during-a-capture', async () => {
    const { runs, capture, screenshot } = setup();
    let answer: (value: CaptureAnswer) => void = () => undefined;
    capture.mockImplementationOnce(() => new Promise<CaptureAnswer>((resolve) => (answer = resolve)));
    await runs.start(plan(pages(A, B), { screenshot: true }));
    await run(RETRY);
    expect(capture).toHaveBeenCalledOnce();
    runs.cancel();
    answer(CAPTURED);
    await run(RETRY);
    // The capture made stays; its screenshot is skipped and the run ends there.
    expect(runs.state().state).toBe('cancelled');
    expect(runs.state().targets.map((t) => [t.outcome, t.screenshot])).toEqual([
      ['captured', null],
      ['cancelled', null],
    ]);
    expect(screenshot).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledOnce();
  });

  test('capture-run-times-out-per-target', async () => {
    const { runs, capture, state } = setup();
    capture.mockImplementation(async () => ({ status: 'refused', reason: 'no-audit' }));
    await runs.start(plan(pages(A, B)));
    // Half the timeout in front, a long while behind another tab, the other half in front.
    await run(TIMEOUT / 2);
    state.activeTabId = 1;
    await run(TIMEOUT * 2);
    expect(outcomes(runs.state())).toEqual(['running', 'pending']);
    state.activeTabId = 10;
    await run(TIMEOUT / 2 + RETRY * 3);
    expect(outcomes(runs.state())[0]).toBe('timed-out');
    // The next target gets its own time.
    expect(outcomes(runs.state())[1]).toBe('running');
    await run(TIMEOUT + RETRY * 3);
    expect(outcomes(runs.state())).toEqual(['timed-out', 'timed-out']);
    expect(runs.state().state).toBe('done');
  });

  test('capture-run-restores-previous-tab', async () => {
    const { runs, state, tabs, browser } = setup();
    await runs.start(plan(pages(A)));
    await run();
    expect(tabs.map((t) => t.id)).toEqual([1]);
    expect(state.activeTabId).toBe(1);
    expect(browser.activateTab).toHaveBeenLastCalledWith(1);
    // A remembered tab that closed meanwhile is not looked for.
    const other = setup();
    other.capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    await other.runs.start(plan(pages(A)));
    await run(RETRY);
    other.tabs.splice(0, 1);
    other.runs.cancel();
    await run(RETRY);
    expect(other.browser.activateTab).not.toHaveBeenCalled();
    expect(other.tabs).toEqual([]);
  });

  test('capture-run-keeps-the-users-tab', async () => {
    // The user went to another tab, then cancelled: that tab stays in front.
    const { runs, state, tabs, browser, capture } = setup();
    tabs.push({ id: 2, loading: false, documentSeq: 1, error: null, crashed: false, url: 'https://example.com/other', own: null });
    capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    await runs.start(plan(pages(A)));
    await run(RETRY);
    state.activeTabId = 2;
    runs.cancel();
    await run(RETRY);
    expect(runs.state().state).toBe('cancelled');
    expect(tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(state.activeTabId).toBe(2);
    expect(browser.activateTab).not.toHaveBeenCalled();
  });

  test('one-run-at-a-time', async () => {
    const { runs, capture, browser, state } = setup();
    capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    expect(await runs.start(plan([]))).toEqual({ status: 'refused', reason: 'no-targets' });
    await runs.start(plan(pages(A)));
    expect(runs.running()).toBe(PROJECT);
    expect(await runs.start(plan(pages(B), { projectId: ID }))).toEqual({ status: 'refused', reason: 'busy' });
    expect(browser.newTab).toHaveBeenCalledOnce();
    runs.cancel();
    await run(RETRY);
    expect(await runs.start(plan(pages(B)))).toMatchObject({ status: 'started' });
    runs.cancel();
    await run(RETRY);
    // No tab to be had: refused, and said in the state.
    state.tabLimit = true;
    expect(await runs.start(plan(pages(A)))).toEqual({ status: 'refused', reason: 'no-tab' });
    expect(runs.state().state).toBe('failed');
    expect(runs.running()).toBeNull();
    // The project is checked again as the run starts (and is busy meanwhile).
    let live: (value: boolean) => void = () => undefined;
    const other = setup({ isLive: () => new Promise<boolean>((resolve) => (live = resolve)) });
    const starting = other.runs.start(plan(pages(A)));
    expect(await other.runs.start(plan(pages(B)))).toEqual({ status: 'refused', reason: 'busy' });
    live(false);
    expect(await starting).toEqual({ status: 'refused', reason: 'not-found' });
    expect(other.browser.newTab).not.toHaveBeenCalled();
    expect(other.runs.running()).toBeNull();
    // A project that goes mid-run ends it.
    const gone = setup();
    gone.capture.mockResolvedValue({ status: 'refused', reason: 'no-project' });
    await gone.runs.start(plan(pages(A, B)));
    await run();
    expect(gone.runs.state().state).toBe('cancelled');
    expect(outcomes(gone.runs.state())).toEqual(['failed', 'cancelled']);
  });

  test('capture-run-caps-targets', async () => {
    const { runs } = setup();
    const many = Array.from({ length: PROJECT_RUN_LIMITS.maxRunTargets + 5 }, (_, i) => `https://example.com/${i}`);
    await runs.start(plan(pages(...many)));
    expect(runs.state()).toMatchObject({ total: PROJECT_RUN_LIMITS.maxRunTargets, omitted: 5 });
    expect(runs.state().targets).toHaveLength(PROJECT_RUN_LIMITS.maxRunTargets);
    runs.cancel();
    await run(RETRY);
  });

  // spec: specs/projects.feature.md — Run scope (`RUN_SCOPES`): `searches` visits only the saved searches.
  test('run-scope-searches-skips-pages', async () => {
    const desktop = { ...PARAMS, device: 'desktop' as const };
    const { runs, seen } = setup(readySerpFor([query(desktop)]));
    await runs.start(plan([...pages(A, B), query(desktop)], { scope: 'searches' }));
    // Only the search is planned: the pages are neither visited nor counted as omitted.
    expect(runs.state()).toMatchObject({ total: 1, omitted: 0 });
    expect(runs.state().targets.map((target) => target.kind)).toEqual(['query']);
    await run();
    expect(seen.map((s) => s.url)).toEqual([SEARCH]);
    expect(runs.state()).toMatchObject({ state: 'done' });
    expect(outcomes(runs.state())).toEqual(['captured']);
    // A project with pages only has nothing to visit in that scope.
    const none = setup();
    await expect(none.runs.start(plan(pages(A, B), { scope: 'searches' }))).resolves.toEqual({ status: 'refused', reason: 'no-targets' });
    expect(none.browser.newTab).not.toHaveBeenCalled();
    // `all` (and no scope) visits pages and searches, as before.
    const all = setup(readySerpFor([query(desktop)]));
    await all.runs.start(plan([...pages(A), query(desktop)], { scope: 'all' }));
    await run();
    expect(all.seen.map((s) => s.url)).toEqual([A, SEARCH]);
  });

  test('run-state-long-polls', async () => {
    const { runs } = setup();
    const first = runs.state();
    // Newer than asked: at once.
    await expect(runs.watch(first.version - 1)).resolves.toBe(first);
    // Not newer: the next change answers it.
    const waiting = runs.watch(first.version);
    await runs.start(plan(pages(A)));
    expect((await waiting).version).toBeGreaterThan(first.version);
    await run();
    // Nothing changes: the timeout answers with the current state.
    const idle = runs.state();
    const timed = runs.watch(idle.version);
    await vi.advanceTimersByTimeAsync(PROJECT_RUN_LIMITS.runStateWatchTimeoutMs);
    await expect(timed).resolves.toBe(idle);
    // One more than the cap answers the oldest early.
    const polls = Array.from({ length: PROJECT_RUN_LIMITS.maxPendingRunWatches + 1 }, () => runs.watch(idle.version));
    await expect(polls[0]).resolves.toBe(idle);
    await vi.advanceTimersByTimeAsync(PROJECT_RUN_LIMITS.runStateWatchTimeoutMs);
    await Promise.all(polls);
  });
});

// ---- Searches in a run (Phase 10 Task 8; plan Decision 10) ----------------------------------------

const DESKTOP: SearchParams = { ...PARAMS, device: 'desktop' };
/** Another search on the same engine: its result page is a result page, but not the target's. */
const BLACK: SearchParams = { ...DESKTOP, query: 'black tea', url: 'https://www.google.com/search?q=black+tea&gl=de&hl=de' };
const BLACK_SEARCH = 'https://www.google.com/search?q=black%20tea&hl=de&gl=de';
const SPACING = RANK_RUN_QUERY_SPACING_MS;
/** A Phase 6 page target on an engine's host, off its result paths. */
const MAPS = 'https://www.google.com/maps/place/x';

/** Records when each navigation happened (fake clock). */
function timedNavigations(fake: ReturnType<typeof setup>): [string, number][] {
  const at: [string, number][] = [];
  const original = fake.browser.navigate.getMockImplementation()!;
  fake.browser.navigate.mockImplementation((url: string) => {
    at.push([url, Date.now()]);
    return original(url);
  });
  return at;
}

describe('searches in a run', () => {
  // spec: specs/projects.feature.md — Searches in a run (Pacing); projects.spec.ts RANK_RUN_QUERY_SPACING_MS
  test('capture-run-spaces-search-targets', async () => {
    expect(PROJECT_RUN_LIMITS.querySpacingMs).toBe(SPACING);
    expect(SPACING).toBe(10_000);
    const targets = [query(DESKTOP), ...pages(A), query(BLACK, BLACK_SEARCH, 'black')];
    const fake = setup(readySerpFor(targets));
    const at = timedNavigations(fake);
    await fake.runs.start(plan(targets));
    await run(RETRY * 4);
    // The page after a search is not delayed; the next search waits.
    expect(at.map(([url]) => url)).toEqual([SEARCH, A]);
    expect(at[1]![1] - at[0]![1]).toBeLessThanOrEqual(RETRY * 2);
    // Between targets: the next search is not under way yet.
    expect(outcomes(fake.runs.state())).toEqual(['captured', 'captured', 'pending']);
    await run(SPACING);
    expect(at.map(([url]) => url)).toEqual([SEARCH, A, BLACK_SEARCH]);
    // From the first search's end (it landed and was captured one look after its navigation): at least the spacing.
    const gap = at[2]![1] - at[0]![1];
    expect(gap).toBeGreaterThanOrEqual(SPACING + RETRY);
    expect(gap).toBeLessThanOrEqual(SPACING + RETRY * 2);
    await run(RETRY * 4);
    expect(fake.runs.state()).toMatchObject({ state: 'done', blockedReason: null });
    expect(outcomes(fake.runs.state())).toEqual(['captured', 'captured', 'captured']);

    // The wait is not the next target's active time: a spacing longer than the timeout still captures it.
    const searches = [query(DESKTOP), query(BLACK, BLACK_SEARCH, 'black')];
    const long = setup({ ...readySerpFor(searches), limits: { querySpacingMs: TIMEOUT * 2 } });
    await long.runs.start(plan(searches));
    await run(TIMEOUT * 2 + RETRY * 6);
    expect(long.runs.state()).toMatchObject({ state: 'done' });
    expect(outcomes(long.runs.state())).toEqual(['captured', 'captured']);

    // Cancel during the wait ends the run at once: the next search is never loaded.
    const cancelled = setup(readySerpFor(searches));
    const navigated = timedNavigations(cancelled);
    await cancelled.runs.start(plan(searches));
    await run(RETRY * 4);
    expect(outcomes(cancelled.runs.state())).toEqual(['captured', 'pending']);
    expect(cancelled.runs.cancel()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled.runs.state()).toMatchObject({ state: 'cancelled' });
    expect(outcomes(cancelled.runs.state())).toEqual(['captured', 'cancelled']);
    expect(navigated.map(([url]) => url)).toEqual([SEARCH]);
    expect(cancelled.tabs.map((t) => t.id)).toEqual([1]);
    // A stop on quit during the wait does the same.
    const stopped = setup(readySerpFor(searches));
    await stopped.runs.start(plan(searches));
    await run(RETRY * 4);
    stopped.runs.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped.runs.state().state).toBe('cancelled');
    expect(stopped.browser.navigate.mock.calls).toEqual([[SEARCH]]);
  });

  // spec: specs/projects.feature.md — Searches in a run (Stop at the first challenge, checked before capture)
  test('capture-run-stops-at-a-challenge', async () => {
    type Case = {
      readonly name: string;
      readonly reason: RunBlockReason;
      readonly verdict?: SerpRunVerdict;
      readonly tabParams?: SearchParams | null;
      /** Where the navigation lands instead of the search URL. */
      readonly lands?: string;
      /** The page commits but never finishes loading. */
      readonly stuck?: boolean;
      readonly time: number;
      /** Blocked before Phase 3 is asked anything. */
      readonly noVerdict?: boolean;
    };
    const cases: Case[] = [
      { name: 'a consent page on another host', reason: 'not-a-result-page', lands: 'https://consent.google.com/ml?continue=https://www.google.com/search?q%3Dgreen%2Btea&gl=DE', time: RETRY * 4, noVerdict: true },
      { name: 'a /sorry/ path on the engine host', reason: 'not-a-result-page', lands: 'https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dgreen%2Btea&q=EgQ', time: RETRY * 4, noVerdict: true },
      { name: 'an unreadable verdict', reason: 'unreadable', verdict: 'unreadable', time: RETRY * 4 },
      { name: 'a not-serp verdict', reason: 'not-a-result-page', verdict: 'not-serp', time: RETRY * 4 },
      { name: 'a disabled verdict', reason: 'serp-off', verdict: 'disabled', time: RETRY * 4 },
      { name: 'a ready verdict for another search', reason: 'mismatch', verdict: 'ready', tabParams: BLACK, time: RETRY * 4 },
      { name: 'a page that stays pending', reason: 'no-reading', verdict: 'pending', time: SERP_SETTLE_WAIT_MS + RETRY * 4 },
      { name: 'a page that never finishes loading', reason: 'timed-out', verdict: 'ready', stuck: true, time: TIMEOUT + RETRY * 4, noVerdict: true },
    ];
    for (const c of cases) {
      const serpVerdictOf = vi.fn((_tabId: number, _pageUrl: string): SerpRunVerdict => c.verdict ?? 'ready');
      const fake = setup({ serpVerdictOf, searchParamsOf: () => (c.tabParams === undefined ? DESKTOP : c.tabParams) });
      if (c.lands !== undefined || c.stuck)
        fake.browser.navigate.mockImplementationOnce(() => {
          const tab = fake.tab(10)!;
          tab.url = c.lands ?? SEARCH;
          tab.documentSeq += 1;
          tab.loading = c.stuck === true;
          return true;
        });
      await fake.runs.start(plan([query(DESKTOP), ...pages(B)], { screenshot: true }));
      await run(c.time);
      const ended = fake.runs.state();
      expect(ended, c.name).toMatchObject({ state: 'blocked', blockedReason: c.reason });
      expect(outcomes(ended), c.name).toEqual(['blocked', 'cancelled']);
      // Nothing of that page is stored: no capture (so no version or reading) and no screenshot.
      expect(fake.capture, c.name).not.toHaveBeenCalled();
      expect(fake.screenshot, c.name).not.toHaveBeenCalled();
      // The run went no further, and its tab is gone.
      expect(fake.browser.navigate.mock.calls, c.name).toEqual([[SEARCH]]);
      expect(fake.tabs.map((t) => t.id), c.name).toEqual([1]);
      expect(fake.runs.running(), c.name).toBeNull();
      if (c.noVerdict) expect(serpVerdictOf, c.name).not.toHaveBeenCalled();
    }
    // Not before the settle wait: a pending page is still waited for just short of it.
    const waiting = setup({ serpVerdictOf: () => 'pending', searchParamsOf: () => DESKTOP });
    await waiting.runs.start(plan([query(DESKTOP)]));
    await run(SERP_SETTLE_WAIT_MS - RETRY * 2);
    expect(waiting.runs.state()).toMatchObject({ state: 'running', blockedReason: null });
    // A tab that moves away from its landed search page (a consent page by script) stops the run too.
    const moved = setup({ serpVerdictOf: () => 'pending', searchParamsOf: () => DESKTOP });
    await moved.runs.start(plan([query(DESKTOP), query(BLACK, BLACK_SEARCH, 'black')]));
    await run(RETRY * 2);
    moved.tab(10)!.url = 'https://consent.google.com/ml?continue=x';
    moved.tab(10)!.documentSeq += 1;
    await run(RETRY * 2);
    expect(moved.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'not-a-result-page' });
    expect(outcomes(moved.runs.state())).toEqual(['blocked', 'cancelled']);
    expect(moved.capture).not.toHaveBeenCalled();
  });

  // spec: specs/projects.feature.md — Searches in a run (3. captures only on `ready` whose search is the target's)
  test('capture-run-captures-only-on-ready', async () => {
    // The tab reads the same search (its own label): captured with the tab's own parameters.
    const tabOwn: SearchParams = { ...DESKTOP, engineLabel: 'Google (tab)' };
    const verdicts: SerpRunVerdict[] = ['pending', 'pending', 'ready'];
    const fake = setup({ serpVerdictOf: () => verdicts.shift() ?? 'ready', searchParamsOf: () => tabOwn });
    await fake.runs.start(plan([query(DESKTOP)], { screenshot: true }));
    await run(RETRY * 2);
    expect(fake.capture).not.toHaveBeenCalled();
    await run(RETRY * 4);
    expect(fake.capture).toHaveBeenCalledExactlyOnceWith(10, { projectId: PROJECT, source: 'project', searchParams: tabOwn, pageUrl: storedPageUrl(SEARCH) });
    expect(fake.screenshot).toHaveBeenCalledExactlyOnceWith(10, { kind: 'viewport', projectId: PROJECT, captureId: ID, searchParams: tabOwn });
    expect(fake.runs.state()).toMatchObject({ state: 'done', blockedReason: null });
    expect(outcomes(fake.runs.state())).toEqual(['captured']);
  });

  // spec: specs/projects.feature.md — Searches in a run (page targets keep Phase 6's behaviour)
  test('capture-run-page-targets-never-block', async () => {
    // A page that never settles times out, and the run goes on to the search; a page never asks for a verdict.
    const serpVerdictOf = vi.fn((_tabId: number, pageUrl: string): SerpRunVerdict => (pageUrl === A ? 'disabled' : 'ready'));
    const fake = setup({ serpVerdictOf, searchParamsOf: (_tabId, pageUrl) => (pageUrl === A ? null : DESKTOP) });
    fake.capture.mockImplementation(async (tabId, options) => (options.pageUrl === A ? { status: 'refused', reason: 'no-audit' } : CAPTURED));
    await fake.runs.start(plan([...pages(A), query(DESKTOP)]));
    await run(TIMEOUT + RETRY * 6);
    expect(fake.runs.state()).toMatchObject({ state: 'done', blockedReason: null });
    expect(outcomes(fake.runs.state())).toEqual(['timed-out', 'captured']);
    expect(serpVerdictOf.mock.calls.every(([, pageUrl]) => pageUrl !== A)).toBe(true);
    // A page target on a page SERP reading cannot read (or with reading off) is captured, with no parameters.
    const plain = setup({ serpVerdictOf: () => 'disabled' });
    await plain.runs.start(plan(pages(A, B)));
    await run();
    expect(outcomes(plain.runs.state())).toEqual(['captured', 'captured']);
    expect(plain.seen.map((s) => s.options.searchParams)).toEqual([null, null]);
    expect(plain.runs.state().state).toBe('done');
  });

  // spec: specs/projects.feature.md — Searches in a run (the next run starts as any run does)
  test('capture-run-after-blocked-starts-normally', async () => {
    let verdict: SerpRunVerdict = 'unreadable';
    const fake = setup({ serpVerdictOf: () => verdict, searchParamsOf: () => DESKTOP });
    await fake.runs.start(plan([query(DESKTOP)]));
    await run();
    expect(fake.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'unreadable' });
    verdict = 'ready';
    expect(await fake.runs.start(plan([query(DESKTOP), ...pages(A)]))).toEqual({ status: 'started', runId: ID });
    expect(fake.runs.state()).toMatchObject({ state: 'running', blockedReason: null, total: 2 });
    // Its search waits its spacing after the blocked one (it was sent), then goes as usual.
    expect(outcomes(fake.runs.state())).toEqual(['pending', 'pending']);
    await run(SPACING);
    expect(fake.runs.state()).toMatchObject({ state: 'done', blockedReason: null });
    expect(outcomes(fake.runs.state())).toEqual(['captured', 'captured']);
  });

  // spec: specs/projects.feature.md — Searches in a run (Pacing, Task 8 review ruling: a navigation the
  // browse guard refused was never sent and adds no wait)
  test('capture-run-no-wait-after-a-failed-load', async () => {
    const searches = [query(DESKTOP), query(BLACK, BLACK_SEARCH, 'black')];
    const fake = setup(readySerpFor(searches));
    const at = timedNavigations(fake);
    // The browse guard refuses the first navigation: nothing is sent.
    fake.browser.navigate.mockImplementationOnce((url: string) => {
      at.push([url, Date.now()]);
      return false;
    });
    await fake.runs.start(plan(searches));
    await run(RETRY * 6);
    // That target fails; the second goes at once and is captured.
    expect(at.map(([url]) => url)).toEqual([SEARCH, BLACK_SEARCH]);
    expect(at[1]![1] - at[0]![1]).toBeLessThan(SPACING);
    expect(outcomes(fake.runs.state())).toEqual(['failed', 'captured']);
    expect(fake.runs.state()).toMatchObject({ state: 'done', blockedReason: null });
  });

  // spec: specs/projects.feature.md — Searches in a run (Task 8 review ruling: a search whose load fails stops the run)
  test('capture-run-stops-after-a-failed-search-load', async () => {
    for (const how of ['offline', 'crash'] as const) {
      const searches = [query(DESKTOP), query(BLACK, BLACK_SEARCH, 'black'), ...pages(A)];
      const fake = setup(readySerpFor(searches));
      fake.browser.navigate.mockImplementationOnce((url: string) => {
        const tab = fake.tab(10)!;
        if (how === 'offline') tab.error = { code: -101, description: 'ERR_CONNECTION_RESET', url };
        else tab.crashed = true;
        return true;
      });
      await fake.runs.start(plan(searches, { screenshot: true }));
      await run(RETRY * 6);
      expect(fake.runs.state(), how).toMatchObject({ state: 'blocked', blockedReason: 'load-failed' });
      expect(outcomes(fake.runs.state()), how).toEqual(['blocked', 'cancelled', 'cancelled']);
      // The next target is never navigated; nothing is captured.
      expect(fake.browser.navigate.mock.calls, how).toEqual([[SEARCH]]);
      expect(fake.capture, how).not.toHaveBeenCalled();
      expect(fake.screenshot, how).not.toHaveBeenCalled();
    }
    // A page target's failed load still only fails it, and the run goes on.
    const page = setup();
    page.state.fail = true;
    await page.runs.start(plan(pages(A, B)));
    await run(RETRY * 6);
    expect(page.runs.state()).toMatchObject({ state: 'done', blockedReason: null });
    expect(outcomes(page.runs.state())).toEqual(['failed', 'failed']);
  });

  // spec: specs/projects.feature.md — Searches in a run (Task 8 review ruling: a page target that is a result page is a search target)
  test('capture-run-result-page-target-is-gated', async () => {
    // A page target whose URL is Google's result page: gated as a search, with its own parameters as the target's.
    const own = runSearchOf({ kind: 'page', url: SEARCH, searchParams: null });
    expect(own).toMatchObject({ engine: 'google', query: 'green tea', gl: 'de', hl: 'de' });
    expect(runSearchOf({ kind: 'page', url: A, searchParams: null })).toBeNull();
    expect(runSearchOf({ kind: 'query', url: SEARCH, searchParams: DESKTOP })).toBe(DESKTOP);
    // Unreadable: the run stops there, nothing captured, the next target never visited.
    const challenge = setup({ serpVerdictOf: () => 'unreadable', searchParamsOf: () => DESKTOP });
    await challenge.runs.start(plan([...pages(SEARCH), ...pages(A)]));
    await run();
    expect(challenge.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'unreadable' });
    expect(challenge.capture).not.toHaveBeenCalled();
    expect(challenge.browser.navigate.mock.calls).toEqual([[SEARCH]]);
    // A ready reading of another search: mismatch against the page's own parameters.
    const other = setup({ serpVerdictOf: () => 'ready', searchParamsOf: () => BLACK });
    await other.runs.start(plan(pages(SEARCH)));
    await run();
    expect(other.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'mismatch' });
    expect(other.capture).not.toHaveBeenCalled();
    // A ready reading of its own search is captured with the tab's parameters; the next search is spaced after it.
    const ok = setup({ serpVerdictOf: () => 'ready', searchParamsOf: (_tabId, pageUrl) => (pageUrl === storedPageUrl(SEARCH) ? DESKTOP : BLACK) });
    const at = timedNavigations(ok);
    await ok.runs.start(plan([...pages(SEARCH), query(BLACK, BLACK_SEARCH, 'black')]));
    await run(RETRY * 4);
    expect(ok.seen.map((seen) => seen.options.searchParams)).toEqual([DESKTOP]);
    expect(at.map(([url]) => url)).toEqual([SEARCH]);
    await run(SPACING + RETRY * 4);
    expect(at.map(([url]) => url)).toEqual([SEARCH, BLACK_SEARCH]);
    expect(at[1]![1] - at[0]![1]).toBeGreaterThanOrEqual(SPACING);
    expect(ok.runs.state()).toMatchObject({ state: 'done' });
  });

  // spec: specs/projects.feature.md — Searches in a run (Task 8 review ruling: the landed document only, never re-checked)
  test('capture-run-blocks-a-reload-after-the-check', async () => {
    // The page reloads (same URL, a new document) while the check reads the tab's parameters.
    const fake = setup({
      serpVerdictOf: () => 'ready',
      searchParamsOf: () => {
        fake.tab(10)!.documentSeq += 1;
        return DESKTOP;
      },
    });
    await fake.runs.start(plan([query(DESKTOP), ...pages(A)], { screenshot: true }));
    await run();
    expect(fake.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'not-a-result-page' });
    expect(outcomes(fake.runs.state())).toEqual(['blocked', 'cancelled']);
    expect(fake.capture).not.toHaveBeenCalled();
    expect(fake.screenshot).not.toHaveBeenCalled();
    // A reload while the reading is pending, then ready: still stopped, not checked again.
    let verdict: SerpRunVerdict = 'pending';
    const late = setup({ serpVerdictOf: () => verdict, searchParamsOf: () => DESKTOP });
    await late.runs.start(plan([query(DESKTOP)]));
    await run(RETRY * 2);
    late.tab(10)!.documentSeq += 1;
    verdict = 'ready';
    await run(RETRY * 2);
    expect(late.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'not-a-result-page' });
    expect(late.capture).not.toHaveBeenCalled();
    // A reload after the capture, before its screenshot: the capture of the checked page stays, without a screenshot, and the run stops.
    const shot = setup(readySerpFor([query(DESKTOP)]));
    shot.capture.mockImplementationOnce(async () => {
      shot.tab(10)!.documentSeq += 1;
      return CAPTURED;
    });
    await shot.runs.start(plan([query(DESKTOP), ...pages(A)], { screenshot: true }));
    await run();
    expect(shot.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'not-a-result-page' });
    expect(shot.runs.state().targets.map((t) => [t.outcome, t.screenshot])).toEqual([
      ['captured', 'failed'],
      ['cancelled', null],
    ]);
    expect(shot.screenshot).not.toHaveBeenCalled();
  });

  // spec: specs/projects.feature.md — Searches in a run (Task 8 review ruling: spacing holds across runs)
  test('capture-run-spacing-holds-across-runs', async () => {
    const searches = [query(DESKTOP), query(BLACK, BLACK_SEARCH, 'black')];
    const fake = setup(readySerpFor(searches));
    const at = timedNavigations(fake);
    // Cancel during the wait, then Check rankings at once: the next search still waits its spacing.
    await fake.runs.start(plan(searches));
    await run(RETRY * 4);
    fake.runs.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(await fake.runs.start(plan(searches.slice(1), { scope: 'searches' }))).toMatchObject({ status: 'started' });
    await run(RETRY * 4);
    expect(at.map(([url]) => url)).toEqual([SEARCH]);
    await run(SPACING);
    expect(at.map(([url]) => url)).toEqual([SEARCH, BLACK_SEARCH]);
    expect(at[1]![1] - at[0]![1]).toBeGreaterThanOrEqual(SPACING);
    await run(RETRY * 4);
    expect(fake.runs.state().state).toBe('done');
    // A rerun right after a blocked run waits too (the blocked search was sent).
    fake.capture.mockClear();
    const blocked = setup({ serpVerdictOf: () => 'unreadable', searchParamsOf: () => DESKTOP });
    const sent = timedNavigations(blocked);
    await blocked.runs.start(plan([query(DESKTOP)]));
    await run(RETRY * 4);
    expect(blocked.runs.state().state).toBe('blocked');
    await blocked.runs.start(plan([query(DESKTOP)]));
    await run(RETRY * 4);
    expect(sent).toHaveLength(1);
    await run(SPACING);
    expect(sent).toHaveLength(2);
    expect(sent[1]![1] - sent[0]![1]).toBeGreaterThanOrEqual(SPACING);
  });

  // spec: specs/projects.feature.md — Searches in a run (whole-branch review ruling: a page on an engine's host is a search)
  test('capture-run-engine-host-page-is-gated', async () => {
    // Pages on an engine's host that the pack refuses (another vertical): no search parameters, but they query an engine.
    const UDM = 'https://www.google.com/search?q=green+tea&udm=50';
    const page = (url: string) => ({ kind: 'page' as const, url, searchParams: null });
    for (const url of [UDM, 'https://www.google.com/search?q=green+tea&tbm=isch', 'https://duckduckgo.com/?q=green+tea&ia=images', 'https://WWW.GOOGLE.COM./search', 'https://html.duckduckgo.com/html/']) {
      expect(runSearchOf(page(url)), url).toBeNull();
      expect(queriesAnEngine(page(url)), url).toBe(true);
    }
    expect(queriesAnEngine(page(SEARCH))).toBe(true);
    expect(queriesAnEngine({ kind: 'query', url: SEARCH, searchParams: DESKTOP })).toBe(true);
    // Off the engine's result paths (the pack's `paths`), a page on its host sends no search: a page target.
    for (const url of [A, MAPS, 'https://duckduckgo.com/about', 'https://www.bing.com/images/search?q=tea', 'https://WWW.GOOGLE.COM./maps', 'https://google.com.example.net/search?q=x', 'ftp://www.google.com/search?q=x', 'not a url']) expect(queriesAnEngine(page(url)), url).toBe(false);

    // In a run: spaced after the search before it, then blocked at once (no result page), nothing of it captured.
    const targets = [query(DESKTOP), ...pages(UDM), ...pages(A)];
    const fake = setup(readySerpFor(targets));
    const at = timedNavigations(fake);
    await fake.runs.start(plan(targets));
    await run(RETRY * 4);
    expect(at.map(([url]) => url)).toEqual([SEARCH]);
    await run(SPACING + RETRY * 4);
    expect(at.map(([url]) => url)).toEqual([SEARCH, UDM]);
    expect(at[1]![1] - at[0]![1]).toBeGreaterThanOrEqual(SPACING);
    expect(fake.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'not-a-result-page' });
    expect(outcomes(fake.runs.state())).toEqual(['captured', 'blocked', 'cancelled']);
    expect(fake.seen.map((seen) => seen.url)).toEqual([SEARCH]);
    // Its navigation was sent: the next search, in the next run, waits its spacing after it.
    await fake.runs.start(plan([query(BLACK, BLACK_SEARCH, 'black')]));
    await run(RETRY * 4);
    expect(at).toHaveLength(2);
    await run(SPACING);
    expect(at.map(([url]) => url)).toEqual([SEARCH, UDM, BLACK_SEARCH]);
    expect(at[2]![1] - at[1]![1]).toBeGreaterThanOrEqual(SPACING);
  });

  // spec: specs/projects.feature.md — Searches in a run (whole-branch review ruling: a same-document URL change)
  test('capture-run-same-document-url-change', async () => {
    /** The run's tab changes its URL by `pushState` (the same document) while the reading is pending. */
    const pushed = async (url: string) => {
      let verdict: SerpRunVerdict = 'pending';
      const searchParamsOf = vi.fn((_tabId: number, _pageUrl: string): SearchParams | null => DESKTOP);
      const fake = setup({ serpVerdictOf: () => verdict, searchParamsOf });
      await fake.runs.start(plan([query(DESKTOP), ...pages(A)]));
      await run(RETRY * 2);
      expect(fake.capture).not.toHaveBeenCalled();
      // Only the URL changes: no new document (`documentSeq` as it was).
      fake.tab(10)!.url = url;
      verdict = 'ready';
      await run(RETRY * 4);
      return { ...fake, searchParamsOf };
    };
    // The same search (an engine's own parameter added): it goes on, captured at the new URL, read again for it.
    const SAME = 'https://www.google.com/search?q=green+tea&gl=de&hl=de&ei=abc';
    const same = await pushed(SAME);
    expect(same.runs.state()).toMatchObject({ state: 'done', blockedReason: null });
    expect(outcomes(same.runs.state())).toEqual(['captured', 'captured']);
    expect(same.capture.mock.calls[0]![1]).toMatchObject({ pageUrl: storedPageUrl(SAME), searchParams: DESKTOP });
    expect(same.searchParamsOf).toHaveBeenCalledWith(10, storedPageUrl(SAME));
    // Another query, or no result page at all: the run stops there, nothing captured.
    for (const url of [BLACK_SEARCH, 'https://www.google.com/search?q=green+tea&gl=fr&hl=de', 'https://www.google.com/sorry/index?continue=x', 'https://consent.google.com/ml?continue=x']) {
      const other = await pushed(url);
      expect(other.runs.state(), url).toMatchObject({ state: 'blocked', blockedReason: 'not-a-result-page' });
      expect(outcomes(other.runs.state()), url).toEqual(['blocked', 'cancelled']);
      expect(other.capture, url).not.toHaveBeenCalled();
    }
    // After the capture, before its screenshot: the same search keeps its screenshot.
    const shot = setup(readySerpFor([query(DESKTOP)]));
    shot.capture.mockImplementationOnce(async () => {
      shot.tab(10)!.url = SAME;
      return CAPTURED;
    });
    await shot.runs.start(plan([query(DESKTOP)], { screenshot: true }));
    await run();
    expect(shot.runs.state()).toMatchObject({ state: 'done' });
    expect(shot.runs.state().targets.map((t) => [t.outcome, t.screenshot])).toEqual([['captured', 'saved']]);
    expect(shot.screenshot).toHaveBeenCalledOnce();
  });

  // spec: specs/projects.feature.md — Searches in a run (`ready` with no tab parameters is `no-reading`)
  test('capture-run-ready-needs-tab-params', async () => {
    const searchParamsOf = vi.fn((_tabId: number, _pageUrl: string): SearchParams | null => null);
    const fake = setup({ serpVerdictOf: () => 'ready', searchParamsOf });
    await fake.runs.start(plan([query(DESKTOP), ...pages(A)], { screenshot: true }));
    await run();
    expect(fake.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'no-reading' });
    expect(outcomes(fake.runs.state())).toEqual(['blocked', 'cancelled']);
    expect(searchParamsOf).toHaveBeenCalledWith(10, storedPageUrl(SEARCH));
    expect(fake.capture).not.toHaveBeenCalled();
    expect(fake.screenshot).not.toHaveBeenCalled();
    // No `searchParamsOf` at all reads the same.
    const none = setup({ serpVerdictOf: () => 'ready' });
    await none.runs.start(plan([query(DESKTOP)]));
    await run();
    expect(none.runs.state()).toMatchObject({ state: 'blocked', blockedReason: 'no-reading' });
    expect(none.capture).not.toHaveBeenCalled();
  });
  /**
   * A setup whose SERP service reads the landed page as Phase 3 does: by the bundled pack, on the device
   * of the profile in effect in the run tab (its own, else its site's pin, else the default).
   */
  const deviceAware = (deps: Partial<CaptureRunDeps> = {}) => {
    const fake: ReturnType<typeof setup> = setup({
      searchParamsOf: (tabId, pageUrl) => searchParamsForUrl(pageUrl, SERP_DEVICE_OF_PRESET[fake.effective(fake.tab(tabId)!).device]),
      ...deps,
    });
    return fake;
  };
  /** The search key the capture's reading is stored under (`service.ts`: the capture's parameters and the landed page's filters). */
  const storedKeyOf = (options: Parameters<CaptureRunDeps['capture']>[1]): string | null =>
    options.searchParams === null || options.pageUrl === undefined ? null : searchKeyOf(options.searchParams, serpFiltersOf(options.pageUrl, options.searchParams.engine) ?? {});

  // spec: specs/projects.feature.md — Searches in a run (3. the device counts); specs/projects.spec.ts QUERY_DEVICE_PROFILES
  // (a `desktop` query is visited with the default profile, never the project's); rankings.feature.md (the saved row's key)
  test('capture-run-files-a-search-under-its-saved-key', async () => {
    const saved = searchParamsForUrl(SEARCH, 'desktop')!;
    expect(saved.device).toBe('desktop');
    // The project renders as a phone; its desktop saved search is still read on the desktop.
    const fake = deviceAware();
    await fake.runs.start(plan([...pages(A), query(saved)], { profile: PHONE }));
    await run(RETRY * 12);
    expect(fake.runs.state()).toMatchObject({ state: 'done', blockedReason: null });
    const search = fake.seen.find((seen) => seen.options.searchParams !== null)!;
    expect(search.options.searchParams?.device).toBe('desktop');
    // The reading's key is the one the Rankings table looks the saved row up by (`searchKeyOf(saved, {})`).
    expect(storedKeyOf(search.options)).toBe(searchKeyOf(saved, {}));
    // The page target still renders with the project's profile.
    expect(fake.seen.find((seen) => seen.url === A)!.profile).toEqual(PHONE);
  });

  // spec: specs/projects.feature.md — Searches in a run (3. another device or other filters is `mismatch`)
  test('capture-run-blocks-another-device-or-filters', async () => {
    const saved = searchParamsForUrl(SEARCH, 'desktop')!;
    const mobile = searchParamsForUrl(SEARCH, 'mobile')!;
    const cases: { name: string; target: SearchParams; arrange: (fake: ReturnType<typeof setup>) => void }[] = [
      // The user pinned a phone profile to the engine: the run tab reads the search as mobile.
      { name: 'a site pin forcing mobile', target: saved, arrange: (fake) => fake.pins.set('https://www.google.com', PHONE) },
      // A mobile query whose tab profile could not be set reads as desktop.
      { name: 'a profile that could not be set', target: mobile, arrange: (fake) => fake.browser.setRenderProfile.mockReturnValue(false) },
      // The engine adds a filter as it lands (past week): another series than the saved search's.
      {
        name: 'a filter on the landed URL',
        target: saved,
        arrange: (fake) => {
          const original = fake.browser.navigate.getMockImplementation()!;
          fake.browser.navigate.mockImplementationOnce((url: string) => original(`${url}&tbs=qdr:w`));
        },
      },
    ];
    for (const c of cases) {
      const fake = deviceAware();
      c.arrange(fake);
      await fake.runs.start(plan([query(c.target), ...pages(A)], { screenshot: true }));
      await run(RETRY * 8);
      expect(fake.runs.state(), c.name).toMatchObject({ state: 'blocked', blockedReason: 'mismatch' });
      expect(outcomes(fake.runs.state()), c.name).toEqual(['blocked', 'cancelled']);
      expect(fake.capture, c.name).not.toHaveBeenCalled();
      expect(fake.screenshot, c.name).not.toHaveBeenCalled();
    }
  });
  // spec: specs/projects.feature.md — Searches in a run (council review: a page off an engine's result paths is a page target)
  test('capture-run-engine-page-off-result-paths-is-a-page', async () => {
    const targets = [...pages(MAPS), ...pages('https://duckduckgo.com/about'), ...pages(A)];
    const fake = setup({ serpVerdictOf: () => 'not-serp' });
    const at = timedNavigations(fake);
    await fake.runs.start(plan(targets));
    await run(RETRY * 8);
    // Captured as pages (no verdict asked, no spacing), and the run goes on to the end.
    expect(fake.runs.state()).toMatchObject({ state: 'done', blockedReason: null });
    expect(outcomes(fake.runs.state())).toEqual(['captured', 'captured', 'captured']);
    expect(fake.seen.map((seen) => seen.url)).toEqual([MAPS, 'https://duckduckgo.com/about', A]);
    expect(at[2]![1] - at[0]![1]).toBeLessThan(SPACING);
  });
});
