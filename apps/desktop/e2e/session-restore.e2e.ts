// Specs: specs/browser-session-db.spec.ts (DB_FILE_NAME), specs/browser.spec.ts (BROWSE_PARTITION, NEW_TAB_LABEL)
// Acceptance: specs/browser-session-db.feature.md (End to end)
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DB_FILE_NAME } from '@app/specs/browser-session-db.spec';
import { BROWSE_PARTITION, NEW_TAB_LABEL } from '@app/specs/browser.spec';
import { APP_DIR, launchApp } from './harness';

/**
 * One loopback site for the whole file, so its port (and the restored tabs' URLs) stay the same
 * across relaunches: every path is a titled page (`/a` → "Page A").
 */
async function startSite(): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const name = new URL(request.url ?? '/', 'http://x').pathname.slice(1).toUpperCase() || 'ROOT';
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>Page ${name}</title><h1>Page ${name}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let site: Awaited<ReturnType<typeof startSite>>;
/** The current test's profile directory (`--user-data-dir`), shared by its launches. */
let profile: string;
let app: ElectronApplication | undefined;
let page: Page;

test.beforeAll(async () => {
  site = await startSite();
});

test.afterAll(async () => {
  await site?.close();
});

test.beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-session-'));
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(profile, { recursive: true, force: true });
});

/** Launches the app on this test's profile, counting every permission prompt bar it renders. */
async function launch(): Promise<void> {
  ({ app, page } = await launchApp([], { userDataDir: profile }));
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => {
    const counter = globalThis as unknown as { __promptsShown: number };
    counter.__promptsShown = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches('[data-testid="permission-prompt"]') || node.querySelector('[data-testid="permission-prompt"]'))) {
            counter.__promptsShown += 1;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

/** Quits the app the way a user does (`app.quit()`: pending writes are flushed first). */
async function quit(): Promise<void> {
  await app?.close();
  app = undefined;
}

const strip = () => page.getByTestId('tab');
const activeTab = () => page.locator('[data-testid="tab"][aria-selected="true"]');
const address = () => page.getByTestId('address');
const prompt = () => page.getByTestId('permission-prompt');
const promptsShown = () => page.evaluate(() => (globalThis as unknown as { __promptsShown: number }).__promptsShown);

async function go(url: string, title: string): Promise<void> {
  await address().click();
  await address().fill(url);
  await address().press('Enter');
  await expect(activeTab()).toHaveAttribute('title', title);
}

/** Every live browse-session WebContents (the tabs' pages), as main sees them. */
async function browseContents(): Promise<{ id: number; url: string }[]> {
  return app!.evaluate(({ session, webContents }, partition) => {
    const browse = session.fromPartition(partition);
    return webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed() && c.session === browse)
      .map((c) => ({ id: c.id, url: c.getURL() }));
  }, BROWSE_PARTITION);
}

async function contentsIdAt(url: string): Promise<number> {
  await expect.poll(async () => (await browseContents()).filter((c) => c.url === url).length).toBe(1);
  return (await browseContents()).find((c) => c.url === url)!.id;
}

function run(id: number, script: string): Promise<unknown> {
  return app!.evaluate(({ webContents }, { id, script }) => webContents.fromId(id)!.mainFrame.executeJavaScript(script) as Promise<unknown>, { id, script });
}

/** Replaces the saved strip with `rows`, straight in the database file, as something other than frost could. */
function plantTabs(rows: { url: string; title: string; active?: boolean }[]): void {
  const db = new DatabaseSync(path.join(profile, DB_FILE_NAME));
  try {
    db.exec('DELETE FROM browser_tabs');
    const insert = db.prepare('INSERT INTO browser_tabs (position, url, title, active) VALUES (?, ?, ?, ?)');
    rows.forEach((row, position) => insert.run(position, row.url, row.title, row.active ? 1 : 0));
  } finally {
    db.close();
  }
}

/** Launches once (creating and migrating the database), then quits. */
async function createProfile(): Promise<void> {
  await launch();
  await quit();
}

test('session-restore-e2e', async () => {
  await launch();
  await go(`${site.origin}/a`, 'Page A');
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/b`, 'Page B');
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/c`, 'Page C');
  await strip().nth(1).click();
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await quit();

  await launch();
  await expect(strip()).toHaveCount(3);
  await expect(strip().nth(0)).toHaveAttribute('title', 'Page A');
  await expect(strip().nth(1)).toHaveAttribute('title', 'Page B');
  await expect(strip().nth(2)).toHaveAttribute('title', 'Page C');
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(address()).toHaveValue(`${site.origin}/b`);
  // Only the active tab loaded; the others load when activated.
  await contentsIdAt(`${site.origin}/b`);
  expect((await browseContents()).map((c) => c.url)).toEqual([`${site.origin}/b`]);
  for (const [index, name] of [[0, 'a'], [2, 'c']] as const) {
    await strip().nth(index).click();
    await expect(address()).toHaveValue(`${site.origin}/${name}`);
    await contentsIdAt(`${site.origin}/${name}`);
  }
});

test('restore-skips-non-browsable-urls-e2e', async () => {
  await createProfile();
  plantTabs([
    { url: `${site.origin}/a`, title: 'Page A' },
    { url: 'file:///etc/passwd', title: 'passwd', active: true },
    { url: 'app://app/', title: 'chrome' },
    { url: 'javascript:alert(1)', title: 'script' },
    { url: 'garbage', title: 'garbage' },
    { url: `${site.origin}/b`, title: 'Page B' },
  ]);

  await launch();
  await expect(strip()).toHaveCount(2);
  await expect(strip().nth(0)).toHaveAttribute('title', 'Page A');
  await expect(strip().nth(1)).toHaveAttribute('title', 'Page B');
  // The skipped active tab handed active to its next valid right neighbour.
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await contentsIdAt(`${site.origin}/b`);
  await strip().nth(0).click();
  await contentsIdAt(`${site.origin}/a`);
  for (const { url } of await browseContents()) expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
});

test('all-invalid-session-restores-empty-tab-e2e', async () => {
  await createProfile();
  plantTabs([
    { url: 'file:///etc/passwd', title: 'passwd', active: true },
    { url: 'app://app/', title: 'chrome' },
    { url: 'javascript:alert(1)', title: 'script' },
  ]);
  await launch();
  await expect(strip()).toHaveCount(1);
  await expect(activeTab()).toHaveAttribute('title', NEW_TAB_LABEL);
  await expect(page.getByTestId('start-view')).toBeVisible();
  expect(await browseContents()).toEqual([]);
});

test('permission-decision-persists-e2e', async () => {
  await launch();
  await go(`${site.origin}/notify`, 'Page NOTIFY');
  const id = await contentsIdAt(`${site.origin}/notify`);
  const asked = run(id, 'Notification.requestPermission()');
  await expect(prompt()).toHaveAttribute('data-origin', site.origin);
  await page.getByTestId('permission-allow').click();
  await expect(asked).resolves.toBe('granted');
  await quit();

  await launch();
  // The restored tab is the page that asked; it is granted with no prompt.
  const again = await contentsIdAt(`${site.origin}/notify`);
  await expect(run(again, 'Notification.permission')).resolves.toBe('granted');
  await expect(run(again, 'Notification.requestPermission()')).resolves.toBe('granted');
  expect(await promptsShown()).toBe(0);
  await expect(prompt()).toHaveCount(0);
});

test('db-file-in-user-data-e2e', async () => {
  await launch();
  expect(await app!.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))).toBe(profile);
  expect(existsSync(path.join(profile, DB_FILE_NAME))).toBe(true);
});

test('main-bundle-keeps-node-sqlite-external', async () => {
  const bundle = await readFile(path.join(APP_DIR, '.vite/build/main.cjs'), 'utf8');
  expect(bundle).toContain('require("node:sqlite")');
  expect(bundle).not.toMatch(/require\(["']drizzle-orm/);
  expect(bundle).not.toMatch(/require\(["']@app\/db/);
});
