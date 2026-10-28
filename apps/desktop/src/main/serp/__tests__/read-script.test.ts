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
import { matchSerp } from '../engines';
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

/** Runs the reader on `document` with the spec's limits (overridden by `limits`). */
function read(document: Document, layout: EngineLayout, limits: Partial<SerpReadLimits> = {}): SerpRead {
  return readSerp(document as unknown as SerpDocument, layout, { ...SERP_READ_LIMITS, ...limits }) as SerpRead;
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
      ['featured-snippet', ['What is frost? A short guide']],
      ['organic', ['Frost explained | Example', 'Ten tips for frosty mornings']],
      ['people-also-ask', ['What causes frost?', 'When does frost form?', 'Is frost frozen dew?']],
      ['organic', ['A history of frost']],
      ['video', ['Frost timelapse']],
      ['organic', ['Frostline weather', 'Frost shop']],
      ['ad', ['Ice scrapers, sponsored']],
      ['knowledge-panel', ['Frost']],
      ['related-searches', ['frost on windows', 'black frost']],
    ]);
    expect(links(google)).toEqual([
      'https://ads.example.net/frost-gear',
      'https://shop.example.org/boots',
      'https://www.icecrystal.example/what-is-frost',
      'https://www.example.com/frost',
      'https://blog.example.org/frost-tips',
      null,
      null,
      null,
      'https://example.com/frost/history',
      'https://video.example.net/watch/frost-timelapse',
      'https://www.frostline.example/',
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
      ['organic', ['Frost explained | Example', 'Frost documentation', 'A history of frost', 'Frostline weather']],
      ['related-searches', ['frost depth', 'frost flowers']],
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
    // On Google's page, the featured snippet's link and the related question's answer link are not organic.
    const google = read(dom(fixture('google.html')).window.document, layoutOf(PACK, 'google'));
    const organic = (google.blocks ?? []).filter((block) => block.type === 'organic').flatMap((block) => block.items.map((item) => item.url));
    expect(organic).toHaveLength(5);
    expect(organic).not.toContain('https://www.icecrystal.example/what-is-frost');
    expect(organic).not.toContain('https://answers.frostline.example/dew');
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
    ];
    for (const layout of variants) {
      const page = dom(fixture('google.html'));
      const document = page.window.document;
      const queried = vi.spyOn(document, 'querySelector');
      const queriedAll = vi.spyOn(document, 'querySelectorAll');
      expect(read(document, layout), JSON.stringify(layout).slice(0, 80)).toMatchObject({ ok: false, reason: 'bad-selector' });
      // Checked before any page element is read.
      expect(queried).not.toHaveBeenCalled();
      expect(queriedAll).not.toHaveBeenCalled();
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
    const full = read(dom(fixture('google.html')).window.document, layout);
    expect(full.ok).toBe(true);
    expect(full.stats.elapsedMs).toBeLessThan(SERP_READ_LIMITS.budgetMs);
  });

  test(
    'serp-reader-is-bounded',
    () => {
      const layout = layoutOf(PACK, 'google');
      const page = dom(fixture('google-hostile.html'));
      const document = page.window.document;
      const rso = document.getElementById('rso')!;
      // An over-long link, a megabyte title, and getters that throw.
      document.getElementById('long')!.setAttribute('href', `https://long.example.net/${'x'.repeat(SERP_READ_LIMITS.maxUrlChars)}`);
      const huge = document.createElement('div');
      huge.innerHTML = '<a href="https://huge.example.net/"><h3></h3></a>';
      huge.querySelector('h3')!.textContent = `huge ${'x'.repeat(1_000_000)}`;
      rso.prepend(huge);
      const throwing = document.createElement('div');
      throwing.innerHTML = '<a href="https://throws.example.net/"><h3>Throws</h3></a><a href="https://box.example.net/"><h3>No box</h3></a>';
      const [throws, boxless] = [...throwing.querySelectorAll('a')];
      Object.defineProperty(throws, 'href', {
        get() {
          throw new Error('hostile getter');
        },
      });
      Object.defineProperty(boxless, 'getBoundingClientRect', {
        value() {
          throw new Error('hostile rect');
        },
      });
      rso.append(throwing);

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
    const evaluated = window.eval(serpReadScript(layout)) as SerpRead;
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
    const cases = [
      { file: 'google.html', url: URLS.google, counts: { organic: 5, ad: 3, 'featured-snippet': 1, 'people-also-ask': 3, video: 1, 'knowledge-panel': 1, 'related-searches': 2 } },
      { file: 'bing.html', url: URLS.bing, counts: { organic: 4, ad: 2, 'featured-snippet': 1, 'related-searches': 2, 'knowledge-panel': 1 } },
      { file: 'duckduckgo.html', url: URLS.duckduckgo, counts: { organic: 3, ad: 1, 'related-searches': 2 } },
      { file: 'duckduckgo-html.html', url: URLS['duckduckgo-html'], counts: { organic: 2, ad: 1 } },
    ];
    for (const { file, url, counts } of cases) {
      const match = matchSerp(url, pack, 'desktop');
      expect(match, file).not.toBeNull();
      const raw = read(dom(fixture(file), url).window.document, match!.engine.layout);
      const snapshot = analyseSerp(raw, { params: match!.params, packVersion: pack.version });
      expect(SerpSnapshotSchema.safeParse(snapshot).success, file).toBe(true);
      expect(snapshot.status, file).toBe('ready');
      if (snapshot.status !== 'ready') continue;
      expect(Object.fromEntries(Object.entries(snapshot.composition.counts).filter(([, n]) => n > 0)), file).toEqual(counts);
    }
    const match = matchSerp(URLS.google, pack, 'desktop')!;
    const unreadable = analyseSerp(read(dom(fixture('google-unreadable.html')).window.document, match.engine.layout), { params: match.params, packVersion: pack.version });
    expect(unreadable).toEqual({ status: 'unreadable', reason: 'no-container', params: match.params, packVersion: pack.version });
  });
});
