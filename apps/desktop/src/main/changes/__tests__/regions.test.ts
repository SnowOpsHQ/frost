// Spec: specs/capture.spec.ts (CAPTURE_LIMITS, CAPTURE_WORLD_ID, PAGE_REGIONS), specs/changes.spec.ts
// (REGION_EXTRACT_LIMITS, CAPTURE_BLOCK_ELEMENTS), specs/changes.schema.ts (RegionAnswerSchema)
// Acceptance: specs/changes-capture.feature.md (The region extraction), specs/changes-diff.feature.md (Regions)
import { JSDOM } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';
import { CAPTURE_LIMITS, CAPTURE_WORLD_ID, PAGE_REGIONS, type PageRegion } from '@app/specs/capture.spec';
import { CAPTURE_BLOCK_ELEMENTS, REGION_EXTRACT_LIMITS, RegionAnswerSchema, type RegionAnswer } from '@app/specs/changes.schema';
import { extractRegions, parseRegionAnswer, REGIONS_SCRIPT, runRegions, type CaptureLimits, type RegionDocument, type RegionExtractLimits } from '../regions';

const PAGE = 'https://example.com/guides/page';

/**
 * Gives `window`'s elements a cheap `checkVisibility()` (jsdom has none): `false` for an element
 * whose own inline `display` is `none` or `contents` (no box). The extraction prunes a hidden
 * subtree, so an ancestor's `display` never needs reading here.
 */
function chromiumVisibility(window: JSDOM['window']): void {
  (window.Element.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility = function (this: HTMLElement) {
    const display = this.style?.display;
    return display !== 'none' && display !== 'contents';
  };
}

function documentOf(body: string, { head = '', url = PAGE } = {}): Document {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`, { url });
  chromiumVisibility(dom.window);
  return dom.window.document;
}

/** Runs the extraction as `REGIONS_SCRIPT` does, and checks the answer parses. */
function extract(body: string, options: { limits?: Partial<CaptureLimits>; extra?: Partial<RegionExtractLimits>; url?: string } = {}): RegionAnswer {
  const raw = extractRegions(documentOf(body, options) as unknown as RegionDocument, { ...CAPTURE_LIMITS, ...options.limits }, { ...REGION_EXTRACT_LIMITS, ...options.extra }, CAPTURE_BLOCK_ELEMENTS);
  return RegionAnswerSchema.parse(raw);
}

const blocksOf = (answer: RegionAnswer, region: PageRegion) => answer.regions[region].blocks;

describe('region extraction', () => {
  test('regions-follow-landmark-rules', () => {
    const answer = extract(`
      <header>Site name<nav><a href="/a">Home</a></nav></header>
      <main>
        <h1>Title</h1><p>Body text</p>
        <article><header><h2>Post</h2></header><p>Post body</p><aside><p>Side note</p></aside></article>
        <div role="navigation"><a href="https://other.org/b" rel="NoFollow  Sponsored">Away</a></div>
        <nav role="none"><p>Not a nav</p></nav>
        <section><footer><p>Section foot</p></footer></section>
        <h3 hidden>Hidden heading</h3><p style="display: none">Hidden text</p>
      </main>
      <div>Loose text<h2>Loose heading</h2></div>
      <footer><p>Copyright</p></footer>`);
    expect(answer.partial).toBe(false);
    expect(blocksOf(answer, 'header')).toEqual(['Site name']);
    expect(blocksOf(answer, 'nav')).toEqual(['Home', 'Away']);
    // A header in an article and a footer in a section are not the page's: their text is main's.
    expect(blocksOf(answer, 'main')).toEqual(['Title', 'Body text', 'Post', 'Post body', 'Not a nav', 'Section foot']);
    expect(blocksOf(answer, 'aside')).toEqual(['Side note']);
    // With a main landmark, content outside every landmark is `other`.
    expect(blocksOf(answer, 'other')).toEqual(['Loose text', 'Loose heading']);
    expect(blocksOf(answer, 'footer')).toEqual(['Copyright']);
    expect(answer.headings).toEqual([
      { level: 1, text: 'Title', region: 'main' },
      { level: 2, text: 'Post', region: 'main' },
      { level: 2, text: 'Loose heading', region: 'other' },
    ]);
    expect(answer.links.list).toEqual([
      { href: 'https://example.com/a', text: 'Home', rel: '', region: 'nav' },
      { href: 'https://other.org/b', text: 'Away', rel: 'nofollow sponsored', region: 'nav' },
    ]);
    expect(answer.links).toMatchObject({ total: 2, internal: 1, external: 1, nofollow: 1 });

    // `<div role=banner>` is a banner wherever it is; its text is the header's.
    const banner = extract('<main><p>m</p></main><footer><div role="banner">Inner banner</div></footer>');
    expect(blocksOf(banner, 'header')).toEqual(['Inner banner']);

    // Without a main landmark, unlandmarked content is main content.
    const plain = extract('<div><h1>Plain</h1><p>Words here</p></div><section><footer>Section foot</footer></section><footer role="contentinfo"><p>Foot</p></footer>');
    expect(blocksOf(plain, 'main')).toEqual(['Plain', 'Words here', 'Section foot']);
    expect(blocksOf(plain, 'other')).toEqual([]);
    expect(blocksOf(plain, 'footer')).toEqual(['Foot']);
    expect(plain.headings).toEqual([{ level: 1, text: 'Plain', region: 'main' }]);
    // `<main role=none>` is not a main landmark either.
    expect(blocksOf(extract('<main role="none"><p>x</p></main><p>y</p>'), 'main')).toEqual(['x', 'y']);

    // Every region is answered, each with H equal to its blocks.
    for (const region of PAGE_REGIONS) expect(answer.regions[region].text).toBe(answer.regions[region].blocks.join('\n'));
    expect(answer.url).toBe(PAGE);
  });

  test('text-blocks-are-not-double-counted', () => {
    const answer = extract('<main><div>a<p>b <b>bold</b>\n\t text</p>c<br>d<hr>e</div><p>Café   au   lait</p><ul><li>one <span>two</span></li><li>  </li></ul><p>x<script>no()</script><style>.no{}</style>y</p></main>');
    expect(blocksOf(answer, 'main')).toEqual(['a', 'b bold text', 'c', 'd', 'e', 'Café au lait', 'one two', 'xy']);
    expect(answer.regions.main.words).toBe(13);
    expect(answer.regions.main.truncated).toBe(false);
    expect(answer.regions.main.text).toBe(blocksOf(answer, 'main').join('\n'));
    // Anchor and heading text is normalised the same; an image link takes its alt, an area its alt.
    const links = extract('<main><h2>  Spaced\n heading </h2><a href="/i"><img alt="Logo"></a><a href="/l" aria-label="Labelled"></a><map><area href="/m" alt="Area"></map></main>');
    expect(links.headings).toEqual([{ level: 2, text: 'Spaced heading', region: 'main' }]);
    expect(links.links.list.map((link) => link.text)).toEqual(['Logo', 'Labelled', 'Area']);
  });

  test('header-and-footer-are-scoped-by-roles-too', () => {
    // HTML-AAM: a header or footer inside role=main / article (as inside the elements) heads that, not the page.
    const scoped = extract('<div role="main"><header>In main</header></div><div role="article"><footer>Article foot</footer></div><p>Loose</p>');
    expect(blocksOf(scoped, 'main')).toEqual(['In main']);
    expect(blocksOf(scoped, 'header')).toEqual([]);
    expect(blocksOf(scoped, 'footer')).toEqual([]);
    expect(blocksOf(scoped, 'other')).toEqual(['Article foot', 'Loose']);
    // The main landmark is found even behind many other roles.
    const late = extract(`${'<div role="note"></div>'.repeat(REGION_EXTRACT_LIMITS.maxMainScan + 50)}<main><p>m</p></main><p>loose</p>`);
    expect(blocksOf(late, 'other')).toEqual(['loose']);
  });

  test('lone-surrogates-and-hidden-heading-text', () => {
    // Lone surrogates are replaced with U+FFFD (blocks, headings, anchors); hidden descendants are not read.
    const answer = extract('<main><p>abc\uD800</p><h2>Visible <span hidden>secret</span><span style="display: none">gone</span>\uDC00</h2><a href="/a">x\uD800y<span hidden>z</span></a></main>');
    expect(blocksOf(answer, 'main')).toEqual(['abc\uFFFD', 'Visible \uFFFD', 'x\uFFFDy']);
    expect(answer.regions.main.text).toBe('abc\uFFFD\nVisible \uFFFD\nx\uFFFDy');
    expect(answer.headings).toEqual([{ level: 2, text: 'Visible \uFFFD', region: 'main' }]);
    expect(answer.links.list[0]!.text).toBe('x\uFFFDy');
  });

  test('hashed-text-stops-at-its-cut', () => {
    // H is cut inside a surrogate pair: the high half is dropped, and nothing is appended after the cut.
    const answer = extract('<main><p>abcd\u{1F375}</p><p>x</p></main>', { limits: { maxHashedRegionChars: 5 } });
    expect(answer.regions.main.text).toBe('abcd');
    expect(answer.regions.main.truncated).toBe(true);
    expect(blocksOf(answer, 'main')).toEqual(['abcd\u{1F375}', 'x']);
  });

  test('regions-are-bounded', () => {
    const limits = { maxBlocksPerRegion: 50, maxRegionChars: 5_000, maxHashedRegionChars: 20_000, maxLinks: 40, maxHeadings: 30 };
    // Over every cap but the walk's: kept lists stop at their caps, H at its cap, region truncated.
    const many = Array.from({ length: 400 }, (_, i) => `<h2>Heading ${i}</h2><p>Paragraph number ${i} ${'word '.repeat(20)}</p><a href="/p${i}">Link ${i}</a>`).join('');
    const capped = extract(`<main>${many}</main>`, { limits });
    expect(capped.partial).toBe(false);
    expect(capped.headings).toHaveLength(30);
    expect(capped.links.list).toHaveLength(40);
    expect(capped.links.total).toBe(400);
    expect(capped.links.internal).toBe(400);
    expect(capped.regions.main.blocks.length).toBeLessThanOrEqual(50);
    expect(capped.regions.main.blocks.reduce((sum, block) => sum + block.length, 0)).toBeLessThanOrEqual(5_000);
    expect(capped.regions.main.text).toHaveLength(20_000);
    expect(capped.regions.main.truncated).toBe(true);
    expect(capped.regions.main.words).toBe(400 * 2 + 400 * 23 + 400 * 2);
    // A block over `maxBlockChars` is cut; a huge text node is read only to `maxScanChars`.
    const huge = extract(`<main><p>${'x'.repeat(5_000)}</p><p>${'y '.repeat(30_000)}</p></main>`, { extra: { maxScanChars: 20_000 } });
    expect(huge.regions.main.blocks[0]).toHaveLength(CAPTURE_LIMITS.maxBlockChars);
    expect(huge.partial).toBe(true);
    expect(huge.regions.main.truncated).toBe(true);

    // A hostile DOM: 100 000 elements, 2 000 levels deep, thousands of links and headings, a huge text node.
    const hostile = documentOf(`<main>${'<div>'.repeat(2_000)}deep${'</div>'.repeat(2_000)}${'<p><a href="/x">l</a><h3>h</h3><span>s</span></p>'.repeat(25_000)}<p>${'z'.repeat(3_000_000)}</p></main>`);
    // The caps, with a budget the walk never reaches (jsdom's speed under load is not under test).
    const unhurried = { ...CAPTURE_LIMITS, extractBudgetMs: 3_600_000 };
    const answer = RegionAnswerSchema.parse(extractRegions(hostile as unknown as RegionDocument, unhurried, REGION_EXTRACT_LIMITS, CAPTURE_BLOCK_ELEMENTS));
    // Partial by its caps alone (the huge text node is read only to `maxScanChars`).
    expect(answer.partial).toBe(true);
    expect(answer.headings).toHaveLength(CAPTURE_LIMITS.maxHeadings);
    expect(answer.links.list).toHaveLength(CAPTURE_LIMITS.maxLinks);
    expect(answer.links.total).toBe(25_000);
    for (const region of PAGE_REGIONS) expect(answer.regions[region].truncated).toBe(true);

    // The deadline, on its own: a budget already spent stops the walk at its first check.
    const spent = { ...CAPTURE_LIMITS, extractBudgetMs: -1 };
    const late = RegionAnswerSchema.parse(extractRegions(hostile as unknown as RegionDocument, spent, REGION_EXTRACT_LIMITS, CAPTURE_BLOCK_ELEMENTS));
    expect(late.partial).toBe(true);
    for (const region of PAGE_REGIONS) expect(late.regions[region].truncated).toBe(true);
    expect(late.links.list.length).toBeLessThan(CAPTURE_LIMITS.maxLinks);
  }, 60_000);

  test('regions-script-is-self-contained', async () => {
    // The serialised script runs on its own (no module scope), in the capture world only.
    const document = documentOf('<main><h1>Scripted</h1></main>');
    const answer = RegionAnswerSchema.parse(new Function('document', `return ${REGIONS_SCRIPT}`)(document));
    expect(answer.headings).toEqual([{ level: 1, text: 'Scripted', region: 'main' }]);
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async () => 'answer'), getURL: () => PAGE };
    await expect(runRegions(contents)).resolves.toBe('answer');
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledExactlyOnceWith(CAPTURE_WORLD_ID, [{ code: REGIONS_SCRIPT }]);
    // Main parses whatever comes back; anything else is `null`.
    expect(parseRegionAnswer(answer)).toEqual(answer);
    expect(parseRegionAnswer({ ...answer, extra: 1 })).toBeNull();
    expect(parseRegionAnswer(null)).toBeNull();
  });
});
