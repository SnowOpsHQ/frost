// Specs: specs/update-client.spec.ts (UPDATE_FEED_SWITCH, UPDATE_PUBLIC_KEY_SWITCH, UPDATE_TEST_CERT_SWITCH,
// UPDATE_PARTITION, Chrome), specs/update-manifest.spec.ts (artifactFileName), specs/fetcher.spec.ts
// (E2E_PUBLIC_HOSTS_SWITCH)
// Acceptance: specs/update-client.feature.md (Chrome, e2e)
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import {
  UPDATE_DOWNLOADS_DIR,
  UPDATE_ERROR_MESSAGES,
  UPDATE_FEED_SWITCH,
  UPDATE_PARTITION,
  UPDATE_PREFS_FILE,
  UPDATE_PUBLIC_KEY_SWITCH,
  UPDATE_TEST_CERT_SWITCH,
  updateAvailableText,
  updateReadyManualText,
  updateUserAgent,
} from '@app/specs/update-client.spec';
import { artifactFileName, updatePlatformKey } from '@app/specs/update-manifest.spec';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { COMMAND_PALETTE_MENU_ID } from '@app/specs/command-palette.spec';
import { artifactBytes, manifestFor, sha256Hex, signEnvelope, startFakeFeed, testSigningKey, type FakeFeed } from '../src/main/update/__tests__/fake-feed';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { selfSignedCertificate } from './tls';

/**
 * The fake feed's public-looking name (`--host-resolver-rules` maps it to 127.0.0.1; the e2e seam
 * `E2E_PUBLIC_HOSTS_SWITCH` exempts it from the private-address check). Its TLS certificate is a
 * per-run self-signed one that only the update session accepts, through the pinned
 * `UPDATE_TEST_CERT_SWITCH`.
 */
const HOST = 'updates.frost-e2e.net';
const VERSION = '99.0.0';
const KEY = testSigningKey('e2e-update-key');
const TLS = selfSignedCertificate();
const PIN = new X509Certificate(TLS.cert).fingerprint256.replace(/:/g, '').toLowerCase();
const PLATFORM = updatePlatformKey(process.platform, process.arch);
const BYTES = artifactBytes(256 * 1024, 11);
const NOTES = 'frost 99.0.0\n\n- <b>Not bold</b>: notes are plain text.\n- Fixes.';
/**
 * What Chromium may add to an update request on its own (beside `host` and the update agent): its
 * transport headers. Anything else (a cookie, a referrer, an origin, `accept-language`, a client
 * hint) fails the test.
 */
const ALLOWED_HEADERS = ['host', 'user-agent', 'connection', 'accept-encoding'];

let feed: FakeFeed;
let app: ElectronApplication | undefined;
let page: Page;
let profile: string | undefined;
let installId: string;
const { press, menu } = chromeHelpers(
  () => app!,
  () => page,
);

const feedUrl = () => `https://${HOST}:${feed.port}/feed.json`;
const artifactUrl = (name = '/frost-artifact') => `https://${HOST}:${feed.port}${name}`;
/** Serves a fresh manifest for `VERSION` whose artifact is `/frost-artifact` with `BYTES`' size and hash. */
function serveOffer(extra: Record<string, unknown> = {}): void {
  feed.route('/feed.json', { body: signEnvelope(manifestFor(VERSION, Date.now(), { [PLATFORM!]: { url: artifactUrl(), sha256: sha256Hex(BYTES), size: BYTES.length } }, { notes: NOTES, ...extra }), KEY) });
}
const paths = () => feed.requests.map((request) => request.path);
const updatesDir = () => path.join(profile!, UPDATE_DOWNLOADS_DIR);
/** Every regular file under `updates/` (relative paths). */
async function filesInUpdates(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  await walk(updatesDir(), '');
  return out.sort();
}

/**
 * Launches on a fresh profile whose prefs have automatic checks off (so no scheduled check runs
 * mid-test; "Check for Updates" still checks, as a user action), with every e2e seam but, unless
 * `withFeed`, the feed itself.
 */
async function launch({ withFeed = true }: { withFeed?: boolean } = {}): Promise<void> {
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-update-'));
  installId = randomUUID();
  await writeFile(path.join(profile, UPDATE_PREFS_FILE), JSON.stringify({ format: 1, installId, checks: 'off' }), { mode: 0o600 });
  const args = [
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    `--${E2E_PUBLIC_HOSTS_SWITCH}=${HOST}`,
    `--${UPDATE_PUBLIC_KEY_SWITCH}=${KEY.keyId}:${KEY.spki}`,
    `--${UPDATE_TEST_CERT_SWITCH}=${PIN}`,
    ...(withFeed ? [`--${UPDATE_FEED_SWITCH}=${feedUrl()}`] : []),
  ];
  ({ app, page } = await launchApp(args, { userDataDir: profile }));
  await page.waitForLoadState('domcontentloaded');
  // The chrome has its first update state: with the feed, checks off (`off`); without, `disabled`.
  await expect(slot()).toHaveAttribute('data-update-status', withFeed ? 'off' : 'disabled');
}

/** Records, in main, every `shell` call the update could make (`showItemInFolder` stubbed: nothing opens). */
async function stubShell(): Promise<void> {
  await app!.evaluate(({ shell }) => {
    const record = { shown: [] as string[], opened: [] as string[] };
    (globalThis as unknown as { __frostUpdateE2E: typeof record }).__frostUpdateE2E = record;
    shell.showItemInFolder = (fullPath: string) => void record.shown.push(fullPath);
    shell.openExternal = async (url: string) => void record.opened.push(url);
    shell.openPath = async (fullPath: string) => {
      record.opened.push(fullPath);
      return '';
    };
  });
}
const shellRecord = () => app!.evaluate(() => structuredClone((globalThis as unknown as { __frostUpdateE2E: { shown: string[]; opened: string[] } }).__frostUpdateE2E));

const palette = () => page.getByTestId('command-palette');
const input = () => page.getByTestId('command-palette-input');
const activeOption = () => page.locator('[data-testid="command-palette-option"][aria-selected="true"]');
const bar = () => page.getByTestId('update-bar');
const slot = () => page.getByTestId('update-slot');

/** Runs palette action `id` (found by typing `query`), as a user would. */
async function runFromPalette(query: string, id: string): Promise<void> {
  await menu(COMMAND_PALETTE_MENU_ID);
  await expect(palette()).toBeVisible();
  await input().fill(query);
  await expect(activeOption()).toHaveAttribute('data-action', id);
  await input().press('Enter');
  await expect(palette()).toHaveCount(0);
}

/** "Check for Updates", then the offer on screen. */
async function checkAndSeeOffer(): Promise<void> {
  await runFromPalette('check for updates', 'update.check');
  await expect(bar()).toHaveAttribute('data-kind', 'available');
  await expect(page.getByTestId('update-text')).toContainText(updateAvailableText(VERSION));
}

test.beforeAll(async () => {
  feed = await startFakeFeed({ tls: TLS });
});

test.afterAll(async () => {
  await feed?.close();
});

test.beforeEach(() => {
  test.skip(PLATFORM === null, 'no update artifact kind for this platform');
  feed.requests.length = 0;
});

test.afterEach(async () => {
  await closeApp(app);
  app = undefined;
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
  profile = undefined;
});

test('update-available-download-verify-show', async () => {
  serveOffer();
  feed.route('/frost-artifact', { body: BYTES });
  await launch();
  await stubShell();
  await checkAndSeeOffer();
  // The notes are the signed plain text: markup in them is text, never an element.
  await page.getByTestId('update-notes-toggle').click();
  await expect(page.getByTestId('update-notes')).toHaveText(NOTES);
  expect(await page.getByTestId('update-notes').evaluate((notes) => notes.tagName + notes.children.length)).toBe('PRE0');
  await expect(page.getByTestId('update-skip')).toBeVisible();
  await expect(page.getByTestId('update-later')).toBeVisible();
  // Nothing was downloaded on its own.
  expect(paths()).toEqual(['/feed.json']);

  await page.getByTestId('update-download').click();
  await expect(bar()).toHaveAttribute('data-kind', 'ready', { timeout: 30_000 });
  await expect(page.getByTestId('update-text')).toHaveText(updateReadyManualText(VERSION));
  expect(paths()).toEqual(['/feed.json', '/frost-artifact']);
  // The artifact request carries no more than the manifest request.
  const artifactRequest = feed.requests[1]!;
  expect(Object.keys(artifactRequest.headers).filter((name) => !ALLOWED_HEADERS.includes(name))).toEqual([]);

  await page.getByTestId('update-show-file').click();
  await expect.poll(async () => (await shellRecord()).shown.length).toBe(1);
  const { shown, opened } = await shellRecord();
  const expected = path.join(updatesDir(), VERSION, artifactFileName(VERSION, PLATFORM!));
  expect(shown).toEqual([expected]);
  // Revealed, never opened or run.
  expect(opened).toEqual([]);
  expect(createHash('sha256').update(await readFile(expected)).digest('hex')).toBe(sha256Hex(BYTES));
  expect(await filesInUpdates()).toEqual([`${VERSION}/${artifactFileName(VERSION, PLATFORM!)}`]);
  // Dismiss hides it for this window's session.
  await page.getByTestId('update-dismiss').click();
  await expect(bar()).toHaveCount(0);
  await expect(slot()).toHaveAttribute('data-update-status', 'ready');
});

test('no-silent-install', async () => {
  serveOffer();
  feed.route('/frost-artifact', { body: BYTES });
  await launch();
  await checkAndSeeOffer();
  // Time passes with the offer on screen: nothing is fetched past the manifest.
  await page.waitForTimeout(3_000);
  expect(paths()).toEqual(['/feed.json']);
  // Later hides the offer for this window's session; still nothing fetched.
  await page.getByTestId('update-later').click();
  await expect(bar()).toHaveCount(0);
  await expect(slot()).toHaveAttribute('data-update-status', 'available');
  // The setting, from the palette: on, then off again (saved in the prefs file), and still no download.
  const prefs = async () => JSON.parse(await readFile(path.join(profile!, UPDATE_PREFS_FILE), 'utf8')) as { checks: string; installId: string };
  await runFromPalette('automatic update checks', 'update.checks-on');
  await expect.poll(async () => (await prefs()).checks).toBe('on');
  await runFromPalette('automatic update checks', 'update.checks-off');
  await expect.poll(async () => (await prefs()).checks).toBe('off');
  expect((await prefs()).installId).toBe(installId);
  await page.waitForTimeout(1_000);
  expect(paths()).toEqual(['/feed.json']);
  expect(await filesInUpdates()).toEqual([]);
});

test('tampered-artifact-shows-error', async () => {
  serveOffer();
  const tampered = Buffer.from(BYTES);
  tampered[4096] = tampered[4096]! ^ 0x01;
  feed.route('/frost-artifact', { body: tampered });
  await launch();
  await checkAndSeeOffer();
  await page.getByTestId('update-download').click();
  await expect(bar()).toHaveAttribute('data-kind', 'error', { timeout: 30_000 });
  await expect(page.getByTestId('update-text')).toHaveText(UPDATE_ERROR_MESSAGES['hash-mismatch']);
  await expect(page.getByTestId('update-show-file')).toHaveCount(0);
  // No file is left: neither the partial nor a "verified" one.
  expect(await filesInUpdates()).toEqual([]);
  await page.getByTestId('update-dismiss').click();
  await expect(bar()).toHaveCount(0);
});

test('feed-request-headers', async () => {
  serveOffer();
  await launch();
  // Cookies for the feed's URL in the update session, the browse session and the default one: none may be sent.
  await app!.evaluate(
    async ({ session }, { url, partitions }) => {
      for (const target of [session.defaultSession, ...partitions.map((partition) => session.fromPartition(partition))]) {
        await target.cookies.set({ url, name: 'frost_e2e', value: 'must-not-be-sent', secure: true });
      }
    },
    { url: feedUrl(), partitions: [UPDATE_PARTITION, BROWSE_PARTITION] },
  );
  const appVersion = await app!.evaluate(({ app: electronApp }) => electronApp.getVersion());
  await checkAndSeeOffer();
  expect(feed.requests).toHaveLength(1);
  const request = feed.requests[0]!;
  expect([request.method, request.path]).toEqual(['GET', '/feed.json']);
  const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
  // What Chromium sent, for the record (the as-built note lists it).
  test.info().annotations.push({ type: 'update-request-headers', description: request.rawHeaders.join(' | ') });
  console.log(`update e2e: manifest request headers: ${JSON.stringify(request.rawHeaders)}`);
  expect(names.filter((name) => !ALLOWED_HEADERS.includes(name))).toEqual([]);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toEqual(expect.arrayContaining(['host', 'user-agent']));
  expect(request.headers['user-agent']).toBe(updateUserAgent(appVersion));
  expect(request.headers.host).toBe(`${HOST}:${feed.port}`);
  // Nothing holds the install ID (or the cookie).
  for (const value of request.rawHeaders) {
    expect(value).not.toContain(installId);
    expect(value).not.toContain('must-not-be-sent');
  }
  expect(request.path).not.toContain(installId);
});

test('no-feed-no-update-ui', async () => {
  serveOffer();
  // Every e2e seam but the feed: anything update-related that tried to reach the fake feed could.
  await launch({ withFeed: false });
  await expect(slot()).toHaveAttribute('data-update-status', 'disabled');
  await expect(bar()).toHaveCount(0);
  // The palette offers nothing about updates.
  await press('chrome', 'K', ['mod']);
  await expect(palette()).toBeVisible();
  await input().fill('update');
  await expect(page.locator('[data-testid="command-palette-option"][data-action^="update."]')).toHaveCount(0);
  await input().press('Escape');
  await page.waitForTimeout(2_000);
  expect(feed.requests).toEqual([]);
  // And the default launch (no switch at all) is the same: disabled, no bar.
  await closeApp(app);
  ({ app, page } = await launchApp());
  await expect(slot()).toHaveAttribute('data-update-status', 'disabled');
  await expect(bar()).toHaveCount(0);
  expect(feed.requests).toEqual([]);
});
