// Acceptance: specs/account-signin.feature.md, specs/gsc.feature.md and specs/telemetry.feature.md
// (Startup: "Startup never stops the window") · spec specs/entitlements-snapshot.spec.ts (NO_ENTITLEMENTS),
// specs/telemetry-privacy.spec.ts (DEFAULT_CONSENT)
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NO_ENTITLEMENTS } from '@app/specs/entitlements-snapshot.spec';
import { DEFAULT_CONSENT } from '@app/specs/telemetry-privacy.spec';

/** Which Electron call throws (each test makes one part of the setup fail). */
const fail = vi.hoisted(() => ({ windows: false, packaged: false, userData: false }));

vi.mock('electron', () => {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const app = {
    get isPackaged(): boolean {
      if (fail.packaged) throw new Error('boom: /home/alice/secret-path');
      return false;
    },
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    getPath: (_name: string) => {
      if (fail.userData) throw new Error('boom: /home/alice/secret-path');
      return '/nonexistent/frost-test-user-data';
    },
    getVersion: () => '1.0.0',
    getAppPath: () => '/nonexistent/app',
    on: (event: string, listener: (...args: unknown[]) => void) => void listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    once: (event: string, listener: (...args: unknown[]) => void) => void listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    removeListener: () => undefined,
    quit: () => undefined,
  };
  const BrowserWindow = {
    getAllWindows: () => {
      if (fail.windows) throw new Error('boom: alice@example.com');
      return [];
    },
    fromId: () => null,
  };
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => Buffer.alloc(0),
    decryptStringAsync: async () => ({ shouldReEncrypt: false, result: '' }),
    getSelectedStorageBackend: () => 'basic_text',
  };
  const electron = { app, BrowserWindow, safeStorage, net: { fetch: vi.fn(async () => new Response(null)) }, shell: { openExternal: vi.fn(async () => undefined) } };
  return { ...electron, default: electron };
});

afterEach(() => {
  Object.assign(fail, { windows: false, packaged: false, userData: false });
  vi.restoreAllMocks();
});

/** The messages main logged (`console.warn`). */
function logged() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return () => warn.mock.calls.map((call) => String(call[0]));
}

const expectFixed = (messages: string[]) => {
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) expect(message).not.toMatch(/boom|alice|secret-path/);
};

describe('startup never stops the window', () => {
  test('account-start-failure-is-unconfigured', async () => {
    const messages = logged();
    fail.windows = true;
    const { createAccountMain } = await import('../account/main');
    const account = await createAccountMain();
    expect(account.service.state()).toMatchObject({ status: 'unconfigured', entitlements: NO_ENTITLEMENTS, keychain: 'memory-only' });
    expect(account.entitlements.current()).toEqual(NO_ENTITLEMENTS);
    expect(account.entitlements.has('ai-agent')).toBe(false);
    expect(await account.service.signIn(1)).toBe('unconfigured');
    expect(account.gestures.consume(1)).toBe(false);
    expect(() => account.menu.showSettings(1)).not.toThrow();
    expect(messages()).toContain('frost: account: could not start; unconfigured for this run');
    expectFixed(messages());
  });

  test('gsc-start-failure-is-unconfigured', async () => {
    const messages = logged();
    const { createAccountMain } = await import('../account/main');
    const { createGscMain } = await import('../gsc/main');
    const account = await createAccountMain();
    fail.packaged = true;
    const gsc = await createGscMain(account);
    fail.packaged = false;
    expect(await gsc.service.status()).toMatchObject({ configured: false, connected: false, connecting: false });
    expect(await gsc.service.connect(1)).toBe('unconfigured');
    expect(messages()).toContain('frost: gsc: could not start; unconfigured for this run');
    expectFixed(messages());
  });

  test('telemetry-start-failure-is-unconfigured', async () => {
    const messages = logged();
    fail.userData = true;
    const { createTelemetryMain } = await import('../telemetry/main');
    const telemetry = createTelemetryMain(Promise.resolve());
    expect(telemetry.service.state()).toMatchObject({ consent: DEFAULT_CONSENT, configured: { usage: false, errors: false } });
    expect(telemetry.service.setConsent('usage', true).consent).toEqual(DEFAULT_CONSENT);
    expect(telemetry.telemetry.span('app.test', {}, () => 42)).toBe(42);
    expect(() => telemetry.telemetry.captureException(new Error('x'))).not.toThrow();
    expect(telemetry.service.reportError({ source: 'error', name: 'Error', message: 'x', stack: null })).toBe('dropped');
    await expect(telemetry.telemetry.flush()).resolves.toBeUndefined();
    expect(messages()).toContain('frost: telemetry: could not start; unconfigured for this run');
    expectFixed(messages());
  });
});
