// Specs: specs/schema-types.spec.ts, specs/seo-limits.spec.ts (SNAPSHOT_LIMITS), specs/seo-snapshot.spec.ts
// (JsonLdBlockSchema, MarkupItemSchema, SeoCopySchemaInputSchema), specs/seo-rules.spec.ts (schema rules)
// Acceptance: specs/seo-schema.feature.md (End to end)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;
const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

const ORGANIZATION = (origin: string) => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${origin}/#org`,
  name: 'Loopback Outfitters',
  url: `${origin}/`,
  logo: `${origin}/logo.png`,
  sameAs: ['https://social.example/loopback-outfitters'],
});
const BREADCRUMBS = (origin: string) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: ['Home', 'Shoes', 'Trail shoe'].map((name, i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${origin}/${['', 'shoes', 'shoes/trail'][i]}` })),
});
const PRODUCT = (origin: string) => ({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Trail shoe',
  image: `${origin}/img/shoe.png`,
  description: 'A light shoe for rough paths.',
  sku: 'TS-100',
  brand: { '@type': 'Brand', name: 'Loopback' },
  offers: { '@type': 'Offer', price: '89.00', priceCurrency: 'EUR', availability: 'https://schema.org/InStock', url: `${origin}/shoes/trail` },
});
const page_ = (title: string, head: string, body = '<h1>Page</h1>') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const VALID_PAGE = (origin: string) => page_('A product page with valid structured data', ld(ORGANIZATION(origin)) + ld(BREADCRUMBS(origin)) + ld(PRODUCT(origin)));

/** Line 4, column 3: a missing comma before "name". */
const MALFORMED = '{\n  "@context": "https://schema.org",\n  "@type": "Organization"\n  "name": "Broken"\n}';
const MALFORMED_PAGE = page_('A page whose JSON-LD has a syntax error', `<script type="application/ld+json">${MALFORMED}</script>`);

const MICRODATA_PAGE = page_(
  'A product described with microdata',
  '',
  `<div itemscope itemtype="https://schema.org/Product">
    <h1 itemprop="name">Microdata boot</h1>
    <img itemprop="image" src="/img/boot.png" alt="A boot" width="10" height="10">
    <p itemprop="description">Waterproof and warm.</p>
    <meta itemprop="sku" content="MB-7">
    <div itemprop="brand" itemscope itemtype="https://schema.org/Brand"><span itemprop="name">Loopback</span></div>
    <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
      <span itemprop="price" content="129.50">€129.50</span><meta itemprop="priceCurrency" content="EUR">
      <link itemprop="availability" href="https://schema.org/InStock"><a itemprop="url" href="/boots/microdata">Buy</a>
    </div>
    <div itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating"><span itemprop="ratingValue">4.6</span> from <span itemprop="reviewCount">212</span> reviews</div>
  </div>`,
);

const FIVE_MB = 5 * 1024 * 1024;
const DEEP = 10_000;
const HOSTILE_PAGE = page_(
  'A page whose structured data fights the extractor',
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing","name":"${'x'.repeat(FIVE_MB)}"}</script>` +
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing","name":"Deep","a":${'['.repeat(DEEP)}${']'.repeat(DEEP)}}</script>` +
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Proto","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"offers":{"@type":"Offer","price":"1","priceCurrency":"USD","__proto__":{"polluted":"yes"}}}</script>',
  `<h1>Hostile</h1>${'<div itemscope itemtype="https://schema.org/Thing" itemprop="part">'.repeat(DEEP)}${'</div>'.repeat(DEEP)}`,
);

/** Markup, bidi overrides and javascript: URLs in JSON-LD values, types and names (`</script>` written `<\/script>`, valid JSON). */
const INERT_PAGE = page_(
  'Inert structured data values',
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"<img src=x onerror=top.__pwned=1> ‮evil","url":"javascript:top.__pwned=2",' +
    '"description":"<script>top.__pwned=3<\\/script>","logo":"https://ok.example/logo.png","sameAs":["javascript:alert(1)"],"<b>key</b>":"<i>v</i>",' +
    '"founder":{"@type":"<script>top.__pwned=4<\\/script>","name":"<a href=javascript:top.__pwned=5>F</a>"}}</script>',
);

async function startSchemaServer() {
  let origin = '';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    if (pathname === '/valid') html(VALID_PAGE(origin));
    else if (pathname === '/malformed') html(MALFORMED_PAGE);
    else if (pathname === '/microdata') html(MICRODATA_PAGE);
    else if (pathname === '/hostile') html(HOSTILE_PAGE);
    else if (pathname === '/inert') html(INERT_PAGE);
    else if (pathname.startsWith('/img/')) response.writeHead(404).end();
    else html(page_(`loopback ${pathname}`, ''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: ElectronApplication;
let page: Page;
let site: Awaited<ReturnType<typeof startSchemaServer>>;
const { go, menu, strip, run, contentsIdAt } = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const block = (index: number) => page.locator(`[data-testid="seo-schema-block"][data-block="${index}"]`);
const entity = (types: string) => page.locator(`[data-testid="seo-entity"][data-types="${types}"]`);
/** A node's own property row (not a nested node's). */
const prop = (scope: ReturnType<Page['locator']>, name: string) => scope.locator(`:scope > .seo-entity-body > .seo-props > [data-testid="seo-prop"][data-name="${name}"]`);
const rawText = (index: number) => block(index).getByTestId('seo-schema-raw').evaluate((pre) => pre.textContent);

async function showPanel(panel: string): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
}

/** Loads `url`, waits for its ready audit (On-Page shows its URL), then opens the Schema panel. */
async function audit(url: string, timeout = AUDIT_WAIT): Promise<void> {
  await go(url);
  await showPanel('on-page');
  await expect(page.getByTestId('seo-fact-url')).toHaveText(url, { timeout });
  await showPanel('schema');
  await expect(page.getByTestId('seo-schema')).toBeVisible();
}

const issueIds = () => page.locator('[data-testid="seo-schema"] > .seo-issues [data-testid="seo-issue"]').evaluateAll((items) => items.map((item) => item.getAttribute('data-rule-id')));
const sidebarElements = () =>
  sidebar().evaluate((root) => ({
    img: root.querySelectorAll('img').length,
    script: root.querySelectorAll('script').length,
    a: root.querySelectorAll('a').length,
    iframe: root.querySelectorAll('iframe').length,
    style: root.querySelectorAll('[style]').length,
  }));
const clipboardText = () => app.evaluate(({ clipboard }) => clipboard.readText());

test.beforeAll(async () => {
  site = await startSchemaServer();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test('schema-valid-page-shows-clean-tree', async () => {
  await audit(`${site.origin}/valid`);
  // No schema issue at all, and a passing dot.
  expect(await issueIds()).toEqual([]);
  await expect(railItem('schema')).toHaveAttribute('data-status', 'pass');
  await expect(page.getByTestId('seo-schema-status')).toHaveAttribute('data-status', 'pass');
  for (const severity of ['error', 'warning', 'info']) await expect(page.getByTestId(`seo-schema-count-${severity}`)).toHaveAttribute('data-count', '0');
  // The header counts the top-level nodes by type.
  expect(await page.getByTestId('seo-schema-type').evaluateAll((items) => items.map((item) => `${item.getAttribute('data-type')}:${item.getAttribute('data-count')}`))).toEqual(['Organization:1', 'BreadcrumbList:1', 'Product:1']);
  await expect(page.getByTestId('seo-schema-syntaxes')).toHaveText('JSON-LD 3 · Microdata 0 · RDFa 0');
  await expect(page.getByTestId('seo-schema-block')).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(block(i)).toHaveAttribute('data-status', 'valid');
  await expect(page.locator('[data-testid="seo-entity-issue"]')).toHaveCount(0);

  // The tree: top-level nodes open, their values as text.
  const org = entity('Organization');
  await expect(org).toHaveAttribute('data-open', 'true');
  await expect(org.getByTestId('seo-entity-name').first()).toHaveText('Loopback Outfitters');
  await expect(prop(org, 'url').getByTestId('seo-prop-value')).toHaveText(`${site.origin}/`);
  await expect(prop(org, 'url').getByTestId('seo-schema-open-url')).toBeEnabled();
  const crumbs = entity('BreadcrumbList');
  const items = prop(crumbs, 'itemListElement').locator('[data-testid="seo-entity"][data-types="ListItem"]');
  await expect(items).toHaveCount(3);
  expect(await items.getByTestId('seo-entity-name').allTextContents()).toEqual(['Home', 'Shoes', 'Trail shoe']);
  // A nested node opens to its properties.
  const offer = prop(entity('Product'), 'offers').locator('[data-testid="seo-entity"][data-types="Offer"]');
  await expect(offer).toHaveAttribute('data-open', 'false');
  await offer.getByTestId('seo-entity-toggle').click();
  await expect(prop(offer, 'price').getByTestId('seo-prop-value')).toHaveText('89.00');
  await expect(prop(offer, 'priceCurrency').getByTestId('seo-prop-value')).toHaveText('EUR');

  // Raw: the block pretty-printed; Copy JSON puts exactly that on the clipboard.
  const pretty = JSON.stringify(PRODUCT(site.origin), null, 2);
  await block(2).locator('[data-testid="seo-schema-view"][data-view="raw"]').click();
  await expect(block(2).getByTestId('seo-schema-raw')).toBeVisible();
  expect(await rawText(2)).toBe(pretty);
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await block(2).getByTestId('seo-schema-copy').click();
  await expect.poll(clipboardText).toBe(pretty);
  await expect(page.getByTestId('seo-schema-flash')).toHaveText('JSON copied');
  await block(2).locator('[data-testid="seo-schema-view"][data-view="tree"]').click();
  await expect(block(2).getByTestId('seo-schema-tree')).toBeVisible();
});

test('schema-syntax-error-shows-location', async () => {
  await audit(`${site.origin}/malformed`);
  expect(await issueIds()).toContain('schema-json-invalid');
  await expect(railItem('schema')).toHaveAttribute('data-status', 'error');
  await expect(block(0)).toHaveAttribute('data-status', 'invalid');
  await expect(block(0).getByTestId('seo-schema-block-status')).toHaveText('Invalid JSON');
  // The raw view is shown at once, with the error's position and its character marked.
  await expect(block(0)).toHaveAttribute('data-view', 'raw');
  await expect(block(0).getByTestId('seo-schema-error-location')).toContainText('Line 4, column 3');
  await expect(block(0).getByTestId('seo-schema-error-location')).toContainText('Expected "," or "}"');
  await expect(block(0).getByTestId('seo-schema-error-mark')).toHaveText('"');
  expect(await rawText(0)).toBe(MALFORMED);
  await expect(block(0).locator('[data-testid="seo-schema-view"][data-view="tree"]')).toBeDisabled();
  // The issue's facts name the block and the position.
  const issue = page.locator('[data-testid="seo-issue"][data-rule-id="schema-json-invalid"]');
  await issue.getByTestId('seo-issue-toggle').click();
  await expect(issue.getByTestId('seo-issue-facts')).toContainText('Line 4, column 3');
  // Copy JSON copies the text as written.
  await block(0).getByTestId('seo-schema-copy').click();
  await expect.poll(clipboardText).toBe(MALFORMED);
});

test('schema-microdata-product-tree', async () => {
  await audit(`${site.origin}/microdata`);
  await expect(page.getByTestId('seo-schema-block')).toHaveCount(0);
  await expect(page.getByTestId('seo-schema-syntaxes')).toHaveText('JSON-LD 0 · Microdata 1 · RDFa 0');
  const markup = page.locator('[data-testid="seo-schema-markup"][data-syntax="microdata"]');
  await expect(markup).toBeVisible();
  const product = markup.locator('[data-testid="seo-entity"][data-types="Product"]');
  await expect(product).toHaveAttribute('data-syntax', 'microdata');
  await expect(product.getByTestId('seo-entity-name').first()).toHaveText('Microdata boot');
  await expect(prop(product, 'image').getByTestId('seo-prop-value')).toHaveText(`${site.origin}/img/boot.png`);
  await expect(prop(product, 'sku').getByTestId('seo-prop-value')).toHaveText('MB-7');
  for (const [name, type] of [
    ['brand', 'Brand'],
    ['offers', 'Offer'],
    ['aggregateRating', 'AggregateRating'],
  ] as const) {
    await expect(prop(product, name).locator(`[data-testid="seo-entity"][data-types="${type}"]`)).toHaveCount(1);
  }
  const offer = prop(product, 'offers').locator('[data-testid="seo-entity"]');
  await offer.getByTestId('seo-entity-toggle').click();
  // The price from `content`, not the shown text; the URL resolved against the page.
  await expect(prop(offer, 'price').getByTestId('seo-prop-value')).toHaveText('129.50');
  await expect(prop(offer, 'url').getByTestId('seo-prop-value')).toHaveText(`${site.origin}/boots/microdata`);
  expect(await issueIds()).not.toContain('schema-price-invalid');
  expect(await issueIds()).not.toContain('schema-required-missing');
});

test('schema-hostile-page-is-bounded', async () => {
  const url = `${site.origin}/hostile`;
  const started = Date.now();
  await audit(url, 30_000);
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(Number(await page.getByTestId('seo-duration').getAttribute('data-ms'))).toBeLessThan(EXTRACT_TIMEOUT_MS);
  expect(await issueIds()).toContain('schema-over-limit');
  // The 5 MB block was cut (not parsed), the deep one read to its bound, the payload's keys dropped.
  await expect(block(0)).toHaveAttribute('data-status', 'cut');
  await expect(block(0).getByTestId('seo-schema-block-status')).toHaveText('Too large to read');
  await expect(block(1)).toHaveAttribute('data-status', 'valid');
  await expect(block(2)).toHaveAttribute('data-status', 'valid');
  await expect(block(2).getByTestId('seo-schema-dropped')).toHaveText('Ignored 3 keys named __proto__, constructor or prototype.');
  const proto = block(2).locator('[data-testid="seo-entity"][data-types="Product"]');
  for (const name of ['__proto__', 'constructor', 'prototype', 'polluted']) await expect(proto.locator(`[data-testid="seo-prop"][data-name="${name}"]`)).toHaveCount(0);
  await expect(prop(proto, 'name').getByTestId('seo-prop-value')).toHaveText('Proto');
  const overLimit = page.locator('[data-testid="seo-issue"][data-rule-id="schema-over-limit"]');
  await overLimit.getByTestId('seo-issue-toggle').click();
  await expect(overLimit.getByTestId('seo-issue-samples')).toContainText(`characters (frost reads blocks of up to ${SNAPSHOT_LIMITS.maxJsonLdChars.toLocaleString('en-US')}): not read`);
  await expect(overLimit.getByTestId('seo-issue-samples')).toContainText('nested deeper than 32 levels');
  // The deep microdata is counted, and only the first levels are kept.
  const markup = page.locator('[data-testid="seo-schema-markup"][data-syntax="microdata"]');
  await expect(markup).toContainText(`${DEEP.toLocaleString('en-US')} items`);
  expect(await markup.locator('[data-testid="seo-entity"]').count()).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxMarkupDepth + 1);
  // Nothing polluted: main, the chrome, and the page's own world.
  expect(await app.evaluate(() => (({}) as Record<string, unknown>)['polluted'])).toBeUndefined();
  expect(await page.evaluate(() => (({}) as Record<string, unknown>)['polluted'])).toBeUndefined();
  expect(await run(await contentsIdAt(url), "typeof ({}).polluted + ':' + typeof Object.prototype.polluted")).toBe('undefined:undefined');
  // The app stays responsive.
  const tabs = await strip().count();
  await menu('new-tab');
  await expect(strip()).toHaveCount(tabs + 1);
  await menu('close-tab');
  await expect(strip()).toHaveCount(tabs);
  await expect(page.getByTestId('ping')).toHaveText('pong');
});

test('schema-values-are-inert', async () => {
  await audit(`${site.origin}/inert`);
  const org = entity('Organization');
  await expect(org.getByTestId('seo-entity-name').first()).toHaveText('<img src=x onerror=top.__pwned=1> ‮evil');
  await expect(prop(org, 'description').getByTestId('seo-prop-value')).toHaveText('<script>top.__pwned=3</script>');
  await expect(prop(org, '<b>key</b>').getByTestId('seo-prop-value')).toHaveText('<i>v</i>');
  // javascript: URLs are text that cannot be opened; an https one can.
  await expect(prop(org, 'url').getByTestId('seo-prop-value')).toHaveText('javascript:top.__pwned=2');
  await expect(prop(org, 'url').getByTestId('seo-schema-open-url')).toBeDisabled();
  await expect(prop(org, 'sameAs').getByTestId('seo-schema-open-url')).toBeDisabled();
  await expect(prop(org, 'logo').getByTestId('seo-schema-open-url')).toBeEnabled();
  // Every node open, every issue open, and the raw view: still nothing but text.
  for (let pass = 0; pass < 3; pass++) for (const toggle of await page.locator('[data-testid="seo-entity"][data-open="false"] > [data-testid="seo-entity-toggle"]').all()) await toggle.click();
  await expect(page.locator('[data-testid="seo-entity"][data-open="false"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="seo-entity-type"]', { hasText: '<script>top.__pwned=4</script>' })).toHaveCount(1);
  for (const toggle of await page.getByTestId('seo-issue-toggle').all()) await toggle.click();
  expect(await sidebarElements()).toEqual({ img: 0, script: 0, a: 0, iframe: 0, style: 0 });
  await block(0).locator('[data-testid="seo-schema-view"][data-view="raw"]').click();
  await expect(block(0).getByTestId('seo-schema-raw')).toContainText('"description": "<script>top.__pwned=3<\\/script>"');
  expect(await sidebarElements()).toEqual({ img: 0, script: 0, a: 0, iframe: 0, style: 0 });
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});
