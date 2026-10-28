// Spec: specs/projects.spec.ts (MOBILE_QUERY_PROFILE), specs/render-profile.spec.ts (pins)
// Acceptance: specs/projects.feature.md (Capture now: render profiles; Scenario: capture-run-never-removes-a-pin)
// The run over the real browser controller and its real render profiles and pins
// (`browser/render-profile.ts`): a run never removes a pin the user saved.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import type { CaptureAnswer } from '@app/specs/changes.spec';
import { MOBILE_QUERY_PROFILE } from '@app/specs/projects.spec';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from '@app/specs/render-profile.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../../browser/controller';
import type { ProfileDebugger } from '../../browser/render-profile-debugger';
import { createRenderProfilePins, type RenderProfilePins } from '../../browser/render-profile-pins';
import { createCaptureRuns, type RunBrowser } from '../capture-run';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const PROJECT = '01920000-0000-7000-8000-0000000000aa';
const ID = '01920000-0000-7000-8000-000000000001';
const NO_JS: RenderProfile = { ...DEFAULT_RENDER_PROFILE, javascriptDisabled: true };
const PHONE_BOT: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
const MOBILE: SearchParams = { engine: 'google', query: 'tea', country: null, language: null, location: null, device: 'mobile' };
const DESKTOP: SearchParams = { ...MOBILE, device: 'desktop' };
const SEARCH = 'https://www.google.com/search?q=tea';

/** A debugger that accepts every command (none of this test's business). */
class FakeDebugger implements ProfileDebugger {
  send = vi.fn(async () => undefined);
  sendTopLevel = vi.fn(async () => undefined);
  detach = vi.fn();
  isAttached = () => true;
  dispose = vi.fn();
}

let views: FakeTabView[];
let controller: BrowserController;
let pins: RenderProfilePins;
let pinRemovals: ReturnType<typeof vi.fn<(origin: string) => void>>;

beforeEach(() => {
  views = [];
  pinRemovals = vi.fn<(origin: string) => void>();
  pins = createRenderProfilePins({ save: vi.fn(), remove: pinRemovals });
  controller = createBrowserController({
    createView: () => {
      const created = new FakeTabView();
      views.push(created);
      return created as unknown as TabView;
    },
    platform: 'linux',
    renderProfiles: { pins, chromeVersion: '140.0.7339.80', debuggerFor: () => new FakeDebugger() },
  });
  controller.attach(new FakeHostWindow() as unknown as HostWindow);
  controller.setPageBounds({ x: 0, y: 90, width: 1000, height: 700 });
});

/** The controller as the run uses it; a navigation commits shortly after, as Electron reports it. */
function runBrowser(): RunBrowser {
  return {
    getState: () => controller.getState(),
    newTab: () => controller.newTab(),
    activateTab: (tabId) => controller.activateTab(tabId),
    closeTab: (tabId) => controller.closeTab(tabId),
    setRenderProfile: (tabId, profile) => controller.setRenderProfile(tabId, profile),
    navigate: (url) => {
      const tabId = controller.getState().activeTabId;
      const ok = controller.navigate(url);
      setTimeout(() => {
        const view = views.find((candidate) => controller.tabIdOf(candidate.contents as never) === tabId);
        if (!view) return;
        view.contents.emit('did-start-navigation', fakeEvent({ url, isMainFrame: true, isSameDocument: false }));
        commit(view.contents as FakeTabContents, url, 'Page');
      }, 5);
      return ok;
    },
  };
}

describe('capture run over the real render profiles', () => {
  test('capture-run-never-removes-a-pin', async () => {
    // The user pinned a profile to the search engine's site and to a page's site.
    pins.set('https://www.google.com', NO_JS);
    pins.set('https://a.example', PHONE_BOT);
    /** The profile in effect in the run's tab at each capture. */
    const inEffect: (RenderProfile | null)[] = [];
    const capture = vi.fn(async (tabId: number): Promise<CaptureAnswer> => {
      inEffect.push(controller.getState().tabs.find((tab) => tab.id === tabId)?.renderProfile?.profile ?? null);
      return { status: 'captured', captureId: ID, versionId: ID, newVersion: true, changeCount: null };
    });
    const runs = createCaptureRuns({ browser: runBrowser(), capture, screenshot: vi.fn(), uuidv7: () => ID, limits: { captureRetryMs: 10 } });
    const previous = controller.getState().activeTabId;
    expect(
      await runs.start({
        projectId: PROJECT,
        profile: null,
        screenshot: false,
        targets: [
          { kind: 'query', label: 'mobile', url: SEARCH, searchParams: MOBILE },
          { kind: 'query', label: 'desktop', url: `${SEARCH}&num=10`, searchParams: DESKTOP },
          { kind: 'page', label: 'a', url: 'https://a.example/', searchParams: null },
        ],
      }),
    ).toMatchObject({ status: 'started' });
    await vi.waitFor(() => expect(runs.state().state).toBe('done'), { timeout: 5_000, interval: 10 });
    expect(runs.state().targets.map((target) => target.outcome)).toEqual(['captured', 'captured', 'captured']);
    // No pin was removed, and both still apply: the mobile query in its own profiled tab, the rest under the pins.
    expect(pinRemovals).not.toHaveBeenCalled();
    expect(pins.get('https://www.google.com')).toEqual(NO_JS);
    expect(pins.get('https://a.example')).toEqual(PHONE_BOT);
    expect(inEffect).toEqual([MOBILE_QUERY_PROFILE, NO_JS, PHONE_BOT]);
    // The run's tabs are gone; the user's tab is in front again.
    expect(controller.getState().tabs.map((tab) => tab.id)).toEqual([previous]);
    expect(controller.getState().activeTabId).toBe(previous);
  });
});
