// Specs: specs/seo-content.spec.ts (SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS, TARGET_QUERY_PLACES, Copy as HTML,
// READABILITY_FORMULAS, INFLESZ_BANDS, SENTENCE_LIMITS), specs/seo-sidebar.spec.ts (SEO_PANELS, HIGHLIGHT_MODES,
// HIGHLIGHT_STYLES, TextHighlightTarget), specs/seo-limits.spec.ts (SEO_WORLD_ID)
// Acceptance: specs/seo-content.feature.md (End to end)
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readability, sentenceReport, textWidth } from '@app/seo-core';
import { INFLESZ_BANDS, SENTENCE_LIMITS, SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS } from '@app/specs/seo-content.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS, SEO_WORLD_ID } from '@app/specs/seo-limits.spec';
import { HIGHLIGHT_STYLES, SEO_PANELS } from '@app/specs/seo-sidebar.spec';
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

async function startSite() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    if (pathname === '/guides/green-tea') html(article());
    else if (pathname === '/inert') html(INERT_PAGE);
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
const { go, contentsIdAt, run } = chromeHelpers(
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
  // Deleting the draft goes back to the page's own snippet (and leaves no draft for later tests).
  await page.getByTestId('seo-draft-delete').click();
  await expect(page.locator('[data-testid="seo-snippet-source"][data-source="draft"]')).toHaveCount(0);
  await expect(desktopTitle).toHaveAttribute('data-truncated', 'true');
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
  const { menu } = chromeHelpers(
    () => app!,
    () => page,
  );
  await writeNotes();
  // Clear Browsing Data with its box unticked (the default) keeps the notes …
  let calls = await stubMessageBoxes([{ response: 0, checkboxChecked: false }]);
  await menu('clear-browsing-data');
  await expect.poll(async () => (await calls()).length).toBe(1);
  expect((await calls())[0]).toMatchObject({ checkboxLabel: 'Also remove target queries and snippet drafts', checkboxChecked: false });
  expect(await storedNotes()).toEqual({ query: 'loose leaf', drafts: 1 });
  // … ticked, it removes them.
  calls = await stubMessageBoxes([{ response: 0, checkboxChecked: true }]);
  await menu('clear-browsing-data');
  await expect.poll(async () => (await calls()).length).toBe(1);
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
  const { menu } = chromeHelpers(
    () => app!,
    () => page,
  );
  const drafts = () => page.locator('[data-testid="seo-snippet-source"][data-source="draft"]');
  await writeNotes();
  // An edit not saved yet (saves wait for typing to pause) when the notes are deleted.
  await page.getByTestId('seo-query-input').fill('loose leaf tin');
  const calls = await stubMessageBoxes([{ response: 0, checkboxChecked: true }]);
  await menu('clear-browsing-data');
  await expect.poll(async () => (await calls()).length).toBe(1);
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
  // inline element inside a sentence (the `<em>`, the link) is not boxed a second time over its words.
  expect(state.drawn).toHaveLength(11);
  const rects = state.drawn.map((box) => `${box.x} ${box.y} ${box.width} ${box.height}`);
  expect(new Set(rects).size, rects.join(' | ')).toBe(rects.length);
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
