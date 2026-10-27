// Spec: specs/seo-limits.spec.ts (SNAPSHOT_LIMITS, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES),
// specs/seo-snapshot.spec.ts (PageSnapshotSchema, hidden elements, wordCount, ImageSchema, SocialSchema)
// Acceptance: specs/seo-sidebar.feature.md (Extraction, Against a DOM), specs/seo-panels.feature.md (Extraction),
// specs/seo-content.feature.md (Visible text; spec specs/seo-content.spec.ts VISIBLE_TEXT_LIMITS, VISIBLE_TEXT_BLOCKS)
import { JSDOM } from 'jsdom';
import { describe, expect, test } from 'vitest';
import { EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SNAPSHOT_LIMITS, SOCIAL_TAGS, SOCIAL_URL_TAGS, type SnapshotLimits } from '@app/specs/seo-limits.spec';
import { PageSnapshotSchema, type PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { SECURITY_LIMITS } from '@app/specs/seo-compliance.spec';
import { VISIBLE_TEXT_BLOCKS, VISIBLE_TEXT_LIMITS } from '@app/specs/seo-content.spec';
import { extractPage, type PageDocument } from '../extract';
import { extractSecurity, RESOURCE_SELECTOR, type SecurityDocument } from '../security-extract';

const PAGE = 'https://example.com/guides/page';

/** Runs the extractor on `document` with the spec's limits (overridden by `limits`), then the security read, as `EXTRACTOR_SCRIPT` does. */
function run(document: unknown, limits: Partial<SnapshotLimits> = {}, budget = EXTRACT_BUDGET_MS): PageSnapshot {
  const page = extractPage(document as PageDocument, { ...SNAPSHOT_LIMITS, ...limits }, budget, ROBOTS_META_NAMES, SOCIAL_TAGS, SOCIAL_URL_TAGS) as PageSnapshot;
  return { ...page, security: extractSecurity(document as SecurityDocument, SECURITY_LIMITS, RESOURCE_SELECTOR) as PageSnapshot['security'] };
}

/** Runs the extractor on `body` (and `head`) in a jsdom document at `url`, after `prepare` (stubs layout values jsdom lacks). */
function extract({
  head = '',
  body = '',
  limits = {},
  budget = EXTRACT_BUDGET_MS,
  url = PAGE,
  prepare,
}: {
  head?: string;
  body?: string;
  limits?: Partial<SnapshotLimits>;
  budget?: number;
  url?: string;
  prepare?: (document: Document, window: JSDOM['window']) => void;
}): PageSnapshot {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`, { url });
  prepare?.(dom.window.document, dom.window);
  return run(dom.window.document, limits, budget);
}

/** Gives `el` a layout box at document position (`left`, `top`) of `width` × `height` (jsdom has no layout). */
function place(el: Element, { left = 0, top = 0, width, height }: { left?: number; top?: number; width: number; height: number }): void {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** Gives the image `el` an intrinsic size (as once it has loaded). */
function loaded(el: Element, width: number, height: number): void {
  Object.defineProperty(el, 'naturalWidth', { value: width });
  Object.defineProperty(el, 'naturalHeight', { value: height });
}

/**
 * Gives `window`'s elements `checkVisibility()` as Chromium answers it (jsdom has none): `false`
 * without a box of its own (`display: none` on it or an ancestor, `display: contents` on it) or
 * inside skipped content (`content-visibility: hidden`, a closed `<details>` but its summary).
 */
function chromiumVisibility(window: JSDOM['window']): void {
  const style = (el: Element, name: string) => window.getComputedStyle(el).getPropertyValue(name);
  window.Element.prototype.checkVisibility = function (this: Element) {
    if (style(this, 'display') === 'contents') return false;
    for (let el: Element | null = this; el !== null; el = el.parentElement) {
      if (style(el, 'display') === 'none') return false;
      const parent = el.parentElement;
      if (parent && style(parent, 'content-visibility') === 'hidden') return false;
      if (parent && parent.localName === 'details' && !parent.hasAttribute('open') && el.localName !== 'summary') return false;
    }
    return true;
  };
}

const times = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i)).join('');

/** `extract`, keeping the visible text (cap `max`, `VISIBLE_TEXT_BLOCKS`) as `EXTRACTOR_SCRIPT` does. */
function visible({ body, max = VISIBLE_TEXT_LIMITS.maxVisibleTextChars, limits = {} }: { body: string; max?: number; limits?: Partial<SnapshotLimits> }): PageSnapshot {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head></head><body>${body}</body></html>`, { url: PAGE });
  const page = extractPage(dom.window.document as unknown as PageDocument, { ...SNAPSHOT_LIMITS, ...limits }, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SOCIAL_TAGS, SOCIAL_URL_TAGS, 20, max, VISIBLE_TEXT_BLOCKS) as PageSnapshot;
  return { ...page, security: extractSecurity(dom.window.document as unknown as SecurityDocument, SECURITY_LIMITS, RESOURCE_SELECTOR) as PageSnapshot['security'] };
}

describe('extractor on a DOM', () => {
  test('extractor-output-parses', () => {
    const snapshot = extract({
      head: `<title> A  page   title </title><meta name="description" content="A description."><meta name="ROBOTS" content="Index, Follow">
        <link rel="canonical" href="/guides/page"><meta property="og:url" content="${PAGE}"><meta name="viewport" content="width=device-width">`,
      body: `<h1>Main</h1><h2>Sub <b>part</b></h2><p>one two three</p>
        <a href="/x">Internal</a><a href="https://www.example.com/y">Same site</a><a href="https://other.org/">Other</a>
        <a href="mailto:a@example.com">Mail</a><a href="javascript:void(0)" rel="NoFollow"><img src="/i.png" alt="Icon"></a>
        <img src="/a.png" alt="Alt text" width="10" height="20" loading="lazy"><img src="/b.png">`,
    });
    expect(PageSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      url: PAGE,
      lang: 'en',
      titles: [{ text: 'A page title', length: 12 }],
      titleTotal: 1,
      metaDescriptions: [{ text: 'A description.', length: 14 }],
      metaRobots: [{ name: 'robots', content: 'index, follow' }],
      canonicals: [{ href: '/guides/page', resolved: PAGE }],
      ogUrl: PAGE,
      viewport: 'width=device-width',
      headings: [
        { level: 1, text: 'Main' },
        { level: 2, text: 'Sub part' },
      ],
      partial: false,
      textTruncated: false,
      linkTotal: 5,
      imageTotal: 3,
    });
    expect(snapshot.links.map((l) => [l.kind, l.text, l.rel])).toEqual([
      ['internal', 'Internal', ''],
      ['internal', 'Same site', ''],
      ['external', 'Other', ''],
      ['other', 'Mail', ''],
      ['other', 'Icon', 'nofollow'],
    ]);
    expect(snapshot.images.map((i) => i.alt?.text ?? null)).toEqual(['Icon', 'Alt text', null]);
    expect(snapshot.images[1]).toMatchObject({ src: 'https://example.com/a.png', width: '10', height: '20', loading: 'lazy' });
    expect(snapshot.wordCount).toBeGreaterThanOrEqual(10);
  });

  test('extractor-caps-lists', () => {
    const limits = { maxRepeated: 2, maxHeadings: 3, maxLinks: 3, maxImages: 2 };
    const snapshot = extract({
      limits,
      head: times(3, (i) => `<title>T${i}</title><meta name="description" content="D${i}"><meta name="robots" content="index"><link rel="canonical" href="/c${i}">`),
      body: times(4, (i) => `<h2>H${i}</h2><a href="/l${i}">L${i}</a><img src="/i${i}.png" alt="A${i}">`),
    });
    expect(snapshot.titles).toHaveLength(2);
    expect(snapshot.titleTotal).toBe(3);
    expect(snapshot.metaDescriptions).toHaveLength(2);
    expect(snapshot.metaDescriptionTotal).toBe(3);
    expect(snapshot.metaRobots).toHaveLength(2);
    expect(snapshot.canonicals).toHaveLength(2);
    expect(snapshot.canonicalTotal).toBe(3);
    expect(snapshot.headings.map((h) => h.text)).toEqual(['H0', 'H1', 'H2']);
    expect(snapshot.headingTotal).toBe(4);
    expect(snapshot.links.map((l) => l.text)).toEqual(['L0', 'L1', 'L2']);
    expect(snapshot.linkTotal).toBe(4);
    expect(snapshot.images.map((i) => i.alt?.text)).toEqual(['A0', 'A1']);
    expect(snapshot.imageTotal).toBe(4);
  });

  test('extractor-caps-strings', () => {
    const limits = { maxUrlChars: 40, maxTextChars: 10, maxHeadingChars: 5, maxAnchorChars: 4, maxAltChars: 6, maxLangChars: 3, maxAttributeChars: 8, maxImageAttributeChars: 3 };
    const long = 'x'.repeat(30);
    const dom = new JSDOM(
      `<!doctype html><html lang="en-GB-oxendict"><head><title>${long}</title><meta name="description" content="${long}"><meta name="robots" content="noindex, nofollow, noarchive">
       <meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://example.com/${long}${long}"></head>
       <body><h1>${long}</h1><a href="/${long}${long}">${long}</a><img src="/${long}.png" alt="${long}" width="12345"></body></html>`,
      { url: `https://example.com/${long}` },
    );
    const s = run(dom.window.document, limits);
    expect(s.url).toHaveLength(40);
    expect(s.lang).toBe('en-');
    expect(s.titles[0]).toEqual({ text: 'x'.repeat(10), length: 30 });
    expect(s.metaDescriptions[0]).toEqual({ text: 'x'.repeat(10), length: 30 });
    expect(s.metaRobots[0]!.content).toHaveLength(8);
    expect(s.viewport).toHaveLength(8);
    expect(s.canonicals[0]!.href).toHaveLength(40);
    expect(s.canonicals[0]!.resolved).toHaveLength(40);
    expect(s.headings[0]!.text).toBe('xxxxx');
    expect(s.links[0]!.text).toBe('xxxx');
    expect(s.links[0]!.href).toHaveLength(40);
    expect(s.images[0]!.alt).toEqual({ text: 'x'.repeat(6), length: 30 });
    expect(s.images[0]!.width).toBe('123');
    expect(s.images[0]!.src).toHaveLength(40);
  });

  test('extractor-element-text-is-bounded', () => {
    // The link's text comes after far more nodes than one element's text read may visit.
    const snapshot = extract({ limits: { maxElementTextVisits: 100 }, body: `<a href="/deep">${times(500, () => '<i></i>')}far away<img src="/x.png" alt="late alt"></a>` });
    expect(snapshot.links[0]!.text).toBe('');
    // Within the cap the text is found.
    expect(extract({ limits: { maxElementTextVisits: 100 }, body: `<a href="/deep">${times(50, () => '<i></i>')}far away</a>` }).links[0]!.text).toBe('far away');
  });

  test('extractor-deadline-gives-partial', () => {
    const body = `<h1>Main</h1>${times(20, (i) => `<p>words ${i}</p><a href="/l${i}">L${i}</a><img src="/${i}.png" alt="a">`)}`;
    // A budget already spent: every list and walk stops at once; totals are still the page's.
    const spent = extract({ body, budget: -1 });
    expect(PageSnapshotSchema.safeParse(spent).success).toBe(true);
    expect(spent).toMatchObject({ partial: true, textTruncated: true, headings: [], links: [], images: [], headingTotal: 1, linkTotal: 20, imageTotal: 20 });
    const fresh = extract({ body });
    expect(fresh).toMatchObject({ partial: false, textTruncated: false });
    expect(fresh.links).toHaveLength(20);
    // The word count also stops at its node and character budgets.
    expect(extract({ body, limits: { maxTextNodes: 3 } })).toMatchObject({ textTruncated: true, partial: false });
    expect(extract({ body, limits: { maxTextScanChars: 10 } })).toMatchObject({ textTruncated: true, partial: false });
  });

  test('extractor-counts-words-without-spaces', () => {
    const japanese = extract({ body: '<p>私は毎日東京の会社で働いています</p>' });
    expect(japanese.wordCount).toBeGreaterThanOrEqual(6);
    const thai = extract({ body: '<p>ฉันอาศัยอยู่ที่กรุงเทพมหานคร</p>' });
    expect(thai.wordCount).toBeGreaterThanOrEqual(3);
    // Spaced text is still counted word by word; punctuation is not a word.
    expect(extract({ body: '<p>One, two — three!</p>' }).wordCount).toBe(3);
  });

  test('extractor-skips-hidden-headings', () => {
    const snapshot = extract({ body: '<div hidden><h1>Secret heading</h1><p>secret words here</p></div><h1 hidden>Also hidden</h1><h1>Shown</h1><p>visible</p>' });
    expect(snapshot.headings).toEqual([{ level: 1, text: 'Shown' }]);
    expect(snapshot.headingTotal).toBe(3);
    expect(snapshot.wordCount).toBe(2);
  });

  test('extractor-keeps-hidden-headings-apart', () => {
    // Phase 2.5 Task 2 review: the served-HTML comparison counts hidden headings with the shown ones.
    const snapshot = extract({ body: '<div hidden><h1>Secret heading</h1></div><h2 hidden>Also hidden</h2><h1>Shown</h1>' });
    expect(snapshot.hiddenHeadings).toEqual([
      { level: 1, text: 'Secret heading' },
      { level: 2, text: 'Also hidden' },
    ]);
    const many = extract({ body: Array.from({ length: SNAPSHOT_LIMITS.maxHiddenHeadings + 10 }, (_, i) => `<h3 hidden>H${i}</h3>`).join('') });
    expect(many.hiddenHeadings).toHaveLength(SNAPSHOT_LIMITS.maxHiddenHeadings);
    expect(many.headingTotal).toBe(SNAPSHOT_LIMITS.maxHiddenHeadings + 10);
  });

  test('extractor-reads-through-boxless-wrappers', () => {
    const words = (body: string) => extract({ body, prepare: (_document, window) => chromiumVisibility(window) });
    // A `display: contents` wrapper (nested too) has no box, but its content is shown.
    const wrapped = words('<div style="display:contents"><p>one two</p> three<div style="display:contents">four</div></div>');
    expect(wrapped.wordCount).toBe(4);
    expect(wrapped.textTruncated).toBe(false);
    // Hidden around the wrapper: not shown.
    expect(words('<div style="display:none"><span style="display:contents">gone</span></div><p>kept</p>').wordCount).toBe(1);
    expect(words('<div style="content-visibility:hidden"><span style="display:contents">skipped</span></div><p>kept</p>').wordCount).toBe(1);
    expect(words('<details><summary>Summary</summary><span style="display:contents">closed</span></details>').wordCount).toBe(1);
    expect(words('<details open><summary>Summary</summary><span style="display:contents">open</span></details>').wordCount).toBe(2);
    // A hidden element is still pruned; `visibility: hidden` still counts (it takes part in layout).
    expect(words('<p style="display:none">gone <span style="display:contents">too</span></p><p style="visibility:hidden">laid <span style="visibility:visible">out</span></p>').wordCount).toBe(2);
    // Headings: one that is `display: contents` is listed; inside a hidden element it is not.
    const headings = words('<h2 style="display:contents">Wrapped heading</h2><div style="display:none"><h2 style="display:contents">Gone</h2></div>');
    expect(headings.headings).toEqual([{ level: 2, text: 'Wrapped heading' }]);
    expect(headings.headingTotal).toBe(2);
    // A hostile chain of wrappers is looked up only so far: past that the heading counts as not shown, and the snapshot is partial.
    const deep = (depth: number) =>
      extract({
        body: `${'<div style="display:contents">'.repeat(depth)}<h2 style="display:contents">Deep</h2>${'</div>'.repeat(depth)}`,
        prepare: (_document, window) => chromiumVisibility(window),
      });
    expect(deep(20)).toMatchObject({ partial: false, headings: [{ level: 2, text: 'Deep' }] });
    expect(deep(2_000)).toMatchObject({ partial: true, headings: [] });
  });

  test('extractor-reads-bot-robots', () => {
    const snapshot = extract({
      head: '<meta name="GoogleBot" content="NoIndex"><meta name="otherbot" content="noindex"><meta name="bingbot" content="nofollow"><meta name="robots" content="index"><meta name="googlebot-news" content="none">',
    });
    expect(snapshot.metaRobots).toEqual([
      { name: 'googlebot', content: 'noindex' },
      { name: 'bingbot', content: 'nofollow' },
      { name: 'robots', content: 'index' },
      { name: 'googlebot-news', content: 'none' },
    ]);
  });

  test('extractor-reads-link-targets', () => {
    const snapshot = extract({ body: '<a href="/a" target=" _blank ">A</a><a href="/b">B</a><a href="/c" target="">C</a>', limits: { maxTargetChars: 4 } });
    expect(snapshot.links.map((link) => link.target)).toEqual(['_bla', null, '']);
  });

  test('extractor-measures-images', () => {
    const snapshot = extract({
      limits: { maxImagePixels: 5_000 },
      body: `<img id="top" src="/top.jpg" loading="lazy"><img id="below" src="/below.jpg" loading="lazy"><img id="hidden" src="/h.png" hidden>
        <img id="unloaded" src="/u.png"><img id="huge" src="/huge.png"><img id="flat" src="/flat.png"><img id="side" src="/side.png">`,
      prepare(document, window) {
        const img = (id: string) => document.getElementById(id)!;
        // Scrolled down 2 000 px: the first viewport is still the top of the document.
        Object.defineProperty(window, 'scrollY', { value: 2_000 });
        Object.defineProperty(window, 'innerHeight', { value: 800 });
        Object.defineProperty(window, 'innerWidth', { value: 1_200 });
        place(img('top'), { top: 100 - 2_000, width: 600.4, height: 299.6 });
        loaded(img('top'), 1_800, 900);
        place(img('below'), { top: 900 - 2_000, width: 300, height: 200 });
        place(img('hidden'), { width: 10, height: 10 });
        loaded(img('hidden'), 10, 10);
        place(img('unloaded'), { top: -2_000, width: 50, height: 50 });
        place(img('huge'), { top: 5_000, width: 9_999_999, height: 20 });
        loaded(img('huge'), 9_999_999, 20);
        place(img('flat'), { top: -2_000, width: 100, height: 0 });
        place(img('side'), { top: -2_000, left: 1_300, width: 100, height: 100 });
      },
    });
    expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const byId = Object.fromEntries(snapshot.images.map((image) => [new URL(image.src).pathname, image]));
    expect(byId['/top.jpg']).toMatchObject({ rendered: { width: 600, height: 300 }, natural: { width: 1_800, height: 900 }, inFirstViewport: true, loading: 'lazy' });
    expect(byId['/below.jpg']).toMatchObject({ rendered: { width: 300, height: 200 }, natural: null, inFirstViewport: false });
    // Hidden: no box (and so not in the first viewport), even if it reports one.
    expect(byId['/h.png']).toMatchObject({ rendered: null, natural: { width: 10, height: 10 }, inFirstViewport: false });
    expect(byId['/u.png']).toMatchObject({ rendered: { width: 50, height: 50 }, natural: null, inFirstViewport: true });
    // Sizes are capped at maxImagePixels.
    expect(byId['/huge.png']).toMatchObject({ rendered: { width: 5_000, height: 20 }, natural: { width: 5_000, height: 20 } });
    // A box with no area is no box; one right of the first viewport is not in it.
    expect(byId['/flat.png']).toMatchObject({ rendered: null, inFirstViewport: false });
    expect(byId['/side.png']).toMatchObject({ rendered: { width: 100, height: 100 }, inFirstViewport: false });
  });

  test('extractor-reads-social-tags', () => {
    const long = 'd'.repeat(40);
    const snapshot = extract({
      limits: { maxSocialChars: 20, maxUrlChars: 30 },
      head: `<meta property="og:title" content="  First   title "><meta property="og:title" content="Second title">
        <meta name="OG:Description" content="${long}"><meta property="og:image" content=" /img/share.png?x=${long} ">
        <meta property="og:image:width" content="1200"><meta property="og:type" content="article"><meta property="og:site_name" content="Example">
        <meta name="twitter:card" content="summary_large_image"><meta property="twitter:title" content="Tw title"><meta name="twitter:image" content="https://example.com/t.png">
        <meta name="twitter:site" content="@example"><meta property="og:url" content="${PAGE}">`,
    });
    expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.social).toEqual({
      'og:title': 'First title',
      'og:description': 'd'.repeat(20),
      'og:image': `/img/share.png?x=${'d'.repeat(13)}`,
      'og:image:width': '1200',
      'og:image:height': null,
      'og:type': 'article',
      'og:site_name': 'Example',
      'twitter:card': 'summary_large_image',
      'twitter:title': 'Tw title',
      'twitter:description': null,
      'twitter:image': 'https://example.com/t.png',
      'twitter:site': '@example',
    });
    // og:url stays the snapshot's own field (cut to maxUrlChars like every URL).
    expect(snapshot.ogUrl).toBe(PAGE.slice(0, 30));
    // None at all: every tag null.
    expect(Object.values(extract({}).social)).toEqual(SOCIAL_TAGS.map(() => null));
  });

  test('extractor-corrects-srcset-density', () => {
    const snapshot = extract({
      body: `<img id="w" src="/small.png" srcset="/small.png 400w, /big.png 1600w" sizes="400px" alt="w">
        <img id="x" src="/one.png" srcset="/one.png 1x, /three.png 3x" alt="x">
        <picture><source srcset="/wide.webp 1200w, /narrow.webp 600w" sizes="300px"><img id="pic" src="/fallback.png" alt="picture"></picture>
        <img id="plain" src="/plain.png" alt="plain">
        <img id="data" src="/d.png" srcset="data:image/png;base64,AAAA 2x, /d.png 1x" alt="data">`,
      prepare(document) {
        const img = (id: string) => document.getElementById(id)!;
        const shows = (id: string, current: string, natural: [number, number], box: [number, number]) => {
          Object.defineProperty(img(id), 'currentSrc', { value: new URL(current, PAGE).href });
          loaded(img(id), ...natural);
          place(img(id), { width: box[0], height: box[1] });
        };
        // The browser picked the 1600w file for a 400px slot: it reports the density-corrected 400 × 200.
        shows('w', '/big.png', [400, 200], [400, 200]);
        // 3x: the file is three times the reported size.
        shows('x', '/three.png', [300, 150], [300, 150]);
        // A <picture> source's candidate.
        shows('pic', '/wide.webp', [300, 150], [300, 150]);
        // No srcset: the natural size is the file's.
        shows('plain', '/plain.png', [640, 320], [320, 160]);
        // A data: candidate (commas inside it) is parsed whole.
        shows('data', 'data:image/png;base64,AAAA', [50, 25], [50, 25]);
      },
    });
    expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.images.map((image) => [image.alt?.text, image.natural])).toEqual([
      ['w', { width: 1600, height: 800 }],
      ['x', { width: 900, height: 450 }],
      ['picture', { width: 1200, height: 600 }],
      ['plain', { width: 640, height: 320 }],
      ['data', { width: 100, height: 50 }],
    ]);
  });

  test('extractor-reads-css-sizing', () => {
    const snapshot = extract({
      head: '<style>.fixed { width: 120px; height: 80px } .half { width: 50% } @media screen { .nested { height: 10px; width: 20px } }</style>',
      body: `<img id="inline" src="/a.png" style="width: 100px; height: 50px"><img id="sheet" class="fixed" src="/b.png"><img id="nested" class="nested" src="/c.png">
        <img id="ratio" src="/d.png"><img id="half" class="half" src="/e.png"><img id="auto" src="/f.png" style="width: auto; height: auto"><img id="attrs" src="/g.png" width="10" height="10" class="fixed">`,
      prepare(document, window) {
        for (const img of document.images) place(img, { width: 10, height: 10 });
        const computed = window.getComputedStyle.bind(window);
        window.getComputedStyle = ((el: Element) => {
          const style = computed(el);
          if (el.id !== 'ratio') return style;
          return Object.assign(Object.create(style), { getPropertyValue: (name: string) => (name === 'aspect-ratio' ? '16 / 9' : style.getPropertyValue(name)) });
        }) as typeof window.getComputedStyle;
      },
    });
    expect(Object.fromEntries(snapshot.images.map((image) => [new URL(image.src).pathname, image.cssSized]))).toEqual({
      '/a.png': true,
      '/b.png': true,
      '/c.png': true,
      '/d.png': true,
      '/e.png': false,
      '/f.png': false,
      // Both attributes present: not measured.
      '/g.png': false,
    });
    // The sizing scan is bounded.
    const bounded = extract({ head: '<style>.fixed { width: 1px; height: 1px }</style>', body: '<img class="fixed" src="/b.png">', limits: { maxSizingSelectors: 0 }, prepare: (document) => place(document.images[0]!, { width: 1, height: 1 }) });
    expect(bounded.images[0]!.cssSized).toBe(false);
  });

  test('extractor-link-kind-counts-the-port', () => {
    const snapshot = extract({ body: '<a href="https://example.com:8443/x">Other port</a><a href="https://example.com:443/y">Default port</a><a href="https://www.example.com/z">www</a>' });
    expect(snapshot.links.map((link) => link.kind)).toEqual(['external', 'internal', 'internal']);
  });

  // ---- Structured data (Task 3; seo-schema.feature.md, Extraction) ----------------------------

  test('extractor-reads-json-ld-text', () => {
    const first = '{\n  "@context": "https://schema.org",\n  "@type": "Organization"\n}';
    const snapshot = extract({
      head: `<script type="application/ld+json">${first}</script><script type="text/javascript">var x = 1;</script>`,
      body: '<script type="APPLICATION/LD+JSON">[{"@type":"Thing"}]</script><script type="application/json">{"no":1}</script><script type="application/ld+json">{oops</script>',
    });
    expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.jsonLd).toEqual([
      { text: first, length: first.length },
      { text: '[{"@type":"Thing"}]', length: 19 },
      { text: '{oops', length: 5 },
    ]);
    expect(snapshot.jsonLdTotal).toBe(3);
  });

  test('extractor-caps-json-ld', () => {
    const block = (n: number) => `<script type="application/ld+json">${'x'.repeat(n)}</script>`;
    // One block over its cap is cut, its full length kept.
    const cut = extract({ body: block(150), limits: { maxJsonLdChars: 100 } });
    expect(cut.jsonLd).toEqual([{ text: 'x'.repeat(100), length: 150 }]);
    // Once the total is used, later blocks are kept empty with their length.
    const used = extract({ body: block(80) + block(80) + block(30), limits: { maxJsonLdChars: 100, maxJsonLdTotalChars: 120 } });
    expect(used.jsonLd.map((b) => [b.text.length, b.length])).toEqual([
      [80, 80],
      [40, 80],
      [0, 30],
    ]);
    // Past the block cap, blocks are only counted.
    const many = extract({ body: times(5, () => block(3)), limits: { maxJsonLdBlocks: 2 } });
    expect(many.jsonLd).toHaveLength(2);
    expect(many.jsonLdTotal).toBe(5);
    expect(PageSnapshotSchema.safeParse(extract({ body: block(SNAPSHOT_LIMITS.maxJsonLdChars + 10) })).success).toBe(true);
  });

  test('extractor-reads-microdata', () => {
    const snapshot = extract({
      body: `<div itemscope itemtype="https://schema.org/Product" itemid="urn:sku:1">
          <h2 itemprop="name"> Trail   shoe </h2>
          <img itemprop="image" src="/shoe.png" alt="">
          <a itemprop="url" href="/p/1">Link</a>
          <span itemprop="sku" content="TS-1">ignored text</span>
          <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
            <span itemprop="price" content="19.99">$19.99</span><meta itemprop="priceCurrency" content="USD">
            <time itemprop="priceValidUntil" datetime="2026-12-31">end of year</time>
            <data itemprop="inventoryLevel" value="7">seven</data>
          </div>
          <span itemprop="color material">Red</span>
        </div>
        <p itemprop="orphan">No item</p>
        <div itemscope><span itemprop="name">Untyped</span></div>`,
    });
    expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.microdataTotal).toBe(3);
    expect(snapshot.microdata).toEqual([
      {
        types: ['https://schema.org/Product'],
        id: 'urn:sku:1',
        vocab: null,
        properties: [
          { name: 'name', value: 'Trail shoe' },
          { name: 'image', value: 'https://example.com/shoe.png' },
          { name: 'url', value: 'https://example.com/p/1' },
          { name: 'sku', value: 'TS-1' },
          { name: 'offers', item: 1 },
          { name: 'color', value: 'Red' },
          { name: 'material', value: 'Red' },
        ],
      },
      {
        types: ['https://schema.org/Offer'],
        id: null,
        vocab: null,
        properties: [
          { name: 'price', value: '19.99' },
          { name: 'priceCurrency', value: 'USD' },
          { name: 'priceValidUntil', value: '2026-12-31' },
          { name: 'inventoryLevel', value: '7' },
        ],
      },
      { types: [], id: null, vocab: null, properties: [{ name: 'name', value: 'Untyped' }] },
    ]);
    expect(snapshot.rdfa).toEqual([]);
  });

  test('extractor-reads-rdfa', () => {
    const snapshot = extract({
      body: `<main vocab="https://schema.org/">
          <article typeof="Recipe" resource="#soup">
            <h1 property="name">Soup</h1>
            <meta property="totalTime" content="PT30M">
            <a property="url" href="/soup">Permalink</a>
            <div property="author" typeof="Person" about="#cook"><span property="name">Cook</span></div>
          </article>
        </main>
        <div typeof="schema:Thing"><span property="schema:name">Prefixed</span></div>`,
    });
    expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.rdfaTotal).toBe(3);
    expect(snapshot.rdfa).toEqual([
      {
        types: ['Recipe'],
        id: '#soup',
        vocab: 'https://schema.org/',
        properties: [
          { name: 'name', value: 'Soup' },
          { name: 'totalTime', value: 'PT30M' },
          { name: 'url', value: 'https://example.com/soup' },
          { name: 'author', item: 1 },
        ],
      },
      { types: ['Person'], id: '#cook', vocab: 'https://schema.org/', properties: [{ name: 'name', value: 'Cook' }] },
      { types: ['schema:Thing'], id: null, vocab: null, properties: [{ name: 'schema:name', value: 'Prefixed' }] },
    ]);
  });

  test('extractor-bounds-markup', () => {
    const nested = (depth: number) => `${'<div itemprop="part" itemscope itemtype="https://schema.org/Thing">'.repeat(depth)}${'</div>'.repeat(depth)}`;
    const deep = extract({ body: `<div itemscope itemtype="https://schema.org/Thing">${nested(10)}</div>`, limits: { maxMarkupDepth: 3 } });
    // The top-level item and three levels below it.
    expect(deep.microdata).toHaveLength(4);
    expect(deep.microdataTotal).toBe(11);
    const many = extract({ body: times(6, () => '<div itemscope itemtype="https://schema.org/Thing"><span itemprop="a">1</span><span itemprop="b">2</span><span itemprop="c">3</span></div>'), limits: { maxMarkupItems: 4, maxItemProperties: 2 } });
    expect(many.microdata).toHaveLength(4);
    expect(many.microdataTotal).toBe(6);
    expect(many.microdata.every((item) => item.properties.length === 2)).toBe(true);
    // A nested item its holder has no room for is dropped, not turned into a top-level item.
    const full = extract({
      body: '<div itemscope itemtype="https://schema.org/Thing"><span itemprop="a">1</span><span itemprop="b">2</span><div itemprop="c" itemscope itemtype="https://schema.org/Thing"><span itemprop="d">3</span></div></div>',
      limits: { maxItemProperties: 2 },
    });
    expect(full.microdata).toHaveLength(1);
    expect(full.microdataTotal).toBe(2);
    const long = extract({ body: `<div itemscope itemtype="https://schema.org/Thing"><p itemprop="description">${'word '.repeat(100)}</p></div>`, limits: { maxSchemaValueChars: 20 } });
    expect((long.microdata[0]!.properties[0] as { value: string }).value).toHaveLength(20);
    // Elements past maxMarkupElements are not looked at; the items are still counted.
    const capped = extract({ body: times(5, () => '<div itemscope itemtype="https://schema.org/Thing"></div>'), limits: { maxMarkupElements: 2 } });
    expect(capped.microdata).toHaveLength(2);
    expect(capped.microdataTotal).toBe(5);
    for (const snapshot of [deep, many, long, capped]) expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  test('extractor-caps-markup-text', () => {
    const value = 'v'.repeat(40);
    const body =
      times(3, () => `<div itemscope itemtype="https://schema.org/Thing"><span itemprop="a">${value}</span><span itemprop="b">${value}</span></div>`) +
      `<div vocab="https://schema.org/" typeof="Thing"><span property="name">${value}</span></div>`;
    const snapshot = extract({ body, limits: { maxMarkupTotalChars: 100 } });
    expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const lengths = [...snapshot.microdata, ...snapshot.rdfa].flatMap((item) => item.properties.map((p) => ('value' in p ? p.value.length : 0)));
    // 40 + 40 + 20, then nothing: microdata and RDFa share the cap.
    expect(lengths).toEqual([40, 40, 20, 0, 0, 0, 0]);
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(100);
  });

  // Phase 2.5 Task 3 (`seo-content.feature.md`, Visible text).
  test('visible-text-blocks', () => {
    const snapshot = visible({
      body: `<header><nav><a href="/">Home</a><a href="/b">Blog</a></nav></header><h1>Green   tea</h1><p>Brew it <b>gently</b>,
        then <i>wait</i>.</p><ul><li>One</li><li>Two</li></ul><h2>Next</h2>After the heading<br>a new line
        <script>var hidden = 1;</script><style>p { color: red }</style><p hidden>Secret</p><div>End</div>`,
    });
    expect(snapshot.visibleText).toEqual({ text: ['HomeBlog', 'Green tea', 'Brew it gently, then wait.', 'One', 'Two', 'Next', 'After the heading', 'a new line', 'End'].join('\n'), truncated: false });
    expect(PageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    // Without a cap (the default) the snapshot has no visible text.
    expect(extract({ body: '<p>Text</p>' }).visibleText).toBeUndefined();
  });

  // Phase 2.5 Task 3 review: the nearest block ancestor decides, not the parent.
  test('visible-text-block-of-inline-text', () => {
    expect(visible({ body: '<div><p><span>alpha</span></p>beta</div>' }).visibleText!.text).toBe('alpha\nbeta');
    expect(visible({ body: '<div>gamma<p><em>delta</em> epsilon</p><b>zeta</b></div>' }).visibleText!.text).toBe('gamma\ndelta epsilon\nzeta');
    // Inline siblings of one block stay joined, as rendered.
    expect(visible({ body: '<p><b>se</b><i>arch</i> <a href="/">engine</a></p>' }).visibleText!.text).toBe('search engine');
    expect(visible({ body: '<ul><li><a href="/a">One</a></li><li><a href="/b">Two</a></li></ul>' }).visibleText!.text).toBe('One\nTwo');
  });

  test('visible-text-capped', () => {
    const snapshot = visible({ body: `<p>${'abcdefghij '.repeat(100)}</p><p>more</p>`, max: 55 });
    expect(snapshot.visibleText!.text).toBe('abcdefghij '.repeat(5).trim());
    expect(snapshot.visibleText!.truncated).toBe(true);
    // The word count still reads the whole walk.
    expect(snapshot.wordCount).toBe(101);
    // Never half a surrogate pair.
    const emoji = visible({ body: `<p>ab${'😀'.repeat(10)}</p>`, max: 5 });
    expect(emoji.visibleText!.text).toBe('ab😀');
    // A walk stopped by its node cap is truncated too.
    expect(visible({ body: times(20, (i) => `<p>w${i}</p>`), limits: { maxTextNodes: 5 } }).visibleText!.truncated).toBe(true);
  });
});

