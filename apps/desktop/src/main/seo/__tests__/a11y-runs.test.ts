// Spec: specs/seo-compliance.spec.ts (A11Y_RUN_STATUSES, A11Y_FAIL_REASONS, A11Y_TIMEOUT_MS, AccessibilityRunState),
// specs/seo-snapshot.spec.ts (PageContext.accessibility), specs/browser.spec.ts (TabState.auditVersion)
// Acceptance: specs/seo-compliance.feature.md (Run lifecycle, Controller)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SeoAuditResponse } from '@app/seo-core';
import { A11Y_LIMITS, A11Y_TIMEOUT_MS, IDLE_A11Y_RUN } from '@app/specs/seo-compliance.spec';
import { AUDIT_DEBOUNCE_MS } from '@app/specs/seo-limits.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { rawSnapshot } from '../../../test/seo-fakes';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../../browser/controller';
import { analyseSnapshot } from '../analyse';
import { contextSource, knownInput, laterInput } from '../context-source';

const A = 'https://example.com/a';
const B = 'https://example.com/b';

/** One accessibility run the controller started, and how to settle it. */
interface Run {
  readonly contents: FakeTabContents;
  resolve(answer: unknown): void;
  reject(error: unknown): void;
}

let views: FakeTabView[];
let win: FakeHostWindow;
let controller: BrowserController;
let runs: Run[];
/** Every context the analysis was given (the accessibility answer travels in it). */
let contexts: unknown[];

/** A run answer (the run script's summary) for `url`, with one critical violation. */
function answer(url: string, impact: 'critical' | 'serious' = 'critical') {
  return {
    url,
    axeVersion: '4.14.0',
    ranAt: 1_760_000_100_000,
    durationMs: 300,
    violations: [{ id: 'image-alt', impact, help: 'Images need text', description: 'd', helpUrl: 'https://help.example/image-alt', tags: ['wcag2a'], nodes: [{ selector: 'img', summary: 'Fix it' }], nodeTotal: 1 }],
    violationTotal: 1,
    passes: 20,
    incomplete: 0,
    inapplicable: 10,
    partial: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  views = [];
  runs = [];
  contexts = [];
  win = new FakeHostWindow();
  controller = createBrowserController({
    createView: () => {
      const view = new FakeTabView();
      views.push(view);
      return view as unknown as TabView;
    },
    platform: 'linux',
    seo: {
      extract: async (contents) => rawSnapshot((contents as unknown as FakeTabContents).url),
      analyse: async (raw, context) => {
        contexts.push(context);
        return analyseSnapshot(raw, context);
      },
    },
    accessibility: (contents) =>
      new Promise<unknown>((resolve, reject) => {
        runs.push({ contents: contents as unknown as FakeTabContents, resolve, reject });
      }),
  });
  controller.attach(win as unknown as HostWindow);
});

afterEach(() => {
  vi.useRealTimers();
});

const activeId = () => controller.getState().activeTabId!;
const version = (id = activeId()) => controller.getState().tabs.find((t) => t.id === id)!.auditVersion;
const response = (id = activeId()): SeoAuditResponse => controller.seo.getAudit(id);
const run = (id = activeId()) => {
  const r = response(id);
  return r.status === 'ready' ? r.accessibilityRun : undefined;
};
const settle = () => vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS + 10);

/** Loads `url` in the active tab and waits for its audit. */
async function load(url: string, contents?: FakeTabContents): Promise<FakeTabContents> {
  if (!contents) {
    controller.navigate(url);
    contents = views.at(-1)!.contents;
  }
  commit(contents, url, `Title of ${url}`);
  contents.emit('did-finish-load');
  await settle();
  expect(response().status).toBe('ready');
  return contents;
}

describe('run lifecycle', () => {
  test('a11y-run-starts-on-request-only', async () => {
    await load(A);
    // Nothing runs on its own.
    expect(runs).toHaveLength(0);
    expect(run()).toEqual(IDLE_A11Y_RUN);
    const before = version();
    expect(controller.seo.runAccessibility(activeId())).toBe(true);
    expect(runs).toHaveLength(1);
    expect(run()).toMatchObject({ status: 'running', startedAt: expect.any(Number), finishedAt: null, reason: null });
    // The state change wakes the chrome (the tab's audit version moves).
    expect(version()).toBeGreaterThan(before);
    // A request while one runs is not doubled.
    expect(controller.seo.runAccessibility(activeId())).toBe(true);
    expect(runs).toHaveLength(1);
  });

  test('a11y-run-only-for-the-active-web-page', async () => {
    const first = activeId();
    await load(A);
    controller.newTab();
    expect(controller.seo.runAccessibility(first)).toBe(false);
    // An empty tab has nothing to check; an unknown tab is a no-op.
    expect(controller.seo.runAccessibility(activeId())).toBe(false);
    expect(controller.seo.runAccessibility(999)).toBe(false);
    expect(runs).toHaveLength(0);
  });

  test('a11y-answer-is-scored-without-pending', async () => {
    await load(A);
    const shown = response();
    controller.seo.runAccessibility(activeId());
    runs[0]!.resolve(answer(A));
    await vi.advanceTimersByTimeAsync(0);
    expect(run()!.status).toBe('done');
    // The audit on screen stays while the answer is scored (no pending in between) …
    expect(response().status).toBe('ready');
    await vi.advanceTimersByTimeAsync(10);
    // … then the new audit has it: the analysis got it beside the snapshot.
    expect(contexts.at(-1)).toMatchObject({ accessibility: answer(A) });
    const now = response();
    if (now.status !== 'ready' || shown.status !== 'ready') throw new Error('not ready');
    expect(now.audit.compliance.accessibility.status).toBe('done');
    expect(now.audit.findings.map((f) => f.ruleId)).toContain('a11y-critical');
    expect(now.audit.score).toBeLessThan(shown.audit.score);
    // Later audits of the same document keep it (a rerun of the audit).
    controller.seo.rerun(activeId());
    await vi.advanceTimersByTimeAsync(10);
    expect(contexts.at(-1)).toMatchObject({ accessibility: answer(A) });
  });

  test('a11y-run-times-out', async () => {
    await load(A);
    controller.seo.runAccessibility(activeId());
    await vi.advanceTimersByTimeAsync(A11Y_TIMEOUT_MS - 1);
    expect(run()!.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(run()).toMatchObject({ status: 'timed-out', finishedAt: expect.any(Number) });
    // Its late answer is dropped: nothing is scored.
    const analysed = contexts.length;
    runs[0]!.resolve(answer(A));
    await vi.advanceTimersByTimeAsync(10);
    expect(run()!.status).toBe('timed-out');
    expect(contexts).toHaveLength(analysed);
    // It can be run again.
    expect(controller.seo.runAccessibility(activeId())).toBe(true);
    expect(runs).toHaveLength(2);
  });

  test('a11y-run-cancelled-by-navigation', async () => {
    const contents = await load(A);
    controller.seo.runAccessibility(activeId());
    await load(B, contents);
    expect(run()).toEqual(IDLE_A11Y_RUN);
    // The old document's answer arrives late: dropped, never in B's context.
    runs[0]!.resolve(answer(A));
    await vi.advanceTimersByTimeAsync(10);
    expect(run()).toEqual(IDLE_A11Y_RUN);
    expect(contexts.every((c) => (c as { accessibility?: unknown } | undefined)?.accessibility === undefined)).toBe(true);
  });

  test('a11y-answer-belongs-to-its-document', async () => {
    const contents = await load(A);
    controller.seo.runAccessibility(activeId());
    runs[0]!.resolve(answer(A));
    await vi.advanceTimersByTimeAsync(10);
    expect(run()!.status).toBe('done');
    // Reloading the same URL is a new document: the answer goes with the old one.
    await load(A, contents);
    expect(run()).toEqual(IDLE_A11Y_RUN);
    expect((contexts.at(-1) as { accessibility?: unknown } | undefined)?.accessibility).toBeUndefined();
    const now = response();
    expect(now.status === 'ready' && now.audit.compliance.accessibility.status).toBe('not-run');
  });

  test('a11y-run-cancelled-by-in-page-navigation', async () => {
    const contents = await load(A);
    controller.seo.runAccessibility(activeId());
    // A fragment change keeps the run.
    contents.url = `${A}#part`;
    contents.emit('did-navigate-in-page', fakeEvent(), contents.url, true);
    expect(run()!.status).toBe('running');
    // Another URL cancels it.
    contents.url = B;
    contents.emit('did-navigate-in-page', fakeEvent(), B, true);
    await settle();
    expect(run()).toEqual(IDLE_A11Y_RUN);
    runs[0]!.resolve(answer(A));
    await vi.advanceTimersByTimeAsync(10);
    expect(run()).toEqual(IDLE_A11Y_RUN);
  });

  test('a11y-run-failures', async () => {
    await load(A);
    const id = activeId();
    controller.seo.runAccessibility(id);
    runs[0]!.resolve({ busy: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(run()).toMatchObject({ status: 'failed', reason: 'busy' });
    controller.seo.runAccessibility(id);
    runs[1]!.reject(new Error('Script failed to execute'));
    await vi.advanceTimersByTimeAsync(0);
    expect(run()).toMatchObject({ status: 'failed', reason: 'script-error' });
    controller.seo.runAccessibility(id);
    runs[2]!.resolve('not an object');
    await vi.advanceTimersByTimeAsync(0);
    expect(run()).toMatchObject({ status: 'failed', reason: 'script-error' });
    // Over main's size check: not kept, never sent to the worker.
    const analysed = contexts.length;
    controller.seo.runAccessibility(id);
    runs[3]!.resolve({ ...answer(A), padding: 'x'.repeat(A11Y_LIMITS.maxResultChars + 1) });
    await vi.advanceTimersByTimeAsync(10);
    expect(run()).toMatchObject({ status: 'failed', reason: 'too-large' });
    expect(contexts).toHaveLength(analysed);
  });

  test('a11y-run-ends-with-the-page', async () => {
    const contents = await load(A);
    controller.seo.runAccessibility(activeId());
    contents.emit('render-process-gone', fakeEvent(), { reason: 'crashed', exitCode: 1 });
    expect(controller.seo.getAudit(activeId()).status).toBe('unavailable');
    runs[0]!.resolve(answer(A));
    await vi.advanceTimersByTimeAsync(10);
    // Closed tab: forgotten, its late answer ignored.
    controller.closeTab(activeId());
    await vi.advanceTimersByTimeAsync(10);
    expect(contexts.every((c) => (c as { accessibility?: unknown } | undefined)?.accessibility === undefined)).toBe(true);
  });

  test('a11y-background-tab-scored-when-shown', async () => {
    await load(A);
    const first = activeId();
    controller.seo.runAccessibility(first);
    controller.newTab();
    await load(B);
    // The first tab's answer arrives while it is in the background: kept, scored once it is shown.
    runs[0]!.resolve(answer(A));
    await vi.advanceTimersByTimeAsync(10);
    expect(contexts.some((c) => (c as { accessibility?: unknown } | undefined)?.accessibility !== undefined)).toBe(false);
    controller.activateTab(first);
    await settle();
    expect(contexts.at(-1)).toMatchObject({ accessibility: answer(A) });
    expect(run(first)!.status).toBe('done');
  });

  test('a11y-answer-while-context-pending', async () => {
    // main's context: the response known at once, the speed measurement later (one per run).
    const measurements: { resolve(value: unknown): void }[] = [];
    const seen: unknown[] = [];
    const held = createBrowserController({
      createView: () => {
        const view = new FakeTabView();
        views.push(view);
        return view as unknown as TabView;
      },
      platform: 'linux',
      seo: {
        extract: async (contents) => rawSnapshot((contents as unknown as FakeTabContents).url),
        analyse: async (raw, context) => {
          seen.push(context);
          return analyseSnapshot(raw, context);
        },
        context: () =>
          contextSource({
            response: knownInput(null),
            robots: knownInput(null),
            performance: laterInput(new Promise<unknown>((resolve) => measurements.push({ resolve }))),
          }),
      },
      accessibility: (contents) =>
        new Promise<unknown>((resolve, reject) => {
          runs.push({ contents: contents as unknown as FakeTabContents, resolve, reject });
        }),
    });
    held.attach(new FakeHostWindow() as unknown as HostWindow);
    const id = held.getState().activeTabId!;
    held.navigate(A);
    const contents = views.at(-1)!.contents;
    commit(contents, A, 'A');
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS + 10);
    // Shown at once without the measurement; then final once it settles.
    expect(held.seo.getAudit(id).status).toBe('ready');
    measurements[0]!.resolve(null);
    await vi.advanceTimersByTimeAsync(10);
    const before = held.seo.getAudit(id);
    if (before.status !== 'ready') throw new Error('not ready');
    expect(before.audit.compliance.accessibility.status).toBe('not-run');
    // The check answers while the re-score's measurement is still pending.
    expect(held.seo.runAccessibility(id)).toBe(true);
    runs.at(-1)!.resolve(answer(A));
    await vi.advanceTimersByTimeAsync(10);
    expect(measurements).toHaveLength(2);
    // The first analysis has the answer but not the measurement: the shown audit is held, not replaced.
    expect(seen.at(-1)).toMatchObject({ accessibility: answer(A) });
    expect(seen.at(-1)).not.toHaveProperty('performance');
    const holding = held.seo.getAudit(id);
    expect(holding.status === 'ready' && holding.audit).toBe(before.audit);
    // The measurement settles: the final analysis has both, and its audit is shown.
    measurements[1]!.resolve(null);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.at(-1)).toMatchObject({ accessibility: answer(A), performance: null });
    const after = held.seo.getAudit(id);
    if (after.status !== 'ready') throw new Error('not ready');
    expect(after.audit.compliance.accessibility.status).toBe('done');
    expect(after.accessibilityRun?.status).toBe('done');
  });
});
