// Spec: specs/location-profiles.spec.ts (LOCATION_PARTITION_PREFIX, locationPartition, proxyRulesFor), specs/browser.spec.ts
// (BROWSE_PARTITION, BROWSE_CLASS_PARTITIONS), specs/render-profile.spec.ts (COOKIE_BLOCK)
// Acceptance: specs/location-profiles.feature.md (location-session-is-browse-class, location-session-has-browse-wiring,
// location-partition-is-in-memory, clear-browsing-data-covers-location-partitions, cookie-block-on-a-location-tab)
// · plan docs/plans/phase-12-big-bets.md, Decision 11, Task 10b
import { session, type Session } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { DATA_API_PARTITION } from '@app/specs/data-sources.spec';
import { LOCATION_PARTITION_PREFIX, locationPartition } from '@app/specs/location-profiles.spec';
import { browseClassSessions, isBrowseClassSession, onBrowseClassSession } from '../../browser/browse-class';
import { browseSessionInstaller } from '../../browser/browse-session-wiring';
import { createCookieBlock } from '../../browser/cookie-block';
import { clearBrowseStorage } from '../../clear-browsing-data';
import type { RichSession } from '../../browser/__tests__/browse-class-fakes';
import { createLocationPartitions } from '../partitions';
import { locationContextOf } from '../sessions';

vi.mock('electron', async () => (await import('../../browser/__tests__/browse-class-fakes')).richElectron());

// The registry is the module's own (one per test file): each test uses profiles of its own.
let n = 0;
const fresh = (): string => `01920000-0000-7000-8000-${(0xc00 + (n += 1)).toString(16).padStart(12, '0')}`;
const PROXY = { scheme: 'http', host: 'proxy.example.net', port: 3128 } as const;

/** The partition's session, with `setProxy` (and `closeAllConnections`) recorded in order with the registration. */
function locationSession(profileId: string, order: string[]): RichSession & { setProxy: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> } {
  const s = session.fromPartition(locationPartition(profileId)) as unknown as RichSession & { setProxy?: ReturnType<typeof vi.fn>; closeAllConnections?: ReturnType<typeof vi.fn> };
  s.setProxy ??= vi.fn(async (config: unknown) => {
    // Resolves later: the registration must wait for it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`setProxy ${JSON.stringify(config)}`);
  });
  s.closeAllConnections ??= vi.fn(async () => {});
  return s as RichSession & { setProxy: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> };
}

describe('location partitions', () => {
  test('location-partition-is-in-memory', async () => {
    const PROFILE = fresh();
    expect(LOCATION_PARTITION_PREFIX.startsWith('persist:')).toBe(false);
    expect(locationPartition(PROFILE)).toBe(`frost-location-${PROFILE}`);
    expect(() => locationPartition('../persist:x')).toThrow();
    const order: string[] = [];
    locationSession(PROFILE, order);
    const partitions = createLocationPartitions();
    await partitions.ensure(PROFILE, PROXY);
    const asked = vi.mocked(session.fromPartition).mock.calls.map(([name]) => name);
    expect(asked).toContain(`frost-location-${PROFILE}`);
    expect(asked.some((name) => name.startsWith('persist:frost-location'))).toBe(false);
  });

  test('location-session-is-browse-class', async () => {
    const [PROFILE, OTHER] = [fresh(), fresh()];
    const before = browseClassSessions();
    const order: string[] = [];
    const target = locationSession(PROFILE, order);
    // Not browse-class before its first use.
    expect(isBrowseClassSession(target)).toBe(false);
    const partitions = createLocationPartitions();
    const wiring = vi.fn(() => order.push('installer'));
    onBrowseClassSession(wiring);
    // It ran at once on the sessions already in the class; from here on, only the new one counts.
    order.length = 0;
    wiring.mockClear();
    const prepared = await partitions.ensure(PROFILE, PROXY);
    expect(prepared).toBe(target);
    expect(isBrowseClassSession(target)).toBe(true);
    // The proxy was set and resolved before the session joined the class (its installers ran after).
    expect(order).toEqual([`setProxy ${JSON.stringify({ mode: 'fixed_servers', proxyRules: 'http://proxy.example.net:3128' })}`, 'installer']);
    // Again: no second proxy call, no second registration.
    await partitions.ensure(PROFILE, PROXY);
    expect(target.setProxy).toHaveBeenCalledOnce();
    expect(wiring).toHaveBeenCalledOnce();
    // App partitions stay app-class.
    expect(isBrowseClassSession(session.defaultSession)).toBe(false);
    expect(isBrowseClassSession(session.fromPartition(DATA_API_PARTITION))).toBe(false);
    expect(browseClassSessions()).toEqual([...before, target]);
    expect(before[0]).toBe(session.fromPartition(BROWSE_PARTITION));
    // A proxy that fails: no registration, and the tab may not open.
    const failing = locationSession(OTHER, order);
    failing.setProxy.mockRejectedValueOnce(new Error('bad rules'));
    await expect(partitions.ensure(OTHER, PROXY)).rejects.toThrow();
    expect(isBrowseClassSession(failing)).toBe(false);
  });

  test('location-session-has-browse-wiring', async () => {
    const PROFILE = fresh();
    const order: string[] = [];
    const target = locationSession(PROFILE, order);
    const mainFrames = { responded: vi.fn(), redirected: vi.fn(), failed: vi.fn() };
    const requests = { responded: vi.fn(), sent: vi.fn(), completed: vi.fn() };
    const permissions = { request: vi.fn(), check: vi.fn(() => false) };
    const wiring = vi.fn(browseSessionInstaller({ mainFrames, requests, hooks: { onDownloadBlocked: vi.fn(), permissions } }));
    onBrowseClassSession(wiring);
    await createLocationPartitions().ensure(PROFILE, PROXY);
    expect(wiring).toHaveBeenCalledWith(target);
    expect(target.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(target.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(target.setDevicePermissionHandler).toHaveBeenCalledOnce();
    expect(target.protocol.handle).toHaveBeenCalledExactlyOnceWith('file', expect.any(Function));
    expect(target.listenerCount('will-download')).toBe(1);
    for (const event of ['onBeforeRedirect', 'onResponseStarted', 'onErrorOccurred', 'onSendHeaders', 'onCompleted'] as const) expect(target.has(event), event).toBe(true);
    const response = { url: 'https://site.example/', resourceType: 'mainFrame', webContentsId: 31, statusCode: 200 };
    target.fire('onResponseStarted', response);
    expect(mainFrames.responded).toHaveBeenCalledWith(response);
  });

  test('clear-browsing-data-covers-location-partitions', async () => {
    const PROFILE = fresh();
    const order: string[] = [];
    const target = locationSession(PROFILE, order);
    await createLocationPartitions().ensure(PROFILE, PROXY);
    const browse = session.fromPartition(BROWSE_PARTITION) as unknown as RichSession;
    await clearBrowseStorage();
    for (const s of [browse, target]) {
      expect(s.clearStorageData, s.label).toHaveBeenCalledOnce();
      expect(s.clearCache, s.label).toHaveBeenCalledOnce();
    }
    // An app session is never cleared there.
    expect((session.defaultSession as unknown as RichSession).clearStorageData).not.toHaveBeenCalled();
  });

  test('cookie-block-on-a-location-tab', async () => {
    const PROFILE = fresh();
    const order: string[] = [];
    const target = locationSession(PROFILE, order);
    const block = createCookieBlock({ isBrowseClass: isBrowseClassSession });
    // Before the partition is prepared it is not a tab's session: refused (fail-open, reported failed).
    expect(block.add(41, target as unknown as Session)).toBe(false);
    await createLocationPartitions().ensure(PROFILE, PROXY);
    expect(block.add(41, target as unknown as Session)).toBe(true);
    expect(block.isRegistered(target as unknown as Session)).toBe(true);
    const sent = target.fire('onBeforeSendHeaders', { webContentsId: 41, url: 'https://site.example/', requestHeaders: { Cookie: 'a=1', Accept: '*/*' } });
    expect(sent).toEqual({ requestHeaders: { Accept: '*/*' } });
    const received = target.fire('onHeadersReceived', { webContentsId: 41, url: 'https://site.example/', responseHeaders: { 'Set-Cookie': ['b=2'], 'Content-Type': ['text/html'] } });
    expect(received).toEqual({ responseHeaders: { 'Content-Type': ['text/html'] } });
    // Another tab of the same profile keeps its cookies; the browse session is untouched.
    expect(target.fire('onBeforeSendHeaders', { webContentsId: 42, url: 'https://site.example/', requestHeaders: { Cookie: 'a=1' } })).toEqual({});
    expect(block.isRegistered(session.fromPartition(BROWSE_PARTITION) as unknown as Session)).toBe(false);
    block.remove(41);
    expect(block.isRegistered(target as unknown as Session)).toBe(false);
  });

  test('location-partition-reset-and-retire', async () => {
    const PROFILE = fresh();
    const order: string[] = [];
    const target = locationSession(PROFILE, order);
    const partitions = createLocationPartitions();
    await partitions.ensure(PROFILE, PROXY);
    expect(partitions.proxyOf(target)).toEqual({ profileId: PROFILE, host: 'proxy.example.net', port: 3128 });
    expect(partitions.proxyOf(session.fromPartition(BROWSE_PARTITION))).toBeNull();
    // Its own permission context (the browse session has none); a reset starts a new one.
    const context = locationContextOf(target);
    expect(context).toBe(`location:${PROFILE}:0`);
    expect(locationContextOf(session.fromPartition(BROWSE_PARTITION))).toBeNull();
    // Edit: cleared, and the next tab sets the (new) proxy first.
    await partitions.reset(PROFILE);
    expect(locationContextOf(target)).not.toBe(context);
    expect(target.clearStorageData).toHaveBeenCalledOnce();
    expect(target.clearCache).toHaveBeenCalledOnce();
    expect(target.closeAllConnections).toHaveBeenCalledOnce();
    expect(partitions.proxyOf(target)).toBeNull();
    await partitions.ensure(PROFILE, { scheme: 'https', host: 'other.example.net', port: 443 });
    expect(target.setProxy).toHaveBeenLastCalledWith({ mode: 'fixed_servers', proxyRules: 'https://other.example.net:443' });
    // Remove: cleared, never prepared again, and never set to direct.
    await partitions.retire(PROFILE);
    expect(target.clearStorageData).toHaveBeenCalledTimes(2);
    await expect(partitions.ensure(PROFILE, PROXY)).rejects.toThrow();
    expect(partitions.proxyOf(target)).toBeNull();
    for (const [config] of target.setProxy.mock.calls) expect((config as { mode: string }).mode).toBe('fixed_servers');
  });
});
