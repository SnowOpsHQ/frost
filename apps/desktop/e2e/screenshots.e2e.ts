// Specs: specs/screenshot.spec.ts (SCREENSHOT_REFUSAL_MESSAGES, FULL_PAGE_SCROLL_NOTE, AREA_SELECT_HINT,
// SCREENSHOTS_DIR_NAME, SCREENSHOT_EDIT_RESULT_MESSAGES), specs/capture-db.spec.ts (CAPTURES_DIR_NAME, SHA256_HEX_PATTERN)
// Acceptance: specs/screenshot.feature.md (End to end; Editing)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { HISTORY_MENU_ID } from '@app/specs/browser-polish.spec';
import { CAPTURES_DIR_NAME, SHA256_HEX_PATTERN } from '@app/specs/capture-db.spec';
import { AREA_SELECT_HINT, FULL_PAGE_SCROLL_NOTE, SCREENSHOT_EDIT_RESULT_MESSAGES, SCREENSHOT_REFUSAL_MESSAGES, SCREENSHOTS_DIR_NAME } from '@app/specs/screenshot.spec';
import { closeApp, launchApp, pageAt } from './harness';
import { chromeHelpers } from './helpers';

/** About three viewports of coloured bands under a fixed header; the page asks for smooth scrolling (frost scrolls instantly anyway). */
const BANDS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'];
const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Coloured bands</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html{scroll-behavior:smooth}html,body{margin:0}header{position:fixed;top:0;left:0;right:0;height:48px;background:#111827;color:#fff;font:16px/48px sans-serif;padding:0 16px}
section{height:50vh;font:24px sans-serif;padding:60px 16px 0;box-sizing:border-box}${BANDS.map((colour, i) => `#band-${i}{background:${colour}}`).join('')}</style></head>
<body><header>Fixed header</header><main>${BANDS.map((_, i) => `<section id="band-${i}"><h2>Band ${i + 1}</h2></section>`).join('')}</main></body></html>`;

async function startSite() {
  const server = createServer((request, response) => {
    if (new URL(request.url ?? '/', 'http://x').pathname === '/bands') response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(PAGE_HTML);
    else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: ElectronApplication;
let page: Page;
let tabPage: Page;
let site: Awaited<ReturnType<typeof startSite>>;
let url: string;
let shotsDir: string;
const { go, menu } = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const status = () => page.getByTestId('changes-capture-status');
const shotButton = (kind: 'viewport' | 'full' | 'area') => page.getByTestId(`screenshot-${kind}`);
const gallery = () => page.getByTestId('screenshot');
const areaHint = () => page.getByTestId('screenshot-area-hint');
const pageDom = () => tabPage.evaluate(() => document.documentElement.outerHTML);
/** Files in the screenshot directory (none before the first screenshot). */
const files = (): string[] => {
  try {
    return readdirSync(shotsDir).sort();
  } catch {
    return [];
  }
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** A PNG's pixel size (its IHDR chunk). */
const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

/**
 * The tab view's size (DIP, as main lays it out) and its device scale factor: the page's
 * `devicePixelRatio` over its zoom. (On a fractionally scaled Wayland output the view's real ratio can
 * differ from the display's reported `scaleFactor`; the view's own is what its pixels follow.)
 */
async function viewMetrics(): Promise<{ width: number; height: number; scale: number }> {
  const view = await app.evaluate(({ BrowserWindow }, tabUrl) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const found = win.contentView.children.find((child) => (child as Electron.WebContentsView).webContents?.getURL() === tabUrl) as Electron.WebContentsView;
    return { ...found.getBounds(), zoom: found.webContents.getZoomFactor() };
  }, url);
  const ratio = await tabPage.evaluate(() => window.devicePixelRatio);
  return { width: view.width, height: view.height, scale: ratio / view.zoom };
}
/** Where the page is scrolled (CSS px; a fractional device ratio snaps it to device pixels). */
const scrollY = () => tabPage.evaluate(() => window.scrollY);

/** Presses a Screenshot button and waits for its outcome (`saved` answers the one new file, read and checked). */
async function shoot(kind: 'viewport' | 'full'): Promise<{ name: string; bytes: Buffer }> {
  const before = files();
  await expect(shotButton(kind)).toBeEnabled();
  await shotButton(kind).click();
  await expect(status()).toHaveAttribute('data-outcome', 'saved', { timeout: 30_000 });
  return newFile(before);
}

function newFile(before: readonly string[]): { name: string; bytes: Buffer } {
  const added = files().filter((name) => !before.includes(name));
  expect(added).toHaveLength(1);
  const name = added[0]!;
  return { name, bytes: readFileSync(path.join(shotsDir, name)) };
}

/** Starts Select area and waits for the selector's host to be in the page (the page sees one element, never inside it). */
async function startArea(): Promise<void> {
  await expect(shotButton('area')).toBeEnabled();
  await shotButton('area').click();
  await expect(areaHint()).toContainText(AREA_SELECT_HINT);
  await expect.poll(() => tabPage.evaluate(() => document.documentElement.childElementCount)).toBe(3);
}

/** Drags from (x1, y1) to (x2, y2) on the tab's page with Playwright's (trusted) mouse. */
async function drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await tabPage.mouse.move(x1, y1);
  await tabPage.mouse.down();
  await tabPage.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
  await tabPage.mouse.move(x2, y2, { steps: 4 });
  await tabPage.mouse.up();
}

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
  shotsDir = path.join(await app.evaluate(({ app }) => app.getPath('userData')), CAPTURES_DIR_NAME, SCREENSHOTS_DIR_NAME);
  url = `${site.origin}/bands`;
  await go(url);
  tabPage = await pageAt(app, url);
  await tabPage.waitForLoadState('load');
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'changes') {
    await page.locator('[data-testid="seo-rail-item"][data-panel="changes"]').click();
  }
  await expect(page.getByTestId('changes')).toBeVisible();
  await expect(page.getByTestId('screenshots')).toHaveAttribute('data-state', 'ready');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test('screenshot-viewport', async () => {
  await expect(page.getByTestId('screenshots-empty')).toBeVisible();
  // The full page's scrolling is said beside it.
  await expect(page.getByTestId('screenshot-full-note')).toHaveText(FULL_PAGE_SCROLL_NOTE);
  await expect(shotButton('full')).toHaveAttribute('title', FULL_PAGE_SCROLL_NOTE);
  const dom = await pageDom();
  const { name, bytes } = await shoot('viewport');
  await expect(status()).toHaveText(/^Saved a screenshot of the viewport \(.+ px\)\.$/);
  // Under the profile, named by its own SHA-256, private to the user.
  expect(name).toMatch(/^[0-9a-f]{64}\.png$/);
  expect(SHA256_HEX_PATTERN.test(name.slice(0, 64))).toBe(true);
  expect(sha256(bytes)).toBe(name.slice(0, 64));
  if (process.platform !== 'win32') {
    expect(statSync(path.join(shotsDir, name)).mode & 0o777).toBe(0o600);
    expect(statSync(shotsDir).mode & 0o777).toBe(0o700);
  }
  // As wide as the view, in device pixels.
  const view = await viewMetrics();
  const size = pngSize(bytes);
  expect(Math.abs(size.width - Math.round(view.width * view.scale))).toBeLessThanOrEqual(1);
  expect(Math.abs(size.height - Math.round(view.height * view.scale))).toBeLessThanOrEqual(1);
  // The gallery shows it: a data: thumbnail, its kind, size and profile.
  await expect(gallery()).toHaveCount(1);
  await expect(gallery().first().getByTestId('screenshot-thumb')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(gallery().first().getByTestId('screenshot-kind')).toHaveText('Viewport');
  await expect(gallery().first().getByTestId('screenshot-size')).toContainText(`${size.width.toLocaleString('en-US')} × ${size.height.toLocaleString('en-US')} px`);
  await expect(gallery().first().getByTestId('screenshot-profile')).toHaveText('Default');
  // Preview: a larger inline image, closed again.
  await gallery().first().getByTestId('screenshot-preview-toggle').click();
  await expect(gallery().first().getByTestId('screenshot-preview-image')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await gallery().first().getByTestId('screenshot-preview-close').click();
  await expect(gallery().first().getByTestId('screenshot-preview')).toHaveCount(0);
  // Copy image puts it on the clipboard (main's).
  await gallery().first().getByTestId('screenshot-copy').click();
  await expect(gallery().first().getByTestId('screenshot-feedback')).toHaveText('Image copied.');
  expect(await pageDom()).toBe(dom);
  // No inline styles in the panel (strict CSP).
  expect(await page.getByTestId('changes').evaluate((root) => root.querySelectorAll('[style]').length)).toBe(0);
});

test('screenshot-full-page', async () => {
  // The page scrolled part-way down: it is put back there afterwards.
  await tabPage.evaluate(() => window.scrollTo({ top: 240, behavior: 'instant' }));
  await expect.poll(async () => Math.abs((await scrollY()) - 240)).toBeLessThan(1);
  const scrolled = await scrollY();
  const { innerHeight, scrollHeight } = await tabPage.evaluate(() => ({ innerHeight: window.innerHeight, scrollHeight: document.scrollingElement!.scrollHeight }));
  expect(scrollHeight).toBeGreaterThanOrEqual(innerHeight * 2.5);
  const dom = await pageDom();
  const started = Date.now();
  const { name, bytes } = await shoot('full');
  const took = Date.now() - started;
  console.log(`screenshot-full-page: ${took} ms for ${scrollHeight} CSS px (${innerHeight} px viewport)`);
  await expect(status()).toHaveText(/^Saved a full-page screenshot \(.+ px\)\.$/);
  expect(sha256(bytes)).toBe(name.slice(0, 64));
  const view = await viewMetrics();
  const size = pngSize(bytes);
  // Taller than the viewport: the whole document, every row once.
  expect(size.height).toBeGreaterThan(Math.round(view.height * view.scale));
  expect(Math.abs(size.height - Math.round(scrollHeight * view.scale))).toBeLessThanOrEqual(2);
  // The scrollbar is cropped: no wider than the view.
  expect(size.width).toBeLessThanOrEqual(Math.round(view.width * view.scale));
  // The scroll position is restored, and the page's DOM is as it was.
  await expect.poll(scrollY).toBe(scrolled);
  expect(await pageDom()).toBe(dom);
  await expect(gallery()).toHaveCount(2);
  await expect(gallery().first().getByTestId('screenshot-kind')).toHaveText('Full page');
});

test('screenshot-area', async () => {
  await tabPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const dom = await pageDom();
  const before = files();
  await startArea();
  await drag(100, 150, 300, 250);
  await expect(status()).toHaveAttribute('data-outcome', 'saved', { timeout: 15_000 });
  await expect(status()).toHaveText(/^Saved a screenshot of the selected area \(.+ px\)\.$/);
  await expect(areaHint()).toHaveCount(0);
  const { name, bytes } = newFile(before);
  expect(sha256(bytes)).toBe(name.slice(0, 64));
  // About the selected size (200 × 100 CSS px), in device pixels.
  const { scale } = await viewMetrics();
  const size = pngSize(bytes);
  expect(Math.abs(size.width - 200 * scale)).toBeLessThanOrEqual(2 * scale);
  expect(Math.abs(size.height - 100 * scale)).toBeLessThanOrEqual(2 * scale);
  // The overlay is gone and nothing in the page changed.
  expect(await pageDom()).toBe(dom);
  await expect(gallery()).toHaveCount(3);
  await expect(gallery().first().getByTestId('screenshot-kind')).toHaveText('Area');
});

test('screenshot-area-esc-cancels', async () => {
  const dom = await pageDom();
  const before = files();
  await startArea();
  await tabPage.keyboard.press('Escape');
  await expect(status()).toHaveAttribute('data-outcome', 'cancelled');
  await expect(status()).toHaveText(SCREENSHOT_REFUSAL_MESSAGES.cancelled);
  await expect(areaHint()).toHaveCount(0);
  expect(files()).toEqual(before);
  expect(await pageDom()).toBe(dom);
  await expect(gallery()).toHaveCount(3);
});

test('screenshot-area-ignores-synthetic-events', async () => {
  const dom = await pageDom();
  const before = files();
  await startArea();
  // The page's own events, on its overlay's host, on what is under the pointer and on the body: none is trusted.
  await tabPage.evaluate(() => {
    const host = document.documentElement.lastElementChild!;
    const targets = [host, document.elementFromPoint(150, 150) ?? host, document.body];
    for (const target of targets) {
      for (const [type, x, y] of [
        ['pointerdown', 50, 60],
        ['pointermove', 200, 220],
        ['pointerup', 260, 280],
      ] as const) {
        target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, composed: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), { clientX: x, clientY: y, button: 0, bubbles: true, composed: true, cancelable: true }));
      }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  // Still selecting: nothing saved, nothing cancelled.
  await page.waitForTimeout(600);
  await expect(areaHint()).toBeVisible();
  await expect(status()).toHaveAttribute('data-outcome', '');
  expect(files()).toEqual(before);
  // The chrome's Cancel ends it.
  await page.getByTestId('screenshot-area-cancel').click();
  await expect(status()).toHaveAttribute('data-outcome', 'cancelled');
  await expect(areaHint()).toHaveCount(0);
  expect(files()).toEqual(before);
  expect(await pageDom()).toBe(dom);
});

test('screenshot-leaves-page-dom-unchanged', async () => {
  await tabPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const dom = await pageDom();
  // Each kind adds a row (an image equal to an earlier one shares its file, named by its hash).
  for (const kind of ['viewport', 'full', 'area'] as const) {
    const count = await gallery().count();
    if (kind === 'area') {
      await startArea();
      await drag(20, 300, 120, 360);
    } else await shotButton(kind).click();
    await expect(gallery()).toHaveCount(count + 1, { timeout: 30_000 });
    await expect(status()).toHaveAttribute('data-outcome', 'saved');
    expect(await pageDom(), kind).toBe(dom);
  }
  expect(files().length).toBeLessThanOrEqual(await gallery().count());
  // (Reveal in folder is not pressed here: it would open the system's file manager.) No inline styles.
  await expect(gallery().first().getByTestId('screenshot-reveal')).toBeEnabled();
  expect(await page.getByTestId('changes').evaluate((root) => root.querySelectorAll('[style]').length)).toBe(0);
});

test('annotate-crop-and-save-a-copy', async () => {
  // A viewport screenshot at a scroll position no other test uses (so its file is new).
  await tabPage.evaluate(() => window.scrollTo({ top: 137, behavior: 'instant' }));
  await expect.poll(async () => Math.abs((await scrollY()) - 137)).toBeLessThan(1);
  const listed = (await gallery().count()) + 1;
  const { name: sourceName, bytes: sourceBytes } = await shoot('viewport');
  const source = pngSize(sourceBytes);
  await expect(gallery()).toHaveCount(listed);
  const before = files();

  // Open it in the editor: a sheet over the page column (the tab's view is hidden meanwhile).
  await gallery().first().getByTestId('screenshot-edit').click();
  const editor = page.getByTestId('screenshot-editor');
  await expect(editor).toHaveAttribute('data-state', 'ready');
  const canvas = page.getByTestId('screenshot-editor-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await page.getByTestId('page-area').boundingBox())?.height ?? 0).toBeLessThan(1);
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const dragOnCanvas = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
  };

  // An arrow, undone and redone, undone again.
  await page.getByTestId('screenshot-editor-tool-arrow').click();
  await dragOnCanvas(at(0.7, 0.7), at(0.8, 0.8));
  await expect(page.getByTestId('screenshot-editor-undo')).toBeEnabled();
  await page.getByTestId('screenshot-editor-undo').click();
  await expect(page.getByTestId('screenshot-editor-redo')).toBeEnabled();
  await page.getByTestId('screenshot-editor-redo').click();
  await page.getByTestId('screenshot-editor-undo').click();
  // A filled blue box, then a crop around it.
  await page.getByTestId('screenshot-editor-tool-box').click();
  await page.getByTestId('screenshot-editor-filled').check();
  await page.locator('[data-testid="screenshot-editor-color"][data-color="#0090ff"]').click();
  await dragOnCanvas(at(0.2, 0.2), at(0.4, 0.4));
  await page.getByTestId('screenshot-editor-tool-crop').click();
  await dragOnCanvas(at(0.1, 0.1), at(0.6, 0.6));
  await page.getByTestId('screenshot-editor-save').click();
  const outcome = page.getByTestId('screenshot-editor-status');
  await expect(outcome).toHaveAttribute('data-outcome', 'saved', { timeout: 30_000 });
  await expect(outcome).toHaveText(SCREENSHOT_EDIT_RESULT_MESSAGES.saved);

  // A second file, named by its own hash, the size of the crop (half the shot, give or take rounding).
  const { name, bytes } = newFile(before);
  expect(sha256(bytes)).toBe(name.slice(0, 64));
  const size = pngSize(bytes);
  expect(Math.abs(size.width - source.width * 0.5)).toBeLessThanOrEqual(4);
  expect(Math.abs(size.height - source.height * 0.5)).toBeLessThanOrEqual(4);
  // The source is byte-for-byte as it was.
  expect(readFileSync(path.join(shotsDir, sourceName))).toEqual(sourceBytes);
  // Under the box (its centre: 0.3 of the shot, 0.2 of it inside the crop) the pixels are the box's colour;
  // the crop's corner is the page's.
  const pixels = await app.evaluate(({ nativeImage }, { file, points }) => {
    const image = nativeImage.createFromPath(file);
    const { width } = image.getSize();
    const bitmap = image.toBitmap();
    return points.map(([x, y]) => [...bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]);
  }, { file: path.join(shotsDir, name), points: [[Math.round(source.width * 0.2), Math.round(source.height * 0.2)], [2, 2]] as [number, number][] });
  expect(pixels[0]).toEqual([0xff, 0x90, 0x00, 0xff]);
  expect(pixels[1]).not.toEqual([0xff, 0x90, 0x00, 0xff]);

  // Close: the gallery lists both, the copy first and labelled Edited; the tab's view is back.
  await page.getByTestId('screenshot-editor-close').click();
  await expect(editor).toHaveCount(0);
  await expect(gallery()).toHaveCount(listed + 1);
  await expect(gallery().first().getByTestId('screenshot-edited')).toHaveText('Edited');
  await expect(gallery().nth(1).getByTestId('screenshot-edited')).toHaveCount(0);
  await expect(gallery().first().getByTestId('screenshot-size')).toContainText(`${size.width.toLocaleString('en-US')} × ${size.height.toLocaleString('en-US')} px`);
  await expect.poll(async () => (await page.getByTestId('page-area').boundingBox())?.height ?? 0).toBeGreaterThan(100);
  expect(await page.getByTestId('changes').evaluate((root) => root.querySelectorAll('[style]').length)).toBe(0);
});

test('screenshot-editor-one-sheet-at-a-time', async () => {
  // A screenshot to open (any: the gallery lists at least one by now, or this one).
  if ((await gallery().count()) === 0) await shoot('viewport');
  const editor = page.getByTestId('screenshot-editor');
  const openEditor = async () => {
    await gallery().first().getByTestId('screenshot-edit').click();
    await expect(editor).toBeVisible();
  };
  // Each sheet opening closes the editor, and the editor opening closes it.
  const sheets: { name: string; open: () => Promise<void>; testId: string }[] = [
    { name: 'Settings', open: () => menu('settings'), testId: 'settings-view' },
    { name: 'History', open: () => menu(HISTORY_MENU_ID), testId: 'history-view' },
    { name: 'Keyboard shortcuts', open: () => menu('help-shortcuts'), testId: 'shortcuts-view' },
    { name: 'Projects', open: () => page.getByTestId('changes-open-projects').click(), testId: 'projects-view' },
  ];
  for (const sheet of sheets) {
    await openEditor();
    await sheet.open();
    await expect(page.getByTestId(sheet.testId), sheet.name).toBeVisible();
    await expect(editor, `${sheet.name} closes the editor`).toHaveCount(0);
    await openEditor();
    await expect(page.getByTestId(sheet.testId), `the editor closes ${sheet.name}`).toHaveCount(0);
    await page.getByTestId('screenshot-editor-close').click();
    await expect(editor).toHaveCount(0);
  }
});
