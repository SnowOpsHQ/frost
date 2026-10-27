// Specs: specs/seo-content.spec.ts (SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS, TARGET_QUERY_PLACES, Copy as HTML),
// specs/seo-sidebar.spec.ts (SEO_PANELS), specs/seo-limits.spec.ts
// Acceptance: specs/seo-content.feature.md (End to end)
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { textWidth } from '@app/seo-core';
import { SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS } from '@app/specs/seo-content.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { SEO_PANELS } from '@app/specs/seo-sidebar.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

const WIDE_TITLE = 'Green tea for beginners: how to choose, brew and store loose leaf green tea at home, step by step';
const DESCRIPTION = 'How to choose green tea, brew it at the right temperature for the leaf, and store the leaves so they keep their fresh taste for months.';

/** An English article: repeated phrases, enough prose for readability, a title wider than a result shows. */
function article(): string {
  const prose = [
    'Green tea is made from leaves that are steamed or pan fired soon after picking.',
    'Good green tea tastes fresh and sweet when the water is not too hot.',
    'Brew green tea for two minutes, then taste it and pour the rest.',
    'Store loose leaf tea in a dark and airtight tin, away from strong smells.',
    'A small pot of green tea is a calm way to start the day.',
  ];
  const paragraphs = Array.from({ length: 6 }, (_, i) => `<p>${prose.map((s, j) => (i + j) % 2 === 0 ? s : s.replace('green tea', 'loose leaf tea')).join(' ')}</p>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${WIDE_TITLE}</title>
<meta name="description" content="${DESCRIPTION}"></head>
<body><header><nav><a href="/">Home</a> <a href="/guides/">Guides</a></nav></header>
<main><h1>Green tea for beginners</h1>${paragraphs}<h2>Brewing green tea</h2><p>Use water at about eighty degrees.</p><h2>Storing the leaves</h2><p>Keep them cool.</p></main></body></html>`;
}

/** Markup, a script-looking title and bidi overrides in every value the Content panel shows. */
const INERT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>&lt;img src=x onerror=top.__pwned=1&gt; ‮evil title</title>
<meta name="description" content="&lt;script&gt;top.__pwned=2&lt;/script&gt; described"></head>
<body><h1>&lt;b&gt;bold&lt;/b&gt; heading</h1><p>&lt;img src=x onerror=top.__pwned=3&gt; &lt;img src=x onerror=top.__pwned=3&gt; ‮reversed ‮reversed</p></body></html>`;

async function startSite() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    if (pathname === '/guides/green-tea') html(article());
    else if (pathname === '/inert') html(INERT_PAGE);
    else html('<!doctype html><html lang="en"><title>loopback</title><p>loopback</p></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: ElectronApplication | undefined;
let page: Page;
let profile: string;
let site: Awaited<ReturnType<typeof startSite>>;
const { go } = chromeHelpers(
  () => app!,
  () => page,
);

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;
const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const articleUrl = () => `${site.origin}/guides/green-tea`;

async function launch(): Promise<void> {
  ({ app, page } = await launchApp([], { userDataDir: profile }));
  await page.waitForLoadState('domcontentloaded');
}

/** Loads `url` and opens the Content panel on its ready audit. */
async function openContent(url: string): Promise<void> {
  await go(url);
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'content') await railItem('content').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'content');
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`, { timeout: AUDIT_WAIT });
  await expect(page.getByTestId('seo-content')).toBeVisible({ timeout: AUDIT_WAIT });
}

test.beforeAll(async () => {
  site = await startSite();
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-content-'));
  await launch();
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('content-panel-on-article', async () => {
  await expect(page.getByTestId('seo-rail-item')).toHaveCount(SEO_PANELS.length);
  await expect(railItem('content')).toHaveAttribute('aria-label', 'Content');
  await openContent(articleUrl());
  // n-grams: counts as information, with where each phrase appears.
  await page.locator('[data-testid="seo-ngram-size"][data-size="2"]').click();
  const greenTea = page.getByTestId('seo-ngram').filter({ has: page.getByTestId('seo-ngram-text').getByText('green tea', { exact: true }) });
  await expect(greenTea).toHaveCount(1);
  await expect(greenTea.locator('[data-place="title"]')).toHaveAttribute('data-present', 'true');
  await expect(greenTea.locator('[data-place="h1"]')).toHaveAttribute('data-present', 'true');
  await expect(greenTea.locator('[data-place="description"]')).toHaveAttribute('data-present', 'true');
  await expect(greenTea.locator('[data-place="url"]')).toHaveAttribute('data-present', 'true');
  // Bars are SVG attributes, never inline styles.
  expect(await page.getByTestId('seo-content').evaluate((root) => root.querySelectorAll('[style]').length)).toBe(0);
  await page.locator('[data-testid="seo-ngram-size"][data-size="1"]').click();
  // Stop-words are not 1-grams.
  const words = await page.getByTestId('seo-ngram-text').allTextContents();
  expect(words).toContain('tea');
  expect(words).not.toContain('the');
  await expect(page.getByTestId('seo-ngram-language')).toContainText('Language en (declared): common words removed.');
  // Readability: English, scored, with its band.
  await expect(page.getByTestId('seo-readability')).toHaveAttribute('data-status', 'ok');
  await expect(page.getByTestId('seo-readability-score')).toHaveText(/^-?\d+\.\d$/);
  await expect(page.getByTestId('seo-readability-band')).not.toBeEmpty();
});

test('snippet-editor-previews', async () => {
  await openContent(articleUrl());
  // The page's own title is wider than a desktop result shows: cut with an ellipsis, within budget.
  const desktopTitle = page.getByTestId('seo-serp-desktop-title');
  await expect(desktopTitle).toHaveAttribute('data-truncated', 'true');
  const shown = (await desktopTitle.textContent())!;
  expect(shown.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
  expect(WIDE_TITLE.startsWith(shown.slice(0, -1))).toBe(true);
  expect(textWidth(shown, 'title')).toBeLessThanOrEqual(SNIPPET_BUDGETS_PX.titleDesktop);
  await expect(page.getByTestId('seo-width-title')).toHaveAttribute('data-state', 'over');
  // The description fits on desktop but not on mobile.
  await expect(page.getByTestId('seo-serp-desktop-description')).toHaveText(DESCRIPTION);
  await expect(page.getByTestId('seo-serp-mobile-description')).toHaveAttribute('data-truncated', 'true');
  // The width rule says so too (On-Page's issue list is the Overview's; the panel's dot is warn).
  await expect(railItem('content')).toHaveAttribute('data-status', 'warn');
  // No favicon or other image is loaded into the chrome: the previews use a drawn glyph.
  expect(await sidebar().evaluate((root) => ({ img: root.querySelectorAll('img').length, glyphs: root.querySelectorAll('.seo-serp-glyph').length }))).toEqual({ img: 0, glyphs: 2 });

  // Copy as HTML of the page itself, through main.
  await app!.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await page.getByTestId('seo-snippet-copy-html').click();
  await expect(page.getByTestId('seo-content-flash')).toHaveText('Copied as HTML');
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(`<title>${WIDE_TITLE}</title>\n<meta name="description" content="${DESCRIPTION}">`);

  // A draft starts from the page's values; editing it updates both previews live.
  await page.getByTestId('seo-snippet-add').click();
  await expect(page.getByTestId('seo-draft-title')).toHaveValue(WIDE_TITLE);
  await page.getByTestId('seo-draft-title').fill('Green tea & <biscuits>: a short guide');
  await expect(desktopTitle).toHaveText('Green tea & <biscuits>: a short guide');
  await expect(desktopTitle).toHaveAttribute('data-truncated', 'false');
  await expect(page.getByTestId('seo-serp-mobile-title')).toHaveText('Green tea & <biscuits>: a short guide');
  await expect(page.getByTestId('seo-width-title')).toHaveAttribute('data-state', 'fits');
  await page.getByTestId('seo-draft-description').fill('Short "quoted" text.');
  await expect(page.getByTestId('seo-serp-mobile-description')).toHaveText('Short "quoted" text.');
  // Copy as HTML of the draft: saved first, escaped by main.
  await page.getByTestId('seo-snippet-copy-html').click();
  await expect(page.getByTestId('seo-content-flash')).toHaveText('Copied as HTML');
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('<title>Green tea &amp; &lt;biscuits&gt;: a short guide</title>\n<meta name="description" content="Short &quot;quoted&quot; text.">');
  // Back to the page's own snippet.
  await page.locator('[data-testid="seo-snippet-source"][data-source="page"]').click();
  await expect(desktopTitle).toHaveAttribute('data-truncated', 'true');
});

test('target-query-persists', async () => {
  await openContent(articleUrl());
  await page.getByTestId('seo-query-input').fill('green tea');
  const place = (name: string) => page.locator(`[data-testid="seo-query-place"][data-place="${name}"]`);
  await expect(place('title')).toHaveAttribute('data-presence', 'all');
  await expect(place('title')).toHaveAttribute('data-phrase', 'true');
  await expect(place('h1')).toHaveAttribute('data-phrase', 'true');
  await expect(place('url')).toHaveAttribute('data-presence', 'all');
  await expect(place('first-words')).toHaveAttribute('data-presence', 'all');
  await expect(place('headings')).toHaveAttribute('data-presence', 'all');
  await page.getByTestId('seo-query-input').fill('green tea kettle');
  await expect(place('title')).toHaveAttribute('data-presence', 'some');
  await expect(place('title')).toHaveAttribute('data-phrase', 'false');
  // Saved once typing pauses (the panel closing or the page changing saves it at once too): opening
  // the panel again reads it back from main.
  await railItem('overview').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'overview');
  await railItem('content').click();
  await expect(page.getByTestId('seo-query-input')).toHaveValue('green tea kettle');

  // A relaunch on the same profile: the query and the draft are still there.
  await closeApp(app);
  app = undefined;
  await launch();
  await openContent(articleUrl());
  await expect(page.getByTestId('seo-query-input')).toHaveValue('green tea kettle');
  await expect(place('title')).toHaveAttribute('data-presence', 'some');
  const draft = page.locator('[data-testid="seo-snippet-source"][data-source="draft"]');
  await expect(draft).toHaveCount(1);
  await draft.click();
  await expect(page.getByTestId('seo-draft-title')).toHaveValue('Green tea & <biscuits>: a short guide');
  // Deleting the draft and clearing the query remove them.
  await page.getByTestId('seo-draft-delete').click();
  await expect(draft).toHaveCount(0);
  await page.getByTestId('seo-query-clear').click();
  await expect(page.getByTestId('seo-query-input')).toHaveValue('');
  await expect(page.getByTestId('seo-query-checklist')).toHaveCount(0);
});

test('content-page-text-is-inert', async () => {
  await openContent(`${site.origin}/inert`);
  await expect(page.getByTestId('seo-serp-desktop-title')).toHaveText('<img src=x onerror=top.__pwned=1> ‮evil title');
  await expect(page.getByTestId('seo-serp-desktop-description')).toHaveText('<script>top.__pwned=2</script> described');
  await page.locator('[data-testid="seo-ngram-size"][data-size="1"]').click();
  expect(await page.getByTestId('seo-ngram-text').allTextContents()).toEqual(expect.arrayContaining(['onerror', 'reversed']));
  await page.getByTestId('seo-query-input').fill('<img src=x>');
  await expect(page.getByTestId('seo-query-checklist')).toBeVisible();
  const elements = await sidebar().evaluate((root) => ({
    img: root.querySelectorAll('img').length,
    script: root.querySelectorAll('script').length,
    a: root.querySelectorAll('a').length,
    b: root.querySelectorAll('b').length,
    iframe: root.querySelectorAll('iframe').length,
    style: root.querySelectorAll('[style]').length,
  }));
  expect(elements).toEqual({ img: 0, script: 0, a: 0, b: 0, iframe: 0, style: 0 });
  // Nothing from the page ran in the chrome.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await page.getByTestId('seo-query-clear').click();
});
