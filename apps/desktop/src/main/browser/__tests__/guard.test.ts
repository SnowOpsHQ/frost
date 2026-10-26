// Spec: specs/browser.spec.ts (BROWSE_PARTITION, BROWSABLE_SCHEMES, BROWSE_BLANK_URL),
// specs/browse-guard.spec.ts (SUBFRAME_ONLY_URLS), specs/security-policy.spec.ts (USER_ACTIVATION_WINDOW_MS)
// Acceptance: specs/browser-chrome.feature.md (Session-classified guard), specs/browse-guard.feature.md
// (Decisions, Wiring)
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { app, session, shell, type HandlerDetails, type Session, type WebContents } from 'electron';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { SUBFRAME_ONLY_URLS } from '@app/specs/browse-guard.spec';
import { USER_ACTIVATION_WINDOW_MS } from '@app/specs/security-policy.spec';
import { FakeSession, FakeWebContents, fakeEvent } from '../../../test/electron-fake';
import { registerAppWideGuards } from '../../security/register';
import { hardenBrowseSession, isAllowedBrowseNavigation, judgeBrowseNavigation, judgeBrowsePopup } from '../guard';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const browseSession = () => session.fromPartition(BROWSE_PARTITION) as unknown as FakeSession;

/** A WebContents created after the app-wide guard is installed (it fires `web-contents-created`). */
function created(ses: FakeSession | undefined): FakeWebContents {
  const contents = new FakeWebContents({}, ses);
  app.emit('web-contents-created', fakeEvent(), contents);
  return contents;
}

function openWindow(contents: FakeWebContents, url: string) {
  const details: HandlerDetails = { url, frameName: '', features: '', disposition: 'foreground-tab', referrer: { url: '', policy: 'strict-origin-when-cross-origin' } };
  if (!contents.windowOpenHandler) throw new Error('no window-open handler registered');
  return contents.windowOpenHandler(details);
}

const WEB_URLS = ['https://example.com/', 'http://127.0.0.1:8080/x', 'about:blank'];
// Schemes never opened externally (mailto: is, on a gesture: browse-guard.feature.md).
const NON_WEB_URLS = ['file:///etc/passwd', 'app://app/', 'javascript:alert(1)', 'data:text/html,x', 'chrome://gpu', 'vscode://x'];

let clock = 0;
/** The injected `openTab` hook (the controller opens a background tab). */
const openTab = vi.fn<(opener: WebContents, url: string) => void>();

beforeEach(() => {
  clock = 10_000;
  app.removeAllListeners();
  vi.mocked(shell.openExternal).mockClear();
  openTab.mockClear();
  registerAppWideGuards({ now: () => clock, browse: { openTab } });
});

function activate(contents: FakeWebContents, type = 'mouseDown') {
  contents.emit('input-event', fakeEvent(), { type, modifiers: [] });
}

describe('session-classified guard', () => {
  test('browse-contents-get-browse-guard', () => {
    const contents = created(browseSession());
    for (const url of WEB_URLS) {
      expect(contents.simulateNavigation(url), url).toBe(false);
      expect(contents.simulateNavigation(url, { isMainFrame: false }), url).toBe(false);
      expect(contents.simulateRedirect(url), url).toBe(false);
    }
  });

  test('browse-guard-drops-non-web-navigation', () => {
    const contents = created(browseSession());
    contents.emit('input-event', fakeEvent(), { type: 'mouseDown', modifiers: [] });
    for (const url of NON_WEB_URLS) {
      expect(contents.simulateNavigation(url), url).toBe(true);
      expect(contents.simulateNavigation(url, { isMainFrame: false }), url).toBe(true);
      expect(contents.simulateRedirect(url), url).toBe(true);
      expect(contents.simulateRedirect(url, { isMainFrame: false }), url).toBe(true);
    }
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('browse-guard-denies-window-open', () => {
    // Without an activation input (gesture-backed opens: browse-guard.feature.md).
    const contents = created(browseSession());
    for (const url of [...WEB_URLS, ...NON_WEB_URLS, 'mailto:a@b.c']) expect(openWindow(contents, url), url).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
  });

  test('browse-guard-refuses-webview', () => {
    const contents = created(browseSession());
    const event = fakeEvent();
    contents.emit('will-attach-webview', event, {}, { src: 'https://example.com/' });
    expect(event.defaultPrevented).toBe(true);
  });

  test('other-sessions-keep-app-pin', () => {
    const throwingSession = new FakeWebContents();
    Object.defineProperty(throwingSession, 'session', {
      get() {
        throw new Error('destroyed');
      },
    });
    app.emit('web-contents-created', fakeEvent(), throwingSession);
    const others = [
      created(session.defaultSession as unknown as FakeSession),
      created(session.fromPartition('persist:other') as unknown as FakeSession),
      created(undefined),
      throwingSession,
    ];
    for (const [i, contents] of others.entries()) {
      expect(contents.simulateNavigation('https://example.com/'), String(i)).toBe(true);
      expect(contents.simulateRedirect('https://example.com/'), String(i)).toBe(true);
      expect(contents.simulateNavigation('app://app/index.html'), String(i)).toBe(false);
    }
  });

  test('browse-session-denies-permissions', () => {
    const ses = browseSession();
    hardenBrowseSession(ses as unknown as Session);
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'fullscreen', 'openExternal']) {
      const callback = vi.fn();
      ses.permissionRequestHandler?.({}, permission, callback, {});
      expect(callback, permission).toHaveBeenCalledExactlyOnceWith(false);
      expect(ses.permissionCheckHandler?.({}, permission, 'https://example.com', {}), permission).toBe(false);
    }
    expect(ses.devicePermissionHandler?.({ deviceType: 'usb', origin: 'https://example.com', device: {} } as never)).toBe(false);
  });
});

describe('decisions', () => {
  const both = [{ isMainFrame: true }, { isMainFrame: false }];

  test('browse-navigation-allows-web-and-blank', () => {
    for (const frame of both) {
      for (const url of ['https://example.com/', 'HTTP://127.0.0.1:8080/x', 'HtTpS://example.com/a?b#c', 'about:blank', 'about:blank#x', 'about:blank?x']) {
        expect(isAllowedBrowseNavigation(url, frame), `${url} ${frame.isMainFrame}`).toBe(true);
      }
    }
    for (const url of SUBFRAME_ONLY_URLS) {
      expect(isAllowedBrowseNavigation(url, { isMainFrame: false }), url).toBe(true);
      expect(isAllowedBrowseNavigation(url, { isMainFrame: true }), url).toBe(false);
    }
  });

  test('browse-navigation-denies-non-web-schemes', () => {
    const denied = [
      'file:///etc/passwd',
      'FILE://x/y',
      'app://app/',
      'chrome://gpu',
      'devtools://devtools/bundled/inspector.html',
      'javascript:alert(1)',
      'data:text/html,<p>x',
      'blob:https://example.com/0b1c',
      'filesystem:https://example.com/temporary/x',
      'mailto:a@b.c',
      'vscode://x',
      'frost-test:x',
      'about:config',
      'about:blanket',
      '',
      'not a url',
      '//example.com/',
    ];
    for (const frame of both) {
      for (const url of denied) expect(isAllowedBrowseNavigation(url, frame), `${url} ${frame.isMainFrame}`).toBe(false);
    }
  });

  test('data-urls-denied-in-subframes', () => {
    for (const url of ['data:text/html,<p>x', 'data:image/png;base64,iVBORw0KGgo=', 'data:,x', 'DATA:text/plain,x']) {
      for (const frame of both) expect(isAllowedBrowseNavigation(url, frame), `${url} ${frame.isMainFrame}`).toBe(false);
    }
  });

  test('judge-navigation-routes-non-web-to-external', () => {
    const gesture = vi.fn(() => true);
    const ctx = (over: { isMainFrame?: boolean; isRedirect?: boolean; userGesture?: () => boolean } = {}) => ({
      isMainFrame: true,
      isRedirect: false,
      userGesture: gesture,
      ...over,
    });
    expect(judgeBrowseNavigation('https://example.com/', ctx())).toBe('allow');
    expect(judgeBrowseNavigation('about:blank', ctx({ isRedirect: true }))).toBe('allow');
    expect(gesture).not.toHaveBeenCalled();

    expect(judgeBrowseNavigation('mailto:a@b.c', ctx())).toBe('open-externally');
    expect(judgeBrowseNavigation('mailto:a@b.c', ctx({ isMainFrame: false }))).toBe('open-externally');
    expect(gesture).toHaveBeenCalledTimes(2);
    expect(judgeBrowseNavigation('mailto:a@b.c', ctx({ userGesture: () => false }))).toBe('drop');
    for (const url of ['vscode://x', 'file:///etc/passwd', 'app://app/', 'mailto:a@b.c?attach=/etc/passwd', 'javascript:1']) {
      expect(judgeBrowseNavigation(url, ctx()), url).toBe('drop');
    }

    gesture.mockClear();
    expect(judgeBrowseNavigation('mailto:a@b.c', ctx({ isRedirect: true }))).toBe('drop');
    expect(judgeBrowseNavigation('app://app/', ctx({ isRedirect: true }))).toBe('drop');
    expect(gesture).not.toHaveBeenCalled();
  });

  test('judge-popup', () => {
    for (const url of ['https://example.com/', 'http://127.0.0.1/x', 'mailto:a@b.c', 'about:blank', 'vscode://x']) {
      expect(judgeBrowsePopup(url, false), url).toBe('drop');
    }
    expect(judgeBrowsePopup('https://example.com/', true)).toBe('tab');
    expect(judgeBrowsePopup('HTTP://127.0.0.1:9/x', true)).toBe('tab');
    expect(judgeBrowsePopup('mailto:a@b.c?subject=hi', true)).toBe('open-externally');
    for (const url of ['about:blank', 'file:///etc/passwd', 'vscode://x', 'javascript:1', 'app://app/', 'data:text/html,x', 'mailto:a@b.c?attach=x']) {
      expect(judgeBrowsePopup(url, true), url).toBe('drop');
    }
  });
});

describe('browse guard', () => {
  const REVIEW_FOCUS_URLS = ['file:///etc/passwd', 'app://app/', 'chrome://gpu', 'javascript:alert(document.domain)', 'data:text/html,<script>alert(1)</script>'];

  test('page-cannot-navigate-to-non-web-scheme', () => {
    const contents = created(browseSession());
    for (const url of REVIEW_FOCUS_URLS) {
      activate(contents);
      expect(contents.simulateNavigation(url), url).toBe(true);
    }
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('subframe-and-redirect-pinned', () => {
    const contents = created(browseSession());
    for (const url of [...REVIEW_FOCUS_URLS, 'data:image/png;base64,x', 'blob:https://example.com/x']) {
      activate(contents);
      expect(contents.simulateNavigation(url, { isMainFrame: false }), url).toBe(true);
      expect(contents.simulateRedirect(url), url).toBe(true);
      expect(contents.simulateRedirect(url, { isMainFrame: false }), url).toBe(true);
    }
    for (const url of WEB_URLS) {
      expect(contents.simulateNavigation(url, { isMainFrame: false }), url).toBe(false);
      expect(contents.simulateRedirect(url, { isMainFrame: false }), url).toBe(false);
    }
    expect(contents.simulateNavigation('about:srcdoc', { isMainFrame: false })).toBe(false);
    expect(contents.simulateNavigation('about:srcdoc')).toBe(true);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('external-scheme-on-gesture-opens-externally', () => {
    const contents = created(browseSession());
    activate(contents);
    clock += 100;
    expect(contents.simulateNavigation('MAILTO:a@b.c?subject=hi')).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith('mailto:a@b.c?subject=hi');
    // The gesture is consumed.
    expect(contents.simulateNavigation('mailto:x@y.z')).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    // A fresh activation backs a subframe's open as well (per-WebContents attribution).
    activate(contents, 'keyDown');
    expect(contents.simulateNavigation('mailto:x@y.z', { isMainFrame: false })).toBe(true);
    expect(shell.openExternal).toHaveBeenLastCalledWith('mailto:x@y.z');
  });

  test('external-scheme-without-gesture-is-dropped', () => {
    const contents = created(browseSession());
    activate(contents, 'mouseMove');
    activate(contents, 'mouseUp');
    expect(contents.simulateNavigation('mailto:a@b.c')).toBe(true);
    activate(contents);
    clock += USER_ACTIVATION_WINDOW_MS + 1;
    expect(contents.simulateNavigation('mailto:a@b.c')).toBe(true);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('never-forwards-non-allowlisted-schemes', () => {
    const contents = created(browseSession());
    for (const url of ['file:///etc/passwd', 'app://app/', 'vscode://file/etc/passwd', 'frost-test:x', 'mailto:a@b.c?attach=/etc/passwd', 'ms-settings:x']) {
      activate(contents);
      expect(contents.simulateNavigation(url), url).toBe(true);
      activate(contents);
      expect(openWindow(contents, url), url).toEqual({ action: 'deny' });
    }
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
  });

  test('redirect-never-opens-externally', () => {
    const contents = created(browseSession());
    activate(contents);
    expect(contents.simulateRedirect('mailto:a@b.c')).toBe(true);
    expect(contents.simulateRedirect('mailto:a@b.c', { isMainFrame: false })).toBe(true);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('popup-with-gesture-opens-background-tab', () => {
    const contents = created(browseSession());
    activate(contents);
    expect(openWindow(contents, 'https://example.com/popup')).toEqual({ action: 'deny' });
    expect(openTab).toHaveBeenCalledExactlyOnceWith(contents, 'https://example.com/popup');
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('popup-without-gesture-is-blocked', () => {
    const contents = created(browseSession());
    for (const url of ['https://example.com/', 'http://127.0.0.1/x', 'mailto:a@b.c']) {
      expect(openWindow(contents, url), url).toEqual({ action: 'deny' });
      activate(contents, 'mouseMove');
      expect(openWindow(contents, url), url).toEqual({ action: 'deny' });
    }
    expect(openTab).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('popup-external-scheme-on-gesture', () => {
    const contents = created(browseSession());
    activate(contents);
    expect(openWindow(contents, 'mailto:a@b.c')).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith('mailto:a@b.c');
    expect(openTab).not.toHaveBeenCalled();
  });

  test('popup-consumes-gesture', () => {
    const contents = created(browseSession());
    activate(contents);
    openWindow(contents, 'https://example.com/1');
    openWindow(contents, 'https://example.com/2');
    openWindow(contents, 'mailto:a@b.c');
    expect(openTab).toHaveBeenCalledExactlyOnceWith(contents, 'https://example.com/1');
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('gesture-ends-with-navigation', () => {
    const contents = created(browseSession());
    // A real click navigated the tab (here: the landing page of a redirect chain committed).
    activate(contents);
    contents.emit('did-navigate', fakeEvent(), 'https://landing.test/', 200, 'OK');
    expect(openWindow(contents, 'https://landing.test/popup')).toEqual({ action: 'deny' });
    activate(contents);
    contents.emit('did-navigate', fakeEvent(), 'https://landing.test/', 200, 'OK');
    expect(contents.simulateNavigation('mailto:a@b.c')).toBe(true);
    expect(openTab).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();

    // A same-document navigation (hash, pushState) keeps it.
    activate(contents);
    contents.emit('did-navigate-in-page', fakeEvent(), 'https://landing.test/#x', true, 1, 1);
    openWindow(contents, 'https://landing.test/popup');
    expect(openTab).toHaveBeenCalledExactlyOnceWith(contents, 'https://landing.test/popup');
  });

  test('webview-stays-refused', () => {
    const contents = created(browseSession());
    activate(contents);
    for (const webPreferences of [{}, { nodeIntegration: true }, { preload: '/tmp/x.js', contextIsolation: false }]) {
      const event = fakeEvent();
      contents.emit('will-attach-webview', event, webPreferences, { src: 'https://example.com/' });
      expect(event.defaultPrevented).toBe(true);
    }
  });

  test('browse-session-cancels-downloads', () => {
    const ses = new FakeSession();
    const onDownloadBlocked = vi.fn();
    hardenBrowseSession(ses as unknown as Session, { onDownloadBlocked });
    const tab = new FakeWebContents();
    for (const url of ['https://example.com/file.zip', 'blob:https://example.com/x']) {
      const event = fakeEvent();
      const item = { cancel: vi.fn(), getURL: () => url };
      ses.emit('will-download', event, item, tab);
      expect(event.defaultPrevented, url).toBe(true);
      expect(item.cancel, url).toHaveBeenCalledTimes(1);
    }
    expect(onDownloadBlocked).toHaveBeenCalledTimes(2);
    expect(onDownloadBlocked).toHaveBeenLastCalledWith(tab);
  });
});
