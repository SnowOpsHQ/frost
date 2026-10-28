// Test-only: helpers for suites that sign in to the fake backend and connect the fake Google
// (`fake-backend.ts`, `fake-google.ts`), bound to a suite's current app and chrome page (getters, as
// suites relaunch). Everything acts through main (`app.evaluate`), the chrome page, or as the system
// browser would (plain `fetch` of the URL main opened); nothing here is a production test hook.
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT_CONFIG_ENV, AccountStateSchema, type AccountState } from '@app/specs/account-state.schema';
import { GscStatusSchema, type GscStatus } from '@app/specs/gsc.schema';
import { IPC_BRIDGE_KEY } from '@app/specs/ipc-transport.spec';
import type { FakeBackend } from './fake-backend';
import type { FakeGoogle } from './fake-google';

/** The unpackaged run-time configuration that points the app at the fake backend and the fake Google. */
export function fakeAccountEnv(backend: FakeBackend, google?: FakeGoogle): Record<string, string> {
  return { [ACCOUNT_CONFIG_ENV.apiBaseUrl]: backend.origin, [ACCOUNT_CONFIG_ENV.entitlementJwks]: JSON.stringify(backend.jwks), ...(google?.env ?? {}) };
}

export function accountHelpers(getApp: () => ElectronApplication, getPage: () => Page) {
  const app = (): ElectronApplication => getApp();
  const page = (): Page => getPage();

  /** Replaces `shell.openExternal` in main with a recorder: nothing opens; `openedUrls` lists what would have. */
  const recordOpenExternal = (): Promise<void> =>
    app().evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __frostOpened: string[] }).__frostOpened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });

  const openedUrls = (): Promise<string[]> => app().evaluate(() => [...(globalThis as unknown as { __frostOpened: string[] }).__frostOpened]);

  /** Calls a procedure from the chrome page, as the renderer would; resolves its data. */
  const call = async (type: 'query' | 'mutation', name: string, input?: unknown): Promise<unknown> => {
    const response = (await page().evaluate(
      ([key, envelope]) => (window as unknown as Record<string, { invoke(e: unknown): Promise<unknown> }>)[key as string]!.invoke(envelope),
      [IPC_BRIDGE_KEY, { type, path: name, input }] as const,
    )) as { result?: { data: unknown }; error?: unknown };
    if (!response.result) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
    return response.result.data;
  };

  const accountState = async (): Promise<AccountState> => AccountStateSchema.parse(await call('query', 'account.state'));
  const gscStatus = async (): Promise<GscStatus> => GscStatusSchema.parse(await call('query', 'gsc.status'));

  /**
   * Runs `click` (a real click that makes main open a URL in the system browser) and then plays the
   * browser: follows the opened URL to the loopback callback. Resolves the URL that was opened.
   */
  const throughBrowser = async (click: () => Promise<void>): Promise<URL> => {
    const before = (await openedUrls()).length;
    await click();
    await expect.poll(async () => (await openedUrls()).length).toBe(before + 1);
    const opened = new URL((await openedUrls())[before]!);
    const toLoopback = await fetch(opened, { redirect: 'manual' });
    expect([302, 303]).toContain(toLoopback.status);
    expect((await fetch(toLoopback.headers.get('location')!, { redirect: 'manual' })).status).toBe(303);
    return opened;
  };

  /** Signs in through the open Settings sheet (Account section): Sign in, the browser leg, then the in-app confirmation. */
  const signInInSettings = async (): Promise<void> => {
    await expect(page().getByTestId('account-section')).toHaveAttribute('data-status', 'signed-out');
    await throughBrowser(() => page().getByTestId('account-sign-in').click());
    await expect(page().getByTestId('account-confirm')).toBeVisible();
    await page().getByTestId('account-confirm').click();
    await expect.poll(async () => (await accountState()).status).toBe('signed-in');
  };

  /** Connects Search Console through the open Settings sheet (Search Console section). */
  const connectInSettings = async (): Promise<void> => {
    await expect(page().getByTestId('gsc-section')).toHaveAttribute('data-kind', 'not-connected');
    await throughBrowser(() => page().getByTestId('gsc-connect').click());
    await expect(page().getByTestId('gsc-headline')).toHaveText('Connected');
    await expect.poll(async () => (await gscStatus()).connected).toBe(true);
  };

  return { recordOpenExternal, openedUrls, call, accountState, gscStatus, throughBrowser, signInInSettings, connectInSettings };
}
