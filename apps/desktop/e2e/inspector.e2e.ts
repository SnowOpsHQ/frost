// Specs: specs/inspector.spec.ts (INSPECTOR_PICK_HINT, INSPECTOR_REFUSAL_MESSAGES, INSPECTOR_REGION_LABELS, INSPECTOR_LABELS,
// INSPECTOR_SOURCE_NOTES)
// Acceptance: specs/inspector.feature.md (End to end; Phase 11 Task 5: inspector-search-selects-node, rendered-and-served-source)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { INSPECTOR_LABELS, INSPECTOR_PICK_HINT, INSPECTOR_REFUSAL_MESSAGES, INSPECTOR_REGION_LABELS, INSPECTOR_SOURCE_NOTES } from '@app/specs/inspector.spec';
import { closeApp, launchApp, pageAt } from './harness';
import { chromeHelpers } from './helpers';

/**
 * A page with landmarks, an H1, a link and a frame holding a link of its own. Its own capture
 * listeners on `document` record every click and context menu they hear (the picker stops the user's
 * on `window`, before them).
 */
const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inspect me</title>
<meta name="description" content="A page to inspect"><style>body{margin:0;font:16px sans-serif}h1{margin:40px 20px;font-size:40px}p{margin:20px}</style></head>
<body><header><nav><a href="/other">Other page</a></nav></header><main><h1 id="title" class="hero">Inspect me</h1><p>Some text and <a id="go" href="/other">a link</a>.</p>
<iframe id="frame" title="frame" srcdoc="<a id='in' href='/other' style='display:block;font:30px sans-serif;padding:20px'>Frame link</a>"></iframe></main><footer>Foot</footer>
<script>window.__heard = []; window.__menus = []; document.addEventListener('click', (event) => window.__heard.push(event.isTrusted), true);
document.addEventListener('contextmenu', (event) => window.__menus.push(event.isTrusted), true);
const added = document.createElement('div'); added.id = 'added'; added.textContent = 'Built by ' + 'the page'; document.body.append(added);</script></body></html>`;
const OTHER_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Other</title></head><body><main><h2>Another page</h2></main></body></html>';

async function startSite() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const body = pathname === '/inspect' ? PAGE_HTML : pathname === '/other' ? OTHER_HTML : null;
    if (body === null) response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
    else response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
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
const { go } = chromeHelpers(
  () => app,
  () => page,
);

const row = (path: string) => page.locator(`[data-testid="inspector-row"][data-path="${path}"]`);
const details = () => page.getByTestId('inspector-details');
const fact = (testId: string, name: string) => page.getByTestId(testId).locator(`[data-name="${name}"] dd`);
const hint = () => page.getByTestId('inspector-pick-hint');
const pageDom = () => tabPage.evaluate(() => document.documentElement.outerHTML);
/** Element children of the tab's `<html>`: 2, or 3 while the inspector's overlay host is in it. */
const htmlChildren = () => tabPage.evaluate(() => document.documentElement.childElementCount);

/** Opens the Inspector panel on the tab and waits for its tree. */
async function openInspector(): Promise<void> {
  if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'inspector') {
    await page.locator('[data-testid="seo-rail-item"][data-panel="inspector"]').click();
  }
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-state', 'ready');
  await expect(row('')).toBeVisible();
}

/** Starts Pick element and waits for the overlay host to be in the page. */
async function startPick(): Promise<void> {
  await page.getByTestId('inspector-pick').click();
  await expect(hint()).toContainText(INSPECTOR_PICK_HINT);
  await expect.poll(htmlChildren).toBe(3);
}

/** Moves the user's (trusted) mouse onto the centre of `selector` in the tab's page, and clicks there. */
async function clickOnPage(selector: string): Promise<void> {
  const box = await tabPage.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await tabPage.mouse.move(x - 10, y, { steps: 3 });
  await tabPage.mouse.move(x, y, { steps: 3 });
  await tabPage.mouse.click(x, y);
}

/** Leaves the tree (its row outline goes) and takes the selection outline off; waits for the overlay host to leave the page. */
async function clearOutline(): Promise<void> {
  await page.getByTestId('inspector-pick').hover();
  await page.getByTestId('inspector-pick').focus();
  if (await page.getByTestId('inspector-clear').isVisible()) await page.getByTestId('inspector-clear').click();
  await expect.poll(htmlChildren).toBe(2);
}

/** The context menus main popped up (recorded instead of shown). */
const frostMenus = () => app.evaluate(() => (globalThis as unknown as { __contextMenus: unknown[] }).__contextMenus.length);
const pageMenus = () => tabPage.evaluate(() => (window as unknown as { __menus: boolean[] }).__menus);
/** Where the frame's document is (`about:srcdoc` until its link is followed). */
const frameUrl = () => tabPage.evaluate(() => (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.location.href);

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
  // No native context menu in the test: record each menu main pops up instead of showing it.
  await app.evaluate(({ Menu }) => {
    const record = globalThis as unknown as { __contextMenus: Electron.Menu[] };
    record.__contextMenus = [];
    Menu.prototype.popup = function (this: Electron.Menu) {
      record.__contextMenus.push(this);
    };
  });
  url = `${site.origin}/inspect`;
  await go(url);
  tabPage = await pageAt(app, url);
  await tabPage.waitForLoadState('load');
  await openInspector();
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test('inspector-tree-expands-to-h1', async () => {
  // `<html>` is open at first: head and body.
  await expect(row('')).toHaveAttribute('aria-expanded', 'true');
  await expect(row('')).toHaveAttribute('aria-level', '1');
  await expect(row('1')).toHaveAttribute('data-tag', 'body');
  await expect(row('1')).toHaveAttribute('aria-expanded', 'false');
  // The keyboard: focus the root, ↓ ↓ to body, → opens it, ↓ ↓ to main, → opens it, → into the H1, Enter.
  await row('').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(row('1')).toBeFocused();
  await expect(row('1')).toHaveAttribute('tabindex', '0');
  await expect(row('')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(row('1')).toHaveAttribute('aria-expanded', 'true');
  await expect(row('1.1')).toHaveAttribute('data-tag', 'main');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(row('1.1')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(row('1.1.0')).toHaveAttribute('data-tag', 'h1');
  await expect(row('1.1.0')).toHaveAttribute('aria-level', '4');
  await page.keyboard.press('ArrowRight');
  await expect(row('1.1.0')).toBeFocused();
  // The row shows `<h1#title.hero>` and its text, as text.
  await expect(row('1.1.0').locator('.inspector-tag')).toHaveText('<h1#title.hero>');
  await expect(row('1.1.0').locator('.inspector-preview')).toHaveText('Inspect me');
  await page.keyboard.press('Enter');
  await expect(details()).toHaveAttribute('data-tag', 'h1');
  await expect(row('1.1.0')).toHaveAttribute('aria-selected', 'true');
  await expect(fact('inspector-seo', 'Heading level')).toHaveText('H1');
  // ← goes back up to main, and closes it.
  await page.keyboard.press('ArrowLeft');
  await expect(row('1.1')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row('1.1')).toHaveAttribute('aria-expanded', 'false');
  await expect(row('1.1.0')).toHaveCount(0);
  await clearOutline();
});

test('inspector-pick-by-mouse', async () => {
  await tabPage.evaluate(() => void ((window as unknown as { __heard: boolean[] }).__heard.length = 0));
  await startPick();
  await clickOnPage('h1');
  await expect(hint()).toHaveCount(0);
  await expect(page.getByTestId('inspector-status')).toHaveText('Element picked.');
  // The tree opens down to the H1 and selects it; its details show.
  await expect(row('1.1.0')).toHaveAttribute('aria-selected', 'true');
  await expect(row('1.1.0')).toBeFocused();
  await expect(details()).toHaveAttribute('data-tag', 'h1');
  await expect(fact('inspector-summary', 'Tag')).toHaveText('<h1>');
  await expect(fact('inspector-summary', 'Region')).toHaveText(INSPECTOR_REGION_LABELS.main);
  await expect(fact('inspector-seo', 'Heading level')).toHaveText('H1');
  await expect(fact('inspector-seo', 'Language')).toHaveText('en');
  await expect(fact('inspector-styles', 'display')).toHaveText('block');
  await expect(fact('inspector-styles', 'font-size')).toHaveText('40px');
  await expect(page.getByTestId('inspector-attributes').locator('tbody tr')).toHaveCount(2);
  // The page's own capture listener on `document` never heard the click; the selection outline stays.
  expect(await tabPage.evaluate(() => (window as unknown as { __heard: boolean[] }).__heard)).toEqual([]);
  expect(await htmlChildren()).toBe(3);
  await clearOutline();
});

test('inspector-pick-covers-frames-and-menus', async () => {
  await expect.poll(() => tabPage.evaluate(() => (document.getElementById('frame') as HTMLIFrameElement).contentDocument?.getElementById('in') !== null)).toBe(true);
  expect(await frameUrl()).toBe('about:srcdoc');
  const menus = await frostMenus();
  await startPick();
  // A right-click while picking opens no menu: neither the page's nor frost's.
  const h1 = (await tabPage.locator('h1').boundingBox())!;
  await tabPage.mouse.click(h1.x + h1.width / 2, h1.y + h1.height / 2, { button: 'right' });
  await page.waitForTimeout(300);
  expect(await pageMenus()).toEqual([]);
  expect(await frostMenus()).toBe(menus);
  await expect(hint()).toBeVisible();
  // A click over the frame picks the frame: its link is not followed.
  await clickOnPage('#frame');
  await expect(details()).toHaveAttribute('data-tag', 'iframe');
  await expect(row('1.1.2')).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(300);
  expect(await frameUrl()).toBe('about:srcdoc');
  expect(tabPage.url()).toBe(url);
  await clearOutline();
  // Not picking, the page's right-click is its own again (and frost's menu opens).
  await tabPage.mouse.click(h1.x + h1.width / 2, h1.y + h1.height / 2, { button: 'right' });
  await expect.poll(pageMenus).toEqual([true]);
  await expect.poll(frostMenus).toBe(menus + 1);
});

test('inspector-ignores-synthetic-click', async () => {
  const dom = await pageDom();
  await startPick();
  // The page clicks its own H1 and presses its own Esc: nothing is picked, nothing ends.
  await tabPage.evaluate(() => {
    const h1 = document.querySelector('h1')!;
    for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) h1.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, composed: true, cancelable: true, button: 0 }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.waitForTimeout(600);
  await expect(hint()).toBeVisible();
  await expect(page.getByTestId('inspector-status')).not.toHaveText('Element picked.');
  // The user's Esc on the page cancels.
  await tabPage.keyboard.press('Escape');
  await expect(hint()).toHaveCount(0);
  await expect(page.getByTestId('inspector-status')).toHaveText(INSPECTOR_REFUSAL_MESSAGES.cancelled);
  await expect.poll(htmlChildren).toBe(2);
  expect(await pageDom()).toBe(dom);
});

test('inspector-leaves-page-dom-unchanged', async () => {
  const dom = await pageDom();
  // Hovering tree rows outlines their nodes; picking the link neither follows it nor changes the page.
  await row('1').hover();
  await expect.poll(htmlChildren).toBe(3);
  await row('').hover();
  await startPick();
  await clickOnPage('#go');
  await expect(details()).toHaveAttribute('data-tag', 'a');
  await expect(fact('inspector-seo', 'Link')).toHaveText(`${site.origin}/other`);
  await expect(fact('inspector-summary', 'Region')).toHaveText(INSPECTOR_REGION_LABELS.main);
  expect(tabPage.url()).toBe(url);
  await page.getByTestId('inspector-clear').click();
  await expect.poll(htmlChildren).toBe(2);
  expect(await pageDom()).toBe(dom);
  expect(tabPage.url()).toBe(url);
});

/** Shows the Inspector's `view` (tree, rendered or served). */
async function showView(view: 'tree' | 'rendered' | 'served'): Promise<void> {
  await page.locator(`[data-testid="inspector-view"][data-view="${view}"]`).click();
  await expect(page.locator(`[data-testid="inspector-view"][data-view="${view}"]`)).toHaveAttribute('aria-pressed', 'true');
}
/** The source rows' text, joined by line breaks (a wrapped line's rows run on). */
const sourceText = () => page.getByTestId('inspector-source-row').evaluateAll((rows) => rows.map((row) => `${row.hasAttribute('data-line') && row.getAttribute('data-row') !== '0' ? '\n' : ''}${row.querySelector('bdi')?.textContent ?? ''}`).join(''));

test('inspector-search-selects-node', async () => {
  await showView('tree');
  // A CSS selector: the H1, chosen from the matches, opens the tree to it and shows its details.
  await page.getByTestId('inspector-search-mode').selectOption('selector');
  await page.getByTestId('inspector-search-query').fill('main h1.hero');
  await page.getByTestId('inspector-search-run').click();
  await expect(page.getByTestId('inspector-search-status')).toHaveText('1 match');
  const match = page.getByTestId('inspector-search-match');
  await expect(match).toHaveCount(1);
  await expect(match).toHaveAttribute('data-path', '1.1.0');
  await expect(match.locator('.inspector-tag')).toHaveText('<h1#title.hero>');
  await match.click();
  await expect(row('1.1.0')).toHaveAttribute('aria-selected', 'true');
  await expect(details()).toHaveAttribute('data-tag', 'h1');
  await expect(fact('inspector-seo', 'Heading level')).toHaveText('H1');
  // Own text, case-insensitive: the link inside the paragraph.
  await page.getByTestId('inspector-search-mode').selectOption('text');
  await page.getByTestId('inspector-search-query').fill('A LINK');
  await page.getByTestId('inspector-search-query').press('Enter');
  await expect(page.getByTestId('inspector-search-match')).toHaveCount(1);
  await expect(page.getByTestId('inspector-search-match')).toHaveAttribute('data-tag', 'a');
  await page.getByTestId('inspector-search-match').click();
  await expect(details()).toHaveAttribute('data-tag', 'a');
  await expect(row('1.1.1.0')).toHaveAttribute('aria-selected', 'true');
  // A selector the page's browser does not understand.
  await page.getByTestId('inspector-search-mode').selectOption('selector');
  await page.getByTestId('inspector-search-query').fill('h1[');
  await page.getByTestId('inspector-search-run').click();
  await expect(page.getByTestId('inspector-search-status')).toHaveText(INSPECTOR_REFUSAL_MESSAGES['invalid-selector']);
  await expect(page.getByTestId('inspector-search-match')).toHaveCount(0);
  await clearOutline();
});

test('rendered-and-served-source', async () => {
  const dom = await pageDom();
  // Rendered: the doctype and the page as it is now (the page's script added an element), all as text.
  await showView('rendered');
  await expect(page.getByTestId('inspector-source')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('inspector-source')).toContainText(INSPECTOR_SOURCE_NOTES.rendered);
  await expect(page.getByTestId('inspector-source-row').first()).toHaveText(/^1<!DOCTYPE html>$/);
  const rendered = await sourceText();
  expect(rendered).toBe(`<!DOCTYPE html>\n${dom}`);
  expect(rendered).toContain('<div id="added">Built by the page</div>');
  // The page's markup is text in the chrome: no element of the page's became one of the chrome's.
  expect(await page.locator('[data-testid="inspector-source-lines"] script, [data-testid="inspector-source-lines"] iframe, [data-testid="inspector-source-lines"] h1').count()).toBe(0);
  // Find in source marks a row and moves to it.
  await page.getByTestId('inspector-find').fill('INSPECT ME');
  await page.getByTestId('inspector-find').press('Enter');
  await expect(page.getByTestId('inspector-find-count')).toHaveText(/^1 \/ [1-9]\d*$/);
  await expect(page.locator('[data-testid="inspector-source-row"][aria-current="true"]')).toContainText('Inspect me');
  // Copy source: main writes its own reading of the source.
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await page.getByTestId('inspector-copy-source').click();
  await expect(page.getByTestId('inspector-source-status')).toHaveText(INSPECTOR_LABELS.sourceCopied);
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`<!DOCTYPE html>\n${dom}`);

  // Served: the HTML as the server sent it to the audit's fetch (no element added by the script).
  await showView('served');
  await expect(page.getByTestId('inspector-source')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(page.getByTestId('inspector-source')).toContainText(INSPECTOR_SOURCE_NOTES.served);
  const served = await sourceText();
  expect(served).toBe(PAGE_HTML);
  expect(served).not.toContain('<div id="added">');
  await page.getByTestId('inspector-copy-source').click();
  await expect(page.getByTestId('inspector-source-status')).toHaveText(INSPECTOR_LABELS.sourceCopied);
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(PAGE_HTML);
  // Reading sources changed nothing on the page.
  expect(await pageDom()).toBe(dom);
  // An in-page move to another URL: the served view reads again, for that URL; the old URL's source
  // is no longer shown (the audit fetches the new one, here the same page; Read again shows it).
  await tabPage.evaluate(() => history.pushState({}, '', '/inspect?pushed=1'));
  await expect(page.getByTestId('inspector-source')).not.toHaveAttribute('data-state', 'ok');
  await expect(async () => {
    if ((await page.getByTestId('inspector-source').getAttribute('data-state')) === 'message') await page.getByTestId('inspector-read-source').click();
    await expect(page.getByTestId('inspector-source')).toHaveAttribute('data-state', 'ok', { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  expect(await sourceText()).toBe(PAGE_HTML);
  await page.getByTestId('inspector-copy-source').click();
  await expect(page.getByTestId('inspector-source-status')).toHaveText(INSPECTOR_LABELS.sourceCopied);
  await tabPage.evaluate(() => history.pushState({}, '', '/inspect'));
  await showView('tree');
  await expect(row('')).toBeVisible();
});

test('inspector-stale-after-navigation', async () => {
  await expect(page.getByTestId('inspector-note')).toHaveCount(0);
  await go(`${site.origin}/other`);
  // The panel's token was for the old document: the tree is read again from the top, with the note.
  await expect(page.getByTestId('inspector-note')).toHaveText(INSPECTOR_REFUSAL_MESSAGES.stale);
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-state', 'ready');
  await expect(row('1')).toHaveAttribute('aria-expanded', 'false');
  await row('1').locator('[data-testid="inspector-twisty"]').click();
  await expect(row('1.0')).toHaveAttribute('data-tag', 'main');
  await row('1.0').locator('[data-testid="inspector-twisty"]').click();
  await expect(row('1.0.0')).toHaveAttribute('data-tag', 'h2');
  await expect(details()).toHaveCount(0);
});
