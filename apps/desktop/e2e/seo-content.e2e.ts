// Specs: specs/seo-content.spec.ts (SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS, TARGET_QUERY_PLACES, Copy as HTML,
// READABILITY_FORMULAS, INFLESZ_BANDS, SENTENCE_LIMITS), specs/seo-sidebar.spec.ts (SEO_PANELS, HIGHLIGHT_MODES,
// HIGHLIGHT_STYLES, TextHighlightTarget; keyphrase, Phase 11), specs/seo-limits.spec.ts (SEO_WORLD_ID), specs/gsc-targets.spec.ts
// (GSC_TARGET_SUGGESTIONS, GSC_TARGETS_COPY); seo-content.spec.ts (SERP_PREVIEW_NOTE, SNIPPET_JSONLD_SOURCES,
// SUGGESTED_JSONLD_SHAPE, SERP_PREVIEW_VARIANT_MISSING, Phase 11 Task 3)
// Acceptance: specs/seo-content.feature.md (End to end; Result preview facts, Phase 11 Task 3)
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readability, sentenceReport, textWidth } from '@app/seo-core';
import { GSC_RANGE_TEXT } from '@app/specs/gsc-panel.spec';
import { GSC_TARGET_SUGGESTIONS, GSC_TARGETS_COPY } from '@app/specs/gsc-targets.spec';
import { INFLESZ_BANDS, SENTENCE_LIMITS, SERP_PREVIEW_NOTE, SERP_PREVIEW_VARIANT_MISSING, SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS, SUGGESTED_JSONLD_SHAPE } from '@app/specs/seo-content.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS, SEO_WORLD_ID } from '@app/specs/seo-limits.spec';
import { HIGHLIGHT_STYLES, SEO_PANELS } from '@app/specs/seo-sidebar.spec';
import { accountHelpers } from './account-helpers';
import { fakeFiltersOf, startFakeGoogle, type FakeGoogle } from './fake-google';
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
<body><h1>&lt;b&gt;bold&lt;/b&gt; heading</h1><p>&lt;img src=x onerror=top.__pwned=3&gt; &lt;img src=x onerror=top.__pwned=3&gt; ‮reversed ‮reversed</p>
<p>This long sentence holds &lt;img src=x onerror=top.__pwned=4&gt; and &lt;b&gt;bold&lt;/b&gt; as plain words and keeps going with many more ordinary words until it is longer than the limit.</p></body></html>`;
/** The difficult (long) sentence of `INERT_PAGE` as the panel lists it: its markup is text. */
const INERT_SENTENCE = 'This long sentence holds <img src=x onerror=top.__pwned=4> and <b>bold</b> as plain words and keeps going with many more ordinary words until it is longer than the limit.';

/** A Spanish article (Szigriszt-Pazos, INFLESZ bands): short easy sentences, one long and one complex sentence. */
const SPANISH_HEADING = 'Té verde para empezar';
const SPANISH_LONG = 'Cuando el agua hierve en la tetera conviene esperar un poco antes de verterla sobre las hojas porque el agua demasiado caliente quema el té y deja un sabor amargo en la boca.';
const SPANISH_COMPLEX = 'La administración municipal considera imprescindible la reorganización administrativa de las competencias institucionales correspondientes.';
const SPANISH_PARAGRAPHS = [
  'El té verde se hace con hojas frescas. Las hojas se secan pronto. El agua no debe estar muy caliente. Deja el té dos minutos en la taza. Luego pruébalo con calma. Guarda las hojas en una lata cerrada. Así el sabor dura más. Una taza de té es una buena forma de empezar el día. Mi abuela tomaba té cada tarde. Lo servía en tazas pequeñas y blancas.',
  `${SPANISH_LONG} ${SPANISH_COMPLEX} El té verde es fácil de preparar en casa. Con un poco de práctica sale muy rico.`,
];
/** The page's text as the audit reads it (blocks end sentences). */
const SPANISH_TEXT = [SPANISH_HEADING, ...SPANISH_PARAGRAPHS].join('\n\n');
const SPANISH_PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Té verde: cómo prepararlo</title></head>
<body><main><h1>${SPANISH_HEADING}</h1>${SPANISH_PARAGRAPHS.map((p) => `<p>${p}</p>`).join('\n')}</main></body></html>`;

/** A strict CSP: no styles, no scripts, no images, Trusted Types required (as `seo-panels.e2e.ts`'s). */
const STRICT_CSP = "default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
/**
 * A long English article (taller than the window) with three long sentences: near the top (an inline
 * `<em>` inside it), in the middle (a link inside it) and at the very end (below the fold).
 */
const LONG_SENTENCES = {
  first: 'When you brew a pot of green tea for a group of friends at the end of a long day, you should <em>always</em> let the water cool for a minute or two before you pour it over the leaves.',
  middle: 'Many people who try <a href="/guides/green-tea">loose leaf tea</a> for the first time find that it tastes much better than the tea in bags they bought at the shop down the road from home.',
  last: 'At the very end of this long guide we want to say once more that good tea needs fresh water, clean cups, a little patience and a quiet place to sit.',
} as const;
function longArticle(): string {
  const easy = 'Green tea is made from fresh leaves. Brew it for two minutes. Taste it, then pour the rest. Keep the leaves in a dark tin.';
  const filler = (from: number, count: number) => Array.from({ length: count }, (_, i) => `<p>Part ${from + i}. ${easy}</p>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A long guide to green tea</title></head>
<body><main><h1>A long guide to green tea</h1>
<p id="first">${easy} ${LONG_SENTENCES.first}</p>
${filler(1, 20)}
<p id="middle">${LONG_SENTENCES.middle} ${easy}</p>
${filler(21, 20)}
<p id="last">${easy} ${LONG_SENTENCES.last}</p></main></body></html>`;
}

/** "running shoes" four times in four blocks, once in capitals, and once inside a longer word ("shoestring"). */
const KEYPHRASE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shoes for trail runs</title></head>
<body><main><h1>Running shoes for trails</h1>
<p>Good running shoes grip on wet rock.</p>
<p>Light RUNNING SHOES dry fast. A running shoestring budget is not enough.</p>
<p>Old running shoes go in the bin.</p></main></body></html>`;

/**
 * Phase 11 Task 3: an article with the structured data the result preview reads, one JSON-LD block
 * each (an Organization the preview does not read first). The site name holds markup: it is text.
 */
const RICH_SITE_NAME = 'Leaf <b>&</b> Kettle';
const RICH_BLOCKS = [
  { '@context': 'https://schema.org', '@type': 'Organization', name: 'Leaf Holdings' },
  { '@context': 'https://schema.org', '@type': 'WebSite', name: RICH_SITE_NAME, url: '/' },
  {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 2, name: 'Guides', item: 'https://example.com/guides' },
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' },
      { '@type': 'ListItem', position: 3, name: 'Sencha' },
    ],
  },
  { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'How to brew sencha', datePublished: '2025-03-04T09:00:00+01:00' },
  { '@context': 'https://schema.org', '@type': 'Product', name: 'Sencha tin', aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.6', reviewCount: '87' } },
  { '@context': 'https://schema.org', '@type': 'VideoObject', name: 'Brewing sencha in two minutes', duration: 'PT2M5S', uploadDate: '2025-03-01', thumbnailUrl: 'https://example.com/thumb.jpg' },
  { '@context': 'https://schema.org', '@type': 'Recipe', name: 'Iced sencha', totalTime: 'PT1H10M', recipeYield: '2 glasses' },
];
const RICH_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>How to brew sencha</title>
<meta name="description" content="Water at seventy degrees, one minute, and a warm cup.">
${RICH_BLOCKS.map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`).join('\n')}</head>
<body><main><h1>How to brew sencha</h1><p>Warm the cup, then pour.</p></main></body></html>`;
/** No structured data: the site name, trail and date come from the tags and the URL. */
const PLAIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A plain tea page</title>
<meta property="og:site_name" content="Plain Tea Co"><meta property="article:published_time" content="2024-06-01T08:00:00Z"></head>
<body><main><h1>A plain tea page</h1><p>Nothing marked up here.</p></main></body></html>`;

async function startSite() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    if (pathname === '/guides/green-tea') html(article());
    else if (pathname === '/inert') html(INERT_PAGE);
    else if (pathname === '/guides/shoes') html(KEYPHRASE_PAGE);
    else if (pathname === '/guides/sencha') html(RICH_PAGE);
    else if (pathname === '/guides/plain') html(PLAIN_PAGE);
    else if (pathname === '/es/te-verde') html(SPANISH_PAGE);
    else if (pathname === '/guides/long') response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': STRICT_CSP }).end(longArticle());
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
/** The fake Google every launch is configured for (`google.env`); connected only by the Search Console tests at the end. */
let google: FakeGoogle;
const { go, contentsIdAt, run } = chromeHelpers(
  () => app!,
  () => page,
);

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;
const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const articleUrl = () => `${site.origin}/guides/green-tea`;

async function launch(): Promise<void> {
  ({ app, page } = await launchApp([], { userDataDir: profile, env: google.env }));
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

/** A box the sentence overlay draws (document coordinates, CSS px) and its label (`''` on a sentence's later lines). */
interface SentenceBox {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The highlight overlay's state, read in the SEO isolated world (the page itself cannot see it). */
function overlay(id: number): Promise<{ mode: string; boxes: number; draws: number; drawn: SentenceBox[] } | null> {
  return app!.evaluate(
    ({ webContents }, { id, world }) =>
      webContents.fromId(id)!.executeJavaScriptInIsolatedWorld(world, [
        {
          code: `(() => {
            const s = globalThis.__frostSeoHighlight;
            if (!s) return null;
            const px = (value) => Number.parseFloat(value);
            const drawn = [...s.root.children]
              .filter((box) => getComputedStyle(box).position === 'absolute')
              .map((box) => {
                const cs = getComputedStyle(box);
                return { label: box.textContent, x: px(cs.left), y: px(cs.top), width: px(cs.width), height: px(cs.height) };
              });
            return { mode: s.mode, boxes: s.boxes(), draws: s.draws(), drawn };
          })()`,
        },
      ]) as Promise<{ mode: string; boxes: number; draws: number; drawn: SentenceBox[] } | null>,
    { id, world: SEO_WORLD_ID },
  );
}

/** What the page's own (main) world sees of its document (as `seo-panels.e2e.ts`'s `pageDom`). */
const pageDom = (id: number) =>
  run(
    id,
    `(() => ({ html: document.documentElement.outerHTML, children: document.documentElement.childElementCount, styled: [...document.querySelectorAll('[style]')].filter((el) => el.parentElement !== document.documentElement).length, sheets: document.styleSheets.length }))()`,
  ) as Promise<{ html: string; children: number; styled: number; sheets: number }>;

/** A page element's box in document coordinates, read in the page's own world. */
const elementBox = (id: number, selector: string) =>
  run(id, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`) as Promise<{ x: number; y: number; width: number; height: number }>;

/** `box` lies within `area` (1 px of rounding allowed). */
const inside = (box: Omit<SentenceBox, 'label'>, area: { x: number; y: number; width: number; height: number }) =>
  box.x >= area.x - 1 && box.y >= area.y - 1 && box.x + box.width <= area.x + area.width + 1 && box.y + box.height <= area.y + area.height + 1;

test.beforeAll(async () => {
  site = await startSite();
  google = await startFakeGoogle();
  google.sites = [{ siteUrl: `${site.origin}/`, permissionLevel: 'siteOwner' }];
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-content-'));
  await launch();
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
  await google?.close();
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
  // Deleting the draft goes back to the page's own snippet (and leaves no draft for later tests).
  await page.getByTestId('seo-draft-delete').click();
  await expect(page.locator('[data-testid="seo-snippet-source"][data-source="draft"]')).toHaveCount(0);
  await expect(desktopTitle).toHaveAttribute('data-truncated', 'true');
});

// Phase 11 Task 3: the result preview's schema facts, toggles, site-name override and rich variants.
test('serp-preview-schema-facts-and-variants', async () => {
  await openContent(`${site.origin}/guides/sencha`);
  const host = new URL(site.origin).host;
  // The standard previews: the WebSite's name (markup is text), a drawn monogram, the schema trail in position order, the date and rating.
  for (const device of ['desktop', 'mobile']) {
    await expect(page.getByTestId(`seo-serp-${device}-site-name`)).toHaveText(RICH_SITE_NAME);
    await expect(page.getByTestId(`seo-serp-${device}-monogram`)).toHaveText('L');
    await expect(page.getByTestId(`seo-serp-${device}-trail`)).toHaveText(`${host} › Home › Guides › Sencha`);
    await expect(page.getByTestId(`seo-serp-${device}-date`)).toContainText('Mar 4, 2025');
    await expect(page.getByTestId(`seo-serp-${device}-rating`)).toContainText('★★★★★');
    await expect(page.getByTestId(`seo-serp-${device}-rating`)).toContainText('Rating: 4.6 · 87 reviews');
  }
  await expect(page.getByTestId('seo-serp-preview-note')).toHaveText(SERP_PREVIEW_NOTE);
  // No favicon, thumbnail or other image is loaded into the chrome; the page's markup made no element.
  expect(await sidebar().evaluate((root) => ({ img: root.querySelectorAll('img').length, b: root.querySelectorAll('b').length, style: root.querySelectorAll('[style]').length }))).toEqual({ img: 0, b: 0, style: 0 });

  // The toggles hide their parts (session only).
  const toggle = (name: string) => page.locator(`[data-testid="seo-serp-toggle"][data-toggle="${name}"]`);
  await toggle('date').click();
  await expect(toggle('date')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('seo-serp-desktop-date')).toHaveCount(0);
  await toggle('rating').click();
  await expect(page.getByTestId('seo-serp-desktop-rating')).toHaveCount(0);
  await toggle('breadcrumb').click();
  await expect(page.getByTestId('seo-serp-desktop-trail')).toHaveText(host);
  for (const name of ['date', 'rating', 'breadcrumb']) await toggle(name).click();
  await expect(page.getByTestId('seo-serp-desktop-date')).toHaveCount(1);
  // A site-name override replaces the name and its monogram; clearing it brings the page's back.
  await page.getByTestId('seo-serp-site-name-input').fill('my tea shop');
  await expect(page.getByTestId('seo-serp-desktop-site-name')).toHaveText('my tea shop');
  await expect(page.getByTestId('seo-serp-desktop-monogram')).toHaveText('M');
  await page.getByTestId('seo-serp-site-name-input').fill('');
  await expect(page.getByTestId('seo-serp-desktop-site-name')).toHaveText(RICH_SITE_NAME);

  // The rich variants: frost's own cards, under the note.
  const variant = (name: string) => page.locator(`[data-testid="seo-serp-variant"][data-variant="${name}"]`);
  const card = page.getByTestId('seo-serp-variant-card');
  const lines = () => card.getByTestId('seo-serp-card-line').allTextContents();
  await variant('top-stories').click();
  await expect(card).toHaveAttribute('data-variant', 'top-stories');
  await expect(page.getByTestId('seo-serp-desktop')).toHaveCount(0);
  expect(await lines()).toEqual(['L' + RICH_SITE_NAME, 'How to brew sencha', 'Mar 4, 2025']);
  await variant('video').click();
  await expect(card).toHaveAttribute('data-variant', 'video');
  expect(await lines()).toEqual(['2:05', 'Brewing sencha in two minutes', `${RICH_SITE_NAME} · Mar 1, 2025`]);
  await variant('recipe').click();
  await expect(card).toHaveAttribute('data-variant', 'recipe');
  expect(await lines()).toEqual(['Iced sencha', 'L' + RICH_SITE_NAME, '1 hr 10 min · Makes 2 glasses']);
  await expect(page.getByTestId('seo-serp-preview-note')).toHaveText(SERP_PREVIEW_NOTE);
  expect(await sidebar().evaluate((root) => root.querySelectorAll('img').length)).toBe(0);
  await variant('standard').click();
  await expect(page.getByTestId('seo-serp-desktop')).toBeVisible();

  // Without structured data: og:site_name, the URL's trail and article:published_time; the rich variants are offered disabled.
  await openContent(`${site.origin}/guides/plain`);
  await expect(page.getByTestId('seo-serp-desktop-site-name')).toHaveText('Plain Tea Co');
  await expect(page.getByTestId('seo-serp-desktop-trail')).toHaveText(`${host} › guides › plain`);
  await expect(page.getByTestId('seo-serp-desktop-date')).toContainText('Jun 1, 2024');
  await expect(page.getByTestId('seo-serp-desktop-rating')).toHaveCount(0);
  for (const name of ['top-stories', 'video', 'recipe'] as const) {
    await expect(variant(name)).toBeDisabled();
    await expect(variant(name)).toHaveAttribute('title', SERP_PREVIEW_VARIANT_MISSING[name]);
  }
  await expect(page.getByTestId('seo-snippet-copy-jsonld')).toBeDisabled();
});

// Phase 11 Task 3: Copy JSON-LD, through main's clipboard.
test('copy-jsonld', async () => {
  await openContent(`${site.origin}/guides/sencha`);
  // The page's own blocks that fed the preview: every one but the Organization, formatted.
  await app!.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await page.getByTestId('seo-snippet-copy-jsonld').click();
  await expect(page.getByTestId('seo-content-flash')).toHaveText('Copied JSON-LD');
  const copied = await app!.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied.split('\n\n').map((block) => JSON.parse(block) as unknown)).toEqual(RICH_BLOCKS.slice(1));
  // A suggested JSON-LD main builds, with the session's site-name override; every < escaped.
  await page.getByTestId('seo-serp-site-name-input').fill('Tea <shop>');
  await page.getByTestId('seo-snippet-copy-jsonld-suggested').click();
  await expect(page.getByTestId('seo-content-flash')).toHaveText('Copied suggested JSON-LD');
  const suggested = await app!.evaluate(({ clipboard }) => clipboard.readText());
  expect(suggested).not.toContain('<');
  expect(suggested).toContain('Tea \\u003cshop>');
  const json = JSON.parse(suggested) as { '@context': string; '@graph': Record<string, unknown>[] };
  expect(json['@context']).toBe(SUGGESTED_JSONLD_SHAPE.context);
  expect(json['@graph'].map((node) => node['@type'])).toEqual([...SUGGESTED_JSONLD_SHAPE.graph]);
  const pageUrl = `${site.origin}/guides/sencha`;
  expect(json['@graph'][0]).toEqual({ '@type': 'WebSite', '@id': `${site.origin}/#website`, name: 'Tea <shop>', url: `${site.origin}/` });
  expect(json['@graph'][1]).toMatchObject({ itemListElement: [{ position: 1, name: 'Home', item: 'https://example.com/' }, { position: 2, name: 'Guides', item: 'https://example.com/guides' }, { position: 3, name: 'Sencha' }] });
  expect(json['@graph'][2]).toMatchObject({ '@id': pageUrl, url: pageUrl, name: 'How to brew sencha', datePublished: '2025-03-04T09:00:00+01:00' });
  await page.getByTestId('seo-serp-site-name-input').fill('');
});

test('target-query-persists', async () => {
  await openContent(articleUrl());
  // A draft of this test's own (no other test's state is relied on).
  // A function: the page object changes with the relaunch below.
  const draft = () => page.locator('[data-testid="seo-snippet-source"][data-source="draft"]');
  await expect(draft()).toHaveCount(0);
  await page.getByTestId('seo-snippet-add').click();
  await page.getByTestId('seo-draft-title').fill('A draft that survives a relaunch');
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
  await expect(draft()).toHaveCount(1);

  // A relaunch on the same profile: the query and the draft are still there.
  await closeApp(app);
  app = undefined;
  await launch();
  await openContent(articleUrl());
  await expect(page.getByTestId('seo-query-input')).toHaveValue('green tea kettle');
  await expect(place('title')).toHaveAttribute('data-presence', 'some');
  await expect(draft()).toHaveCount(1);
  await draft().click();
  await expect(page.getByTestId('seo-draft-title')).toHaveValue('A draft that survives a relaunch');
  // Deleting the draft and clearing the query remove them.
  await page.getByTestId('seo-draft-delete').click();
  await expect(draft()).toHaveCount(0);
  await page.getByTestId('seo-query-clear').click();
  await expect(page.getByTestId('seo-query-input')).toHaveValue('');
  await expect(page.getByTestId('seo-query-checklist')).toHaveCount(0);
});

/** Answers main's next message boxes with `answers` (and records them), as the user would click. */
async function stubMessageBoxes(answers: { response: number; checkboxChecked: boolean }[]): Promise<() => Promise<{ message: string; checkboxLabel?: string }[]>> {
  await app!.evaluate(({ dialog }, queued) => {
    const record = { calls: [] as unknown[], answers: queued };
    (globalThis as unknown as { __contentDialogs: typeof record }).__contentDialogs = record;
    Object.assign(dialog, {
      showMessageBox: async (...args: unknown[]) => {
        record.calls.push(args.length > 1 ? args[1] : args[0]);
        return record.answers.shift() ?? { response: 1, checkboxChecked: false };
      },
    });
  }, answers);
  return () => app!.evaluate(() => (globalThis as unknown as { __contentDialogs: { calls: { message: string; checkboxLabel?: string }[] } }).__contentDialogs.calls);
}

/**
 * Runs the menu's Clear Browsing Data… and waits until it has asked (`calls`: the dialogs since the
 * last `stubMessageBoxes`). The item is clicked again until it asks: while an earlier clear is
 * still running, the item answers that same run and shows no dialog (`createClearBrowsingData`),
 * and a clear takes a few hundred milliseconds on Windows.
 */
async function clearBrowsingDataAsks(calls: () => Promise<unknown[]>): Promise<void> {
  const { menu } = chromeHelpers(
    () => app!,
    () => page,
  );
  await expect
    .poll(async () => {
      if ((await calls()).length === 0) await menu('clear-browsing-data');
      return (await calls()).length;
    })
    .toBe(1);
}

/** Stores a query and a draft for the article (through the panel), and waits until main has them. */
async function writeNotes(): Promise<void> {
  await openContent(articleUrl());
  await page.getByTestId('seo-query-input').fill('loose leaf');
  await page.getByTestId('seo-snippet-add').click();
  await page.getByTestId('seo-draft-title').fill('A note to delete');
  await railItem('overview').click();
  await railItem('content').click();
  await expect(page.getByTestId('seo-query-input')).toHaveValue('loose leaf');
  await expect(page.locator('[data-testid="seo-snippet-source"][data-source="draft"]')).toHaveCount(1);
}

/** The panel's notes as main has them now (opened again, so read back). */
async function storedNotes(): Promise<{ query: string; drafts: number }> {
  await railItem('overview').click();
  await railItem('content').click();
  await expect(page.getByTestId('seo-query-input')).toBeEnabled();
  return { query: await page.getByTestId('seo-query-input').inputValue(), drafts: await page.locator('[data-testid="seo-snippet-source"][data-source="draft"]').count() };
}

test('delete-all-notes-and-clear-browsing-data', async () => {
  await writeNotes();
  // Clear Browsing Data with its box unticked (the default) keeps the notes …
  let calls = await stubMessageBoxes([{ response: 0, checkboxChecked: false }]);
  await clearBrowsingDataAsks(calls);
  expect((await calls())[0]).toMatchObject({ checkboxLabel: 'Also remove target queries and snippet drafts', checkboxChecked: false });
  expect(await storedNotes()).toEqual({ query: 'loose leaf', drafts: 1 });
  // … ticked, it removes them (asked again once the first clear has ended).
  calls = await stubMessageBoxes([{ response: 0, checkboxChecked: true }]);
  await clearBrowsingDataAsks(calls);
  await expect.poll(storedNotes).toEqual({ query: '', drafts: 0 });

  // The panel's "Delete all notes": cancelled, nothing goes; confirmed, every note goes.
  await writeNotes();
  calls = await stubMessageBoxes([{ response: 1, checkboxChecked: false }, { response: 0, checkboxChecked: false }]);
  await page.getByTestId('seo-notes-delete-all').click();
  await expect(page.getByTestId('seo-content-flash')).toHaveText('Nothing was deleted');
  expect((await calls())[0]).toMatchObject({ message: 'Delete all content notes?' });
  expect(await storedNotes()).toEqual({ query: 'loose leaf', drafts: 1 });
  await page.getByTestId('seo-notes-delete-all').click();
  await expect(page.getByTestId('seo-content-flash')).toHaveText('Every content note deleted');
  // The open panel drops them at once.
  await expect(page.getByTestId('seo-query-input')).toHaveValue('');
  await expect(page.locator('[data-testid="seo-snippet-source"][data-source="draft"]')).toHaveCount(0);
  expect(await storedNotes()).toEqual({ query: '', drafts: 0 });
});

// Codex review (PR #6): Clear Browsing Data deleting the notes resets an open Content panel.
test('clear-browsing-data-resets-open-content-panel', async () => {
  const drafts = () => page.locator('[data-testid="seo-snippet-source"][data-source="draft"]');
  await writeNotes();
  // An edit not saved yet (saves wait for typing to pause) when the notes are deleted.
  await page.getByTestId('seo-query-input').fill('loose leaf tin');
  const calls = await stubMessageBoxes([{ response: 0, checkboxChecked: true }]);
  await clearBrowsingDataAsks(calls);
  // The open panel (not opened again) drops the deleted query and draft at once.
  await expect(page.getByTestId('seo-query-input')).toHaveValue('');
  await expect(drafts()).toHaveCount(0);
  // The pending edit was not saved afterwards: main has nothing.
  expect(await storedNotes()).toEqual({ query: '', drafts: 0 });
  // A later edit stores only itself; nothing deleted comes back with it.
  await page.getByTestId('seo-query-input').fill('oolong');
  await expect.poll(storedNotes).toEqual({ query: 'oolong', drafts: 0 });
  // Leaves no note for the other tests.
  await page.getByTestId('seo-query-clear').click();
  await expect.poll(storedNotes).toEqual({ query: '', drafts: 0 });
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
  // (Phase 8) A difficult sentence holding markup is listed as text.
  await expect(page.getByTestId('seo-difficult-sentence')).toHaveCount(1);
  await expect(page.getByTestId('seo-difficult-sentence')).toHaveAttribute('data-reason', 'long');
  await expect(page.getByTestId('seo-difficult-text')).toHaveText(INERT_SENTENCE);
  expect(await page.getByTestId('seo-difficult-sentences').evaluate((list) => list.querySelectorAll('img, b, script').length)).toBe(0);
  // Nothing from the page ran in the chrome.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await page.getByTestId('seo-query-clear').click();
});

test('content-readability-depth', async () => {
  const url = `${site.origin}/es/te-verde`;
  await openContent(url);
  // The Szigriszt-Pazos score of the page's text (one decimal) in its INFLESZ band: the pure engine's
  // values for the fixture's text, so the whole path (extract, analyse, show) is checked.
  const expected = readability(SPANISH_TEXT, 'es');
  if (expected.status !== 'ok') throw new Error('the Spanish fixture is not scored');
  await expect(page.getByTestId('seo-readability')).toHaveAttribute('data-status', 'ok');
  await expect(page.getByTestId('seo-readability')).toHaveAttribute('data-formula', 'szigriszt-pazos');
  await expect(page.getByTestId('seo-readability-formula')).toHaveText('Szigriszt-Pazos');
  await expect(page.getByTestId('seo-readability-score')).toHaveText(expected.score.toFixed(1));
  await expect(page.getByTestId('seo-readability-band')).toHaveText(expected.band);
  expect(INFLESZ_BANDS.map((band) => band.label)).toContain(expected.band);
  expect(expected.band).toBe('Quite easy');
  // The sentence statistics.
  const report = sentenceReport(SPANISH_TEXT, 'es');
  if (report.status !== 'ok') throw new Error('the Spanish fixture has no sentences');
  const stats = page.getByTestId('seo-sentence-stats');
  expect(await stats.locator('dt').allTextContents()).toEqual(['Sentences', 'Words per sentence', 'Longest sentence', `Over ${SENTENCE_LIMITS.longSentenceWords} words`, 'Complex words']);
  expect(await stats.locator('dd').allTextContents()).toEqual([
    String(report.sentences),
    report.averageWords.toLocaleString('en-US', { maximumFractionDigits: 1 }),
    `${report.longestWords} words`,
    String(report.longCount),
    `${(Math.round(report.complexWordShare! * 1000) / 10).toLocaleString('en-US')}%`,
  ]);
  expect({ sentences: report.sentences, longestWords: report.longestWords, longCount: report.longCount }).toEqual({ sentences: 15, longestWords: 33, longCount: 1 });
  // The difficult sentences, in page order, with their reasons; and the toggle that boxes them.
  await expect(page.getByTestId('seo-difficult-heading')).toHaveText('Difficult sentences (2)');
  const rows = page.getByTestId('seo-difficult-sentence');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-reason', 'long');
  await expect(rows.nth(0).getByTestId('seo-difficult-text')).toHaveText(SPANISH_LONG);
  await expect(rows.nth(0)).toContainText('33 words');
  await expect(rows.nth(1)).toHaveAttribute('data-reason', 'complex');
  await expect(rows.nth(1).getByTestId('seo-difficult-text')).toHaveText(SPANISH_COMPLEX);
  await expect(rows.nth(1)).toContainText('Complex');
  await expect(page.getByTestId('seo-highlight-sentences')).toHaveAttribute('aria-pressed', 'false');
});

test('content-highlight-sentences-leaves-no-residue', async () => {
  const url = `${site.origin}/guides/long`;
  await openContent(url);
  const id = await contentsIdAt(url);
  // The page really is locked down: its own inline style attribute is refused.
  expect(await run(id, `(() => { const d = document.createElement('div'); d.setAttribute('style', 'position: absolute'); document.body.append(d); const p = getComputedStyle(d).position; d.remove(); return p; })()`)).toBe('static');
  await expect(page.getByTestId('seo-difficult-heading')).toHaveText('Difficult sentences (3)');
  const before = await pageDom(id);
  const toggle = page.getByTestId('seo-highlight-sentences');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await overlay(id))?.boxes ?? 0).toBeGreaterThan(0);
  // One toggle on a still page: one drawing pass.
  await page.waitForTimeout(400);
  const state = (await overlay(id))!;
  expect(state.mode).toBe('sentences');
  expect(state.draws).toBe(1);
  expect(state.drawn).toHaveLength(state.boxes);
  // Real boxes where the sentences are: each sentence labelled once (on its first line), every box a
  // line-sized rectangle inside the article, the last one below the fold (document coordinates). An
  // inline element inside a sentence (the `<em>`, the link) is not boxed a second time over its words:
  // no two boxes overlap. (The number of boxes follows the line wrapping, so it differs between fonts.)
  const rects = state.drawn.map((box) => `${box.x} ${box.y} ${box.width} ${box.height}`);
  for (const [i, a] of state.drawn.entries()) {
    for (const b of state.drawn.slice(i + 1)) {
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(overlapX > 1 && overlapY > 1, rects.join(' | ')).toBe(false);
    }
  }
  const label = HIGHLIGHT_STYLES['long-sentence'].label;
  const labelled = state.drawn.filter((box) => box.label !== '');
  expect(labelled.map((box) => box.label)).toEqual([label, label, label]);
  const main = await elementBox(id, 'main');
  for (const box of state.drawn) {
    expect(box.width).toBeGreaterThanOrEqual(1);
    expect(box.height).toBeGreaterThanOrEqual(8);
    expect(box.height).toBeLessThanOrEqual(40);
    expect(inside(box, main), JSON.stringify(box)).toBe(true);
  }
  const places = await Promise.all((['#first', '#middle', '#last'] as const).map((selector) => elementBox(id, selector)));
  labelled.forEach((box, i) => expect(inside(box, places[i]!), `sentence ${i + 1}: ${JSON.stringify(box)}`).toBe(true));
  const viewportHeight = (await run(id, 'innerHeight')) as number;
  expect(labelled[2]!.y).toBeGreaterThan(viewportHeight);
  // Nothing of it reaches the page's own world.
  expect(await run(id, "typeof window.__frostSeoHighlight === 'undefined'")).toBe(true);
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

  // On, then leaving the Content panel: removed, and the toggle is off when the panel comes back.
  await toggle.click();
  await expect.poll(async () => (await overlay(id))?.boxes ?? 0).toBeGreaterThan(0);
  await railItem('overview').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'overview');
  await expect.poll(async () => (await pageDom(id)).html).toBe(before.html);
  expect(await overlay(id)).toBeNull();
  await railItem('content').click();
  await expect(page.getByTestId('seo-highlight-sentences')).toHaveAttribute('aria-pressed', 'false');

  // On again, then a navigation (the Content panel stays open): the mode resets and nothing is left in the new page either.
  await page.getByTestId('seo-highlight-sentences').click();
  await expect.poll(async () => (await overlay(id))?.boxes ?? 0).toBeGreaterThan(0);
  const next = `${site.origin}/es/te-verde`;
  await openContent(next);
  await expect(page.getByTestId('seo-highlight-sentences')).toHaveAttribute('aria-pressed', 'false');
  const nextId = await contentsIdAt(next);
  expect(await overlay(nextId)).toBeNull();
  expect((await pageDom(nextId)).html).not.toContain('aria-hidden');
});

test('highlight-keyphrase-from-ngram', async () => {
  const url = `${site.origin}/guides/shoes`;
  await openContent(url);
  const id = await contentsIdAt(url);
  const before = await pageDom(id);
  await page.locator('[data-testid="seo-ngram-size"][data-size="2"]').click();
  const row = page.getByTestId('seo-ngram').filter({ has: page.getByTestId('seo-ngram-text').getByText('running shoes', { exact: true }) });
  await expect(row.getByTestId('seo-ngram-count')).toHaveText('4');
  const toggle = row.getByTestId('seo-ngram-highlight');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Every whole-word occurrence (the heading's, the capitalised one), each on one line; not "running shoestring".
  await expect.poll(async () => (await overlay(id))?.drawn.map((box) => box.label)).toEqual(Array.from({ length: 4 }, () => HIGHLIGHT_STYLES.keyphrase.label));
  expect((await overlay(id))!.mode).toBe('keyphrase');
  const places = await Promise.all(['h1', 'p:nth-of-type(1)', 'p:nth-of-type(2)', 'p:nth-of-type(3)'].map((selector) => elementBox(id, `main > ${selector}`)));
  (await overlay(id))!.drawn.forEach((box, i) => expect(inside(box, places[i]!), `occurrence ${i + 1}: ${JSON.stringify(box)}`).toBe(true));
  // Nothing of it reaches the page's own world; one host element of frost's own.
  expect(await run(id, "typeof window.__frostSeoHighlight === 'undefined'")).toBe(true);
  expect((await pageDom(id)).children).toBe(before.children + 1);
  // Leaving the Content panel removes it and leaves the page as it was.
  await railItem('overview').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'overview');
  await expect.poll(async () => (await pageDom(id)).html).toBe(before.html);
  expect(await overlay(id)).toBeNull();
  await railItem('content').click();
  await page.locator('[data-testid="seo-ngram-size"][data-size="2"]').click();
  await expect(row.getByTestId('seo-ngram-highlight')).toHaveAttribute('aria-pressed', 'false');
});

// Search Console under the target query (seo-content.feature.md, Search Console targets): connected at
// the end of the file, so the tests above see the panel as before (configured, not connected).

/** Opens Settings from the command palette and connects Search Console there (the stand-in browser plays Google's consent). */
async function connectSearchConsole(): Promise<void> {
  const { press, chromeCaughtUp } = chromeHelpers(
    () => app!,
    () => page,
  );
  const { recordOpenExternal, connectInSettings } = accountHelpers(
    () => app!,
    () => page,
  );
  await recordOpenExternal();
  await chromeCaughtUp();
  await press('chrome', 'K', ['mod']);
  await page.getByTestId('command-palette-input').fill('settings');
  await page.locator('[data-testid="command-palette-option"][data-action="settings.open"]').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await connectInSettings();
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('settings-view')).toHaveCount(0);
}

/** The fake Google's reads of one dimension, in order. */
const readsOf = (dimension: 'query' | 'page') => google.queries.filter((q) => (q.body.dimensions as string[] | undefined)?.[0] === dimension);
const RANGE = GSC_RANGE_TEXT.lastDays.replace('{n}', '28');

test('content-gsc-suggestion-sets-target', async () => {
  // Configured but not connected: the target query section is as before, and nothing was read.
  await openContent(articleUrl());
  await expect(page.getByTestId('seo-query-input')).toHaveValue('');
  await expect(page.getByTestId('gsc-targets')).toHaveCount(0);
  expect(google.queries).toEqual([]);

  await connectSearchConsole();
  await openContent(articleUrl());
  const suggestions = page.getByTestId('gsc-target-suggestions');
  await expect(suggestions).toHaveAttribute('data-state', 'list');
  // The page's top queries (the fake's, most clicks first), at most five, each with "Use as target".
  const rows = page.getByTestId('gsc-target-suggestion');
  await expect(rows).toHaveCount(GSC_TARGET_SUGGESTIONS);
  await expect(page.getByTestId('gsc-target-suggestion-query')).toHaveText(Array.from({ length: GSC_TARGET_SUGGESTIONS }, (_, i) => `fake query ${i + 1}`));
  await expect(page.getByTestId('gsc-target-use')).toHaveCount(GSC_TARGET_SUGGESTIONS);
  await expect(page.getByTestId('gsc-target-suggestions-note')).toHaveText(GSC_TARGETS_COPY.suggestionsNote.replace('{range}', RANGE));
  // Read for this page, without a country or device; nothing about pages yet (no target query).
  const read = readsOf('query').at(-1)!;
  expect(fakeFiltersOf(read.body)).toEqual({ page: articleUrl(), query: null, country: null, device: null });
  expect(readsOf('page')).toEqual([]);

  // "Use as target" on the second: the field shows it, the row is marked, and main keeps it.
  const second = rows.nth(1);
  await expect(second.getByTestId('gsc-target-use')).toHaveAttribute('aria-label', GSC_TARGETS_COPY.useAsTargetLabel.replace('{query}', 'fake query 2'));
  await second.getByTestId('gsc-target-use').click();
  await expect(page.getByTestId('seo-query-input')).toHaveValue('fake query 2');
  await expect(second).toHaveAttribute('data-target', 'true');
  await expect(second.getByTestId('gsc-target-current')).toHaveText(GSC_TARGETS_COPY.currentTarget);
  await expect(second.getByTestId('gsc-target-use')).toHaveCount(0);
  await expect.poll(storedNotes).toEqual({ query: 'fake query 2', drafts: 0 });
});

test('content-target-pages-marks-this-page', async () => {
  const other = `${site.origin}/guides/oolong`;
  const third = `${site.origin}/guides/black-tea`;
  google.pageRows = (query) =>
    query === 'fake query 3'
      ? [
          { keys: [other], clicks: 40, impressions: 400, ctr: 0.1, position: 2 },
          { keys: [articleUrl()], clicks: 25, impressions: 300, ctr: 0.08, position: 3 },
          { keys: [third], clicks: 5, impressions: 90, ctr: 0.05, position: 7 },
        ]
      : [];
  await openContent(articleUrl());
  await expect(page.getByTestId('gsc-target-suggestions')).toHaveAttribute('data-state', 'list');
  // A target query of this test's own, set as the user does.
  await page.getByTestId('gsc-target-suggestion').nth(2).getByTestId('gsc-target-use').click();
  await expect(page.getByTestId('seo-query-input')).toHaveValue('fake query 3');
  // The query→page check: the property's pages Google showed for it, this page marked, its place said.
  const pages = page.getByTestId('gsc-target-pages');
  await expect(pages).toHaveAttribute('data-state', 'list');
  const rows = page.getByTestId('gsc-target-page');
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('gsc-target-page-url')).toHaveText([other, articleUrl(), third]);
  await expect(rows.nth(1)).toHaveAttribute('data-this-page', 'true');
  await expect(rows.nth(1).getByTestId('gsc-target-this-page')).toHaveText(GSC_TARGETS_COPY.thisPage);
  await expect(page.getByTestId('gsc-target-this-page')).toHaveCount(1);
  await expect(page.getByTestId('gsc-target-pages-summary')).toHaveText(
    GSC_TARGETS_COPY.thisPageRank.replace('{rank}', '2').replace('{pages}', '3 pages').replace('{query}', 'fake query 3').replace('{range}', RANGE),
  );
  await expect(page.getByTestId('gsc-target-pages-facts')).toHaveText(GSC_TARGETS_COPY.facts);
  // Facts only: another page leading looks like this page leading (no tone), and page URLs are never links.
  expect(await pages.evaluate((root) => ({ toned: root.querySelectorAll('[data-tone]').length, links: root.querySelectorAll('a, [href]').length }))).toEqual({ toned: 0, links: 0 });
  // One read of the property's pages for the saved target query (no page, country or device filter).
  const read = readsOf('page').filter((q) => fakeFiltersOf(q.body).query === 'fake query 3');
  expect(read).toHaveLength(1);
  expect(fakeFiltersOf(read[0]!.body)).toEqual({ page: null, query: 'fake query 3', country: null, device: null });
  // Leaves no note for later runs.
  await page.getByTestId('seo-query-clear').click();
  await expect.poll(storedNotes).toEqual({ query: '', drafts: 0 });
});
