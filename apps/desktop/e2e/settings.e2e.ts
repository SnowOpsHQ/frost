// Specs: specs/account-settings.spec.ts (SETTINGS_MENU, ACCOUNT_SETTINGS_TEXT, GSC_SETTINGS_TEXT), specs/account-state.schema.ts
// (ACCOUNT_CONFIG_ENV, AccountStateSchema), specs/account-api.schema.ts (requestFingerprint, DesktopAuthorizeQuerySchema),
// specs/telemetry-consent.schema.ts (TELEMETRY_CONFIG_ENV, TelemetryStateSchema), specs/gsc.schema.ts (GSC_SCOPE, GscStatusSchema)
// Acceptance: specs/account-settings.feature.md (End to end) · review focus "Telemetry UI matches behaviour", the in-app
// sign-in confirmation
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT_SETTINGS_TEXT, SETTINGS_MENU } from '@app/specs/account-settings.spec';
import { DesktopAuthorizeQuerySchema, requestFingerprint } from '@app/specs/account-api.schema';
import { ACCOUNT_CONFIG_ENV, AccountStateSchema, type AccountState } from '@app/specs/account-state.schema';
import { HISTORY_MENU_ID } from '@app/specs/browser-polish.spec';
import { GSC_SCOPE, GscStatusSchema, type GscStatus } from '@app/specs/gsc.schema';
import { IPC_BRIDGE_KEY } from '@app/specs/ipc-transport.spec';
import { TELEMETRY_CONFIG_ENV, TelemetryStateSchema, type TelemetryState } from '@app/specs/telemetry-consent.schema';
import { startFakeBackend, type FakeBackend } from './fake-backend';
import { startFakeGoogle, type FakeGoogle } from './fake-google';
import { startFakeTelemetry, type FakeTelemetry } from './fake-telemetry';
import { closeApp, launchApp, startLoopbackServer } from './harness';
import { chromeHelpers } from './helpers';

test.describe.configure({ mode: 'serial' });

let backend: FakeBackend;
let google: FakeGoogle;
let telemetry: FakeTelemetry;
let site: { origin: string; close(): Promise<void> };
let profile: string;
let app: ElectronApplication | undefined;
let page: Page;
const { go, contentsIdAt, menu, press, chromeCaughtUp } = chromeHelpers(
  () => app!,
  () => page,
);

/** Launches on the suite's profile with every fake configured and `shell.openExternal` replaced by a recorder. */
async function launch(): Promise<void> {
  ({ app, page } = await launchApp([], {
    userDataDir: profile,
    env: {
      [ACCOUNT_CONFIG_ENV.apiBaseUrl]: backend.origin,
      [ACCOUNT_CONFIG_ENV.entitlementJwks]: JSON.stringify(backend.jwks),
      [TELEMETRY_CONFIG_ENV.otelEndpoint]: telemetry.otelEndpoint,
      [TELEMETRY_CONFIG_ENV.sentryDsn]: telemetry.sentryDsn,
      ...google.env,
    },
  }));
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __frostOpened: string[] }).__frostOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  // The chrome has its first state (a palette or menu request before that would read as history).
  await chromeCaughtUp();
}

const openedUrls = (): Promise<string[]> => app!.evaluate(() => [...(globalThis as unknown as { __frostOpened: string[] }).__frostOpened]);

/** Reads a procedure from the chrome page (to check main agrees with what the view shows). */
async function query(name: string): Promise<unknown> {
  const response = (await page.evaluate(
    ([key, envelope]) => (window as unknown as Record<string, { invoke(e: unknown): Promise<unknown> }>)[key as string]!.invoke(envelope),
    [IPC_BRIDGE_KEY, { type: 'query', path: name }] as const,
  )) as { result?: { data: unknown }; error?: unknown };
  if (!response.result) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
  return response.result.data;
}
const accountState = async (): Promise<AccountState> => AccountStateSchema.parse(await query('account.state'));
const telemetryState = async (): Promise<TelemetryState> => TelemetryStateSchema.parse(await query('telemetry.state'));
const gscStatus = async (): Promise<GscStatus> => GscStatusSchema.parse(await query('gsc.status'));

const settings = () => page.getByTestId('settings-view');
const history = () => page.getByTestId('history-view');
const toggle = (channel: 'usage' | 'errors') => page.getByTestId(`telemetry-toggle-${channel}`);
const viewHeight = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children[0]?.getBounds().height ?? 0);

/** Runs a palette action by clicking its option. */
async function palette(actionId: string, query: string): Promise<void> {
  await press('chrome', 'K', ['mod']);
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill(query);
  await page.locator(`[data-testid="command-palette-option"][data-action="${actionId}"]`).click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
}

test.beforeAll(async () => {
  backend = await startFakeBackend();
  google = await startFakeGoogle();
  telemetry = await startFakeTelemetry();
  site = await startLoopbackServer();
  google.sites = [{ siteUrl: `${site.origin}/`, permissionLevel: 'siteOwner' }];
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-settings-'));
  await launch();
});

test.afterAll(async () => {
  await closeApp(app);
  await backend?.close();
  await google?.close();
  await telemetry?.close();
  await site?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('settings-opens-from-palette-and-menu', async () => {
  await palette('settings.open', 'settings');
  await expect(settings()).toBeVisible();
  await expect(page.locator('#settings-section-account')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settings()).toHaveCount(0);

  // Mod+, is the menu item's accelerator (a synthetic key event does not reach the native menu, so its
  // item is clicked, as the History suite does for Mod+Y).
  const accelerator = await app!.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.accelerator ?? null, SETTINGS_MENU.id);
  expect(accelerator).toBe('CmdOrCtrl+,');
  await menu(SETTINGS_MENU.id);
  await expect(settings()).toBeVisible();
  await expect(page.locator('#settings-section-account')).toBeFocused();
  await page.getByTestId('settings-close').click();
  await expect(settings()).toHaveCount(0);

  // The menu item itself; History and Settings never show together.
  await menu(SETTINGS_MENU.id);
  await expect(settings()).toBeVisible();
  await menu(HISTORY_MENU_ID);
  await expect(history()).toBeVisible();
  await expect(settings()).toHaveCount(0);
  await palette('settings.telemetry', 'telemetry settings');
  await expect(settings()).toBeVisible();
  await expect(history()).toHaveCount(0);
  await expect(page.locator('#settings-section-telemetry')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settings()).toHaveCount(0);
});

test('settings-sheet-not-covered-by-page', async () => {
  const url = `${site.origin}/page`;
  await go(url);
  await contentsIdAt(url);
  await expect.poll(viewHeight).toBeGreaterThan(0);
  await menu(SETTINGS_MENU.id);
  await expect(settings()).toBeVisible();
  // The page's view is laid out zero-high: nothing is drawn over the sheet.
  await expect.poll(viewHeight).toBe(0);
  const sheet = (await settings().boundingBox())!;
  expect(sheet.height).toBeGreaterThan(200);
  await page.keyboard.press('Escape');
  await expect.poll(viewHeight).toBeGreaterThan(0);
});

test('settings-telemetry-toggles-follow-main', async () => {
  await palette('settings.telemetry', 'telemetry');
  for (const channel of ['usage', 'errors'] as const) await expect(toggle(channel)).toHaveAttribute('aria-checked', 'false');
  expect((await telemetryState()).consent).toEqual({ usage: false, errors: false });
  await expect(page.getByTestId('telemetry-section')).not.toContainText('no endpoint');

  await toggle('usage').click();
  await expect(toggle('usage')).toHaveAttribute('aria-checked', 'true');
  expect((await telemetryState()).consent).toEqual({ usage: true, errors: false });
  await toggle('errors').click();
  await expect(toggle('errors')).toHaveAttribute('aria-checked', 'true');
  await toggle('errors').click();
  await expect(toggle('errors')).toHaveAttribute('aria-checked', 'false');
  expect((await telemetryState()).consent).toEqual({ usage: true, errors: false });
  await expect(page.getByTestId('telemetry-run-only')).toHaveCount(0);

  // The same profile after a restart: what main kept.
  await closeApp(app);
  await launch();
  await palette('settings.telemetry', 'telemetry');
  await expect(toggle('usage')).toHaveAttribute('aria-checked', 'true');
  await expect(toggle('errors')).toHaveAttribute('aria-checked', 'false');
  expect((await telemetryState()).consent).toEqual({ usage: true, errors: false });
  // Off again (the rest of the suite sends nothing).
  await toggle('usage').click();
  await expect(toggle('usage')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
});

test('settings-sign-in-needs-confirmation', async () => {
  await palette('settings.sign-in', 'sign in');
  await expect(settings()).toBeVisible();
  await expect(page.getByTestId('account-section')).toHaveAttribute('data-status', 'signed-out');
  const before = (await openedUrls()).length;
  await page.getByTestId('account-sign-in').click();
  await expect.poll(async () => (await openedUrls()).length).toBe(before + 1);
  const authorize = new URL((await openedUrls())[before]!);
  const { code_challenge: challenge } = DesktopAuthorizeQuerySchema.parse(Object.fromEntries(authorize.searchParams));
  // The code the browser page shows, prominently in the view while it waits.
  const fingerprint = requestFingerprint(challenge);
  await expect(page.getByTestId('account-section')).toHaveAttribute('data-status', 'awaiting-browser');
  await expect(page.getByTestId('account-fingerprint')).toHaveText(fingerprint);
  await expect(page.getByTestId('account-section')).toContainText(ACCOUNT_SETTINGS_TEXT.fingerprintHint);

  // The test is the browser.
  const toLoopback = await fetch(authorize, { redirect: 'manual' });
  expect(toLoopback.status).toBe(303);
  expect((await fetch(toLoopback.headers.get('location')!, { redirect: 'manual' })).status).toBe(303);

  // The in-app confirmation: the account named, the same code, nothing signed in yet.
  await expect(page.getByTestId('account-question')).toHaveText(`Sign in to frost as ${backend.user.email}?`);
  await expect(page.getByTestId('account-fingerprint')).toHaveText(fingerprint);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(await accountState()).toMatchObject({ status: 'confirming', entitlements: { plan: 'free', status: 'none' } });
  expect(backend.tokens.length).toBeGreaterThan(0);

  await page.getByTestId('account-confirm').click();
  await expect(page.getByTestId('account-plan')).toHaveText('Pro');
  await expect(page.getByTestId('account-email')).toHaveText(backend.user.email);
  await expect(page.getByTestId('account-plan-status')).toHaveText('Pro is active.');
  expect(await accountState()).toMatchObject({ status: 'signed-in', entitlements: { plan: 'pro', status: 'active' } });
  await page.screenshot({ path: '/tmp/frost-settings.png' }).catch(() => undefined);
});

test('settings-search-console-connect-disconnect', async () => {
  await page.getByTestId('settings-nav-search-console').click();
  await expect(page.getByTestId('gsc-section')).toHaveAttribute('data-kind', 'not-connected');
  const before = (await openedUrls()).length;
  await page.getByTestId('gsc-connect').click();
  await expect.poll(async () => (await openedUrls()).length).toBe(before + 1);
  const consent = new URL((await openedUrls())[before]!);
  expect(consent.searchParams.get('scope')).toBe(GSC_SCOPE);
  await expect(page.getByTestId('gsc-section')).toHaveAttribute('data-kind', 'connecting');
  const toLoopback = await fetch(consent, { redirect: 'manual' });
  expect(toLoopback.status).toBe(302);
  expect((await fetch(toLoopback.headers.get('location')!, { redirect: 'manual' })).status).toBe(303);
  await expect(page.getByTestId('gsc-headline')).toHaveText('Connected');
  expect(await gscStatus()).toMatchObject({ connected: true, entitled: true });

  const refresh = google.refreshTokens.at(-1)!;
  await page.getByTestId('gsc-disconnect').click();
  await expect(page.getByTestId('gsc-connect')).toBeVisible();
  await expect.poll(() => google.revoked.includes(refresh)).toBe(true);
  expect(await gscStatus()).toMatchObject({ connected: false, connecting: false });
});
