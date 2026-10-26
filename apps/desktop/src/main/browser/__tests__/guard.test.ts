// Spec: specs/browser.spec.ts (BROWSE_PARTITION, BROWSABLE_SCHEMES, BROWSE_BLANK_URL)
// Acceptance: specs/browser-chrome.feature.md (Session-classified guard)
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { app, session, shell, type HandlerDetails, type Session } from 'electron';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { FakeSession, FakeWebContents, fakeEvent } from '../../../test/electron-fake';
import { registerAppWideGuards } from '../../security/register';
import { hardenBrowseSession } from '../guard';

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
const NON_WEB_URLS = ['file:///etc/passwd', 'app://app/', 'javascript:alert(1)', 'data:text/html,x', 'chrome://gpu', 'mailto:a@b.c'];

beforeEach(() => {
  app.removeAllListeners();
  vi.mocked(shell.openExternal).mockClear();
  registerAppWideGuards({ now: () => 0 });
});

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
    const contents = created(browseSession());
    contents.emit('input-event', fakeEvent(), { type: 'mouseDown', modifiers: [] });
    for (const url of [...WEB_URLS, ...NON_WEB_URLS]) expect(openWindow(contents, url), url).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
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
