// Spec: specs/serp.spec.ts (SERP_WORLD_ID, SERP_READ_LIMITS, SERP_READ_FAILURES),
// specs/serp-snapshot.schema.ts (SerpReadSchema, SerpSnapshotSchema), specs/serp-selector-pack.spec.ts (SERP_PACK_PUBLIC_KEYS)
// Acceptance: specs/serp-overlay.feature.md (Reading; review focus serp-reader-is-bounded)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';
import { SERP_READ_LIMITS, SERP_WORLD_ID, type SerpReadLimits } from '@app/specs/serp.spec';
import { SERP_PACK_PUBLIC_KEYS } from '@app/specs/serp-selector-pack.spec';
import { SelectorPackSchema, type EngineLayout, type SelectorPack } from '@app/specs/serp-selector-pack.schema';
import { SerpReadSchema, SerpSnapshotSchema, type SerpRead } from '@app/specs/serp-snapshot.schema';
import { BUNDLED_PACK } from '../bundled';
import { matchSerp, redirectRules } from '../engines';
import { verifyPack } from '../pack-verify';
import { readSerp, runSerpRead, serpReadScript, type SerpDocument } from '../read-script';
import { analyseSerp } from '../serp-analyse';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(path.join(HERE, 'fixtures', name), 'utf8');

/** The bundled pack, parsed (its signature is checked in `serp-bundled-pack-reads-fixtures`). */
const PACK: SelectorPack = SelectorPackSchema.parse(JSON.parse(new TextDecoder().decode(BUNDLED_PACK.bytes)));
const layoutOf = (pack: SelectorPack, id: string): EngineLayout => pack.engines.find((engine) => engine.id === id)!.layout;

const URLS = {
  google: 'https://www.google.com/search?q=frost&hl=en&gl=us',
  bing: 'https://www.bing.com/search?q=frost&cc=us',
  duckduckgo: 'https://duckduckgo.com/?q=frost&kl=us-en',
  'duckduckgo-html': 'https://html.duckduckgo.com/html/?q=frost',
} as const;

function dom(html: string, url: string = URLS.google, options: ConstructorParameters<typeof JSDOM>[1] = {}): JSDOM {
  return new JSDOM(html, { url, ...options });
}

/**
 * A time budget for the tests that check what is read, not how fast: a cold jsdom read on a loaded
 * CI runner can pass the spec's `budgetMs` and stop early. `serp-reader-time-budget` uses the real one.
 */
const READ_TEST_BUDGET_MS = 10_000;

/** Runs the reader on `document` with the spec's limits and `READ_TEST_BUDGET_MS` (overridden by `limits`). */
function read(document: Document, layout: EngineLayout, limits: Partial<SerpReadLimits> = {}): SerpRead {
  return readSerp(document as unknown as SerpDocument, layout, { ...SERP_READ_LIMITS, budgetMs: READ_TEST_BUDGET_MS, ...limits }) as SerpRead;
}

/** The blocks as `[type, titles]`, and every link in order. */
const titles = (answer: SerpRead) => (answer.blocks ?? []).map((block) => [block.type, block.items.map((item) => item.title)] as const);
const links = (answer: SerpRead) => (answer.blocks ?? []).flatMap((block) => block.items.map((item) => item.url));

describe('reading synthetic result pages', () => {
  test('serp-reader-reads-fixtures', () => {
    const google = read(dom(fixture('google.html')).window.document, layoutOf(PACK, 'google'));
    expect(google.ok).toBe(true);
    expect(titles(google)).toEqual([
      ['ad', ['Frost Gear, sponsored', 'Winter boots on sale']],
      // One result per product, not per link.
      ['shopping', ['Wool mittens', 'Frost scarf']],
      ['featured-snippet', ['What is frost? A short guide']],
      ['organic', ['Frost explained | Example', 'Ten tips for frosty mornings']],
      ['people-also-ask', ['What causes frost?', 'When does frost form?', 'Is frost frozen dew?']],
      ['organic', ['A history of frost']],
      ['video', ['Frost timelapse']],
      // The top-stories wrapper the pack does not read is skipped (`notInside`), never organic.
      ['organic', ['Frostline weather', 'Frost notes', 'Odd link', 'Frost shop']],
      ['ad', ['Ice scrapers, sponsored']],
      ['knowledge-panel', ['Frost']],
      ['related-searches', ['frost on windows', 'black frost']],
    ]);
    expect(links(google)).toEqual([
      'https://ads.example.net/frost-gear',
      'https://shop.example.org/boots',
      'https://shop.example.org/mittens',
      'https://gear.frostline.example/scarf',
      'https://www.icecrystal.example/what-is-frost',
      'https://www.example.com/frost',
      'https://blog.example.org/frost-tips',
      null,
      null,
      null,
      'https://example.com/frost/history',
      'https://video.example.net/watch/frost-timelapse',
      'https://www.frostline.example/',
      // The reader reads links as they are; the worker unwraps redirects.
      'https://www.google.com/url?q=https://alice.github.io/frost-notes&sa=U&ved=x',
      'https://www.google.com/url?sa=t&url=javascript:alert(1)',
      'https://shop.example.com/frost',
      'https://ads.example.net/scrapers',
      'https://encyclopedia.example.org/frost',
      // Relative links resolved against the page.
      'https://www.google.com/search?q=frost+on+windows',
      'https://www.google.com/search?q=black+frost',
    ]);
    expect(SerpReadSchema.safeParse(google).success).toBe(true);

    const bing = read(dom(fixture('bing.html'), URLS.bing).window.document, layoutOf(PACK, 'bing'));
    expect(titles(bing)).toEqual([
      ['ad', ['Frost Gear, sponsored', 'Winter boots']],
      ['featured-snippet', ['What is frost?']],
      // The result inside an answer wrapper is not organic (`notInside`).
      ['organic', ['Frost explained | Example', 'Frost documentation', 'A history of frost', 'Frostline weather']],
      ['related-searches', ['frost depth', 'frost flowers']],
      // The entity panel's own hook, not the whole sidebar (whose ad has no entity title).
      ['knowledge-panel', ['Frost']],
    ]);
    expect(SerpReadSchema.safeParse(bing).success).toBe(true);

    const duck = read(dom(fixture('duckduckgo.html'), URLS.duckduckgo).window.document, layoutOf(PACK, 'duckduckgo'));
    expect(titles(duck)).toEqual([
      ['ad', ['Frost Gear, sponsored']],
      ['organic', ['Frost explained | Example', 'Ten tips for frosty mornings', 'Frostline weather']],
      ['related-searches', ['frost flowers', 'frost depth']],
    ]);
    expect(links(duck).slice(0, 2)).toEqual(['https://ads.example.net/frost-gear', 'https://www.example.com/frost']);

    const plain = read(dom(fixture('duckduckgo-html.html'), URLS['duckduckgo-html']).window.document, layoutOf(PACK, 'duckduckgo'));
    expect(titles(plain)).toEqual([
      ['ad', ['Frost Gear, sponsored']],
      ['organic', ['Frost explained | Example', 'Frost documentation']],
    ]);
  });

  test('serp-reader-dedupes-nested', () => {
    const page = dom(`<!doctype html><body><div id="main"><div id="area">
      <div class="r"><a href="https://a.example/">A</a><div class="r"><a href="https://b.example/">B nested</a></div></div>
      <div class="box"><div class="r"><a href="https://c.example/">C in box</a></div></div>
      <div class="r both"><a href="https://d.example/">D</a></div>
    </div></div></body>`);
    const layout: EngineLayout = {
      results: '#main',
      blocks: [
        { type: 'ad', container: '#area', item: '.both' },
        { type: 'organic', container: '#area', item: '.r', required: true },
        { type: 'featured-snippet', container: '#area .box' },
      ],
    };
    const answer = read(page.window.document, layout);
    // D goes to the earlier block (pack order); B, nested in A, counts once; C is the box's (the
    // most specific block), not organic.
    expect(titles(answer)).toEqual([
      ['organic', ['A']],
      ['featured-snippet', ['C in box']],
      ['ad', ['D']],
    ]);
    // On Google's page, the featured snippet's link, the related question's answer link and the top story are not organic.
    const google = read(dom(fixture('google.html')).window.document, layoutOf(PACK, 'google'));
    const organic = (google.blocks ?? []).filter((block) => block.type === 'organic').flatMap((block) => block.items.map((item) => item.url));
    expect(organic).toHaveLength(7);
    for (const url of ['https://www.icecrystal.example/what-is-frost', 'https://answers.frostline.example/dew', 'https://news.example.net/frost-warning']) expect(organic).not.toContain(url);
  });

  test('serp-reader-precedence-by-closest', () => {
    // More feature containers than a block reads (`maxContainersPerBlock`): their links are still
    // the feature's, never organic, because nesting is decided per item with `closest`.
    const features = Array.from({ length: SERP_READ_LIMITS.maxContainersPerBlock + 4 }, (_, i) => `<block-component><a href="https://f${i}.example/"><h3>Feature ${i}</h3></a></block-component>`).join('');
    const page = dom(`<!doctype html><body><div id="search"><div id="rso">${features}<div><a href="https://www.example.com/"><h3>Organic</h3></a></div></div></div></body>`);
    const answer = read(page.window.document, layoutOf(PACK, 'google'));
    const organic = (answer.blocks ?? []).filter((block) => block.type === 'organic').flatMap((block) => block.items.map((item) => item.title));
    expect(organic).toEqual(['Organic']);
    expect((answer.blocks ?? []).filter((block) => block.type === 'featured-snippet')).toHaveLength(SERP_READ_LIMITS.maxContainersPerBlock);
    expect(answer.stats.truncated).toBe(true);
    // Two blocks sharing one container (DuckDuckGo's ads and results) do not swallow each other: only a container strictly inside counts.
    const shared = dom(`<!doctype html><body><main id="m"><a class="ad" href="https://ad.example/">Ad</a><a href="https://one.example/">One</a></main></body>`);
    const layout: EngineLayout = { results: '#m', blocks: [{ type: 'ad', container: 'main', item: 'a.ad' }, { type: 'organic', container: '#m', item: 'a', required: true }] };
    expect(titles(read(shared.window.document, layout))).toEqual([
      ['ad', ['Ad']],
      ['organic', ['One']],
    ]);
  });

  test('serp-reader-title-required', () => {
    const layout = layoutOf(PACK, 'google');
    // A sidebar with only ads and products is not a knowledge panel: the block names a title.
    const page = dom(`<!doctype html><body><div id="search"><div id="rso"><div><a href="https://www.example.com/"><h3>Organic</h3></a></div></div></div>
      <div id="rhs"><div class="commercial-unit-desktop-rhs"><div class="pla-unit"><a href="https://shop.example.org/p">Product</a></div></div><a href="https://ads.example.net/">Sponsored</a></div></body>`);
    expect(titles(read(page.window.document, layout))).toEqual([
      ['organic', ['Organic']],
      ['shopping', ['Product']],
    ]);
  });

  test('serp-reader-caps-in-document-order', () => {
    const layout = layoutOf(PACK, 'google');
    // 120 product links above the results: the shopping block takes `maxItemsPerBlock`, and the organic results are all read.
    const products = Array.from({ length: 120 }, (_, i) => `<div class="pla-unit"><a href="https://shop${i}.example/">P${i}</a></div>`).join('');
    const organic = Array.from({ length: 10 }, (_, i) => `<div><a href="https://o${i}.example/"><h3>O${i}</h3></a></div>`).join('');
    const page = dom(`<!doctype html><body><div class="commercial-unit-desktop-top">${products}</div><div id="search"><div id="rso">${organic}</div></div></body>`);
    const answer = read(page.window.document, layout);
    expect(answer.ok).toBe(true);
    expect(titles(answer).map(([type, items]) => [type, items.length])).toEqual([
      ['shopping', SERP_READ_LIMITS.maxItemsPerBlock],
      ['organic', 10],
    ]);
    expect(answer.stats).toMatchObject({ truncated: true, organicCut: false });
    // Past `maxResults`, the bottom of the page is cut: here organic results, so `organicCut`.
    const cut = read(page.window.document, layout, { maxResults: SERP_READ_LIMITS.maxItemsPerBlock + 4 });
    expect(titles(cut).map(([type, items]) => [type, items.length])).toEqual([
      ['shopping', SERP_READ_LIMITS.maxItemsPerBlock],
      ['organic', 4],
    ]);
    expect(cut.stats).toMatchObject({ truncated: true, organicCut: true });
    expect(SerpReadSchema.safeParse(cut).success).toBe(true);
  });

  test('serp-reader-boxes', () => {
    // Each item's box is its block's `box` element (Google organic's result wrapper), else the item; document coordinates.
    const page = dom(fixture('google.html'));
    const { window } = page;
    window.scrollTo = () => undefined;
    Object.defineProperty(window, 'scrollY', { value: 1_000 });
    let next = 0;
    window.Element.prototype.getBoundingClientRect = function (this: Element) {
      const top = (next += 50);
      return { left: 8, top, width: this.classList.contains('g') ? 600 : 300, height: 40, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    const answer = read(window.document, layoutOf(PACK, 'google'));
    const organic = (answer.blocks ?? []).filter((block) => block.type === 'organic').flatMap((block) => block.items);
    // Wrapped in div.g: the wrapper's box; not wrapped: the link's.
    expect(organic.map((item) => item.rect?.width)).toEqual([600, 300, 300, 600, 300, 300, 300]);
    expect(organic[0]!.rect).toMatchObject({ x: 8, height: 40 });
    expect(organic[0]!.rect!.y).toBeGreaterThan(1_000);
    // A block's box is the union of its items' boxes.
    const block = (answer.blocks ?? []).find((b) => b.type === 'organic')!;
    expect(block.rect).toMatchObject({ x: 8, width: 600 });
    expect(SerpReadSchema.safeParse(answer).success).toBe(true);
  });

  test('serp-reader-resists-clobbering', () => {
    // Named elements shadow `document`'s and a form's methods in every world; the reader calls its own world's prototypes.
    const html = fixture('google.html').replace(
      '<body>',
      // (Not `createTreeWalker`: jsdom's own selector engine calls `document.createTreeWalker` by name,
      // so that one breaks jsdom itself; Chromium's selector engine is native.)
      '<body><form name="querySelector"></form><form name="querySelectorAll"></form><img name="createElement"><img name="defaultView"><img name="createDocumentFragment"><img name="createTextNode">',
    );
    const page = dom(html);
    const document = page.window.document as unknown as Record<string, unknown>;
    expect(typeof document.querySelector).toBe('object');
    // An element whose own methods are shadowed too.
    const rso = page.window.document.getElementById('rso')!;
    for (const anchor of [...rso.getElementsByTagName('a')]) Object.defineProperty(anchor, 'href', { value: 'https://evil.example/' });
    // (Not `localName`: jsdom's selector engine reads it by name.)
    for (const name of ['querySelectorAll', 'querySelector', 'closest', 'contains', 'compareDocumentPosition']) Object.defineProperty(rso, name, { value: () => null });
    expect(titles(read(page.window.document, layoutOf(PACK, 'google')))).toEqual(titles(read(dom(fixture('google.html')).window.document, layoutOf(PACK, 'google'))));
    expect(links(read(page.window.document, layoutOf(PACK, 'google')))).not.toContain('https://evil.example/');
    // The reader never reads a property of the page's document or elements by name.
    expect(readSerp.toString()).not.toMatch(/document\.[A-Za-z]|\bel\.[A-Za-z]|container\.[A-Za-z]/);
  });

  test('serp-unreadable-never-guesses', () => {
    const layout = layoutOf(PACK, 'google');
    // The results anchor is missing (a changed layout): unreadable, even though links with titles are there.
    expect(read(dom(fixture('google-unreadable.html')).window.document, layout)).toMatchObject({ ok: false, reason: 'no-container' });
    // The anchor is there, related questions too, but the required organic block takes nothing.
    const unknown = dom(`<!doctype html><body><div id="search"><div id="rso">
      <div data-initq="x"><div data-q="1">A question?</div></div>
      <section><a href="https://www.example.com/"><span class="t">Frost</span></a></section>
    </div></div></body>`);
    expect(read(unknown.window.document, layout)).toMatchObject({ ok: false, reason: 'no-results' });
    // Nothing at all.
    expect(read(dom('<!doctype html><body><div id="search"></div></body>').window.document, layout)).toMatchObject({ ok: false, reason: 'no-results' });
    // A failure carries no blocks (only a timeout does).
    expect(read(unknown.window.document, layout).blocks).toBeUndefined();
  });

  test('serp-reader-bad-selector', () => {
    const base = layoutOf(PACK, 'google');
    const organic = { type: 'organic', container: '#rso', item: 'a[href]', required: true } as const;
    const variants: EngineLayout[] = [
      { ...base, results: '#search[[' },
      { results: '#search', blocks: [{ ...organic, container: '#rso >>> a' }] },
      { results: '#search', blocks: [{ ...organic, item: 'a[[href]' }] },
      { results: '#search', blocks: [{ ...organic, link: ':nope(a)' }] },
      { results: '#search', blocks: [{ ...organic, title: 'h3,' }] },
      { results: '#search', blocks: [{ ...organic, notInside: 'g-section[' }] },
      { results: '#search', blocks: [{ ...organic, box: '>' }] },
    ];
    for (const layout of variants) {
      const page = dom(fixture('google.html'));
      const { Document, Element } = page.window;
      const queried = vi.spyOn(Document.prototype, 'querySelector');
      const queriedAll = vi.spyOn(Document.prototype, 'querySelectorAll');
      const elementAll = vi.spyOn(Element.prototype, 'querySelectorAll');
      expect(read(page.window.document, layout), JSON.stringify(layout).slice(0, 80)).toMatchObject({ ok: false, reason: 'bad-selector' });
      // Checked before any page element is read.
      expect(queried).not.toHaveBeenCalled();
      expect(queriedAll).not.toHaveBeenCalled();
      expect(elementAll).not.toHaveBeenCalled();
    }
  });

  test('serp-reader-time-budget', () => {
    const layout = layoutOf(PACK, 'google');
    const late = read(dom(fixture('google.html')).window.document, layout, { budgetMs: 0 });
    expect(late).toMatchObject({ ok: false, reason: 'timeout' });
    expect(SerpReadSchema.safeParse(late).success).toBe(true);
    // A node budget the page exceeds: stopped there, with what was read by then.
    const small = read(dom(fixture('google.html')).window.document, layout, { maxNodesVisited: 12 });
    expect(small).toMatchObject({ ok: false, reason: 'timeout' });
    expect(small.stats.nodes).toBeLessThanOrEqual(12);
    expect(SerpReadSchema.safeParse(small).success).toBe(true);
    // The real budget reads the whole page well within it.
    const full = read(dom(fixture('google.html')).window.document, layout, { budgetMs: SERP_READ_LIMITS.budgetMs });
    expect(full.ok).toBe(true);
    expect(full.stats.elapsedMs).toBeLessThan(SERP_READ_LIMITS.budgetMs);
  });

  test(
    'serp-reader-is-bounded',
    () => {
      const layout = layoutOf(PACK, 'google');
      const page = dom(fixture('google-hostile.html'));
      const { window } = page;
      const document = window.document;
      const rso = document.getElementById('rso')!;
      // An over-long link, a megabyte title, and DOM calls that throw (patched on this world's
      // prototypes, where a reader that calls them would meet them).
      document.getElementById('long')!.setAttribute('href', `https://long.example.net/${'x'.repeat(SERP_READ_LIMITS.maxUrlChars)}`);
      const huge = document.createElement('div');
      huge.innerHTML = '<a href="https://huge.example.net/"><h3></h3></a>';
      huge.querySelector('h3')!.textContent = `huge ${'x'.repeat(1_000_000)}`;
      rso.prepend(huge);
      const throwing = document.createElement('div');
      throwing.innerHTML = '<a href="https://throws.example.net/"><h3>Throws</h3></a><a href="https://text.example.net/"><h3>Text throws</h3></a><a id="boxless" href="https://box.example.net/"><h3>No box</h3></a>';
      rso.append(throwing);
      const href = Object.getOwnPropertyDescriptor(window.HTMLAnchorElement.prototype, 'href')!;
      Object.defineProperty(window.HTMLAnchorElement.prototype, 'href', {
        get(this: HTMLAnchorElement) {
          const value = href.get!.call(this) as string;
          if (value.includes('throws.example')) throw new Error('hostile getter');
          return value;
        },
      });
      const substringData = window.CharacterData.prototype.substringData;
      window.CharacterData.prototype.substringData = function (this: CharacterData, offset: number, count: number) {
        if (this.data === 'Text throws') throw new Error('hostile text');
        return substringData.call(this, offset, count);
      };
      const rect = window.Element.prototype.getBoundingClientRect;
      window.Element.prototype.getBoundingClientRect = function (this: Element) {
        if (this.id === 'boxless') throw new Error('hostile rect');
        return rect.call(this);
      };

      const answer = read(document, layout);
      expect(answer.ok).toBe(true);
      expect(SerpReadSchema.safeParse(answer).success).toBe(true);
      const items = (answer.blocks ?? []).flatMap((block) => block.items);
      // Only the http(s) links survive: no javascript:, data:, SVG, over-long or throwing one.
      expect(items.map((item) => item.url)).toEqual(['https://huge.example.net/', 'https://www.example.com/ok', 'https://box.example.net/']);
      expect(items[0]!.title.length).toBe(SERP_READ_LIMITS.maxTitleChars);
      // Script and style text is not title text.
      expect(items[1]!.title).toBe('Fine result');
      expect(answer.stats.nodes).toBeLessThanOrEqual(SERP_READ_LIMITS.maxNodesVisited);

      // 100,000 results: the answer stays within the caps (or the read stops: timeout), and never throws.
      const many = dom(fixture('google-hostile.html'));
      const area = many.window.document.getElementById('rso')!;
      area.innerHTML = '<div><a href="https://r.example.net/"><h3>r</h3></a></div>'.repeat(100_000);
      const started = performance.now();
      const flood = read(many.window.document, layout);
      const took = performance.now() - started;
      expect(SerpReadSchema.safeParse(flood).success).toBe(true);
      if (flood.ok) {
        expect(flood.stats.truncated).toBe(true);
        expect(flood.blocks.reduce((sum, block) => sum + block.items.length, 0)).toBeLessThanOrEqual(SERP_READ_LIMITS.maxResults);
      } else {
        expect(flood.reason).toBe('timeout');
      }
      expect(flood.stats.nodes).toBeLessThanOrEqual(SERP_READ_LIMITS.maxNodesVisited);
      // The reader's own work stops at its caps (jsdom's one selector match aside).
      expect(took).toBeLessThan(30_000);
    },
    60_000,
  );

  test('serp-read-script-is-data', async () => {
    // A hostile selector stays a string: the script is the reader plus JSON arguments.
    const hostile: EngineLayout = { results: '#search', blocks: [{ type: 'organic', container: `"]); globalThis.pwned = 1; ([\``, required: true }] };
    const script = serpReadScript(hostile);
    expect(script).toContain(JSON.stringify(hostile.blocks[0]!.container));
    expect(script).toContain(JSON.stringify(SERP_READ_LIMITS));
    const page = dom(fixture('google.html'), URLS.google, { runScripts: 'outside-only' });
    const window = page.window as unknown as { eval(code: string): unknown; pwned?: unknown };
    expect(window.eval(script)).toMatchObject({ ok: false, reason: 'bad-selector' });
    expect(window.pwned).toBeUndefined();
    // Self-contained: evaluated in the page's own world it answers as the function does.
    const layout = layoutOf(PACK, 'google');
    // With the tests' read budget: a cold read on a loaded runner can pass the spec's 150 ms.
    const evaluated = window.eval(serpReadScript(layout, { ...SERP_READ_LIMITS, budgetMs: READ_TEST_BUDGET_MS })) as SerpRead;
    expect(titles(evaluated)).toEqual(titles(read(dom(fixture('google.html')).window.document, layout)));
    // Run once, in the SERP world only.
    const calls: { worldId: number; scripts: { code: string }[] }[] = [];
    const contents = {
      executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]) {
        calls.push({ worldId, scripts });
        return Promise.resolve('answer');
      },
    };
    await expect(runSerpRead(contents, layout)).resolves.toBe('answer');
    expect(calls).toEqual([{ worldId: SERP_WORLD_ID, scripts: [{ code: serpReadScript(layout) }] }]);
  });

  test('serp-bundled-pack-reads-fixtures', () => {
    const verified = verifyPack(BUNDLED_PACK.bytes, BUNDLED_PACK.signature, SERP_PACK_PUBLIC_KEYS);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const pack = verified.pack;
    const wrapped: Record<string, unknown> = {};
    const cases = [
      { file: 'google.html', url: URLS.google, counts: { organic: 7, ad: 3, shopping: 2, 'featured-snippet': 1, 'people-also-ask': 3, video: 1, 'knowledge-panel': 1, 'related-searches': 2 } },
      { file: 'bing.html', url: URLS.bing, counts: { organic: 4, ad: 2, 'featured-snippet': 1, 'related-searches': 2, 'knowledge-panel': 1 } },
      { file: 'duckduckgo.html', url: URLS.duckduckgo, counts: { organic: 3, ad: 1, 'related-searches': 2 } },
      { file: 'duckduckgo-html.html', url: URLS['duckduckgo-html'], counts: { organic: 2, ad: 1 } },
    ];
    for (const { file, url, counts } of cases) {
      const match = matchSerp(url, pack, 'desktop');
      expect(match, file).not.toBeNull();
      const raw = read(dom(fixture(file), url).window.document, match!.engine.layout);
      const snapshot = analyseSerp(raw, { params: match!.params, packVersion: pack.version, redirects: redirectRules(match!.engine) });
      expect(SerpSnapshotSchema.safeParse(snapshot).success, file).toBe(true);
      expect(snapshot.status, file).toBe('ready');
      if (snapshot.status !== 'ready') continue;
      expect(Object.fromEntries(Object.entries(snapshot.composition.counts).filter(([, n]) => n > 0)), file).toEqual(counts);
      // Click redirects are unwrapped by the engine's rules: the engine never owns its own results.
      expect(snapshot.ownership.domains.map((share) => share.domain), file).not.toEqual(expect.arrayContaining(['google.com', 'bing.com', 'duckduckgo.com']));
      wrapped[file] = snapshot.results.filter((result) => result.redirected || (result.url?.includes('/url?') ?? false)).map((result) => [result.url, result.redirected, result.domain]);
    }
    expect(wrapped).toEqual({
      'google.html': [
        ['https://alice.github.io/frost-notes', true, 'alice.github.io'],
        // A redirect to something that is not a web URL: kept as read, no domain, never an owner.
        ['https://www.google.com/url?sa=t&url=javascript:alert(1)', false, null],
      ],
      'bing.html': [['https://docs.example.org/frost', true, 'example.org']],
      'duckduckgo.html': [],
      'duckduckgo-html.html': [['https://www.example.com/frost', true, 'example.com']],
    });
    const match = matchSerp(URLS.google, pack, 'desktop')!;
    const unreadable = analyseSerp(read(dom(fixture('google-unreadable.html')).window.document, match.engine.layout), { params: match.params, packVersion: pack.version, redirects: redirectRules(match.engine) });
    expect(unreadable).toEqual({ status: 'unreadable', reason: 'no-container', params: match.params, packVersion: pack.version });
  });
});
