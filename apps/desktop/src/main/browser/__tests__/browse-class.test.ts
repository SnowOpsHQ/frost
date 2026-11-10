// Spec: specs/browser.spec.ts (BROWSE_PARTITION, BROWSE_CLASS_PARTITIONS, TAB_VIEW_WEB_PREFERENCES)
// Acceptance: specs/browser-chrome.feature.md (Session classification: the browse-class registry;
// Session-classified guard), specs/window-hardening.feature.md (Tab views on any browse-class partition)
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { app, session, type Session } from 'electron';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { BROWSE_CLASS_PARTITIONS, BROWSE_PARTITION, TAB_VIEW_WEB_PREFERENCES } from '@app/specs/browser.spec';
import { CLEAR_SITE_DATA } from '@app/specs/devtools.spec';
import { DEFAULT_TAB_OVERRIDES } from '@app/specs/render-profile.spec';
import { commit, FakeHostWindow, FakeTabView } from '../../../test/controller-fakes';
import { FakeWebContents, fakeEvent, type FakeSession, type FakeWebContentsView } from '../../../test/electron-fake';
import { clearBrowseStorage } from '../../clear-browsing-data';
import { tabSiteData } from '../../devtools/site-data';
import { createSiteStorage } from '../../devtools/storage';
import { registerAppWideGuards } from '../../security/register';
import { createTabView } from '../../window';
import { browseClassSessionOf, browseClassSessions, createBrowseClassRegistry, isBrowseClassContents, isBrowseClassSession, markAppSession, registerBrowseClassSession } from '../browse-class';
import { createBrowserController, type HostWindow, type TabView } from '../controller';
import { createCookieBlock } from '../cookie-block';
import { createProfileDebugger, type DebuggerHost } from '../render-profile-debugger';
import { createRenderProfilePins } from '../render-profile-pins';
import { RichSession, richPartition } from './browse-class-fakes';

vi.mock('electron', async () => (await import('./browse-class-fakes')).richElectron());

const asSession = (s: unknown): Session => s as Session;
const browse = (): RichSession => session.fromPartition(BROWSE_PARTITION) as unknown as RichSession;
/** A partition registered as browse-class (Task 10b's location partitions will be such). */
const registered = (partition: string): RichSession => {
  const s = richPartition(partition);
  registerBrowseClassSession(asSession(s));
  return s;
};

/** A WebContents created after the app-wide guard is installed (classified at its creation). */
const created = (s: unknown): FakeWebContents => {
  const contents = new FakeWebContents({}, s as FakeSession);
  app.emit('web-contents-created', fakeEvent(), contents);
  return contents;
};

describe('browse-class registry', () => {
  beforeAll(() => registerAppWideGuards({ now: () => 10_000 }));

  test('registry-membership', () => {
    const fixedSession = new RichSession('browse');
    const fixed = vi.fn(() => [asSession(fixedSession)]);
    const registry = createBrowseClassRegistry({ fixed });
    expect(registry.isBrowseClassSession(fixedSession)).toBe(true);
    // Fail closed: anything else is app content.
    for (const other of [new RichSession('app'), null, undefined, {}, BROWSE_PARTITION, 0]) expect(registry.isBrowseClassSession(other)).toBe(false);
    // A registered session is browse-class from its registration on; registering again is a no-op.
    const second = new RichSession('second');
    expect(registry.isBrowseClassSession(second)).toBe(false);
    registry.registerBrowseClassSession(asSession(second));
    registry.registerBrowseClassSession(asSession(second));
    registry.registerBrowseClassSession(asSession(fixedSession));
    expect(registry.isBrowseClassSession(second)).toBe(true);
    expect(registry.browseClassSessions()).toEqual([fixedSession, second]);
    // Before the app is ready the partition lookup throws: nothing fixed is browse-class (fail closed).
    const early = createBrowseClassRegistry({
      fixed: () => {
        throw new Error('not ready');
      },
    });
    expect(early.isBrowseClassSession(fixedSession)).toBe(false);
    // Main's registry: the browse partition's session (BROWSE_CLASS_PARTITIONS), first.
    expect(BROWSE_CLASS_PARTITIONS).toEqual([BROWSE_PARTITION]);
    expect(isBrowseClassSession(browse())).toBe(true);
    expect(isBrowseClassSession(session.defaultSession)).toBe(false);
    expect(isBrowseClassSession(richPartition('persist:frost-app'))).toBe(false);
    expect(browseClassSessions()[0]).toBe(browse());
    // A WebContents' session, read fail-closed.
    expect(browseClassSessionOf({ session: browse() })).toBe(browse());
    expect(isBrowseClassContents({ session: session.defaultSession })).toBe(false);
    const throwing = {
      get session(): never {
        throw new Error('destroyed');
      },
    };
    expect(isBrowseClassContents(throwing)).toBe(false);
    expect(browseClassSessionOf(null)).toBeNull();
  });

  test('browse-class-installer-failure-fails-closed', () => {
    const fixedSession = new RichSession('browse');
    const registry = createBrowseClassRegistry({ fixed: () => [asSession(fixedSession)] });
    const second = new RichSession('second');
    let failing = true;
    const first = vi.fn();
    const flaky = vi.fn((s: Session) => {
      if (failing && (s as unknown) === second) throw new Error('installer failed');
    });
    const last = vi.fn();
    registry.onBrowseClassSession(first);
    registry.onBrowseClassSession(flaky);
    registry.onBrowseClassSession(last);
    expect(() => registry.registerBrowseClassSession(asSession(second))).toThrow('installer failed');
    // Left out of the class: its WebContents keep the app pin.
    expect(registry.isBrowseClassSession(second)).toBe(false);
    expect(registry.browseClassSessions()).toEqual([fixedSession]);
    expect(last).not.toHaveBeenCalledWith(second);
    // Registering again runs only the installers that had not run on it.
    failing = false;
    registry.registerBrowseClassSession(asSession(second));
    expect(registry.isBrowseClassSession(second)).toBe(true);
    expect(first.mock.calls.filter(([s]) => (s as unknown) === second)).toHaveLength(1);
    expect(flaky.mock.calls.filter(([s]) => (s as unknown) === second)).toHaveLength(2);
    expect(last.mock.calls.filter(([s]) => (s as unknown) === second)).toHaveLength(1);
    // The same installer added twice runs once per session.
    registry.onBrowseClassSession(first);
    expect(first).toHaveBeenCalledTimes(2);

    // An installer that throws on a member is not kept: a session registered after gets nothing of
    // it; adding it again runs it only where it has not run.
    const other = new RichSession('other');
    const members = createBrowseClassRegistry({ fixed: () => [asSession(fixedSession), asSession(other)] });
    let broken = true;
    const partial = vi.fn((s: Session) => {
      if (broken && (s as unknown) === other) throw new Error('second member failed');
    });
    expect(() => members.onBrowseClassSession(partial)).toThrow('second member failed');
    const third = new RichSession('third');
    members.registerBrowseClassSession(asSession(third));
    expect(partial.mock.calls.map(([s]) => s)).toEqual([fixedSession, other]);
    broken = false;
    members.onBrowseClassSession(partial);
    expect(partial.mock.calls.map(([s]) => s)).toEqual([fixedSession, other, other, third]);
  });

  test('registry-refuses-app-sessions', () => {
    // Main's registry: the default session is never browse-class.
    expect(() => registerBrowseClassSession(asSession(session.defaultSession))).toThrow('app session');
    expect(isBrowseClassSession(session.defaultSession)).toBe(false);
    // A session marked as an app session (registerSecurity marks the app windows') is refused too.
    const appWindows = richPartition('persist:frost-test-app-windows');
    markAppSession(asSession(appWindows));
    expect(() => registerBrowseClassSession(asSession(appWindows))).toThrow('app session');
    expect(isBrowseClassSession(appWindows)).toBe(false);
    // A browse-class session can never be marked as an app session.
    expect(() => markAppSession(asSession(browse()))).toThrow();
    // Not a session at all.
    expect(() => registerBrowseClassSession(null as unknown as Session)).toThrow('not a session');
    // The factory: `isAppSession`, failing closed when it throws (then only a mark refuses).
    const app = new RichSession('app');
    const registry = createBrowseClassRegistry({ fixed: () => [], isAppSession: (s) => (s as unknown) === app });
    const installer = vi.fn();
    registry.onBrowseClassSession(installer);
    expect(() => registry.registerBrowseClassSession(asSession(app))).toThrow('app session');
    expect(installer).not.toHaveBeenCalled();
  });

  test('classified-at-creation', () => {
    const late = richPartition('persist:frost-test-late');
    // A tab created on a partition before it is registered: app content, for life.
    const early = created(late);
    expect(early.simulateNavigation('https://example.com/')).toBe(true);
    registerBrowseClassSession(asSession(late));
    expect(isBrowseClassSession(late)).toBe(true);
    expect(isBrowseClassContents(early)).toBe(false);
    expect(browseClassSessionOf(early)).toBeNull();
    expect(early.simulateNavigation('https://example.com/')).toBe(true);
    const dbg = Object.assign(new EventEmitter(), { attach: vi.fn(), detach: vi.fn(), isAttached: vi.fn(() => false), sendCommand: vi.fn(async () => ({})) });
    expect(() => createProfileDebugger(early as unknown as DebuggerHost, vi.fn())).toThrow('browse-session tabs only');
    expect(() => createProfileDebugger({ debugger: dbg as unknown as DebuggerHost['debugger'], session: early.session as unknown as DebuggerHost['session'], isDestroyed: () => false }, vi.fn())).not.toThrow();
    // A tab created on it after the registration is a tab.
    const later = created(late);
    expect(isBrowseClassContents(later)).toBe(true);
    expect(later.simulateNavigation('https://example.com/')).toBe(false);
    // The factory records the first answer per WebContents.
    const second = new RichSession('second');
    const registry = createBrowseClassRegistry({ fixed: () => [] });
    const contents = { session: second };
    expect(registry.browseClassSessionOf(contents)).toBeNull();
    registry.registerBrowseClassSession(asSession(second));
    expect(registry.browseClassSessionOf(contents)).toBeNull();
    expect(registry.browseClassSessionOf({ session: second })).toBe(second);
  });

  test('tab-classified-by-the-registry', () => {
    // Browse-class contents get the browse guard (a web navigation is allowed) ...
    for (const s of [browse(), registered('persist:frost-test-guard')]) expect(created(s).simulateNavigation('https://example.com/')).toBe(false);
    // ... everything else keeps the app pin (the navigation is prevented).
    for (const s of [session.defaultSession, richPartition('persist:frost-test-unregistered'), undefined]) expect(created(s).simulateNavigation('https://example.com/')).toBe(true);
  });

  test('render-profile-debugger-accepts-browse-class', () => {
    const host = (s: unknown): { host: DebuggerHost; attach: ReturnType<typeof vi.fn> } => {
      const attach = vi.fn();
      const dbg = Object.assign(new EventEmitter(), { attach, detach: vi.fn(), isAttached: vi.fn(() => false), sendCommand: vi.fn(async () => ({})) });
      return { host: { debugger: dbg as unknown as DebuggerHost['debugger'], session: s as DebuggerHost['session'], isDestroyed: () => false }, attach };
    };
    for (const s of [browse(), registered('persist:frost-test-profiles')]) expect(() => createProfileDebugger(host(s).host, vi.fn())).not.toThrow();
    for (const s of [session.defaultSession, richPartition('persist:frost-test-unregistered'), {}, null]) {
      const { host: h, attach } = host(s);
      expect(() => createProfileDebugger(h, vi.fn())).toThrow('browse-session tabs only');
      expect(attach).not.toHaveBeenCalled();
    }
  });

  test('devtools-storage-uses-the-tabs-session', async () => {
    const second = registered('persist:frost-test-devtools');
    const stranger = richPartition('persist:frost-test-stranger');
    const tabs = new Map<number, { session: unknown }>([
      [11, { session: browse() }],
      [12, { session: second }],
      [13, { session: stranger }],
    ]);
    const log = vi.fn();
    const storage = createSiteStorage({ ...tabSiteData((contentsId) => tabs.get(contentsId)), confirmClear: async () => true, log });
    const PAGE = 'https://shop.example/cart';
    // The second session's tab reads its own cookie store, never the browse partition's.
    expect(await storage.storage(12, PAGE)).toMatchObject({ status: 'ready', cookies: [{ name: 'persist:frost-test-devtools-cookie' }] });
    expect(second.cookies.get).toHaveBeenCalledExactlyOnceWith({ url: PAGE });
    expect(browse().cookies.get).not.toHaveBeenCalled();
    expect(await storage.clearSiteData(12, PAGE)).toBe('cleared');
    expect(second.clearData).toHaveBeenCalledExactlyOnceWith({ origins: ['https://shop.example'], dataTypes: [...CLEAR_SITE_DATA.dataTypes] });
    expect(browse().clearData).not.toHaveBeenCalled();
    // The browse tab reads the browse session.
    expect(await storage.storage(11, PAGE)).toMatchObject({ cookies: [{ name: `${BROWSE_PARTITION}-cookie` }] });
    // A WebContents on a session that is not browse-class, or none: no cookies read, nothing cleared.
    for (const id of [13, 99]) {
      expect(await storage.storage(id, PAGE)).toMatchObject({ status: 'ready', cookies: [] });
      await storage.clearSiteData(id, PAGE);
    }
    expect(stranger.cookies.get).not.toHaveBeenCalled();
    expect(stranger.clearData).not.toHaveBeenCalled();
    expect(session.defaultSession.cookies.get).not.toHaveBeenCalled();
  });

  test('devtools-clear-keyed-by-session-and-origin', async () => {
    const second = registered('persist:frost-test-devtools-key');
    const tabs = new Map<number, { session: unknown }>([
      [21, { session: browse() }],
      [22, { session: second }],
      [23, { session: browse() }],
    ]);
    let answer: (yes: boolean) => void = () => undefined;
    const confirmClear = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const storage = createSiteStorage({ ...tabSiteData((contentsId) => tabs.get(contentsId)), confirmClear, log: vi.fn() });
    const PAGE = 'https://key.example/a';
    const first = storage.clearSiteData(21, PAGE);
    // The same origin on another session: its own clear, so busy (never "cleared" for a session not cleared).
    expect(await storage.clearSiteData(22, PAGE)).toBe('busy');
    // Another tab of the same session and origin shares the answer.
    const same = storage.clearSiteData(23, 'https://key.example/b');
    expect(confirmClear).toHaveBeenCalledOnce();
    answer(true);
    expect(await first).toBe('cleared');
    expect(await same).toBe('cleared');
    expect(browse().clearData).toHaveBeenCalledWith({ origins: ['https://key.example'], dataTypes: [...CLEAR_SITE_DATA.dataTypes] });
    expect(second.clearData).not.toHaveBeenCalled();
    // Clearing throws: `failed`, never `cleared`.
    second.clearData.mockRejectedValueOnce(new Error('disk'));
    const failing = storage.clearSiteData(22, PAGE);
    answer(true);
    expect(await failing).toBe('failed');
    // A tab whose session is not browse-class: confirmed, nothing cleared, `failed`.
    tabs.set(24, { session: richPartition('persist:frost-test-devtools-key-stranger') });
    const stranger = storage.clearSiteData(24, PAGE);
    answer(true);
    expect(await stranger).toBe('failed');
  });

  test('cookie-block-per-browse-class-session', async () => {
    const home = browse();
    const second = registered('persist:frost-test-cookies');
    const stranger = richPartition('persist:frost-test-cookies-stranger');
    const views: FakeTabView[] = [];
    let nextId = 100;
    let nextSession: RichSession = home;
    const controller = createBrowserController({
      createView: () => {
        const view = new FakeTabView();
        Object.assign(view.contents, { id: nextId++, session: nextSession });
        views.push(view);
        return view as unknown as TabView;
      },
      platform: 'linux',
      renderProfiles: {
        pins: createRenderProfilePins(),
        chromeVersion: '140.0.0.0',
        debuggerFor: () => ({ send: async () => undefined, sendTopLevel: async () => undefined, detach: () => undefined, isAttached: () => true, dispose: () => undefined }),
      },
      // As main wires it (index.ts).
      tabOverrides: { cookieBlock: createCookieBlock({ isBrowseClass: isBrowseClassSession }) },
    });
    controller.attach(new FakeHostWindow() as unknown as HostWindow);
    const openOn = async (s: RichSession, url: string): Promise<{ id: number; contentsId: number }> => {
      if (views.length > 0) controller.newTab();
      nextSession = s;
      controller.navigate(url);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const contents = views.at(-1)!.contents;
      contents.emit('did-start-navigation', fakeEvent({ url, isMainFrame: true, isSameDocument: false }));
      commit(contents, url, 'Page');
      return { id: controller.getState().activeTabId!, contentsId: (contents as unknown as { id: number }).id };
    };
    const off = (tabId: number): boolean => controller.tabOverrides.set(tabId, { ...DEFAULT_TAB_OVERRIDES, cookiesDisabled: true });
    const pairOn = (s: RichSession): boolean => s.has('onBeforeSendHeaders') && s.has('onHeadersReceived');
    const registrations = (s: RichSession): number[] => [s.registrations('onBeforeSendHeaders'), s.registrations('onHeadersReceived')];
    const request = (webContentsId: number) => ({ url: 'https://a.example/', resourceType: 'mainFrame', webContentsId, requestHeaders: { Cookie: 'sid=1', Accept: '*/*' } });

    const a = await openOn(home, 'https://a.example/');
    const b = await openOn(second, 'https://b.example/');
    const c = await openOn(second, 'https://c.example/');
    const d = await openOn(stranger, 'https://d.example/');
    expect(off(a.id)).toBe(true);
    expect(pairOn(home)).toBe(true);
    expect(pairOn(second)).toBe(false);
    // A tab of the second session turns cookies off: that session gets its own pair.
    off(b.id);
    expect(pairOn(second)).toBe(true);
    expect(second.fire('onBeforeSendHeaders', request(b.contentsId))).toEqual({ requestHeaders: { Accept: '*/*' } });
    expect(second.fire('onBeforeSendHeaders', request(c.contentsId))).toEqual({});
    off(c.id);
    // One blocking listener per event per session.
    expect(registrations(second)).toEqual([1, 1]);
    expect(registrations(home)).toEqual([1, 1]);
    // It goes with the session's last cookies-off tab (one turned back on, the other closed) ...
    controller.tabOverrides.set(b.id, DEFAULT_TAB_OVERRIDES);
    expect(pairOn(second)).toBe(true);
    controller.closeTab(c.id);
    expect(pairOn(second)).toBe(false);
    // ... and the browse session's pair is unaffected throughout.
    expect(pairOn(home)).toBe(true);
    expect(registrations(home)).toEqual([1, 1]);
    expect(home.webRequest.onBeforeSendHeaders.mock.calls.some((args: unknown[]) => args[0] === null)).toBe(false);
    expect(home.fire('onBeforeSendHeaders', request(a.contentsId))).toEqual({ requestHeaders: { Accept: '*/*' } });
    // A session that is not browse-class never gets a blocking listener, and the tab says so: its
    // overrides are `failed` (the chip's "not applied"), never a silent "cookies off".
    const status = (tabId: number) => controller.getState().tabs.find((t) => t.id === tabId)!.overridesStatus;
    expect(status(a.id)).not.toBe('failed');
    off(d.id);
    expect(registrations(stranger)).toEqual([0, 0]);
    expect(registrations(session.defaultSession as unknown as RichSession)).toEqual([0, 0]);
    expect(status(d.id)).toBe('failed');
    expect(controller.getState().tabs.find((t) => t.id === d.id)!.tabOverrides.cookiesDisabled).toBe(true);
    // Cookies back on: nothing to apply, nothing failed.
    controller.tabOverrides.set(d.id, DEFAULT_TAB_OVERRIDES);
    expect(status(d.id)).toBe('active');
  });

  test('cookie-block-refusal-is-reported', () => {
    const logs: string[] = [];
    const ok = richPartition('persist:frost-test-block-ok');
    const block = createCookieBlock({ isBrowseClass: (s) => (s as unknown) === ok, log: (line) => logs.push(line) });
    expect(block.add(1, ok as never)).toBe(true);
    expect(block.add(1, ok as never)).toBe(true);
    expect(block.add(2, richPartition('persist:frost-test-block-no') as never)).toBe(false);
    expect(logs).toEqual(['cookie-block: not a browse-class session; the tab keeps its cookies']);
    // The pair could not be registered: refused too (and nothing half-registered is left).
    const broken = richPartition('persist:frost-test-block-broken');
    broken.webRequest.onHeadersReceived.mockImplementationOnce(() => {
      throw new Error('gone');
    });
    expect(createCookieBlock().add(3, broken as never)).toBe(false);
    expect(broken.has('onBeforeSendHeaders') || broken.has('onHeadersReceived')).toBe(false);
  });

  test('clear-browse-storage-covers-every-browse-class-session', async () => {
    const second = registered('persist:frost-test-clear');
    const stranger = richPartition('persist:frost-test-clear-stranger');
    await clearBrowseStorage();
    const members = browseClassSessions() as unknown as RichSession[];
    expect(members).toContain(browse());
    expect(members).toContain(second);
    for (const s of members) {
      expect(s.clearStorageData, s.label).toHaveBeenCalledOnce();
      expect(s.clearCache, s.label).toHaveBeenCalledOnce();
      expect(s.clearStorageData.mock.invocationCallOrder[0]!).toBeLessThan(s.clearCache.mock.invocationCallOrder[0]!);
    }
    const app = session.defaultSession as unknown as RichSession;
    for (const s of [app, stranger]) {
      expect(s.clearStorageData).not.toHaveBeenCalled();
      expect(s.clearCache).not.toHaveBeenCalled();
    }
  });

  test('tab-view-hardened-on-any-partition', () => {
    const prefs = (view: unknown): Record<string, unknown> => ({ ...(view as FakeWebContentsView).options.webPreferences });
    expect(prefs(createTabView())).toEqual(TAB_VIEW_WEB_PREFERENCES);
    const other = prefs(createTabView('persist:frost-test-view'));
    expect(other).toEqual({ ...TAB_VIEW_WEB_PREFERENCES, partition: 'persist:frost-test-view' });
    expect(Object.hasOwn(other, 'preload')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// browse-class-registry-is-the-only-test
//
// A source scan of apps/desktop/src/main/** (tests excluded), in three layers, so a hidden "is
// this the browse session?" check cannot hide behind one pattern:
// 1. Nothing can look the browse session up without naming its partition. So the names
//    `BROWSE_PARTITION` / `BROWSE_CLASS_PARTITIONS` (and the partition string itself, or any string or
//    template holding both `frost-` and `browser`) appear only in the registry, `window.ts`
//    (createTabView's default) and `index.ts` (the fetcher setup); no file imports browser.spec as a
//    namespace or dynamically. Only the registry and `location/**` (Task 10b) may register a session
//    (`registerBrowseClassSession`), and only the registry makes a registry.
// 2. In `index.ts` the one `fromPartition(BROWSE_PARTITION)` is bound to one name, used only as the
//    bounded fetchers' session (`netHop(net, …)`, `netResolver(…)`, `….getUserAgent()`). `window.ts`
//    never looks a session up.
// 3. No identity test on a session outside the registry: no `===` / `!==` / `==` / `!=` or
//    `Object.is` whose operand is a `…session` / `…Session` / `ses` name or a `fromPartition(…)` call
//    (but against null, undefined or a boolean), no `.has` / `.includes` / `.indexOf` / `.get` /
//    `.find` / `.some` keyed by one, and no picking one member out of `browseClassSessions()` (an
//    index, `.at`, `.find`, destructuring), except the listed per-session bookkeeping (each exception
//    must still exist, so the list cannot rot).
// ---------------------------------------------------------------------------------------------

const MAIN = path.resolve(import.meta.dirname, '../..');

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...sourcesUnder(full));
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const REGISTRY = 'browser/browse-class.ts';
/** Files that may name the browse partition, and why. */
const MAY_NAME_THE_PARTITION: Readonly<Record<string, string>> = {
  [REGISTRY]: 'the registry: its fixed members',
  'window.ts': "createTabView's default partition",
  'index.ts': "the bounded fetchers' session (Decision 11)",
};
/** Per-session bookkeeping keyed by a session (a map or set of sessions), never a class check. */
const SESSION_KEYED_EXCEPTIONS: readonly { readonly file: string; readonly code: string; readonly why: string }[] = [
  { file: 'browser/cookie-block.ts', code: 'current === session', why: 'a tab already on this session (no class check)' },
  { file: 'browser/cookie-block.ts', code: 'tabsOf.get(session)', why: 'the cookies-off tabs of each session' },
  { file: 'browser/cookie-block.ts', code: 'tabsOf.has(session)', why: 'whether this session has its pair' },
  { file: 'browser/web-request.ts', code: 'hubs.get(session)', why: "each session's one observer hub" },
  { file: 'security/register.ts', code: 'downloadsRefused.has(session)', why: "the app session's download refusal, added once" },
  // Phase 12 Task 10b: which location profile a proxy `login` came from (the answer's partition check; no class check).
  { file: 'location/partitions.ts', code: 'entry.session === candidate', why: "the location profile whose partition a login's session is" },
  { file: 'location/sessions.ts', code: 'marks.has(session)', why: 'a location partition marked once (its permission context; no class check)' },
  { file: 'location/sessions.ts', code: 'marks.get(session)', why: "a location partition's permission context (no class check)" },
];

const SESSIONISH = /(?:^|[.?])(?:\w*session|\w*Session|ses)$/;
const COMPARISON = /(===|!==|==|!=)/g;
const LITERAL = /^(?:null|undefined|true|false)$/;

function comparisonsOnSessions(code: string): string[] {
  const found: string[] = [];
  for (const line of code.split('\n')) {
    for (const match of line.matchAll(COMPARISON)) {
      const at = match.index;
      const before = line.slice(0, at).trimEnd();
      const after = line.slice(at + match[0].length).trimStart();
      const left = /([\w$.?]+(?:\([^()]*\))?)$/.exec(before)?.[1] ?? '';
      const right = /^([\w$.?]+(?:\([^()]*\))?)/.exec(after)?.[1] ?? '';
      if (/\btypeof\s+[\w$.?]+$/.test(before)) continue;
      const sessionish = (operand: string): boolean => SESSIONISH.test(operand) || /fromPartition\(/.test(operand) || /fromPartition\([^()]*\)$/.test(before);
      if (!sessionish(left) && !sessionish(right)) continue;
      if (LITERAL.test(left) || LITERAL.test(right)) continue;
      found.push(`${left} ${match[0]} ${right}`.trim());
    }
  }
  return found;
}

/** `Object.is(a, b)` with a session operand (but against null, undefined or a boolean). */
function objectIsOnSessions(code: string): string[] {
  return [...code.matchAll(/Object\.is\(\s*([^,()]+(?:\([^()]*\))?)\s*,\s*([^,()]+(?:\([^()]*\))?)\s*\)/g)]
    .filter((m) => {
      const [a, b] = [m[1]!.trim(), m[2]!.trim()];
      const sessionish = (operand: string): boolean => SESSIONISH.test(operand) || /fromPartition\(/.test(operand);
      return (sessionish(a) || sessionish(b)) && !LITERAL.test(a) && !LITERAL.test(b);
    })
    .map((m) => m[0]);
}

/** One member picked out of `browseClassSessions()`: "the browse session" by position or search. */
function membersPicked(code: string): string[] {
  return [
    ...[...code.matchAll(/browseClassSessions\(\)\s*(?:\?\.)?(?:\[|\.at\(|\.find\(|\.findIndex\(|\.indexOf\(|\.includes\(|\.filter\(|\.shift\(|\.pop\()/g)].map((m) => m[0]),
    ...[...code.matchAll(/\[[^\]=]*\]\s*=\s*browseClassSessions\(\)/g)].map((m) => m[0]),
  ];
}

/** Every string or template literal that holds both `frost-` and `browser` (any spelling of the partition). */
function partitionSpellings(code: string): string[] {
  return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]).filter((literal) => /frost-/.test(literal) && /browser/i.test(literal));
}

function lookupsBySession(code: string): string[] {
  return [...code.matchAll(/([\w$]*)\.(?:has|includes|indexOf|lastIndexOf|get|find|some)\(\s*([\w$.?]+)\s*\)/g)]
    .filter((m) => SESSIONISH.test(m[2]!))
    .map((m) => m[0].replace(/\s+/g, ''));
}

describe('browse-class registry is the only test', () => {
  const files = sourcesUnder(MAIN).map((file) => ({ rel: path.relative(MAIN, file).split(path.sep).join('/'), code: readFileSync(file, 'utf8') }));

  test('browse-class-registry-is-the-only-test', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.rel === REGISTRY)).toBe(true);
    const problems: string[] = [];
    expect(partitionSpellings(`const p = '${BROWSE_PARTITION}';`)).toHaveLength(1);
    for (const { rel, code } of files) {
      // Layer 1: naming the partition, registering a session.
      if (!(rel in MAY_NAME_THE_PARTITION) && /\bBROWSE_(?:CLASS_)?PARTITIONS?\b/.test(code)) problems.push(`${rel}: names the browse partition`);
      for (const literal of partitionSpellings(code)) problems.push(`${rel}: spells the browse partition: ${literal.slice(0, 60)}`);
      if (rel !== REGISTRY && !rel.startsWith('location/') && /\bregisterBrowseClassSession\b/.test(code)) problems.push(`${rel}: registers a browse-class session (only location/** may)`);
      if (rel !== REGISTRY && /\bcreateBrowseClassRegistry\b/.test(code)) problems.push(`${rel}: makes a second registry`);
      if (/import\s*\*\s*as\s+[\w$]+\s+from\s*['"]@app\/specs\/browser\.spec['"]/.test(code)) problems.push(`${rel}: namespace import of browser.spec`);
      if (/(?:import|require)\(\s*['"]@app\/specs\/browser\.spec['"]\s*\)/.test(code)) problems.push(`${rel}: dynamic import of browser.spec`);
      if (rel !== REGISTRY && /\bBROWSE_CLASS_PARTITIONS\b/.test(code)) problems.push(`${rel}: names BROWSE_CLASS_PARTITIONS`);
      // Layer 3: identity tests on a session.
      if (rel === REGISTRY) continue;
      const allowed = SESSION_KEYED_EXCEPTIONS.filter((e) => e.file === rel).map((e) => e.code.replace(/\s+/g, ''));
      for (const hit of membersPicked(code)) problems.push(`${rel}: picks one browse-class session: ${hit}`);
      for (const hit of [...comparisonsOnSessions(code), ...objectIsOnSessions(code), ...lookupsBySession(code)]) {
        if (!allowed.includes(hit.replace(/\s+/g, ''))) problems.push(`${rel}: compares or looks up a session: ${hit}`);
      }
    }
    // Every exception still exists (the list cannot rot).
    for (const exception of SESSION_KEYED_EXCEPTIONS) {
      const file = files.find((f) => f.rel === exception.file);
      if (!file || !file.code.includes(exception.code)) problems.push(`stale exception: ${exception.file}: ${exception.code}`);
    }
    // Layer 2: index.ts looks the browse partition up once, for the fetchers only; window.ts never.
    const index = files.find((f) => f.rel === 'index.ts')!.code;
    const lookups = [...index.matchAll(/fromPartition\(\s*BROWSE_PARTITION\s*\)/g)];
    if (lookups.length !== 1) problems.push(`index.ts: ${lookups.length} browse partition lookups (expected 1, the fetchers')`);
    const bound = /const\s+([\w$]+)\s*=\s*session\.fromPartition\(\s*BROWSE_PARTITION\s*\);/.exec(index);
    if (!bound) problems.push('index.ts: the fetchers\' session is not bound to one name');
    else {
      const name = bound[1]!;
      const rest = index
        .replace(bound[0], '')
        .replace(new RegExp(`netHop\\(\\s*net\\s*,\\s*${name}\\s*\\)`, 'g'), '')
        .replace(new RegExp(`netResolver\\(\\s*${name}\\s*\\)`, 'g'), '')
        .replace(new RegExp(`\\b${name}\\.getUserAgent\\(\\)`, 'g'), '');
      if (new RegExp(`\\b${name}\\b`).test(rest)) problems.push(`index.ts: the fetchers' session (${name}) is used beyond netHop / netResolver / getUserAgent`);
    }
    const indexOther = index.replace(/import\s*\{[^}]*\}\s*from\s*'@app\/specs\/browser\.spec';/, '').replace(/fromPartition\(\s*BROWSE_PARTITION\s*\)/, '');
    if (/\bBROWSE_PARTITION\b/.test(indexOther)) problems.push('index.ts: names BROWSE_PARTITION beyond the fetchers\' lookup');
    const windowTs = files.find((f) => f.rel === 'window.ts')!.code;
    if (/fromPartition/.test(windowTs)) problems.push('window.ts: looks a session up');
    expect(problems).toEqual([]);
  });

  test('the scan catches what it is for', () => {
    // The patterns themselves, on known violations (so a broken regex cannot pass vacuously).
    expect(comparisonsOnSessions('return contents.session === session.fromPartition(BROWSE_PARTITION);')).toHaveLength(1);
    expect(comparisonsOnSessions('if (ses !== browse) return;')).toHaveLength(1);
    expect(comparisonsOnSessions('if (browseSession == other) x();')).toHaveLength(1);
    expect(comparisonsOnSessions('const same = fromPartition(P) === s;')).toHaveLength(1);
    expect(comparisonsOnSessions('if (session === null) return;')).toEqual([]);
    expect(comparisonsOnSessions("if (typeof contents.session === 'object') x();")).toEqual([]);
    expect(lookupsBySession('if (browseSessions.has(contents.session)) x();')).toEqual(['browseSessions.has(contents.session)']);
    expect(lookupsBySession('[a].includes(webContents.session)')).toEqual(['.includes(webContents.session)']);
    expect(lookupsBySession('known.includes(webContents.session)')).toEqual(['known.includes(webContents.session)']);
    expect(objectIsOnSessions('if (Object.is(contents.session, browse)) x();')).toHaveLength(1);
    expect(objectIsOnSessions('Object.is(other, session.fromPartition(P))')).toHaveLength(1);
    expect(objectIsOnSessions('Object.is(contents.session, null)')).toEqual([]);
    expect(objectIsOnSessions('Object.is(a, b)')).toEqual([]);
    for (const picked of ['browseClassSessions()[0]', 'browseClassSessions().at(0)', 'browseClassSessions().find((s) => s)', 'const [home] = browseClassSessions();']) expect(membersPicked(picked), picked).toHaveLength(1);
    expect(membersPicked('for (const s of browseClassSessions()) clear(s);')).toEqual([]);
    for (const spelled of ["'persist:' + 'frost-browser'", '`persist:frost-${"browser"}`', '"persist:frost-Browser"', '`frost-${kind}-browser`']) expect(partitionSpellings(spelled).length, spelled).toBeGreaterThan(0);
    expect(partitionSpellings("'frost-app' + 'web browser'")).toEqual([]);
  });
});
