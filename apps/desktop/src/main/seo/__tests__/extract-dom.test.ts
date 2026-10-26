// Spec: specs/seo-limits.spec.ts (SNAPSHOT_LIMITS, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES),
// specs/seo-snapshot.spec.ts (PageSnapshotSchema, hidden elements, wordCount)
// Acceptance: specs/seo-sidebar.feature.md (Extraction, Against a DOM)
import { JSDOM } from 'jsdom';
import { describe, expect, test } from 'vitest';
import { EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SNAPSHOT_LIMITS, type SnapshotLimits } from '@app/specs/seo-limits.spec';
import { PageSnapshotSchema, type PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { extractPage, type PageDocument } from '../extract';

const PAGE = 'https://example.com/guides/page';

/** Runs the extractor on `body` (and `head`) in a jsdom document at `url`. */
function extract({ head = '', body = '', limits = {}, budget = EXTRACT_BUDGET_MS, url = PAGE }: { head?: string; body?: string; limits?: Partial<SnapshotLimits>; budget?: number; url?: string }): PageSnapshot {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`, { url });
  return extractPage(dom.window.document as unknown as PageDocument, { ...SNAPSHOT_LIMITS, ...limits }, budget, ROBOTS_META_NAMES) as PageSnapshot;
}

const times = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i)).join('');

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
    const s = extractPage(dom.window.document as unknown as PageDocument, { ...SNAPSHOT_LIMITS, ...limits }, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES) as PageSnapshot;
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
});
