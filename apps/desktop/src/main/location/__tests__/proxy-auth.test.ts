// Spec: specs/location-profiles.spec.ts (proxyAuthKey, LOCATION_CREDENTIALS_FILE)
// Acceptance: specs/location-profiles.feature.md (proxy-login-only-for-its-proxy, no-login-listener-cancels; Q7)
// · plan docs/plans/phase-12-big-bets.md, Decision 11, Threat model "Proxy credentials answer a site's auth prompt", Task 10b
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { fakeEvent } from '../../../test/electron-fake';
import { createProxyLogin, installProxyLogin, type ProxyLoginDeps } from '../proxy-auth';
import { createMemoryLocationSecrets } from '../secrets';

const PROFILE = '01920000-0000-7000-8000-0000000000c1';
const OTHER = '01920000-0000-7000-8000-0000000000c2';
const USER = 'me';
const PASS = 'proxy-pass-SECRET-0123';

const locationSession = { name: 'location' };
const otherLocationSession = { name: 'other-location' };
const browseSession = { name: 'browse' };
const contentsOn = (session: unknown, destroyed = false) => ({ session, isDestroyed: () => destroyed });

async function setup() {
  const secrets = createMemoryLocationSecrets();
  expect(await secrets.setCredentials(PROFILE, USER, PASS)).toBe('stored');
  expect(await secrets.setCredentials(OTHER, 'them', 'other-pass')).toBe('stored');
  const log = vi.fn<(line: string) => void>();
  const deps: ProxyLoginDeps = {
    proxyOf: (session) => (session === locationSession ? { profileId: PROFILE, host: 'proxy.example.net', port: 3128 } : session === otherLocationSession ? { profileId: OTHER, host: 'other.example.net', port: 8080 } : null),
    withCredentials: (profileId, fn) => secrets.withCredentials(profileId, fn),
    log,
  };
  return { listener: createProxyLogin(deps), secrets, log };
}

const details = (firstAuthAttempt = true) => ({ url: 'https://site.example/', pid: 1, isRequestForNavigation: true, firstAuthAttempt });
const proxyInfo = (host = 'proxy.example.net', port = 3128) => ({ isProxy: true, scheme: 'basic', host, port, realm: 'r' });

/** Runs the listener and resolves what `callback` got (after the store's closure ran). */
async function login(listener: ReturnType<typeof createProxyLogin>, contents: unknown, info: Record<string, unknown>, first = true) {
  const event = fakeEvent();
  const callback = vi.fn<(username?: string, password?: string) => void>();
  listener(event, contents, details(first), info, callback);
  await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
  return { event, args: callback.mock.calls[0] };
}

describe('proxy login', () => {
  test('proxy-login-only-for-its-proxy', async () => {
    const { listener, log } = await setup();
    // Its own proxy, on its own partition, the first attempt: answered with its sign-in.
    const ok = await login(listener, contentsOn(locationSession), proxyInfo());
    expect(ok.event.preventDefault).toHaveBeenCalled();
    expect(ok.args).toEqual([USER, PASS]);
    // The host is compared without case.
    expect((await login(listener, contentsOn(locationSession), proxyInfo('PROXY.example.NET'))).args).toEqual([USER, PASS]);
    // Everything else is cancelled: preventDefault, and the callback with no arguments.
    const cancelled = [
      [contentsOn(locationSession), proxyInfo('proxy.example.net', 3129)],
      [contentsOn(locationSession), proxyInfo('evil.example.net', 3128)],
      // A site's own 401 (not the proxy) on a location tab.
      [contentsOn(locationSession), { ...proxyInfo(), isProxy: false }],
      // The browse session (the user's own connection) and another profile's partition.
      [contentsOn(browseSession), proxyInfo()],
      [contentsOn(otherLocationSession), proxyInfo()],
      // No WebContents (a service worker), or a destroyed one.
      [null, proxyInfo()],
      [contentsOn(locationSession, true), proxyInfo()],
      // Odd shapes.
      [contentsOn(locationSession), { isProxy: 'true', host: 'proxy.example.net', port: 3128 }],
      [contentsOn(locationSession), { isProxy: true, host: 'proxy.example.net', port: '3128' }],
      [contentsOn(locationSession), undefined],
    ] as const;
    for (const [contents, info] of cancelled) {
      const answer = await login(listener, contents, info as Record<string, unknown>);
      expect(answer.event.preventDefault).toHaveBeenCalled();
      expect(answer.args, JSON.stringify(info)).toEqual([]);
    }
    // The other profile's proxy on the other partition gets the other profile's sign-in, never this one's.
    expect((await login(listener, contentsOn(otherLocationSession), proxyInfo('other.example.net', 8080))).args).toEqual(['them', 'other-pass']);
    // A second attempt (the proxy rejected the sign-in) is never answered again.
    expect((await login(listener, contentsOn(locationSession), proxyInfo(), false)).args).toEqual([]);
    // Nothing about a request or a secret is logged.
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/proxy-pass|site\.example|proxy\.example/);
  });

  test('proxy-login-without-a-stored-sign-in-cancels', async () => {
    const { listener, secrets } = await setup();
    await secrets.forget(PROFILE);
    expect((await login(listener, contentsOn(locationSession), proxyInfo())).args).toEqual([]);
    // A store that fails cancels too.
    const failing = createProxyLogin({ proxyOf: () => ({ profileId: PROFILE, host: 'proxy.example.net', port: 3128 }), withCredentials: async () => Promise.reject(new Error('keychain')) });
    expect((await login(failing, contentsOn(locationSession), proxyInfo())).args).toEqual([]);
  });

  test('no-login-listener-cancels', async () => {
    // Today's behaviour pinned: no module of main listens for `login` but this one, which main installs once.
    const main = path.resolve(__dirname, '../..');
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) {
          if (name !== '__tests__') walk(file);
        } else if (/\.ts$/.test(name)) sources.push(file);
      }
    };
    walk(main);
    const listening = sources.filter((file) => /\.(on|once|addListener|prependListener)\(\s*['"`]login['"`]/.test(readFileSync(file, 'utf8'))).map((file) => path.relative(main, file).split(path.sep).join('/'));
    expect(listening).toEqual(['location/proxy-auth.ts']);
    // With no profile prepared, every `login` it gets is cancelled.
    const app = { on: vi.fn() };
    const listener = installProxyLogin(app, { proxyOf: () => null, withCredentials: vi.fn(async () => ({ ok: false as const })) });
    expect(app.on).toHaveBeenCalledExactlyOnceWith('login', listener);
    for (const info of [proxyInfo(), { ...proxyInfo(), isProxy: false }]) {
      for (const contents of [contentsOn(browseSession), contentsOn(locationSession), null]) {
        const answer = await login(listener, contents, info);
        expect(answer.args).toEqual([]);
      }
    }
  });
});
