// Spec: specs/render-profile.spec.ts (TabOverrides, DEFAULT_TAB_OVERRIDES, GEOLOCATION_PRESETS, TAB_OVERRIDES_WORLD_ID),
// specs/render-profile.schema.spec.ts (TabOverridesSchema), specs/browser.spec.ts (TabState.tabOverrides,
// TabState.loadedUnderOverrides, TabState.overridesRevision, TabState.overridesStatus)
// Acceptance: specs/render-profile.feature.md (Tab overrides: tab-local, the document marker, the override revision)
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BrowserStateSchema } from '@app/specs/browser.spec';
import { DEFAULT_RENDER_PROFILE, DEFAULT_TAB_OVERRIDES, GEOLOCATION_PRESETS, TAB_OVERRIDES_WORLD_ID, type RenderProfile, type TabOverrides } from '@app/specs/render-profile.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';
import type { CookieBlock } from '../cookie-block';
import type { ProfileDebugger } from '../render-profile-debugger';
import { changesTabs } from '../../changes/service';
import { screenshotTabs } from '../../screenshots/service';
import { createRenderProfilePins, type RenderProfilePins } from '../render-profile-pins';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const CSS_OFF: TabOverrides = { ...DEFAULT_TAB_OVERRIDES, cssDisabled: true };
const COOKIES_OFF: TabOverrides = { ...DEFAULT_TAB_OVERRIDES, cookiesDisabled: true };
const PARIS: TabOverrides = { ...DEFAULT_TAB_OVERRIDES, geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 100 } };
const ALL: TabOverrides = { cssDisabled: true, cookiesDisabled: true, geolocation: GEOLOCATION_PRESETS[0].geolocation };
const PHONE_BOT: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

let views: FakeTabView[];
let controller: BrowserController;
let pins: RenderProfilePins;
let pinWrites: ReturnType<typeof vi.fn>;
let debuggers: Map<FakeTabContents, ProfileDebugger & { dispose: ReturnType<typeof vi.fn> }>;
let blocked: Map<number, unknown>;
let cookieBlock: CookieBlock & { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
let nextId: number;
/** What every debugger `send` answers (tests replace it to fail or hold a list). */
let sendAnswer: () => Promise<void>;

beforeEach(() => {
  sendAnswer = async () => undefined;
  views = [];
  debuggers = new Map();
  blocked = new Map();
  nextId = 10;
  pinWrites = vi.fn();
  pins = createRenderProfilePins({ save: pinWrites as never });
  cookieBlock = {
    add: vi.fn((id: number, session: unknown) => void blocked.set(id, session)),
    remove: vi.fn((id: number) => void blocked.delete(id)),
    isRegistered: () => blocked.size > 0,
  };
  controller = createBrowserController({
    createView: () => {
      const view = new FakeTabView();
      Object.assign(view.contents, { id: nextId++, session: { webRequest: {} } });
      views.push(view);
      return view as unknown as TabView;
    },
    platform: 'linux',
    renderProfiles: {
      pins,
      chromeVersion: '140.0.0.0',
      debuggerFor: (contents) => {
        const dbg = { send: vi.fn(() => sendAnswer()), sendTopLevel: vi.fn(async () => undefined), detach: vi.fn(), isAttached: () => true, dispose: vi.fn() };
        debuggers.set(contents as unknown as FakeTabContents, dbg);
        return dbg;
      },
    },
    tabOverrides: { cookieBlock },
  });
  controller.attach(new FakeHostWindow() as unknown as HostWindow);
});

const tabState = (id: number) => controller.getState().tabs.find((t) => t.id === id)!;
const activeId = () => controller.getState().activeTabId!;
const marker = (id: number) => tabState(id).loadedUnderOverrides;
const revision = (id: number) => tabState(id).overridesRevision;

/** A main-frame navigation's start (a new document). */
const start = (contents: FakeTabContents, url: string) => contents.emit('did-start-navigation', fakeEvent({ url, isMainFrame: true, isSameDocument: false }));
/** Its commit: the new document is there and still loading. */
const commitOnly = (contents: FakeTabContents, url: string) => {
  contents.loading = true;
  contents.url = url;
  contents.emit('did-navigate', fakeEvent(), url, 200, 'OK');
};
/** The load finished (Electron's `did-stop-loading`). */
const finish = (contents: FakeTabContents) => {
  contents.loading = false;
  contents.emit('did-stop-loading');
};
/** A whole main-frame navigation: started, committed, finished. */
const navigateTo = (contents: FakeTabContents, url: string) => {
  start(contents, url);
  commit(contents, url, 'Page');
};

async function openAt(url: string): Promise<{ id: number; contents: FakeTabContents }> {
  controller.navigate(url);
  await settle();
  const contents = views.at(-1)!.contents;
  navigateTo(contents, url);
  return { id: activeId(), contents };
}

describe('tab overrides', () => {
  test('emulation-is-tab-local-and-not-pinned', async () => {
    const first = await openAt('https://a.example/');
    controller.newTab();
    const second = await openAt('https://a.example/other');
    expect(tabState(first.id).tabOverrides).toEqual(DEFAULT_TAB_OVERRIDES);
    expect(controller.tabOverrides.set(first.id, ALL)).toBe(true);
    // The tab's own value, in its state; no other tab, no profile and no pin.
    expect(tabState(first.id).tabOverrides).toEqual(ALL);
    expect(tabState(second.id).tabOverrides).toEqual(DEFAULT_TAB_OVERRIDES);
    expect(tabState(first.id).renderProfile).toBeNull();
    expect(pinWrites).not.toHaveBeenCalled();
    expect(pins.get('https://a.example')).toBeNull();
    expect(BrowserStateSchema.parse(controller.getState())).toEqual(controller.getState());
    // It stays with the tab across sites (it is not a site's).
    navigateTo(first.contents, 'https://b.example/');
    expect(tabState(first.id).tabOverrides).toEqual(ALL);
    // A tab opened from it, or a new tab on the same site, starts with none.
    const popup = controller.openTabFromPage(first.contents, 'https://a.example/popup')!;
    await settle();
    expect(tabState(popup).tabOverrides).toEqual(DEFAULT_TAB_OVERRIDES);
    controller.newTab();
    const third = await openAt('https://b.example/');
    expect(tabState(third.id).tabOverrides).toEqual(DEFAULT_TAB_OVERRIDES);
    // CSS off ran in the overrides' world on the overridden tab only.
    const worlds = (contents: FakeTabContents) => contents.executeJavaScriptInIsolatedWorld.mock.calls.filter(([world]) => world === TAB_OVERRIDES_WORLD_ID).length;
    expect(worlds(first.contents)).toBeGreaterThan(0);
    expect(worlds(second.contents)).toBe(0);
    expect(worlds(third.contents)).toBe(0);
    // Unknown ids are no-ops.
    expect(controller.tabOverrides.set(999, ALL)).toBe(false);
  });

  test('emulation-ends-with-the-tab', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.tabOverrides.set(id, { ...COOKIES_OFF, geolocation: PARIS.geolocation });
    const webContentsId = (contents as unknown as { id: number }).id;
    expect(cookieBlock.add).toHaveBeenCalledWith(webContentsId, expect.anything());
    expect(blocked.has(webContentsId)).toBe(true);
    const dbg = debuggers.get(contents)!;
    controller.newTab();
    controller.closeTab(id);
    // Its cookie block, its debugger and its state go with it.
    expect(cookieBlock.remove).toHaveBeenCalledWith(webContentsId);
    expect(blocked.size).toBe(0);
    expect(dbg.dispose).toHaveBeenCalled();
    expect(controller.getState().tabs.every((t) => t.tabOverrides.cookiesDisabled === false && t.tabOverrides.geolocation === null)).toBe(true);
    // Reopened (the closed-tab stack): it comes back without them.
    controller.reopenClosedTab();
    await settle();
    expect(tabState(activeId()).tabOverrides).toEqual(DEFAULT_TAB_OVERRIDES);
  });

  test('marker-set-when-a-document-loads-under-overrides', async () => {
    const { id, contents } = await openAt('https://a.example/');
    expect(marker(id)).toBe(false);
    // A document committed while an override is on (set before any page was there: no document yet).
    controller.newTab();
    const fresh = activeId();
    controller.tabOverrides.set(fresh, CSS_OFF);
    expect(marker(fresh)).toBe(false);
    controller.navigate('https://c.example/');
    await settle();
    navigateTo(views.at(-1)!.contents, 'https://c.example/');
    expect(marker(fresh)).toBe(true);
    void contents;
    void id;

    // A document that commits clean but is still loading when an override is turned on.
    const other = await (async () => {
      controller.newTab();
      return openAt('https://b.example/');
    })();
    start(other.contents, 'https://b.example/next');
    commitOnly(other.contents, 'https://b.example/next');
    expect(marker(other.id)).toBe(false);
    controller.tabOverrides.set(other.id, COOKIES_OFF);
    expect(marker(other.id)).toBe(true);
    finish(other.contents);
    expect(marker(other.id)).toBe(true);
  });

  test('marker-set-when-an-override-turns-on-after-load', async () => {
    // Security-review ruling: an override turned on over a page that finished loading marks it too
    // (CSS off or cookies off may already have changed what the page did), raising the revision.
    const { id, contents } = await openAt('https://a.example/');
    expect(marker(id)).toBe(false);
    controller.tabOverrides.set(id, CSS_OFF);
    expect(marker(id)).toBe(true);
    expect(revision(id)).toBe(2);
    // Turned off again: still marked, so capture and screenshots refuse until a reload.
    controller.tabOverrides.set(id, DEFAULT_TAB_OVERRIDES);
    expect(marker(id)).toBe(true);
    const browser = { getState: () => controller.getState(), seo: controller.seo };
    const captures = changesTabs(browser, () => null, { loadedAt: () => null, watch: () => undefined });
    const shots = screenshotTabs(browser, () => null);
    expect(captures.overridesOn!(id)).toBe(true);
    expect(shots.overridesOn!(id)).toBe(true);
    navigateTo(contents, 'https://a.example/');
    expect(marker(id)).toBe(false);
    expect(captures.overridesOn!(id)).toBe(false);
    expect(shots.overridesOn!(id)).toBe(false);
    // Each override that turns on marks it again (a location too); one that stays on does not re-mark.
    controller.tabOverrides.set(id, PARIS);
    expect(marker(id)).toBe(true);
    const at = revision(id);
    controller.tabOverrides.set(id, { ...PARIS, geolocation: { latitude: 1, longitude: 2, accuracy: 3 } });
    expect(revision(id)).toBe(at + 1);
  });

  test('marker-kept-when-overrides-turned-off', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.tabOverrides.set(id, COOKIES_OFF);
    navigateTo(contents, 'https://a.example/');
    expect(marker(id)).toBe(true);
    // Turning the overrides off never clears it (the page was served and built without cookies).
    controller.tabOverrides.set(id, DEFAULT_TAB_OVERRIDES);
    expect(marker(id)).toBe(true);
    expect(tabState(id).tabOverrides).toEqual(DEFAULT_TAB_OVERRIDES);
    // Nor does a same-document navigation.
    contents.emit('did-start-navigation', fakeEvent({ url: 'https://a.example/#part', isMainFrame: true, isSameDocument: true }));
    contents.emit('did-navigate-in-page', fakeEvent(), 'https://a.example/#part', true);
    contents.emit('did-stop-loading');
    expect(marker(id)).toBe(true);
    // A subframe's navigation neither.
    contents.emit('did-start-navigation', fakeEvent({ url: 'https://ads.example/', isMainFrame: false, isSameDocument: false }));
    contents.emit('did-stop-loading');
    expect(marker(id)).toBe(true);
  });

  test('marker-cleared-only-by-a-clean-navigation', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.tabOverrides.set(id, CSS_OFF);
    navigateTo(contents, 'https://a.example/');
    controller.tabOverrides.set(id, DEFAULT_TAB_OVERRIDES);
    expect(marker(id)).toBe(true);
    // A navigation that starts but has not finished does not clear it yet.
    start(contents, 'https://a.example/');
    commitOnly(contents, 'https://a.example/');
    expect(marker(id)).toBe(true);
    // It completes with every override off from start to finish: cleared.
    finish(contents);
    expect(marker(id)).toBe(false);

    // One whose load saw an override (turned on and off again mid-load) keeps it set.
    start(contents, 'https://a.example/x');
    commitOnly(contents, 'https://a.example/x');
    controller.tabOverrides.set(id, PARIS);
    controller.tabOverrides.set(id, DEFAULT_TAB_OVERRIDES);
    finish(contents);
    expect(marker(id)).toBe(true);
    // A failed navigation (nothing committed) changes nothing.
    start(contents, 'https://a.example/broken');
    contents.emit('did-fail-load', fakeEvent(), -105, 'ERR_NAME_NOT_RESOLVED', 'https://a.example/broken', true);
    finish(contents);
    expect(marker(id)).toBe(true);
    // The next clean one clears it.
    navigateTo(contents, 'https://a.example/y');
    expect(marker(id)).toBe(false);
  });

  test('navigation-ending-without-a-commit-forgets-what-it-saw', async () => {
    const { id, contents } = await openAt('https://a.example/');
    // On over the committed document: marked.
    controller.tabOverrides.set(id, COOKIES_OFF);
    expect(marker(id)).toBe(true);
    // A navigation started while it was on ends without a new document (a download, a 204): the tab
    // just stops loading. Then the override goes off.
    start(contents, 'https://a.example/report.zip');
    finish(contents);
    controller.tabOverrides.set(id, DEFAULT_TAB_OVERRIDES);
    expect(marker(id)).toBe(true);
    // The next navigation, clean from start to finish, clears the marker (the ended one's "saw" is gone).
    navigateTo(contents, 'https://a.example/clean');
    expect(marker(id)).toBe(false);
    // The same after a failed one (`did-fail-load`).
    controller.tabOverrides.set(id, PARIS);
    start(contents, 'https://a.example/broken');
    contents.emit('did-fail-load', fakeEvent(), -105, 'ERR_NAME_NOT_RESOLVED', 'https://a.example/broken', true);
    controller.tabOverrides.set(id, DEFAULT_TAB_OVERRIDES);
    navigateTo(contents, 'https://a.example/clean-again');
    expect(marker(id)).toBe(false);
  });

  test('marker-kept-when-override-on-at-navigation-start', async () => {
    // A tab with no document yet (an override set on it marks nothing until a document loads).
    const fresh = async () => {
      controller.newTab();
      const id = activeId();
      controller.navigate('https://a.example/');
      await settle();
      return { id, contents: views.at(-1)!.contents };
    };
    const { id, contents } = await fresh();
    controller.tabOverrides.set(id, CSS_OFF);
    expect(marker(id)).toBe(false);
    // On when the navigation starts, off before it commits and completes: setting wins.
    start(contents, 'https://a.example/next');
    controller.tabOverrides.set(id, DEFAULT_TAB_OVERRIDES);
    commitOnly(contents, 'https://a.example/next');
    finish(contents);
    expect(marker(id)).toBe(true);

    // Overlapping navigations: the first saw an override, a second started after it was turned off
    // overtakes it before anything committed; setting wins (what the first saw is kept).
    const other = await fresh();
    start(other.contents, 'https://a.example/first');
    controller.tabOverrides.set(other.id, PARIS);
    start(other.contents, 'https://a.example/second');
    controller.tabOverrides.set(other.id, DEFAULT_TAB_OVERRIDES);
    expect(marker(other.id)).toBe(false);
    commitOnly(other.contents, 'https://a.example/second');
    finish(other.contents);
    expect(marker(other.id)).toBe(true);
  });

  test('override-revision-raised-on-change-and-marker-set', async () => {
    const { id, contents } = await openAt('https://a.example/');
    const other = activeId();
    expect(revision(id)).toBe(0);
    // Every set raises it, and so does every marker set (an override turning on over the page is one).
    controller.tabOverrides.set(id, CSS_OFF);
    expect(revision(id)).toBe(2);
    controller.tabOverrides.set(id, { ...CSS_OFF, cookiesDisabled: true });
    expect(revision(id)).toBe(4);
    controller.tabOverrides.set(id, { ...CSS_OFF, cookiesDisabled: true });
    expect(revision(id)).toBe(5);
    // Every time a document is marked.
    navigateTo(contents, 'https://a.example/');
    expect(marker(id)).toBe(true);
    expect(revision(id)).toBe(6);
    navigateTo(contents, 'https://a.example/');
    expect(revision(id)).toBe(7);
    // Clearing the marker does not (nothing that could taint a capture happened).
    controller.tabOverrides.set(id, DEFAULT_TAB_OVERRIDES);
    expect(revision(id)).toBe(8);
    navigateTo(contents, 'https://a.example/clean');
    expect(marker(id)).toBe(false);
    expect(revision(id)).toBe(8);
    // Only the tab's own revision moves.
    expect(other).toBe(id);
    controller.newTab();
    const second = await openAt('https://b.example/');
    expect(revision(second.id)).toBe(0);
    expect(revision(id)).toBe(8);
    // A profile change is not an override change.
    controller.setRenderProfile(id, PHONE_BOT, false);
    expect(revision(id)).toBe(8);
  });

  test('override-cdp-failure-shown-without-a-profile', async () => {
    const { id } = await openAt('https://a.example/');
    expect(tabState(id).overridesStatus).toBe('active');
    // CSS off has no CDP part: nothing to apply.
    controller.tabOverrides.set(id, CSS_OFF);
    expect(tabState(id).overridesStatus).toBe('active');
    // Cookies off with no profile: applying until the debugger answers, then failed when it refuses.
    let refuse: (error: Error) => void = () => undefined;
    sendAnswer = () => new Promise<void>((_resolve, reject) => (refuse = reject));
    controller.tabOverrides.set(id, COOKIES_OFF);
    expect(tabState(id).overridesStatus).toBe('applying');
    const version = controller.getState().version;
    refuse(new Error('refused'));
    await settle();
    expect(tabState(id)).toMatchObject({ overridesStatus: 'failed', renderProfile: null });
    expect(controller.getState().version).toBeGreaterThan(version);
    expect(BrowserStateSchema.parse(controller.getState())).toEqual(controller.getState());
    // A later list that is answered puts it right; an older list's late refusal does not undo it.
    let refuseOld: (error: Error) => void = () => undefined;
    sendAnswer = () => new Promise<void>((_resolve, reject) => (refuseOld = reject));
    controller.tabOverrides.set(id, PARIS);
    sendAnswer = async () => undefined;
    controller.tabOverrides.set(id, { ...PARIS, cookiesDisabled: true });
    await settle();
    expect(tabState(id).overridesStatus).toBe('active');
    refuseOld(new Error('late'));
    await settle();
    expect(tabState(id).overridesStatus).toBe('active');
    // Back to normal: nothing to apply.
    sendAnswer = () => Promise.reject(new Error('refused'));
    controller.tabOverrides.set(id, { ...PARIS, cookiesDisabled: true, geolocation: { latitude: 1, longitude: 1, accuracy: 10 } });
    await settle();
    expect(tabState(id).overridesStatus).toBe('failed');
    controller.tabOverrides.set(id, DEFAULT_TAB_OVERRIDES);
    expect(tabState(id).overridesStatus).toBe('active');
  });
});
