// Spec: specs/seo-limits.spec.ts (AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS), specs/seo-sidebar.spec.ts
// (SEO_AUDIT_STATUSES, SEO_UNAVAILABLE_REASONS), specs/browser.spec.ts (TabState.auditVersion)
// Acceptance: specs/seo-sidebar.feature.md (Auditor)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { rawSnapshot } from '../../../test/seo-fakes';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../../browser/controller';

const A = 'https://example.com/a';
const B = 'https://example.com/b';

/** One extraction the controller started: the contents it ran on, and how to settle it. */
interface Run {
  readonly contents: FakeTabContents;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

let views: FakeTabView[];
let win: FakeHostWindow;
let controller: BrowserController;
let runs: Run[];

beforeEach(() => {
  vi.useFakeTimers();
  views = [];
  runs = [];
  win = new FakeHostWindow();
  controller = createBrowserController({
    createView: () => {
      const view = new FakeTabView();
      views.push(view);
      return view as unknown as TabView;
    },
    platform: 'linux',
    seo: {
      extract: (contents) =>
        new Promise((resolve, reject) => {
          runs.push({ contents: contents as unknown as FakeTabContents, resolve, reject });
        }),
    },
  });
  controller.attach(win as unknown as HostWindow);
});

afterEach(() => {
  vi.useRealTimers();
});

const activeId = () => controller.getState().activeTabId!;
const tabState = (id = activeId()) => controller.getState().tabs.find((t) => t.id === id)!;
const audit = (id = activeId()) => controller.seo.getAudit(id);

/** Loads `url` in the active tab: commits it and finishes the load, as Electron reports it. */
function load(url: string, contents?: FakeTabContents): FakeTabContents {
  if (!contents) {
    controller.navigate(url);
    contents = views.at(-1)!.contents;
  }
  commit(contents, url, `Title of ${url}`);
  contents.emit('did-finish-load');
  return contents;
}

/** An SPA route change: the URL changes in place (`pushState`). */
function pushState(contents: FakeTabContents, url: string, isMainFrame = true) {
  if (isMainFrame) contents.url = url;
  contents.emit('did-navigate-in-page', fakeEvent(), url, isMainFrame, 1, 1);
}

/** Lets settled promises run their continuations. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('auditor', () => {
  test('audit-runs-after-load', async () => {
    const before = tabState().auditVersion;
    const versionBefore = controller.getState().version;
    const contents = load(A);
    expect(audit()).toEqual({ status: 'pending', url: A });
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS - 1);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contents).toBe(contents);
    // Still pending (the answer has not changed, so neither has the version).
    expect(audit()).toEqual({ status: 'pending', url: A });
    const pendingVersion = tabState().auditVersion;

    const woken = controller.watch(controller.getState().version);
    runs[0]!.resolve(rawSnapshot(A));
    await flush();
    const answer = audit();
    expect(answer.status).toBe('ready');
    if (answer.status !== 'ready') throw new Error('not ready');
    expect(answer.url).toBe(A);
    expect(answer.audit.url).toBe(A);
    expect(answer.audit.score).toBe(100);
    expect(answer.audit.page.title?.text).toBe('A well titled page about something useful');
    expect(tabState().auditVersion).toBeGreaterThan(pendingVersion);
    expect(tabState().auditVersion).toBeGreaterThan(before);
    await expect(woken).resolves.toMatchObject({ version: expect.any(Number) });
    expect(controller.getState().version).toBeGreaterThan(versionBefore);
  });

  test('audit-debounced', async () => {
    const contents = load(A);
    await vi.advanceTimersByTimeAsync(200);
    pushState(contents, `${A}#one`);
    await vi.advanceTimersByTimeAsync(200);
    pushState(contents, `${A}#two`);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS - 1);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(1);
    runs[0]!.resolve(rawSnapshot(`${A}#two`));
    await flush();
    expect(audit().status).toBe('ready');
    // A subframe's in-page navigation audits nothing.
    pushState(contents, 'https://ads.example.net/frame#x', false);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS * 2);
    expect(runs).toHaveLength(1);
  });

  test('audit-active-tab-only', async () => {
    const first = load(A);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    runs[0]!.resolve(rawSnapshot(A));
    await flush();
    const firstId = activeId();

    // A background tab (a popup) loads: nothing is extracted for it.
    const backgroundId = controller.openTabFromPage(first, B)!;
    const background = views.at(-1)!.contents;
    load(B, background);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS * 3);
    expect(runs).toHaveLength(1);
    expect(audit(backgroundId)).toEqual({ status: 'pending', url: B });

    // Shown: audited (it has none).
    controller.activateTab(backgroundId);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.contents).toBe(background);
    runs[1]!.resolve(rawSnapshot(B));
    await flush();
    expect(audit(backgroundId).status).toBe('ready');

    // Back to the first tab: its audit is still current, so it is not run again.
    controller.activateTab(firstId);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS * 3);
    expect(runs).toHaveLength(2);
    expect(audit(firstId).status).toBe('ready');

    // The background tab reloads while hidden: stale, so it is audited again when shown.
    background.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS * 3);
    expect(runs).toHaveLength(2);
    controller.activateTab(backgroundId);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    expect(runs).toHaveLength(3);
  });

  test('audit-matches-current-url', async () => {
    const contents = load(A);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    expect(runs).toHaveLength(1);
    // The SPA moves on before the extraction of /a settles.
    pushState(contents, B);
    runs[0]!.resolve(rawSnapshot(A));
    await flush();
    expect(audit()).toEqual({ status: 'pending', url: B });
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    expect(runs).toHaveLength(2);
    runs[1]!.resolve(rawSnapshot(B));
    await flush();
    const answer = audit();
    expect(answer.status).toBe('ready');
    expect(answer.status === 'ready' && answer.audit.url).toBe(B);

    // A superseded run's late result never replaces a newer one.
    expect(controller.seo.rerun(activeId())).toBe(true);
    expect(controller.seo.rerun(activeId())).toBe(true);
    expect(runs).toHaveLength(4);
    runs[3]!.resolve(rawSnapshot(B, { titles: [{ text: 'Newer run title for this page', length: 29 }] }));
    await flush();
    runs[2]!.resolve(rawSnapshot(B, { titles: [{ text: 'Older run title for this page', length: 29 }] }));
    await flush();
    const latest = audit();
    expect(latest.status === 'ready' && latest.audit.page.title?.text).toBe('Newer run title for this page');

    // A new page commits: the old audit is never answered for it.
    commit(contents, A, 'A again');
    expect(audit()).toEqual({ status: 'pending', url: A });
  });

  test('audit-timeout-is-unavailable', async () => {
    load(A);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    expect(runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(EXTRACT_TIMEOUT_MS - 1);
    expect(audit().status).toBe('pending');
    const version = tabState().auditVersion;
    await vi.advanceTimersByTimeAsync(1);
    expect(audit()).toEqual({ status: 'unavailable', url: A, reason: 'timeout' });
    expect(tabState().auditVersion).toBeGreaterThan(version);
    // The late result is ignored.
    runs[0]!.resolve(rawSnapshot(A));
    await flush();
    expect(audit()).toEqual({ status: 'unavailable', url: A, reason: 'timeout' });
  });

  test('audit-invalid-snapshot-is-unavailable', async () => {
    load(A);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    const tooManyLinks = Array.from({ length: SNAPSHOT_LIMITS.maxLinks + 1 }, (_, i) => ({ href: `${A}/${i}`, scheme: 'https:', rel: '', text: 'x', kind: 'internal' }));
    const answers: [unknown, string][] = [
      [undefined, 'invalid-snapshot'],
      ['<html>', 'invalid-snapshot'],
      [{ ...rawSnapshot(A), injected: '<script>' }, 'invalid-snapshot'],
      [rawSnapshot(A, { links: tooManyLinks as never, linkTotal: 100_000 }), 'invalid-snapshot'],
    ];
    for (const [answer, reason] of answers) {
      runs.at(-1)!.resolve(answer);
      await flush();
      expect(audit()).toEqual({ status: 'unavailable', url: A, reason });
      controller.seo.rerun(activeId());
    }
    runs.at(-1)!.reject(new Error('Script failed to execute'));
    await flush();
    expect(audit()).toEqual({ status: 'unavailable', url: A, reason: 'extraction-failed' });
  });

  test('audit-skips-non-pages', async () => {
    // An empty tab.
    expect(audit()).toEqual({ status: 'unavailable', url: '', reason: 'no-page' });
    expect(controller.seo.getAudit(999)).toEqual({ status: 'unavailable', url: '', reason: 'no-tab' });

    // A load error.
    controller.navigate(A);
    const contents = views.at(-1)!.contents;
    contents.emit('did-fail-load', fakeEvent(), -105, 'ERR_NAME_NOT_RESOLVED', A, true);
    contents.emit('did-finish-load');
    expect(audit()).toMatchObject({ status: 'unavailable', reason: 'load-error' });

    // A crash.
    load(A, contents);
    contents.emit('render-process-gone', fakeEvent(), { reason: 'crashed', exitCode: 1 });
    contents.emit('did-finish-load');
    expect(audit()).toMatchObject({ status: 'unavailable', reason: 'crashed' });

    // A non-web page.
    contents.emit('did-start-loading');
    contents.url = 'about:blank';
    contents.emit('did-navigate', fakeEvent(), 'about:blank', 200, 'OK');
    contents.emit('did-finish-load');
    expect(audit()).toMatchObject({ status: 'unavailable', reason: 'no-page' });

    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS * 4);
    expect(runs).toHaveLength(0);
    expect(controller.seo.rerun(activeId())).toBe(false);
    expect(controller.seo.rerun(999)).toBe(false);
    expect(runs).toHaveLength(0);
  });

  test('audit-rerun', async () => {
    load(A);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    runs[0]!.resolve(rawSnapshot(A));
    await flush();
    expect(audit().status).toBe('ready');
    const version = tabState().auditVersion;
    // At once, no debounce.
    expect(controller.seo.rerun(activeId())).toBe(true);
    expect(runs).toHaveLength(2);
    expect(audit()).toEqual({ status: 'pending', url: A });
    expect(tabState().auditVersion).toBeGreaterThan(version);
    runs[1]!.resolve(rawSnapshot(A));
    await flush();
    expect(audit().status).toBe('ready');
  });

  test('closed-tab-audit-is-forgotten', async () => {
    // A pending timer is cleared with the tab.
    load(A);
    const firstId = activeId();
    controller.closeTab(firstId);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS * 2);
    expect(runs).toHaveLength(0);
    expect(controller.seo.getAudit(firstId)).toEqual({ status: 'unavailable', url: '', reason: 'no-tab' });

    // An in-flight run's late result changes nothing.
    load(B);
    const secondId = activeId();
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    expect(runs).toHaveLength(1);
    controller.closeTab(secondId);
    const version = controller.getState().version;
    runs[0]!.resolve(rawSnapshot(B));
    await flush();
    expect(controller.getState().version).toBe(version);
    expect(controller.seo.getAudit(secondId)).toMatchObject({ status: 'unavailable', reason: 'no-tab' });
  });
});
