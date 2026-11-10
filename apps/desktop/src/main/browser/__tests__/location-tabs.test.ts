// Spec: specs/location-profiles.spec.ts (locationPartition, LOCATION_WEBRTC_POLICY), specs/browser.spec.ts (TabStateSchema.location,
// BrowserStateSchema), specs/browser-session-db.feature.md (Controller)
// Acceptance: specs/location-profiles.feature.md (location-tab-webrtc-proxied-only, location-tab-not-in-history-or-session)
// · plan docs/plans/phase-12-big-bets.md, Decision 11, Task 10b
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BrowserStateSchema } from '@app/specs/browser.spec';
import { locationPartition } from '@app/specs/location-profiles.spec';
import { OPEN_IN_TEMPLATES } from '@app/specs/command-palette.spec';
import { commit, FakeHostWindow, FakeTabView } from '../../../test/controller-fakes';
import { createBrowserController, type BrowserController, type HostWindow, type SessionSink, type TabView } from '../controller';

const PROFILE = '01920000-0000-7000-8000-0000000000c1';
const BERLIN = { profileId: PROFILE, label: 'Berlin' };

let views: { view: FakeTabView; partition: string | undefined }[];
let events: string[];
let win: FakeHostWindow;
let controller: BrowserController;
let sink: { saveSession: ReturnType<typeof vi.fn<SessionSink['saveSession']>>; recordVisit: ReturnType<typeof vi.fn<SessionSink['recordVisit']>>; updateVisitTitle: ReturnType<typeof vi.fn<SessionSink['updateVisitTitle']>> };

beforeEach(() => {
  views = [];
  events = [];
  win = new FakeHostWindow();
  sink = { saveSession: vi.fn(), recordVisit: vi.fn(), updateVisitTitle: vi.fn() };
  controller = createBrowserController({
    createView: (partition?: string) => {
      const view = new FakeTabView();
      const index = views.length;
      events.push(`create ${index} ${partition ?? 'home'}`);
      view.contents.loadURL.mockImplementation(async (url: string) => void events.push(`load ${index} ${url}`));
      views.push({ view, partition });
      return view as unknown as TabView;
    },
    platform: 'linux',
    session: sink,
  });
  controller.attach(win as unknown as HostWindow);
});

const state = () => controller.getState();
const tabOf = (id: number) => state().tabs.find((tab) => tab.id === id)!;

describe('location tabs', () => {
  test('location-tab-webrtc-proxied-only', () => {
    const partition = locationPartition(PROFILE);
    // The first tab of the profile, and a second one.
    const first = controller.openLocationTab(BERLIN)!;
    expect(first).not.toBeNull();
    expect(state().activeTabId).toBe(first);
    expect(tabOf(first).location).toEqual(BERLIN);
    expect(BrowserStateSchema.safeParse(state()).success).toBe(true);
    expect(controller.navigate('https://site.example/')).toBe(true);
    const second = controller.openLocationTab(BERLIN)!;
    expect(controller.navigate('https://site.example/b')).toBe(true);
    // A tab the page opens (a gesture-backed popup) is a tab of the same profile.
    const opener = views[1]!.view.contents;
    const popup = controller.openTabFromPage(opener, 'https://site.example/popup')!;
    expect(tabOf(popup).location).toEqual(BERLIN);
    // A link opened from its panels (a SERP result destination, a sidebar link: no render profile inherited) stays there too.
    controller.activateTab(second);
    const fromPanel = controller.openBackgroundTab('https://result.example/', false)!;
    expect(tabOf(fromPanel).location).toEqual(BERLIN);
    // A home tab is on the browse partition (the factory's default), with no location.
    controller.newTab();
    expect(controller.navigate('https://home.example/')).toBe(true);
    const home = state().activeTabId!;
    expect(tabOf(home).location ?? null).toBeNull();
    expect(views.map((v) => v.partition)).toEqual([partition, partition, partition, partition, undefined]);
    // Each location view was made on the partition (where `createTabView` sets the WebRTC policy) before its first load.
    expect(events).toEqual([
      `create 0 ${partition}`,
      'load 0 https://site.example/',
      `create 1 ${partition}`,
      'load 1 https://site.example/b',
      `create 2 ${partition}`,
      'load 2 https://site.example/popup',
      `create 3 ${partition}`,
      'load 3 https://result.example/',
      'create 4 home',
      'load 4 https://home.example/',
    ]);
  });

  test('location-tab-not-in-history-or-session', () => {
    // A home tab with a page, then a location tab with one.
    expect(controller.navigate('https://home.example/')).toBe(true);
    commit(views[0]!.view.contents, 'https://home.example/', 'Home');
    expect(sink.recordVisit).toHaveBeenCalledWith('https://home.example/');
    sink.recordVisit.mockClear();
    sink.updateVisitTitle.mockClear();
    const located = controller.openLocationTab(BERLIN)!;
    expect(controller.navigate('https://shop.frost-e2e.com/secret-search')).toBe(true);
    commit(views[1]!.view.contents, 'https://shop.frost-e2e.com/secret-search', 'Secret');
    // Never a visit, never a title.
    expect(sink.recordVisit).not.toHaveBeenCalled();
    expect(sink.updateVisitTitle).not.toHaveBeenCalled();
    // An "Open in" tool from it opens on the user's own connection (a third party, never through the proxy).
    const tool = controller.openTool(OPEN_IN_TEMPLATES[0]!.id);
    expect(tool).toMatchObject({ status: 'opened' });
    if (tool.status === 'opened') {
      expect(tabOf(tool.tabId).location ?? null).toBeNull();
      expect(views.at(-1)!.partition).toBeUndefined();
      controller.closeTab(tool.tabId);
      controller.activateTab(located);
    }
    // Never in the saved session: the active location tab counts as the saved tab on its left.
    const saved = sink.saveSession.mock.calls.at(-1)![0];
    expect(saved.tabs).toEqual([{ url: 'https://home.example/', title: 'Home' }]);
    expect(saved.activeIndex).toBe(0);
    expect(JSON.stringify(sink.saveSession.mock.calls)).not.toContain('secret-search');
    // Reopen Closed Tab brings it back on its profile, within the run.
    expect(controller.closeTab(located)).toBe(true);
    const reopened = controller.reopenClosedTab()!;
    expect(tabOf(reopened).location).toEqual(BERLIN);
    expect(views.at(-1)!.partition).toBe(locationPartition(PROFILE));
    expect(sink.recordVisit).not.toHaveBeenCalled();
    // Once its profile is forgotten (edited or removed), its tabs close and none is reopened.
    controller.forgetLocation(PROFILE);
    expect(state().tabs.map((tab) => tab.location ?? null)).toEqual([null]);
    expect(controller.reopenClosedTab()).toBeNull();
    expect(JSON.stringify(sink.saveSession.mock.calls)).not.toContain('secret-search');
  });

  test('location-tab-session-with-only-location-tabs', () => {
    expect(controller.navigate('https://home.example/')).toBe(true);
    commit(views[0]!.view.contents, 'https://home.example/', 'Home');
    const home = state().activeTabId!;
    expect(sink.saveSession.mock.calls.at(-1)![0].tabs).toEqual([{ url: 'https://home.example/', title: 'Home' }]);
    controller.openLocationTab(BERLIN);
    expect(controller.navigate('https://site.example/')).toBe(true);
    commit(views.at(-1)!.view.contents, 'https://site.example/', 'Site');
    controller.closeTab(home);
    // Nothing of the location tab is saved: one empty tab stands in.
    expect(sink.saveSession.mock.calls.at(-1)![0]).toEqual({ tabs: [{ url: '', title: '' }], activeIndex: 0 });
  });
});
