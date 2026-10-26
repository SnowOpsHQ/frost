// Spec: specs/security-policy.spec.ts, specs/browse-guard.spec.ts
// Acceptance: specs/external-url.feature.md, specs/browse-guard.feature.md (App-wide)
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { app, shell, type BrowserWindow, type HandlerDetails, type Session } from 'electron';
import { APP_CSP, PINNED_NAVIGATION_EVENTS, USER_ACTIVATION_WINDOW_MS } from '@app/specs/security-policy.spec';
import { FakeBrowserWindow, FakeSession, FakeWebContents, fakeEvent } from '../../../test/electron-fake';
import { registerAppWideGuards, registerSecurity, type SecurityOptions } from '../register';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const DEV_SERVER_URL = 'http://localhost:5173';

let clock = 0;
const now = () => clock;
let ses: FakeSession;
let win: FakeBrowserWindow;

function register(window: FakeBrowserWindow, options?: SecurityOptions) {
  registerSecurity(ses as unknown as Session, window as unknown as BrowserWindow, options);
}

function setup(options: SecurityOptions = {}) {
  register(win, { now, ...options });
  return win.webContents;
}

/** A fresh app process: no app-wide guards installed yet (they live on `app`'s listeners). */
function freshApp() {
  app.removeAllListeners();
}

function openWindow(contents: FakeWebContents, url: string) {
  const details: HandlerDetails = { url, frameName: '', features: '', disposition: 'foreground-tab', referrer: { url: 'app://app/', policy: 'strict-origin-when-cross-origin' } };
  if (!contents.windowOpenHandler) throw new Error('no window-open handler registered');
  return contents.windowOpenHandler(details);
}

function userInput(contents: FakeWebContents, type: string) {
  contents.emit('input-event', fakeEvent(), { type, modifiers: [] });
}


function headersFor(url: string, responseHeaders: Record<string, string[]>) {
  const callback = vi.fn();
  ses.headersReceivedListener?.({ url, responseHeaders } as never, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0]?.[0] as { responseHeaders?: Record<string, string[]>; cancel?: boolean };
}

beforeEach(() => {
  clock = 10_000;
  ses = new FakeSession();
  win = new FakeBrowserWindow({});
  vi.mocked(shell.openExternal).mockClear();
  freshApp();
});

describe('window-open handler', () => {
  test('window-open-is-always-denied-in-app', () => {
    const contents = setup();
    userInput(contents, 'mouseDown');
    for (const url of ['https://x.com', 'app://app/other', 'vscode://x', 'javascript:1', '']) {
      expect(openWindow(contents, url)).toEqual({ action: 'deny' });
    }
  });

  test('opens-allowlisted-url-externally-on-gesture', () => {
    const contents = setup();
    userInput(contents, 'mouseDown');
    clock += 100;
    expect(openWindow(contents, 'HTTPS://x.com/a?b=1')).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    expect(shell.openExternal).toHaveBeenCalledWith('https://x.com/a?b=1');
  });

  test('does-not-open-externally-without-gesture', () => {
    const contents = setup();
    userInput(contents, 'mouseMove');
    userInput(contents, 'mouseUp');
    expect(openWindow(contents, 'https://x.com')).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('does-not-open-non-allowlisted-scheme-on-gesture', () => {
    const contents = setup();
    for (const url of ['vscode://x', 'file:///etc/passwd', 'javascript:alert(1)']) {
      userInput(contents, 'mouseDown');
      openWindow(contents, url);
    }
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('window-open-judges-chromium-normalized-url', () => {
    // Chromium hands the handler `http://evil/` for `window.open('http:evil')`; the raw-string rule
    // (`HOST_REQUIRED_EXTERNAL_SCHEMES`) never sees `http:evil` on this path.
    const contents = setup();
    userInput(contents, 'mouseDown');
    expect(openWindow(contents, 'http://evil/')).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith('http://evil/');
  });

  test('consumes-gesture-on-first-window-open', () => {
    const contents = setup();
    userInput(contents, 'keyDown');
    openWindow(contents, 'https://x.com/1');
    openWindow(contents, 'https://x.com/2');
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    expect(shell.openExternal).toHaveBeenCalledWith('https://x.com/1');
  });

  test('ignores-expired-gesture', () => {
    const contents = setup();
    userInput(contents, 'mouseDown');
    clock += USER_ACTIVATION_WINDOW_MS + 1;
    openWindow(contents, 'https://x.com');
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('permissions', () => {
  test('denies-every-permission-request', () => {
    setup();
    for (const permission of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'fullscreen', 'unknown']) {
      const callback = vi.fn();
      ses.permissionRequestHandler?.(win.webContents, permission, callback, {});
      expect(callback, permission).toHaveBeenCalledExactlyOnceWith(false);
    }
  });

  test('denies-every-permission-check', () => {
    setup();
    expect(ses.permissionCheckHandler).toBeTypeOf('function');
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-sanitized-write', 'hid', 'serial', 'usb']) {
      expect(ses.permissionCheckHandler?.(win.webContents, permission, 'app://app', {}), permission).toBe(false);
    }
  });

  test('denies-device-permissions', () => {
    setup();
    expect(ses.devicePermissionHandler).toBeTypeOf('function');
    expect(ses.devicePermissionHandler?.({ deviceType: 'usb', origin: 'app://app', device: {} } as never)).toBe(false);
  });
});

describe('navigation pinning', () => {
  test('prevents-navigation-off-app-origin', () => {
    const contents = setup();
    expect(contents.simulateNavigation('https://evil.com/')).toBe(true);
    expect(contents.simulateNavigation('file:///etc/passwd')).toBe(true);
    expect(contents.simulateNavigation('app://app/index.html')).toBe(false);
  });

  test('prevents-subframe-navigation-off-app-origin', () => {
    const contents = setup();
    const subframe = { isMainFrame: false };
    expect(contents.simulateNavigation('https://evil.com/', subframe)).toBe(true);
    expect(contents.simulateNavigation('javascript:alert(1)', subframe)).toBe(true);
    expect(contents.simulateNavigation('app://app/frame.html', subframe)).toBe(false);
  });

  test('does-not-open-external-navigation', () => {
    const contents = setup();
    userInput(contents, 'mouseDown');
    expect(contents.simulateNavigation('https://x.com/')).toBe(true);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  test('allows-dev-server-navigation-in-dev-only', () => {
    expect(setup().simulateNavigation(`${DEV_SERVER_URL}/`)).toBe(true);
    freshApp();
    win = new FakeBrowserWindow({});
    const devContents = setup({ devServerUrl: DEV_SERVER_URL });
    expect(devContents.simulateNavigation(`${DEV_SERVER_URL}/`)).toBe(false);
    expect(devContents.simulateNavigation(`${DEV_SERVER_URL}/`, { isMainFrame: false })).toBe(false);
    expect(devContents.simulateNavigation('http://localhost:5174/')).toBe(true);
  });

  test('prevents-redirect-off-app-origin', () => {
    const contents = setup();
    expect(contents.simulateRedirect('https://evil.com/')).toBe(true);
    expect(contents.simulateRedirect('https://evil.com/', { isMainFrame: false })).toBe(true);
    expect(contents.simulateRedirect('app://app/other.html')).toBe(false);
  });

  test('blocks-webview-attach', () => {
    const contents = setup();
    const event = fakeEvent();
    contents.emit('will-attach-webview', event, { nodeIntegration: false }, { src: 'https://x.com' });
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('app CSP header', () => {
  test('applies-csp-to-app-responses', () => {
    setup();
    const response = headersFor('app://app/index.html', {
      'content-type': ['text/html'],
      'content-security-policy': ['default-src *'],
      'Content-Security-Policy': ["script-src 'unsafe-inline'"],
    });
    expect(response.cancel).toBeFalsy();
    const headers = response.responseHeaders ?? {};
    const cspKeys = Object.keys(headers).filter((key) => key.toLowerCase() === 'content-security-policy');
    expect(cspKeys).toEqual(['Content-Security-Policy']);
    expect(headers['Content-Security-Policy']).toEqual([APP_CSP]);
    expect(headers['content-type']).toEqual(['text/html']);
  });

  test('leaves-non-app-responses-untouched', () => {
    setup();
    for (const url of [`${DEV_SERVER_URL}/`, 'https://x.com/', 'file:///index.html']) {
      const response = headersFor(url, { 'content-type': ['text/html'] });
      expect(response, url).toEqual({});
    }
  });
});

describe('app-wide guards', () => {
  test('guards-every-new-webcontents', () => {
    registerAppWideGuards({ now });
    const contents = new FakeWebContents();
    app.emit('web-contents-created', fakeEvent(), contents);
    expect(openWindow(contents, 'https://x.com')).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(contents.simulateNavigation('https://evil.com/')).toBe(true);
    const event = fakeEvent();
    contents.emit('will-attach-webview', event, {}, {});
    expect(event.defaultPrevented).toBe(true);
  });

  test('guards-each-webcontents-once', () => {
    registerAppWideGuards({ now });
    app.emit('web-contents-created', fakeEvent(), win.webContents);
    const contents = setup();
    for (const event of ['input-event', ...PINNED_NAVIGATION_EVENTS, 'will-attach-webview']) {
      expect(contents.listenerCount(event), event).toBe(1);
    }
    expect(contents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
  });

  test('registers-guards-through-one-path', () => {
    const options: SecurityOptions = { now, devServerUrl: DEV_SERVER_URL };
    register(win, options);
    expect(app.listenerCount('web-contents-created')).toBe(1);
    // `win` existed before the hook, so registerSecurity guards it — with the installed options.
    expect(win.webContents.simulateNavigation(`${DEV_SERVER_URL}/`)).toBe(false);
    expect(win.webContents.simulateNavigation('https://evil.com/')).toBe(true);

    // Later WebContents (created after the hook) get the same options.
    const later = new FakeBrowserWindow({});
    app.emit('web-contents-created', fakeEvent(), later.webContents);
    expect(later.webContents.simulateNavigation(`${DEV_SERVER_URL}/`)).toBe(false);

    // Omitting options reuses the installed ones; nothing is registered twice.
    register(later);
    register(win, options);
    expect(app.listenerCount('web-contents-created')).toBe(1);
    for (const contents of [win.webContents, later.webContents]) {
      expect(contents.listenerCount('will-frame-navigate')).toBe(1);
      expect(contents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    }
  });

  test('rejects-conflicting-security-options', () => {
    registerAppWideGuards({ now });
    expect(() => register(win, { now, devServerUrl: DEV_SERVER_URL })).toThrow(/conflict/i);
    expect(() => registerAppWideGuards({ now: () => 0 })).toThrow(/conflict/i);
    // Rejected before anything was applied.
    expect(ses.setPermissionRequestHandler).not.toHaveBeenCalled();
    expect(win.webContents.setWindowOpenHandler).not.toHaveBeenCalled();

    // Equal options (same fields, different object) are accepted.
    expect(() => registerAppWideGuards({ now, devServerUrl: undefined })).not.toThrow();
    expect(() => register(win, { now })).not.toThrow();
    expect(app.listenerCount('web-contents-created')).toBe(1);
    expect(win.webContents.simulateNavigation(`${DEV_SERVER_URL}/`)).toBe(true);
  });
});

describe('certificates and downloads', () => {
  test('certificate-errors-are-refused', () => {
    registerAppWideGuards({ now });
    for (const [contents, error] of [
      [new FakeWebContents(), 'net::ERR_CERT_AUTHORITY_INVALID'],
      [win.webContents, 'net::ERR_CERT_DATE_INVALID'],
      [null, 'net::ERR_CERT_COMMON_NAME_INVALID'],
    ] as const) {
      const event = fakeEvent();
      const callback = vi.fn();
      app.emit('certificate-error', event, contents, 'https://self-signed.test/', error, {}, callback, true);
      expect(event.defaultPrevented, error).toBe(true);
      expect(callback, error).toHaveBeenCalledExactlyOnceWith(false);
    }
    // Installed once with the app-wide guards.
    registerAppWideGuards({ now });
    expect(app.listenerCount('certificate-error')).toBe(1);
  });

  test('client-certificates-are-not-sent', () => {
    registerAppWideGuards({ now });
    const event = fakeEvent();
    const callback = vi.fn();
    const certificates = [{ subjectName: 'me' }, { subjectName: 'also me' }];
    app.emit('select-client-certificate', event, new FakeWebContents(), 'https://x.com/', certificates, callback);
    expect(event.defaultPrevented).toBe(true);
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    expect(app.listenerCount('select-client-certificate')).toBe(1);
  });

  test('app-session-cancels-downloads', () => {
    setup();
    register(new FakeBrowserWindow({}));
    expect(ses.listenerCount('will-download')).toBe(1);
    const event = fakeEvent();
    const item = { cancel: vi.fn() };
    ses.emit('will-download', event, item, win.webContents);
    expect(event.defaultPrevented).toBe(true);
    expect(item.cancel).toHaveBeenCalledTimes(1);
  });
});
