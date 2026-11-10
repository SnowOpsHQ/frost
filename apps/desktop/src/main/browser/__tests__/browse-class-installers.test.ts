// Spec: specs/browser.spec.ts (BROWSE_PARTITION, BROWSE_CLASS_PARTITIONS)
// Acceptance: specs/browser-chrome.feature.md (Session classification: every-browse-installer-runs-per-session)
import { session, type Session } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { fakeEvent } from '../../../test/electron-fake';
import { browseClassSessions, onBrowseClassSession, registerBrowseClassSession } from '../browse-class';
import { browseSessionInstaller } from '../browse-session-wiring';
import { REQUEST_FILTER } from '../web-request';
import { RichSession, richPartition, WEB_REQUEST_EVENTS } from './browse-class-fakes';

vi.mock('electron', async () => (await import('./browse-class-fakes')).richElectron());

const OBSERVED = ['onBeforeRedirect', 'onResponseStarted', 'onErrorOccurred', 'onSendHeaders', 'onCompleted'] as const;
const BLOCKING = ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived'] as const;

describe('browse-class installers', () => {
  test('every-browse-installer-runs-per-session', () => {
    expect([...OBSERVED, ...BLOCKING].sort()).toEqual([...WEB_REQUEST_EVENTS].sort());
    const browse = session.fromPartition(BROWSE_PARTITION) as unknown as RichSession;
    const mainFrames = { responded: vi.fn(), redirected: vi.fn(), failed: vi.fn() };
    const requests = { responded: vi.fn(), sent: vi.fn(), completed: vi.fn() };
    const onDownloadBlocked = vi.fn();
    const permissions = { request: vi.fn(), check: vi.fn(() => false) };
    // Main's browse-session wiring, as index.ts adds it: one installer.
    const wiring = vi.fn(browseSessionInstaller({ mainFrames, requests, hooks: { onDownloadBlocked, permissions } }));
    onBrowseClassSession(wiring);
    // It ran once, on the browse session, when added.
    expect(wiring).toHaveBeenCalledExactlyOnceWith(browse);

    const second = richPartition('persist:frost-test-second');
    expect(second.setPermissionRequestHandler).not.toHaveBeenCalled();
    registerBrowseClassSession(second as unknown as Session);
    registerBrowseClassSession(second as unknown as Session);
    expect(wiring.mock.calls.map(([s]) => s)).toEqual([browse, second]);

    for (const s of [browse, second]) {
      // Request observers: each event has its one (wide) listener; the widening re-registers the
      // three main-frame ones once, and adds the other two once.
      for (const event of OBSERVED) {
        expect(s.has(event), `${s.label} ${event}`).toBe(true);
        expect(s.requestListeners.get(event)!.filter, `${s.label} ${event}`).toEqual(REQUEST_FILTER);
      }
      expect(OBSERVED.map((event) => s.registrations(event))).toEqual([2, 2, 2, 1, 1]);
      // No blocking listener.
      for (const event of BLOCKING) expect(s.registrations(event), `${s.label} ${event}`).toBe(0);
      // Guard and permission handlers, set once.
      expect(s.setPermissionRequestHandler).toHaveBeenCalledOnce();
      expect(s.setPermissionCheckHandler).toHaveBeenCalledOnce();
      expect(s.setDevicePermissionHandler).toHaveBeenCalledOnce();
      expect(s.protocol.handle).toHaveBeenCalledExactlyOnceWith('file', expect.any(Function));
      // Downloads: one listener.
      expect(s.listenerCount('will-download')).toBe(1);
    }

    // The second session's wiring reaches the same observers and hooks.
    const response = { url: 'https://b.example/', resourceType: 'mainFrame', webContentsId: 12, statusCode: 200 };
    second.fire('onResponseStarted', response);
    expect(mainFrames.responded).toHaveBeenCalledExactlyOnceWith(response);
    expect(requests.responded).toHaveBeenCalledExactlyOnceWith(response);
    const sub = { url: 'https://b.example/x.js', resourceType: 'script', webContentsId: 12 };
    second.fire('onSendHeaders', sub);
    expect(requests.sent).toHaveBeenCalledExactlyOnceWith(sub);
    const requestHandler = second.setPermissionRequestHandler.mock.calls[0]![0] as (...args: unknown[]) => void;
    const callback = vi.fn();
    requestHandler({ id: 12 }, 'geolocation', callback, { requestingUrl: 'https://b.example/' });
    expect(permissions.request).toHaveBeenCalledExactlyOnceWith({ id: 12 }, 'geolocation', callback, { requestingUrl: 'https://b.example/' });
    expect(second.setDevicePermissionHandler.mock.calls[0]![0]({ deviceType: 'usb' })).toBe(false);
    const item = { cancel: vi.fn() };
    const event = fakeEvent();
    const contents = { id: 12 };
    second.emit('will-download', event, item, contents);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(onDownloadBlocked).toHaveBeenCalledExactlyOnceWith(contents);

    // An installer added later runs at once on every browse-class session, once.
    const late = vi.fn();
    onBrowseClassSession(late);
    expect(late.mock.calls.map(([s]) => s)).toEqual([browse, second]);
    // A third session gets both, once each; nothing runs again on the first two.
    const third = richPartition('persist:frost-test-third');
    registerBrowseClassSession(third as unknown as Session);
    expect(wiring.mock.calls.map(([s]) => s)).toEqual([browse, second, third]);
    expect(late.mock.calls.map(([s]) => s)).toEqual([browse, second, third]);
    expect(browseClassSessions()).toEqual([browse, second, third]);
    // The app's own session is never wired.
    const appSession = session.defaultSession as unknown as RichSession;
    expect(appSession.setPermissionRequestHandler).not.toHaveBeenCalled();
    expect(appSession.listenerCount('will-download')).toBe(0);
    expect(WEB_REQUEST_EVENTS.map((e) => appSession.registrations(e))).toEqual(WEB_REQUEST_EVENTS.map(() => 0));
  });
});
