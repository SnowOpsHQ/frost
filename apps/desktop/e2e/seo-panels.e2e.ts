// Specs: specs/seo-sidebar.spec.ts (Links, Images, Social, HIGHLIGHT_MODES), specs/seo-snapshot.spec.ts,
// specs/seo-limits.spec.ts (SEO_WORLD_ID, SNAPSHOT_LIMITS), specs/seo-rules.spec.ts, specs/browser.spec.ts
// Acceptance: specs/seo-panels.feature.md (End to end)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS, SEO_WORLD_ID, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { LINKS_CSV_COLUMNS } from '@app/specs/seo-sidebar.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/** A valid grayscale PNG of `width` × `height` (so the page's images have real intrinsic sizes). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const IMAGES: Record<string, [number, number]> = {
  '/img/hero.png': [800, 400],
  '/img/top-lazy.png': [200, 100],
  '/img/nosize.png': [120, 60],
  '/img/no-alt.png': [50, 50],
  '/img/below.png': [300, 150],
};

const LINKS_PAGE = (origin: string, other: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Links on a page about tea and coffee</title></head>
<body><h1>Links</h1><h2>Section</h2><h3>Subsection</h3><p>
<a href="/guides/tea">Tea guide</a>
<a href="${origin}/guides/coffee" target="_blank">Coffee guide</a>
<a href="${other}/target-page" rel="nofollow noopener">Partner, "quoted"</a>
<a href="https://ads.example.net/offer" rel="sponsored">=HYPERLINK("http://evil.example","win")</a>
<a href="/forum/42" rel="ugc">A forum reply</a>
<a href="mailto:hello@example.com">Email us</a>
<a href="javascript:void(0)">Menu</a>
</p></body></html>`;

const MANY_LINKS = SNAPSHOT_LIMITS.maxLinks + 100;
const MANY_LINKS_PAGE = `<!doctype html><html lang="en"><head><title>A page with more links than frost lists</title></head><body><h1>Many</h1>${Array.from({ length: MANY_LINKS }, (_, i) => `<a href="/m/${i}">m${i}</a>`).join(' ')}</body></html>`;

const IMAGES_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Images: sizes, alt text and lazy loading</title>
<style>body { margin: 0; } img { display: block; } #hero { width: 100px; height: 50px; } .spacer { height: 3000px; }</style></head>
<body><h1>Images</h1>
<img id="hero" src="/img/hero.png" alt="A hero picture" width="800" height="400">
<img src="/img/top-lazy.png" alt="" loading="lazy" width="200" height="100">
<img src="/img/nosize.png" alt="Without size attributes">
<img src="/img/no-alt.png" width="50" height="50">
<div class="spacer"></div>
<img src="/img/below.png" alt="Far below" loading="lazy" width="300" height="150">
</body></html>`;

const SOCIAL_PAGE = (origin: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sharing a page with Open Graph tags</title>
<meta name="description" content="A page whose share card frost draws from its tags.">
<meta property="og:title" content="Share me: the open graph card">
<meta property="og:description" content="What the card says under its headline.">
<meta property="og:image" content="${origin}/og-image.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:type" content="article"><meta property="og:site_name" content="Loopback Times">
<meta property="og:url" content="${origin}/social">
<meta name="twitter:site" content="@loopback"><meta name="twitter:image" content="${origin}/tw-image.png">
</head><body><h1>Share me</h1><p>Some text.</p></body></html>`;

/** Markup and bidi overrides in every value the new panels show. */
const INERT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inert values in the panels</title>
<meta property="og:title" content="&lt;img src=x onerror=top.__pwned=5&gt; card">
<meta property="og:description" content="&lt;script&gt;top.__pwned=6&lt;/script&gt; ‮reversed">
<meta property="og:image" content="javascript:top.__pwned=7">
<meta name="twitter:card" content="&lt;b&gt;bold&lt;/b&gt;"></head>
<body><h1>Inert</h1>
<a href="javascript:top.__pwned=8">&lt;img src=x onerror=top.__pwned=9&gt; ‮link</a>
<a href="/fine" target="&lt;script&gt;">&lt;script&gt;top.__pwned=10&lt;/script&gt;</a>
<img src="/img/no-alt.png" alt="&lt;img src=x onerror=top.__pwned=11&gt; ‮alt" width="50" height="50" loading="&lt;b&gt;">
</body></html>`;

/** A strict CSP: no styles, no scripts, no images, Trusted Types required. */
const STRICT_CSP = "default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const CSP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A page with a strict content security policy</title></head>
<body><h1>Strict CSP</h1><p><a href="/a">Internal</a> <a href="https://example.org/">External</a> <a href="/n" rel="nofollow">Nofollow</a></p><h2>Second</h2><h3>Third</h3></body></html>`;

/** Loopback pages for the panels; every request path is logged. */
async function startPanelServer() {
  const requests: string[] = [];
  let origin = '';
  let other = '';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    requests.push(pathname);
    const html = (body: string, headers: Record<string, string> = {}) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers }).end(body);
    const size = IMAGES[pathname];
    if (size) response.writeHead(200, { 'Content-Type': 'image/png' }).end(png(size[0], size[1]));
    else if (pathname === '/links') html(LINKS_PAGE(origin, other));
    else if (pathname === '/many-links') html(MANY_LINKS_PAGE);
    else if (pathname === '/images') html(IMAGES_PAGE);
    else if (pathname === '/social') html(SOCIAL_PAGE(origin));
    else if (pathname === '/inert') html(INERT_PAGE);
    else if (pathname === '/csp') html(CSP_PAGE, { 'Content-Security-Policy': STRICT_CSP });
    else if (pathname === '/og-image.png' || pathname === '/tw-image.png') response.writeHead(200, { 'Content-Type': 'image/png' }).end(png(12, 6));
    else html(`<!doctype html><html lang="en"><title>loopback ${pathname}</title><h1>loopback</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  // The same server under another host name: an external site for the page on 127.0.0.1.
  other = `http://localhost:${port}`;
  return {
    origin,
    other,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: ElectronApplication;
let page: Page;
let site: Awaited<ReturnType<typeof startPanelServer>>;
const { go, contentsIdAt, menu, run, strip, activeTab, browseContents } = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;

async function showPanel(panel: 'overview' | 'on-page' | 'links' | 'images' | 'social'): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
}

/** Loads `url` in the active tab and waits for its ready audit (On-Page shows its URL). */
async function audit(url: string): Promise<number> {
  await go(url);
  await showPanel('on-page');
  await expect(page.getByTestId('seo-fact-url')).toHaveText(url, { timeout: AUDIT_WAIT });
  return contentsIdAt(url);
}

/** The highlight overlay's state, read in the SEO isolated world (the page itself cannot see it). */
function overlay(id: number): Promise<{ mode: string; boxes: number; style: Record<string, string> | null; kinds: string[] } | null> {
  return app.evaluate(
    ({ webContents }, { id, world }) =>
      webContents.fromId(id)!.executeJavaScriptInIsolatedWorld(world, [
        {
          code: `(() => {
            const s = globalThis.__frostSeoHighlight;
            if (!s) return null;
            const first = s.root.firstElementChild;
            const label = first && first.firstElementChild;
            const cs = first && getComputedStyle(first);
            const ls = label && getComputedStyle(label);
            return {
              mode: s.mode,
              boxes: s.boxes(),
              kinds: [...s.root.children].map((box) => box.textContent),
              style: cs && { position: cs.position, borderTopWidth: cs.borderTopWidth, borderTopStyle: cs.borderTopStyle, borderTopColor: cs.borderTopColor, labelColor: ls.color, labelBackground: ls.backgroundColor, labelFontSize: ls.fontSize },
            };
          })()`,
        },
      ]) as Promise<{ mode: string; boxes: number; style: Record<string, string> | null; kinds: string[] } | null>,
    { id, world: SEO_WORLD_ID },
  );
}

/** What the page's own (main) world sees of its document. */
const pageDom = (id: number) =>
  run(
    id,
    `(() => ({ html: document.documentElement.outerHTML, children: document.documentElement.childElementCount, styled: [...document.querySelectorAll('[style]')].filter((el) => el.parentElement !== document.documentElement).length, sheets: document.styleSheets.length }))()`,
  ) as Promise<{ html: string; children: number; styled: number; sheets: number }>;

/** What the sidebar's DOM holds that page text must never become. */
const sidebarElements = () =>
  sidebar().evaluate((root) => ({
    img: root.querySelectorAll('img').length,
    script: root.querySelectorAll('script').length,
    a: root.querySelectorAll('a').length,
    iframe: root.querySelectorAll('iframe').length,
    style: root.querySelectorAll('[style]').length,
  }));

test.beforeAll(async () => {
  site = await startPanelServer();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test('links-table-and-filters', async () => {
  await audit(`${site.origin}/links`);
  await showPanel('links');
  await expect(page.getByTestId('seo-links-total-count')).toHaveText('7');
  await expect(page.getByTestId('seo-links-count-internal')).toHaveText('3');
  await expect(page.getByTestId('seo-links-count-external')).toHaveText('2');
  await expect(page.getByTestId('seo-links-count-other')).toHaveText('2');
  for (const flag of ['nofollow', 'sponsored', 'ugc']) await expect(page.getByTestId(`seo-links-count-${flag}`)).toHaveText('1');
  const rows = page.getByTestId('seo-link-row');
  await expect(rows).toHaveCount(7);
  await expect(rows.nth(1)).toContainText('target _blank');
  await expect(page.getByTestId('seo-links-capped')).toHaveCount(0);
  // The rail's Links dot comes from the links rules (javascript: href is a warning).
  await expect(railItem('links')).toHaveAttribute('data-status', 'warn');

  await page.locator('[data-testid="seo-links-type"][data-type="external"]').click();
  await expect(rows).toHaveCount(2);
  expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-kind')))).toEqual(['external', 'external']);
  await page.getByTestId('seo-links-rel').selectOption('sponsored');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-rel', 'sponsored');
  await page.locator('[data-testid="seo-links-type"][data-type="all"]').click();
  await page.getByTestId('seo-links-rel').selectOption('followed');
  await expect(rows).toHaveCount(4);
  await page.getByTestId('seo-links-rel').selectOption('all');
  await page.getByTestId('seo-links-search').fill('GUIDE');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('seo-links-shown')).toHaveText('2 of 7 links match');
  await page.getByTestId('seo-links-search').fill('');
  await expect(rows).toHaveCount(7);

  // More links than the snapshot keeps: the table says how many it shows.
  await audit(`${site.origin}/many-links`);
  await showPanel('links');
  await expect(page.getByTestId('seo-links-capped')).toHaveText(`Showing the first 1,000 of ${MANY_LINKS.toLocaleString('en-US')} links.`);
  await expect(page.getByTestId('seo-link-row')).toHaveCount(SNAPSHOT_LIMITS.maxLinks);
});

test('links-copy-csv', async () => {
  await audit(`${site.origin}/links`);
  await showPanel('links');
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await page.locator('[data-testid="seo-links-type"][data-type="external"]').click();
  await page.getByTestId('seo-links-copy-csv').click();
  await expect(page.getByTestId('seo-links-flash')).toHaveText('Copied 2 links as CSV');
  const csv = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(csv.split('\r\n')).toEqual([
    LINKS_CSV_COLUMNS.join(','),
    `${site.other}/target-page,"Partner, ""quoted""",external,nofollow noopener,yes,no,no,`,
    // Page text that looks like a formula is never one in a spreadsheet.
    `https://ads.example.net/offer,"'=HYPERLINK(""http://evil.example"",""win"")",external,sponsored,no,yes,no,`,
    '',
  ]);
  await page.locator('[data-testid="seo-links-type"][data-type="all"]').click();
});

test('links-open-in-new-tab', async () => {
  const url = `${site.origin}/links`;
  await audit(url);
  await showPanel('links');
  const tabs = await strip().count();
  const opener = await activeTab().getAttribute('data-tab-id');
  const row = page.getByTestId('seo-link-row').nth(2);
  await row.getByRole('button').first().click();
  await expect(row.getByTestId('seo-open-url')).toBeEnabled();
  await row.getByTestId('seo-open-url').click();
  // A background tab: the strip grows, the page's tab stays active, the new one loads the link.
  await expect(strip()).toHaveCount(tabs + 1);
  expect(await activeTab().getAttribute('data-tab-id')).toBe(opener);
  await expect.poll(async () => (await browseContents()).some((c) => c.url === `${site.other}/target-page`)).toBe(true);
  // Copy URL writes the row's href through main.
  await row.getByTestId('seo-copy-url').click();
  await expect(page.getByTestId('seo-links-flash')).toHaveText('URL copied');
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`${site.other}/target-page`);
  // A mailto: or javascript: link is never openable.
  for (const index of [5, 6]) {
    const other = page.getByTestId('seo-link-row').nth(index);
    await other.getByRole('button').first().click();
    await expect(other.getByTestId('seo-open-url')).toBeDisabled();
  }
  expect(await sidebarElements()).toMatchObject({ a: 0 });
  await menu('close-tab');
  await expect(strip()).toHaveCount(tabs);
});

test('images-table', async () => {
  const url = `${site.origin}/images`;
  await audit(url);
  await showPanel('images');
  const rows = page.getByTestId('seo-image-row');
  await expect(rows).toHaveCount(5);
  // The lazy image at the top may finish loading after the audit: audited again until it has a size.
  await expect
    .poll(
      async () => {
        const natural = await rows.nth(1).getByTestId('seo-image-natural').textContent();
        if (natural === 'not loaded') await page.getByTestId('seo-rerun').click();
        return natural;
      },
      { timeout: 15_000 },
    )
    .toBe('200 × 100');
  await expect(rows.nth(0)).toHaveAttribute('data-oversized', 'true');
  await expect(rows.nth(0).getByTestId('seo-image-rendered')).toHaveText('100 × 50');
  await expect(rows.nth(0).getByTestId('seo-image-natural')).toHaveText('800 × 400');
  await expect(rows.nth(0).getByTestId('seo-image-declared')).toHaveText('800 × 400');
  await expect(rows.nth(0).getByTestId('seo-image-oversized')).toHaveText('oversized 8×');
  await expect(rows.nth(1)).toHaveAttribute('data-lazy-first-viewport', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-alt', 'decorative');
  await expect(rows.nth(2)).toHaveAttribute('data-no-dimensions', 'true');
  await expect(rows.nth(2).getByTestId('seo-image-declared')).toHaveText('none');
  await expect(rows.nth(3)).toHaveAttribute('data-alt', 'missing');
  // Far below the first screen: lazy is right there.
  await expect(rows.nth(4)).toHaveAttribute('data-lazy-first-viewport', 'false');
  await expect(rows.nth(4)).toHaveAttribute('data-oversized', 'false');
  for (const [filter, count] of [
    ['oversized', 1],
    ['lazy-first-viewport', 1],
    ['no-dimensions', 1],
    ['missing-alt', 1],
    ['all', 5],
  ] as const) {
    await page.locator(`[data-testid="seo-images-filter"][data-filter="${filter}"]`).click();
    await expect(rows, filter).toHaveCount(count);
  }
  // The rules behind them, in the panel's issues.
  for (const rule of ['images-oversized', 'images-lazy-in-first-viewport', 'images-missing-dimensions', 'images-missing-alt']) await expect(page.locator(`[data-rule-id="${rule}"]`), rule).toHaveCount(1);
  await expect(railItem('images')).toHaveAttribute('data-status', 'warn');
  // The chrome lists the images; it never loads one.
  expect(await sidebarElements()).toEqual({ img: 0, script: 0, a: 0, iframe: 0, style: 0 });
});

test('social-fields-without-remote-requests', async () => {
  const url = `${site.origin}/social`;
  await audit(url);
  await showPanel('social');
  await expect(page.getByTestId('seo-social-og-title')).toHaveText('Share me: the open graph card');
  await expect(page.getByTestId('seo-social-og-image')).toHaveText(`${site.origin}/og-image.png`);
  await expect(page.getByTestId('seo-social-og-site_name')).toHaveText('Loopback Times');
  await expect(page.getByTestId('seo-social-og-url')).toHaveText(url);
  await expect(page.getByTestId('seo-social-twitter-card')).toHaveAttribute('data-missing', 'true');
  await expect(page.getByTestId('seo-social-twitter-image')).toHaveText(`${site.origin}/tw-image.png`);
  // The cards are drawn from the text, with a placeholder image and its declared size.
  await expect(page.getByTestId('seo-social-card-large')).toContainText('Share me: the open graph card');
  await expect(page.getByTestId('seo-social-card-large')).toContainText('What the card says under its headline.');
  await expect(page.getByTestId('seo-social-card-summary')).toContainText('Loopback Times');
  await expect(page.getByTestId('seo-social-image-size')).toHaveText('Declared 1200 × 630 px');
  for (const rule of ['og-image-not-https', 'twitter-card-missing']) await expect(page.locator(`[data-rule-id="${rule}"]`), rule).toHaveCount(1);
  await expect(railItem('social')).toHaveAttribute('data-status', 'warn');
  expect(await sidebarElements()).toEqual({ img: 0, script: 0, a: 0, iframe: 0, style: 0 });
  // Neither the chrome nor the page ever fetched the share images.
  await page.waitForTimeout(500);
  expect(site.requests).toContain('/social');
  expect(site.requests.filter((path) => path === '/og-image.png' || path === '/tw-image.png')).toEqual([]);
});

test('highlight-links-leaves-no-residue', async () => {
  const id = await audit(`${site.origin}/links`);
  await showPanel('links');
  const before = await pageDom(id);
  const toggle = page.getByTestId('seo-highlight-links');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await overlay(id))?.boxes).toBe(7);
  expect((await overlay(id))!.kinds).toEqual(['int', 'int', 'nofollow', 'ext', 'int', 'other', 'other']);
  // The page sees one element of frost's own (a closed shadow root: nothing inside it), and none of its own changed.
  const on = await pageDom(id);
  expect(on.children).toBe(before.children + 1);
  expect(on.styled).toBe(before.styled);
  expect(on.sheets).toBe(before.sheets);
  expect(await run(id, 'document.documentElement.lastElementChild.shadowRoot')).toBeNull();
  expect(await run(id, 'document.documentElement.lastElementChild.childElementCount')).toBe(0);
  // Off: the page's DOM is exactly as it was.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await pageDom(id)).html).toBe(before.html);
  expect(await overlay(id)).toBeNull();

  // On again, then a navigation: the mode resets and nothing is left in the new page either.
  await toggle.click();
  await expect.poll(async () => (await overlay(id))?.boxes).toBe(7);
  const next = await audit(`${site.origin}/images`);
  await showPanel('links');
  await expect(page.getByTestId('seo-highlight-links')).toHaveAttribute('aria-pressed', 'false');
  expect(await overlay(next)).toBeNull();
  expect((await pageDom(next)).html).not.toContain('aria-hidden');

  // On, then another tab becomes active: removed from the page it was on.
  const id2 = await audit(`${site.origin}/links`);
  await showPanel('links');
  const clean = await pageDom(id2);
  await page.getByTestId('seo-highlight-links').click();
  await expect.poll(async () => (await overlay(id2))?.boxes).toBe(7);
  await menu('new-tab');
  await expect.poll(async () => (await pageDom(id2)).html).toBe(clean.html);
  expect(await overlay(id2)).toBeNull();
  await menu('close-tab');
  await showPanel('links');
  await expect(page.getByTestId('seo-highlight-links')).toHaveAttribute('aria-pressed', 'false');
});

test('highlight-headings-on-strict-csp-page', async () => {
  const id = await audit(`${site.origin}/csp`);
  // The page really is locked down: its own inline style attribute is refused.
  expect(await run(id, `(() => { const d = document.createElement('div'); d.setAttribute('style', 'position: absolute'); document.body.append(d); const p = getComputedStyle(d).position; d.remove(); return p; })()`)).toBe('static');
  const before = await pageDom(id);
  await showPanel('on-page');
  await page.getByTestId('seo-highlight-headings').click();
  await expect(page.getByTestId('seo-highlight-headings')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await overlay(id))?.boxes).toBe(3);
  const state = (await overlay(id))!;
  expect(state.kinds).toEqual(['H1', 'H2', 'H3']);
  // Its CSSOM styles apply under the page's CSP: positioned, outlined, labelled.
  expect(state.style).toMatchObject({ position: 'absolute', borderTopStyle: 'solid', borderTopColor: 'rgb(124, 58, 237)', labelColor: 'rgb(255, 255, 255)', labelFontSize: '10px' });
  // Snapped to device pixels, but there.
  expect(Number.parseFloat(state.style!['borderTopWidth']!)).toBeGreaterThan(0);
  expect(await run(id, 'getComputedStyle(document.documentElement.lastElementChild).position')).toBe('absolute');
  // Links on the same page too, then off: no residue.
  await showPanel('links');
  await page.getByTestId('seo-highlight-links').click();
  await expect.poll(async () => (await overlay(id))?.kinds).toEqual(['int', 'ext', 'nofollow']);
  await page.getByTestId('seo-highlight-links').click();
  await expect.poll(async () => (await pageDom(id)).html).toBe(before.html);
});

test('page-text-is-inert-in-new-panels', async () => {
  await audit(`${site.origin}/inert`);
  for (const panel of ['links', 'images', 'social'] as const) {
    await showPanel(panel);
    // Every row's actions (one open at a time) and every issue open: all the page text the panel can show.
    for (const row of await page.locator('[data-testid="seo-link-row"], [data-testid="seo-image-row"]').all()) {
      await row.getByRole('button').first().click();
      expect(await sidebarElements(), panel).toEqual({ img: 0, script: 0, a: 0, iframe: 0, style: 0 });
    }
    for (const toggle of await page.getByTestId('seo-issue-toggle').all()) await toggle.click();
    expect(await sidebarElements(), panel).toEqual({ img: 0, script: 0, a: 0, iframe: 0, style: 0 });
  }
  await showPanel('links');
  await expect(page.getByTestId('seo-link-text').first()).toHaveText('<img src=x onerror=top.__pwned=9> ‮link');
  await page.getByTestId('seo-link-row').first().getByRole('button').first().click();
  await expect(page.getByTestId('seo-link-row').first().getByTestId('seo-open-url')).toBeDisabled();
  await expect(page.getByTestId('seo-link-row').nth(1)).toContainText('target <script>');
  await showPanel('images');
  await expect(page.getByTestId('seo-image-alt')).toHaveText('<img src=x onerror=top.__pwned=11> ‮alt');
  await expect(page.getByTestId('seo-image-loading')).toHaveText('loading=<b>');
  await showPanel('social');
  await expect(page.getByTestId('seo-social-card-title')).toHaveText('<img src=x onerror=top.__pwned=5> card');
  await expect(page.getByTestId('seo-social-twitter-card')).toHaveText('<b>bold</b>');
  // A javascript: image URL is text, with no way to open it.
  await expect(page.getByTestId('seo-social-image-url')).toHaveText('javascript:top.__pwned=7');
  await expect(page.getByTestId('seo-social-image').getByTestId('seo-open-url')).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});
