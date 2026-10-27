// Specs: specs/ipc-transport.spec.ts, specs/app-protocol.spec.ts, specs/window-hardening.spec.ts
// Acceptance: specs/ipc-e2e.feature.md
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { APP_ENTRY_URL } from '@app/specs/app-protocol.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_BRIDGE_KEY, IPC_BRIDGE_METHODS } from '@app/specs/ipc-transport.spec';
import { APP_CSP } from '@app/specs/security-policy.spec';
import { HARDENED_WEB_PREFERENCES } from '@app/specs/window-hardening.spec';
import { appEntryScriptUrl, destroyWindows, launchApp, openUntrackedWindow, pageAt, startLoopbackServer } from './harness';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
});

test.afterAll(async () => {
  await app?.close();
});

test('loads-app-from-app-scheme', async () => {
  await page.waitForLoadState('domcontentloaded');
  expect(page.url().startsWith(APP_ENTRY_URL)).toBe(true);
  const mainUrl = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL());
  expect(mainUrl?.startsWith(APP_ENTRY_URL)).toBe(true);
});

test('renders-pong-over-ipc', async () => {
  await expect(page.getByTestId('ping')).toHaveText('pong');
});

test('effective-webpreferences-are-hardened', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    // Undocumented internal (see src/types/electron-internal.d.ts); present in Electron 45.
    const contents = win?.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> | null };
    return contents.getLastWebPreferences();
  });
  expect(prefs).toMatchObject(HARDENED_WEB_PREFERENCES);
});

test('renderer-has-no-node-or-ipc-globals', async () => {
  const globals = await page.evaluate((bridgeKey) => {
    const g = globalThis as Record<string, unknown>;
    const bridge = g[bridgeKey];
    return {
      leaked: ['require', 'process', 'ipcRenderer', 'module', 'Buffer', 'electron'].filter((name) => name in g),
      bridgeKeys: typeof bridge === 'object' && bridge !== null ? Object.keys(bridge) : null,
    };
  }, IPC_BRIDGE_KEY);
  expect(globals.leaked).toEqual([]);
  expect(globals.bridgeKeys).toEqual([...IPC_BRIDGE_METHODS]);
});

test('boots-under-strict-csp-without-violations', async () => {
  const problems: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' || /content.security.policy|trusted.?type/i.test(text)) {
      problems.push(`${message.type()}: ${text}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  // Listeners are attached now; reload so the whole boot happens under observation.
  await page.reload();
  await expect(page.getByTestId('ping')).toHaveText('pong');
  expect(page.url().startsWith(APP_ENTRY_URL)).toBe(true);

  const csp = await page.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'));
  expect(csp).toBe(APP_CSP);
  expect(problems).toEqual([]);
});

test('app-scheme-refuses-foreign-pages', async () => {
  const loopback = await startLoopbackServer();
  const windowIds: number[] = [];
  try {
    // An untracked window cannot even load the app document…
    const appDoc = await openUntrackedWindow(app, APP_ENTRY_URL);
    windowIds.push(appDoc.id);
    expect(appDoc.loadError).toMatch(/ERR_BLOCKED_BY_CLIENT/);

    // …and a foreign page (in the same session) cannot embed the app's script.
    const foreign = await openUntrackedWindow(app, `${loopback.origin}/`);
    windowIds.push(foreign.id);
    expect(foreign.loadError).toBeNull();
    const foreignPage = await pageAt(app, loopback.origin);
    const loadScript = (src: string) =>
      foreignPage.evaluate(
        (url) =>
          new Promise<string>((resolve) => {
            const script = document.createElement('script');
            script.onload = () => resolve('load');
            script.onerror = () => resolve('error');
            script.src = url;
            document.head.append(script);
          }),
        src,
      );
    expect(await loadScript(`${loopback.origin}/ok.js`)).toBe('load'); // control: scripts do load here
    expect(await loadScript(await appEntryScriptUrl())).toBe('error');

    // The app window itself still loads it.
    expect(await page.evaluate(async (url) => (await fetch(url)).status, await appEntryScriptUrl())).toBe(200);
  } finally {
    await destroyWindows(app, windowIds);
    await loopback.close();
  }
});

test('untracked-window-is-forbidden', async () => {
  const loopback = await startLoopbackServer();
  let windowId: number | undefined;
  try {
    const foreign = await openUntrackedWindow(app, `${loopback.origin}/?ipc`);
    windowId = foreign.id;
    expect(foreign.loadError).toBeNull();
    const foreignPage = await pageAt(app, `${loopback.origin}/?ipc`);
    const response = await foreignPage.evaluate(
      (key) => (window as unknown as Record<string, { invoke(e: unknown): Promise<unknown> }>)[key]!.invoke({ type: 'query', path: 'ping' }),
      IPC_BRIDGE_KEY,
    );
    expect(response).toEqual({
      error: { message: IPC_SENDER_ERROR_CODE, code: -32003, data: { code: IPC_SENDER_ERROR_CODE, httpStatus: 403 } },
    });
  } finally {
    if (windowId !== undefined) await destroyWindows(app, [windowId]);
    await loopback.close();
  }
});
