// Spec: specs/projects.spec.ts (PROJECT_RUN_LIMITS, RUN_STATES, RUN_TARGET_OUTCOMES, RUN_RETRY_REFUSALS,
// MOBILE_QUERY_PROFILE, RUN_SCREENSHOT_KIND)
// Acceptance: specs/projects.feature.md (Capture now; Scenarios: capture run)
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import type { CaptureAnswer } from '@app/specs/changes.spec';
import { MOBILE_QUERY_PROFILE, PROJECT_RUN_LIMITS, type RunState } from '@app/specs/projects.spec';
import { DEFAULT_RENDER_PROFILE, isDefaultRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import type { TakeScreenshotAnswer } from '@app/specs/screenshot.spec';
import { createCaptureRuns, stopRunOnQuit, type CaptureRunDeps, type RunPlan, type RunTab } from '../capture-run';

const PROJECT = '01920000-0000-7000-8000-0000000000aa';
const ID = '01920000-0000-7000-8000-000000000001';
const A = 'https://example.com/a';
const B = 'https://example.com/b';
const PHONE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
const NO_JS: RenderProfile = { ...DEFAULT_RENDER_PROFILE, javascriptDisabled: true };
const PARAMS: SearchParams = { engine: 'google', query: 'green tea', country: 'de', language: 'de', location: 'Berlin', device: 'mobile' };
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
  const seen: { tabId: number; url: string; profile: RenderProfile; options: unknown }[] = [];
  const capture = vi.fn(async (tabId: number, options: Parameters<CaptureRunDeps['capture']>[1]): Promise<CaptureAnswer> => {
    const tab = fake.tab(tabId)!;
    seen.push({ tabId, url: tab.url, profile: fake.effective(tab), options });
    return CAPTURED;
  });
  const screenshot = vi.fn(async (_tabId: number, _options: Parameters<CaptureRunDeps['screenshot']>[1]): Promise<TakeScreenshotAnswer> => ({ status: 'saved', id: ID, kind: 'viewport', width: 800, height: 600, bytes: 10, truncated: false }));
  const runs = createCaptureRuns({ browser: fake.browser, capture, screenshot, uuidv7: () => ID, ...deps });
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
    const { runs, seen, screenshot } = setup();
    const desktop = { ...PARAMS, device: 'desktop' as const };
    await runs.start(plan([...pages(A), query(desktop)], { screenshot: true }));
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
    // A refused screenshot is said, and the capture still counts.
    const other = setup();
    other.screenshot.mockResolvedValue({ status: 'refused', reason: 'capture-failed' });
    await other.runs.start(plan(pages(A), { screenshot: true }));
    await run();
    expect(other.runs.state().targets[0]).toMatchObject({ outcome: 'captured', screenshot: 'failed' });
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
    const { runs, seen, browser, pins } = setup();
    const desktop = { ...PARAMS, device: 'desktop' as const };
    await runs.start(plan([...pages(A), query(PARAMS, SEARCH, 'mobile'), query(desktop, `${SEARCH}&x`, 'desktop'), ...pages(B)], { profile: PHONE }));
    await run(RETRY * 12);
    // Grouped by profile: the project's group in one tab, the mobile query in a fresh one, each set before its first navigation.
    expect(runs.state().targets.map((t) => t.label)).toEqual([A, 'desktop', B, 'mobile']);
    expect(seen.map((s) => [s.tabId, s.profile])).toEqual([
      [10, PHONE],
      [10, PHONE],
      [10, PHONE],
      [11, MOBILE_QUERY_PROFILE],
    ]);
    expect(browser.setRenderProfile.mock.calls).toEqual([
      [10, PHONE],
      [11, MOBILE_QUERY_PROFILE],
    ]);
    expect(runs.state().state).toBe('done');
    expect(pins.size).toBe(0);
  });

  test('capture-run-never-removes-a-pin', async () => {
    // The user pinned profiles to the search engine and to a page's site.
    const { runs, seen, browser, pins } = setup();
    pins.set('https://www.google.com', NO_JS);
    pins.set('https://example.com', PHONE);
    const desktop = { ...PARAMS, device: 'desktop' as const };
    await runs.start(plan([query(PARAMS, SEARCH, 'mobile'), query(desktop, `${SEARCH}&x`, 'desktop'), ...pages(A)]));
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
