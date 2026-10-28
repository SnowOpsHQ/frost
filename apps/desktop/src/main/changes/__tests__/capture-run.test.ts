// Spec: specs/projects.spec.ts (PROJECT_RUN_LIMITS, RUN_STATES, RUN_TARGET_OUTCOMES, RUN_RETRY_REFUSALS,
// MOBILE_QUERY_PROFILE, RUN_SCREENSHOT_KIND)
// Acceptance: specs/projects.feature.md (Capture now; Scenarios: capture run)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import type { CaptureAnswer } from '@app/specs/changes.spec';
import { MOBILE_QUERY_PROFILE, PROJECT_RUN_LIMITS, type RunState } from '@app/specs/projects.spec';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from '@app/specs/render-profile.spec';
import type { TakeScreenshotAnswer } from '@app/specs/screenshot.spec';
import { createCaptureRuns, type CaptureRunDeps, type RunPlan, type RunTab } from '../capture-run';

const PROJECT = '01920000-0000-7000-8000-0000000000aa';
const ID = '01920000-0000-7000-8000-000000000001';
const A = 'https://example.com/a';
const B = 'https://example.com/b';
const PHONE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
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

/** A browser with tab 1 open and active; a navigation commits at once (a new document, not loading). */
function fakeBrowser() {
  const tabs: ({ -readonly [K in keyof RunTab]: RunTab[K] } & { url: string; profile: RenderProfile })[] = [{ id: 1, loading: false, documentSeq: 3, error: null, crashed: false, url: 'https://example.com/start', profile: DEFAULT_RENDER_PROFILE }];
  const state = { activeTabId: 1 as number | null, nextId: 10, commit: true, tabLimit: false };
  const active = () => tabs.find((tab) => tab.id === state.activeTabId);
  const browser = {
    getState: vi.fn(() => ({ activeTabId: state.activeTabId, tabs: tabs.map((tab) => ({ ...tab })) })),
    newTab: vi.fn(() => {
      if (state.tabLimit) return null;
      const id = state.nextId++;
      tabs.push({ id, loading: false, documentSeq: 0, error: null, crashed: false, url: '', profile: DEFAULT_RENDER_PROFILE });
      state.activeTabId = id;
      return id;
    }),
    navigate: vi.fn((url: string) => {
      const tab = active();
      if (!tab) return false;
      tab.url = url;
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
      tab.profile = profile;
      return true;
    }),
  };
  return { browser, tabs, state, tab: (id: number) => tabs.find((t) => t.id === id) };
}

function setup(deps: Partial<CaptureRunDeps> = {}) {
  const fake = fakeBrowser();
  /** The URL and profile each capture saw. */
  const seen: { url: string; profile: RenderProfile; options: unknown }[] = [];
  const capture = vi.fn(async (tabId: number, options: Parameters<CaptureRunDeps['capture']>[1]): Promise<CaptureAnswer> => {
    const tab = fake.tab(tabId)!;
    seen.push({ url: tab.url, profile: tab.profile, options });
    return CAPTURED;
  });
  const screenshot = vi.fn(async (_tabId: number, _options: Parameters<CaptureRunDeps['screenshot']>[1]): Promise<TakeScreenshotAnswer> => ({ status: 'saved', id: ID, kind: 'viewport', width: 800, height: 600, bytes: 10, truncated: false }));
  const runs = createCaptureRuns({ browser: fake.browser, capture, screenshot, uuidv7: () => ID, ...deps });
  return { ...fake, runs, capture, screenshot, seen };
}

const pages = (...urls: string[]): RunPlan['targets'] => urls.map((url) => ({ kind: 'page', label: url, url, searchParams: null }));
const plan = (targets: RunPlan['targets'], changes: Partial<RunPlan> = {}): RunPlan => ({ projectId: PROJECT, profile: null, screenshot: false, targets, ...changes });
/** Lets the run go on for `ms` of (fake) time. */
const run = (ms = RETRY * 4) => vi.advanceTimersByTimeAsync(ms);
const outcomes = (state: RunState) => state.targets.map((target) => target.outcome);

describe('capture run', () => {
  test('capture-run-visits-each-target-in-its-own-tab', async () => {
    const { runs, browser, state, seen, tabs } = setup();
    expect(runs.state()).toMatchObject({ state: 'idle', runId: null, targets: [] });
    expect(runs.start(plan(pages(A, B)))).toEqual({ status: 'started', runId: ID });
    // A new tab, made active; the previous one remembered.
    expect(browser.newTab).toHaveBeenCalledOnce();
    expect(state.activeTabId).toBe(10);
    expect(runs.state()).toMatchObject({ state: 'running', projectId: PROJECT, total: 2, omitted: 0, current: 1 });
    await run();
    expect(seen.map((s) => s.url)).toEqual([A, B]);
    expect(seen[0]!.options).toEqual({ projectId: PROJECT, source: 'project', searchParams: null });
    const done = runs.state();
    expect(done.state).toBe('done');
    expect(done.targets).toEqual([
      { kind: 'page', label: A, outcome: 'captured', changeCount: 2, screenshot: null },
      { kind: 'page', label: B, outcome: 'captured', changeCount: 2, screenshot: null },
    ]);
    expect(tabs.map((t) => t.id)).toEqual([1]);
    expect(runs.running()).toBeNull();
  });

  test('capture-run-waits-for-active-tab', async () => {
    const { runs, browser, state, capture } = setup();
    capture.mockResolvedValueOnce({ status: 'refused', reason: 'no-audit' });
    runs.start(plan(pages(A, B)));
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
    runs.start(plan(pages(A)));
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
    other.runs.start(plan(pages(A, B)));
    await run();
    expect(other.capture).toHaveBeenCalledTimes(2);
    expect(outcomes(other.runs.state())).toEqual(['failed', 'failed']);
    expect(other.runs.state().state).toBe('done');
  });

  test('capture-run-waits-for-its-navigation', async () => {
    const { runs, state, tab, capture } = setup();
    state.commit = false;
    runs.start(plan(pages(A)));
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

  test('capture-run-records-query-params', async () => {
    const { runs, seen, screenshot } = setup();
    runs.start(plan([...pages(A), { kind: 'query', label: '“green tea” on Google', url: SEARCH, searchParams: PARAMS }], { screenshot: true }));
    await run();
    expect(seen.map((s) => s.url)).toEqual([A, SEARCH]);
    expect(seen[1]!.options).toEqual({ projectId: PROJECT, source: 'project', searchParams: PARAMS });
    // Each captured target's viewport screenshot is linked to its capture, with the same parameters.
    expect(screenshot).toHaveBeenNthCalledWith(1, 10, { kind: 'viewport', projectId: PROJECT, captureId: ID, searchParams: null });
    expect(screenshot).toHaveBeenNthCalledWith(2, 10, { kind: 'viewport', projectId: PROJECT, captureId: ID, searchParams: PARAMS });
    expect(runs.state().targets.map((t) => [t.kind, t.screenshot])).toEqual([
      ['page', 'saved'],
      ['query', 'saved'],
    ]);
    // A refused screenshot is said, and the capture still counts.
    const other = setup();
    other.screenshot.mockResolvedValue({ status: 'refused', reason: 'capture-failed' });
    other.runs.start(plan(pages(A), { screenshot: true }));
    await run();
    expect(other.runs.state().targets[0]).toMatchObject({ outcome: 'captured', screenshot: 'failed' });
  });

  test('capture-run-applies-profiles', async () => {
    const { runs, seen, browser } = setup();
    const desktopQuery = { ...PARAMS, device: 'desktop' as const };
    runs.start(
      plan(
        [...pages(A), { kind: 'query', label: 'q1', url: SEARCH, searchParams: PARAMS }, { kind: 'query', label: 'q2', url: `${SEARCH}&x`, searchParams: desktopQuery }, ...pages(B)],
        { profile: PHONE },
      ),
    );
    await run(RETRY * 10);
    // The project's profile on its own tab (never a pin); a mobile query as a phone with a mobile user agent, for that target only.
    expect(seen.map((s) => s.profile)).toEqual([PHONE, MOBILE_QUERY_PROFILE, PHONE, PHONE]);
    for (const call of browser.setRenderProfile.mock.calls) expect(call).toHaveLength(2);
    expect(browser.setRenderProfile.mock.calls.map(([id]) => id)).toEqual([10, 10, 10]);
    // Without a project profile: frost's default (setting it clears the tab's), and only when it changes.
    const other = setup();
    other.runs.start(plan([...pages(A), { kind: 'query', label: 'q', url: SEARCH, searchParams: PARAMS }, ...pages(B)]));
    await run(RETRY * 10);
    expect(other.seen.map((s) => s.profile)).toEqual([DEFAULT_RENDER_PROFILE, MOBILE_QUERY_PROFILE, DEFAULT_RENDER_PROFILE]);
    expect(other.browser.setRenderProfile.mock.calls).toEqual([
      [10, MOBILE_QUERY_PROFILE],
      [10, DEFAULT_RENDER_PROFILE],
    ]);
  });

  test('capture-run-cancels-on-tab-close', async () => {
    const { runs, state, browser, capture } = setup();
    capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    runs.start(plan(pages(A, B)));
    await run(RETRY * 2);
    browser.closeTab(10);
    await run(RETRY * 2);
    const ended = runs.state();
    expect(ended.state).toBe('tab-closed');
    expect(outcomes(ended)).toEqual(['cancelled', 'cancelled']);
    expect(runs.running()).toBeNull();
    // The remembered tab is in front again; the run closed nothing else.
    expect(state.activeTabId).toBe(1);
    expect(browser.closeTab).toHaveBeenCalledTimes(1);
  });

  test('capture-run-cancels', async () => {
    const { runs, capture, tabs, state } = setup();
    capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    expect(runs.cancel()).toBe(false);
    runs.start(plan(pages(A, B)));
    await run(RETRY * 2);
    expect(runs.cancel()).toBe(true);
    // At once: the wait is woken, not left to run out.
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.state().state).toBe('cancelled');
    expect(outcomes(runs.state())).toEqual(['cancelled', 'cancelled']);
    expect(tabs.map((t) => t.id)).toEqual([1]);
    expect(state.activeTabId).toBe(1);
  });

  test('capture-run-times-out-per-target', async () => {
    const { runs, capture, state } = setup();
    capture.mockImplementation(async (_tabId, _options) => ({ status: 'refused', reason: 'no-audit' }));
    runs.start(plan(pages(A, B)));
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
    runs.start(plan(pages(A)));
    await run();
    expect(tabs.map((t) => t.id)).toEqual([1]);
    expect(state.activeTabId).toBe(1);
    expect(browser.activateTab).toHaveBeenLastCalledWith(1);
    // A remembered tab that closed meanwhile is not looked for.
    const other = setup();
    other.capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    other.runs.start(plan(pages(A)));
    await run(RETRY);
    other.tabs.splice(0, 1);
    other.runs.cancel();
    await run(RETRY);
    expect(other.browser.activateTab).not.toHaveBeenCalled();
    expect(other.tabs).toEqual([]);
  });

  test('one-run-at-a-time', async () => {
    const { runs, capture, browser, state } = setup();
    capture.mockResolvedValue({ status: 'refused', reason: 'no-audit' });
    expect(runs.start(plan([]))).toEqual({ status: 'refused', reason: 'no-targets' });
    runs.start(plan(pages(A)));
    expect(runs.running()).toBe(PROJECT);
    expect(runs.start(plan(pages(B), { projectId: ID }))).toEqual({ status: 'refused', reason: 'busy' });
    expect(browser.newTab).toHaveBeenCalledOnce();
    runs.cancel();
    await run(RETRY);
    expect(runs.start(plan(pages(B)))).toMatchObject({ status: 'started' });
    runs.cancel();
    await run(RETRY);
    // No tab to be had: refused, and said in the state.
    state.tabLimit = true;
    expect(runs.start(plan(pages(A)))).toEqual({ status: 'refused', reason: 'no-tab' });
    expect(runs.state().state).toBe('failed');
    expect(runs.running()).toBeNull();
  });

  test('capture-run-caps-targets', async () => {
    const { runs } = setup();
    const many = Array.from({ length: PROJECT_RUN_LIMITS.maxRunTargets + 5 }, (_, i) => `https://example.com/${i}`);
    runs.start(plan(pages(...many)));
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
    runs.start(plan(pages(A)));
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
