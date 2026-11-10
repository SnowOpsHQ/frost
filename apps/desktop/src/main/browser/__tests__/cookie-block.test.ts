// Spec: specs/render-profile.spec.ts (COOKIE_BLOCK, COOKIES_OFF_HINT, TabOverrides, DEFAULT_TAB_OVERRIDES)
// Acceptance: specs/render-profile.feature.md (Page writes: cookie block exception; Tab overrides: Cookies off, Fail-open)
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { COOKIE_BLOCK, COOKIES_OFF_HINT, DEFAULT_TAB_OVERRIDES } from '@app/specs/render-profile.spec';
import { commit, FakeHostWindow, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';
import { createCookieBlock, type CookieBlockSession } from '../cookie-block';
import type { ProfileDebugger } from '../render-profile-debugger';
import { createRenderProfilePins } from '../render-profile-pins';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

type BeforeSend = (details: Record<string, unknown>, callback: (response: Record<string, unknown>) => void) => void;
type HeadersReceived = BeforeSend;

/** A session's `webRequest` as Electron holds it: one listener per event (a new one replaces it; `null` removes it). */
class FakeBlockSession implements CookieBlockSession {
  sendHeaders: { filter: unknown; listener: BeforeSend } | null = null;
  headersReceived: { filter: unknown; listener: HeadersReceived } | null = null;
  readonly calls: string[] = [];
  readonly webRequest = {
    onBeforeSendHeaders: vi.fn((filter: unknown, listener?: unknown) => {
      this.calls.push(listener === undefined && filter === null ? 'remove-send' : listener === null ? 'remove-send' : 'send');
      this.sendHeaders = typeof listener === 'function' ? { filter, listener: listener as BeforeSend } : null;
    }),
    onHeadersReceived: vi.fn((filter: unknown, listener?: unknown) => {
      this.calls.push(listener === undefined && filter === null ? 'remove-received' : listener === null ? 'remove-received' : 'received');
      this.headersReceived = typeof listener === 'function' ? { filter, listener: listener as HeadersReceived } : null;
    }),
  } as unknown as CookieBlockSession['webRequest'];
  get registered(): boolean {
    return this.sendHeaders !== null && this.headersReceived !== null;
  }
  /** Runs a request through the session's `onBeforeSendHeaders` (or none); answers what the callback got. */
  send(details: Record<string, unknown>): Record<string, unknown> | 'no listener' {
    const pair = this.sendHeaders;
    if (!pair) return 'no listener';
    const answers: Record<string, unknown>[] = [];
    pair.listener(details, (response) => answers.push(response));
    expect(answers).toHaveLength(1);
    return answers[0]!;
  }
  receive(details: Record<string, unknown>): Record<string, unknown> | 'no listener' {
    const pair = this.headersReceived;
    if (!pair) return 'no listener';
    const answers: Record<string, unknown>[] = [];
    pair.listener(details, (response) => answers.push(response));
    expect(answers).toHaveLength(1);
    return answers[0]!;
  }
}

const URL = 'https://shop.example/cart?session=secret-value';
const request = (webContentsId: number | undefined, headers: Record<string, string> = { Cookie: 'sid=SECRET', Accept: 'text/html' }, resourceType = 'mainFrame') => ({ url: URL, resourceType, webContentsId, requestHeaders: headers });
const response = (webContentsId: number | undefined, headers: Record<string, string[]> = { 'set-cookie': ['sid=NEW; Path=/'], 'Content-Type': ['text/html'] }) => ({ url: URL, resourceType: 'mainFrame', webContentsId, responseHeaders: headers });

describe('cookie block', () => {
  let session: FakeBlockSession;
  let logs: string[];
  beforeEach(() => {
    session = new FakeBlockSession();
    logs = [];
  });

  test('strips-only-listed-tabs', () => {
    const block = createCookieBlock({ log: (line) => logs.push(line) });
    block.add(7, session);
    // The cookies-off tab: `Cookie` and `Set-Cookie` go (any letter case); every other header stays.
    expect(session.send(request(7))).toEqual({ requestHeaders: { Accept: 'text/html' } });
    expect(session.send(request(7, { cookie: 'a=1', COOKIE: 'b=2', 'X-Other': '1' }))).toEqual({ requestHeaders: { 'X-Other': '1' } });
    expect(session.receive(response(7))).toEqual({ responseHeaders: { 'Content-Type': ['text/html'] } });
    expect(session.receive(response(7, { 'Set-Cookie': ['a=1'], 'SET-COOKIE': ['b=2'] }))).toEqual({ responseHeaders: {} });
    // A header named `__proto__` stays a header beside the edit (never the object's prototype).
    const odd = JSON.parse('{"Cookie":"a=1","__proto__":"kept","Accept":"*/*"}') as Record<string, string>;
    const edited = session.send(request(7, odd)) as { requestHeaders: Record<string, string> };
    expect(Object.keys(edited.requestHeaders)).toEqual(['__proto__', 'Accept']);
    expect(Object.getOwnPropertyDescriptor(edited.requestHeaders, '__proto__')!.value).toBe('kept');
    expect(Object.getPrototypeOf(edited.requestHeaders)).toBe(Object.prototype);
    // Nothing to remove: passed through as it is.
    expect(session.send(request(7, { Accept: '*/*' }))).toEqual({});
    // Another tab, a request with no tab (a service worker's): unchanged.
    expect(session.send(request(8))).toEqual({});
    expect(session.receive(response(8))).toEqual({});
    expect(session.send(request(undefined))).toEqual({});
    expect(session.receive(response(undefined))).toEqual({});
    expect(logs).toEqual([]);
    expect(COOKIE_BLOCK.requestHeaders).toEqual(['cookie']);
    expect(COOKIE_BLOCK.responseHeaders).toEqual(['set-cookie']);
  });

  test('subframe-requests-of-the-tab-stripped', () => {
    const block = createCookieBlock();
    block.add(7, session);
    // A frame of the tab (same- or cross-site), its images and a dedicated worker carry the tab's id.
    for (const type of ['subFrame', 'image', 'xhr', 'script', 'stylesheet', 'webSocket', 'other']) {
      expect(session.send(request(7, { Cookie: 'sid=1' }, type)), type).toEqual({ requestHeaders: {} });
    }
    expect(session.receive({ ...response(7), resourceType: 'subFrame' })).toEqual({ responseHeaders: { 'Content-Type': ['text/html'] } });
  });

  test('registered-only-while-needed', () => {
    const block = createCookieBlock();
    // Nothing is registered until a tab has cookies off.
    expect(session.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
    expect(block.isRegistered(session)).toBe(false);
    block.add(7, session);
    block.add(9, session);
    // One pair per session, registered once, filtered to `COOKIE_BLOCK.urls`.
    expect(session.calls).toEqual(['send', 'received']);
    expect(session.sendHeaders!.filter).toEqual({ urls: [...COOKIE_BLOCK.urls] });
    expect(session.headersReceived!.filter).toEqual({ urls: [...COOKIE_BLOCK.urls] });
    block.add(7, session);
    expect(session.calls).toEqual(['send', 'received']);
    block.remove(7);
    expect(session.registered).toBe(true);
    expect(session.send(request(7))).toEqual({});
    block.remove(9);
    // The last one went: the pair is removed (no request waits for main any more).
    expect(session.registered).toBe(false);
    expect(session.calls).toEqual(['send', 'received', 'remove-send', 'remove-received']);
    expect(block.isRegistered(session)).toBe(false);
    // Removing an id that has nothing is a no-op.
    block.remove(42);
    expect(session.calls).toHaveLength(4);
    // A registration that throws half-way (the second listener) leaves no half pair behind.
    const broken = new FakeBlockSession();
    const logs: string[] = [];
    const failing = createCookieBlock({ log: (line) => logs.push(line) });
    (broken.webRequest.onHeadersReceived as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new TypeError('refused');
    });
    failing.add(3, broken);
    expect(broken.sendHeaders).toBeNull();
    expect(broken.headersReceived).toBeNull();
    expect(failing.isRegistered(broken)).toBe(false);
    expect(logs).toEqual(['cookie-block: the listeners could not be registered (TypeError)']);
    // It can be tried again.
    failing.add(3, broken);
    expect(broken.registered).toBe(true);
  });

  test('registers-on-the-tabs-own-session', () => {
    const block = createCookieBlock();
    const other = new FakeBlockSession();
    block.add(7, session);
    block.add(8, other);
    // Each session has its own pair, acting on its own tabs.
    expect(session.registered && other.registered).toBe(true);
    expect(session.send(request(8))).toEqual({});
    expect(other.send(request(8))).toEqual({ requestHeaders: { Accept: 'text/html' } });
    // A tab moving to another session (a new view) is removed from the first.
    block.add(7, other);
    expect(session.registered).toBe(false);
    expect(other.send(request(7))).toEqual({ requestHeaders: { Accept: 'text/html' } });
    block.remove(8);
    expect(other.registered).toBe(true);
    block.remove(7);
    expect(other.registered).toBe(false);
  });

  test('listener-always-answers', () => {
    const block = createCookieBlock({ log: (line) => logs.push(line) });
    block.add(7, session);
    // The tab lookup throws (a hostile or broken details object): answered `{}` once.
    const throwingId = { url: URL, get webContentsId(): number {
      throw new Error('lookup failed');
    }, requestHeaders: { Cookie: 'a' }, responseHeaders: { 'set-cookie': ['a'] } };
    expect(session.send(throwingId)).toEqual({});
    expect(session.receive(throwingId)).toEqual({});
    // The header edit throws: answered `{}` once.
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new TypeError('edit failed');
      },
    });
    expect(session.send({ ...request(7), requestHeaders: hostile })).toEqual({});
    expect(session.receive({ ...response(7), responseHeaders: hostile })).toEqual({});
    // A response with no headers at all: passed on.
    expect(session.receive({ url: URL, webContentsId: 7 })).toEqual({});
    expect(logs).toHaveLength(4);
  });

  test('listener-error-passes-request-unchanged-and-logs', () => {
    const block = createCookieBlock({ log: (line) => logs.push(line) });
    block.add(7, session);
    const headers = { Cookie: 'sid=SECRET-COOKIE', Accept: 'text/html' };
    const failing = { url: URL, requestHeaders: headers, get webContentsId(): number {
      const error = new Error(`boom ${URL} sid=SECRET-COOKIE`) as Error & { code: string };
      error.code = 'E_LOOKUP';
      throw error;
    } };
    let answered: unknown;
    // Nothing propagates out of the listener; the request goes on unchanged.
    expect(() => session.sendHeaders!.listener(failing, (r) => (answered = r))).not.toThrow();
    expect(answered).toEqual({});
    expect(headers).toEqual({ Cookie: 'sid=SECRET-COOKIE', Accept: 'text/html' });
    // One line: the listener and the error's code (or name), never the URL, a header or the message.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('onBeforeSendHeaders');
    expect(logs[0]).toContain('E_LOOKUP');
    for (const secret of ['shop.example', 'SECRET', 'boom', 'session=']) expect(logs[0]).not.toContain(secret);
    session.headersReceived!.listener({ url: URL, get webContentsId(): number {
      throw new RangeError('x');
    } }, (r) => (answered = r));
    expect(answered).toEqual({});
    expect(logs[1]).toContain('onHeadersReceived');
    expect(logs[1]).toContain('RangeError');
    // The hint says what fail-open means for the user.
    expect(COOKIES_OFF_HINT).toContain('that request is sent as normal');
    expect(COOKIES_OFF_HINT).toContain('Slightly slows loading in all tabs while on');
    expect(COOKIES_OFF_HINT).toContain('service-worker requests keep their cookies');
    // Said honestly (security review): no allowlisted CDP method reaches the Cookie Store API.
    expect(COOKIES_OFF_HINT).toContain('The page’s script can still read and write cookies through the Cookie Store API');
  });
});

describe('cookie block in the browser', () => {
  let views: FakeTabView[];
  let controller: BrowserController;
  let browse: FakeBlockSession;
  let defaultSession: FakeBlockSession;
  let nextId: number;

  const quietDebugger = (): ProfileDebugger => ({ send: async () => undefined, sendTopLevel: async () => undefined, detach: () => undefined, isAttached: () => true, dispose: () => undefined });

  beforeEach(() => {
    views = [];
    nextId = 100;
    browse = new FakeBlockSession();
    defaultSession = new FakeBlockSession();
    controller = createBrowserController({
      createView: () => {
        const view = new FakeTabView();
        // A tab's WebContents: its own id, on the browse session.
        Object.assign(view.contents, { id: nextId++, session: browse });
        views.push(view);
        return view as unknown as TabView;
      },
      platform: 'linux',
      renderProfiles: { pins: createRenderProfilePins(), chromeVersion: '140.0.0.0', debuggerFor: () => quietDebugger() },
      tabOverrides: { cookieBlock: createCookieBlock() },
    });
    controller.attach(new FakeHostWindow() as unknown as HostWindow);
  });

  async function openAt(url: string): Promise<{ id: number; webContentsId: number }> {
    controller.navigate(url);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const contents = views.at(-1)!.contents;
    contents.emit('did-start-navigation', fakeEvent({ url, isMainFrame: true, isSameDocument: false }));
    commit(contents, url, 'Page');
    return { id: controller.getState().activeTabId!, webContentsId: (contents as unknown as { id: number }).id };
  }

  test('removed-on-tab-close-and-switch-off', async () => {
    const first = await openAt('https://a.example/');
    controller.newTab();
    const second = await openAt('https://b.example/');
    expect(browse.registered).toBe(false);
    expect(controller.tabOverrides.set(first.id, { ...DEFAULT_TAB_OVERRIDES, cookiesDisabled: true })).toBe(true);
    expect(controller.tabOverrides.set(second.id, { ...DEFAULT_TAB_OVERRIDES, cookiesDisabled: true })).toBe(true);
    expect(browse.registered).toBe(true);
    expect(browse.send(request(first.webContentsId))).toEqual({ requestHeaders: { Accept: 'text/html' } });
    // Switched off on one tab: that tab's cookies go out again; the pair stays for the other.
    controller.tabOverrides.set(first.id, DEFAULT_TAB_OVERRIDES);
    expect(browse.send(request(first.webContentsId))).toEqual({});
    expect(browse.registered).toBe(true);
    // The last cookies-off tab closes: the pair is removed.
    controller.closeTab(second.id);
    expect(browse.registered).toBe(false);
    expect(browse.calls.filter((c) => c.startsWith('remove'))).toEqual(['remove-send', 'remove-received']);
  });

  test('other-tabs-and-default-session-untouched', async () => {
    const first = await openAt('https://a.example/');
    controller.newTab();
    const second = await openAt('https://b.example/');
    controller.tabOverrides.set(first.id, { ...DEFAULT_TAB_OVERRIDES, cookiesDisabled: true });
    // The other tab's requests and responses pass unchanged (answered at once).
    expect(browse.send(request(second.webContentsId))).toEqual({});
    expect(browse.receive(response(second.webContentsId))).toEqual({});
    // Nothing on the app's own (default) session, and no other override changed the other tab.
    expect(defaultSession.calls).toEqual([]);
    expect(controller.getState().tabs.find((t) => t.id === second.id)!.tabOverrides).toEqual(DEFAULT_TAB_OVERRIDES);
    // A tab opened from the cookies-off tab does not inherit the switch.
    const popup = controller.openTabFromPage(views[0]!.contents, 'https://c.example/')!;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(controller.getState().tabs.find((t) => t.id === popup)!.tabOverrides).toEqual(DEFAULT_TAB_OVERRIDES);
    const popupContents = views.at(-1)!.contents as unknown as { id: number };
    expect(browse.send(request(popupContents.id))).toEqual({});
  });
});
