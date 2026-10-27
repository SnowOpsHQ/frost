// Spec: specs/seo-rules.spec.ts (SEO_RULE_SPECS, thresholds), specs/seo-snapshot.spec.ts (PageSnapshot)
// Acceptance: specs/seo-rules.feature.md (Catalog, one scenario per rule)
import { describe, expect, test } from 'vitest';
import {
  DESCRIPTION_MIN_CHARS,
  FINDING_SAMPLE_LIMIT,
  IMAGE_ALT_MAX_CHARS,
  IMAGE_OVERSIZE_FACTOR,
  SEO_RULE_SPECS,
  THIN_CONTENT_WORDS,
  TITLE_MIN_CHARS,
  URL_MAX_CHARS,
  type SeoRuleId,
} from '@app/specs/seo-rules.spec';
import { DESCRIPTION_WIDTH_RULE, SNIPPET_BUDGETS_PX, TITLE_WIDTH_RULE } from '@app/specs/seo-content.spec';
import { minSnippetWidth, RULES, runAudit, type FindingDetails, type PageSnapshot } from '../index';
import { chars, cleanSnapshot, page, PAGE_URL, robots, socialTags, text } from './fixtures';

function rule(id: SeoRuleId) {
  const found = RULES.find((r) => r.id === id);
  if (!found) throw new Error(`no rule ${id}`);
  return found;
}

/** The rule's details on `snapshot`; fails the test when it passes. */
function fails(id: SeoRuleId, snapshot: PageSnapshot): FindingDetails {
  const result = rule(id).check(snapshot);
  expect(result, `${id} should fail`).not.toBeNull();
  expect(result!.samples.length).toBeLessThanOrEqual(FINDING_SAMPLE_LIMIT);
  return result!;
}

function passes(id: SeoRuleId, snapshot: PageSnapshot): void {
  expect(rule(id).check(snapshot), `${id} should pass`).toBeNull();
}

/** The value of the fact labelled `label`. */
function factOf(result: FindingDetails, label: string): string | undefined {
  return result.facts.find((f) => f.label === label)?.value;
}

const link = (changes: Partial<PageSnapshot['links'][number]> = {}): PageSnapshot['links'][number] => ({
  href: 'https://example.com/a',
  scheme: 'https:',
  rel: '',
  text: 'A page',
  kind: 'internal',
  target: null,
  ...changes,
});
const image = (changes: Partial<PageSnapshot['images'][number]> = {}): PageSnapshot['images'][number] => ({
  src: 'https://example.com/a.png',
  alt: text('An image'),
  width: '100',
  height: '50',
  loading: null,
  rendered: { width: 100, height: 50 },
  natural: { width: 200, height: 100 },
  inFirstViewport: false,
  cssSized: false,
  ...changes,
});
const canonical = (href: string, resolved: string | null = new URL(href, PAGE_URL).href) => ({ canonicals: [{ href, resolved }], canonicalTotal: 1 });

describe('catalog', () => {
  test('catalog-matches-spec', () => {
    expect(RULES.map((r) => r.id)).toEqual(SEO_RULE_SPECS.map((s) => s.id));
    for (const [index, spec] of SEO_RULE_SPECS.entries()) {
      const r = RULES[index]!;
      expect({ id: r.id, category: r.category, severity: r.severity, title: r.title, condition: r.condition, why: r.why, fix: r.fix }).toEqual(spec);
      expect(typeof r.check).toBe('function');
    }
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    expect(RULES.length).toBeGreaterThanOrEqual(25);
  });

  test('clean-fixture-passes-every-rule', () => {
    for (const r of RULES) expect(r.check(cleanSnapshot()), r.id).toBeNull();
    const audit = runAudit(cleanSnapshot());
    expect(audit.findings).toEqual([]);
    expect(audit.score).toBe(100);
  });

  test('title-matching-h1-is-fine', () => {
    const snapshot = page({ titles: [text('SEO basics: a practical guide for beginners')], headings: [{ level: 1, text: 'SEO basics: a practical guide for beginners' }] });
    const failing = runAudit(snapshot).findings.map((f) => f.category);
    expect(failing).not.toContain('title');
    expect(failing).not.toContain('headings');
  });
});

describe('title', () => {
  test('title-missing', () => {
    fails('title-missing', page({ titles: [], titleTotal: 0 }));
    passes('title-missing', cleanSnapshot());
  });

  test('title-empty', () => {
    fails('title-empty', page({ titles: [text('')], titleTotal: 1 }));
    passes('title-empty', cleanSnapshot());
    // Not both: a missing title is title-missing only.
    passes('title-empty', page({ titles: [], titleTotal: 0 }));
  });

  test('title-multiple', () => {
    const result = fails('title-multiple', page({ titles: [text('One title for the page here'), text('Another title for the page')], titleTotal: 2 }));
    expect(factOf(result, 'Titles')).toBe('2');
    expect(result.samples).toEqual(['One title for the page here', 'Another title for the page']);
    passes('title-multiple', cleanSnapshot());
  });

  test('title-too-short', () => {
    const short = chars(TITLE_MIN_CHARS - 1);
    const result = fails('title-too-short', page({ titles: [text(short)] }));
    expect(factOf(result, 'Title')).toBe(short);
    expect(factOf(result, 'Length')).toBe(`${TITLE_MIN_CHARS - 1} characters`);
    passes('title-too-short', page({ titles: [text(chars(TITLE_MIN_CHARS))] }));
    passes('title-too-short', page({ titles: [], titleTotal: 0 }));
    passes('title-too-short', page({ titles: [text('')] }));
    // A width since the Phase 2.5 Task 3 review: 40 narrow letters are still too short.
    const narrow = fails('title-too-short', page({ titles: [text(chars(40, 'i'))] }));
    expect(factOf(narrow, 'Width')).toBe('178 px');
    expect(factOf(narrow, 'At least')).toBe(`about ${Math.round(minSnippetWidth('title'))} px`);
  });

  // Phase 2.5 Task 3 review (`seo-content.feature.md`, Rules): every script has a passing range.
  test('cjk-title-has-a-passing-range', () => {
    const cjk = (n: number) => '漢'.repeat(n);
    const title = (n: number) => page({ titles: [text(cjk(n))] });
    fails('title-too-short', title(14));
    for (const n of [15, 22, 29]) {
      passes('title-too-short', title(n));
      passes('title-too-wide', title(n));
    }
    fails('title-too-wide', title(30));
    // A description: 14 px each, at least about 480 px, at most 920 px.
    const description = (n: number) => page({ metaDescriptions: [text(cjk(n))] });
    fails('meta-description-too-short', description(34));
    for (const n of [35, 50, 65]) {
      passes('meta-description-too-short', description(n));
      passes('meta-description-too-wide', description(n));
    }
    fails('meta-description-too-wide', description(66));
    expect(runAudit(title(20)).findings.filter((f) => f.category === 'title')).toEqual([]);
  });

  // Phase 2.5 Task 3 (`seo-content.feature.md`, Rules): the width replaces the character maximum.
  test('title-too-wide', () => {
    // 32 wide letters are past the budget though within the old 60 characters …
    const wide = fails('title-too-wide', page({ titles: [text(chars(32, 'W'))] }));
    expect(factOf(wide, 'Width')).toBe('604 px');
    expect(factOf(wide, 'Budget')).toBe(`about ${SNIPPET_BUDGETS_PX.titleDesktop} px`);
    expect(factOf(wide, 'A result shows')).toMatch(/^W+…$/);
    // … and 100 narrow ones fit.
    passes('title-too-wide', page({ titles: [text(chars(100, 'i'))] }));
    passes('title-too-wide', cleanSnapshot());
    passes('title-too-wide', page({ titles: [], titleTotal: 0 }));
    passes('title-too-wide', page({ titles: [text('')] }));
    // A 10 MB title: the kept text (capped) is already far past the budget.
    fails('title-too-wide', page({ titles: [text(chars(1_024), 10_485_760)] }));
  });
});

describe('meta description', () => {
  test('meta-description-missing', () => {
    expect(factOf(fails('meta-description-missing', page({ metaDescriptions: [], metaDescriptionTotal: 0 })), 'Meta description')).toBe('None');
    expect(factOf(fails('meta-description-missing', page({ metaDescriptions: [text('')], metaDescriptionTotal: 1 })), 'Meta description')).toBe('Empty');
    expect(factOf(fails('meta-description-missing', page({ metaDescriptions: [text(''), text('')], metaDescriptionTotal: 2 })), 'Meta description')).toBe('Empty');
    passes('meta-description-missing', cleanSnapshot());
    // An empty tag before one with text changes nothing.
    passes('meta-description-missing', page({ metaDescriptions: [text(''), text(chars(100))], metaDescriptionTotal: 2 }));
  });

  test('meta-description-too-short', () => {
    // `x` is 7 px at the description size, the minimum about 480 px.
    fails('meta-description-too-short', page({ metaDescriptions: [text(chars(DESCRIPTION_MIN_CHARS - 2))] }));
    fails('meta-description-too-short', page({ metaDescriptions: [text(chars(DESCRIPTION_MIN_CHARS + 30, 'i'))] }));
    passes('meta-description-too-short', page({ metaDescriptions: [text(chars(DESCRIPTION_MIN_CHARS))] }));
    // The first description with text is measured, whatever comes before it.
    fails('meta-description-too-short', page({ metaDescriptions: [text(''), text(chars(10))], metaDescriptionTotal: 2 }));
    passes('meta-description-too-short', page({ metaDescriptions: [text(''), text(chars(100))], metaDescriptionTotal: 2 }));
  });

  test('meta-description-too-wide', () => {
    // `x` is 7 px at the description size: 132 are 924 px, 131 are 917 px.
    const wide = fails('meta-description-too-wide', page({ metaDescriptions: [text(chars(132))] }));
    expect(factOf(wide, 'Width')).toBe('924 px');
    passes('meta-description-too-wide', page({ metaDescriptions: [text(chars(131))] }));
    passes('meta-description-too-wide', page({ metaDescriptions: [text(chars(200, 'i'))] }));
    // The first description with text is measured.
    fails('meta-description-too-wide', page({ metaDescriptions: [text(''), text(chars(132))], metaDescriptionTotal: 2 }));
    passes('meta-description-too-wide', page({ metaDescriptions: [], metaDescriptionTotal: 0 }));
  });

  test('width-rules-replace-character-maximums', () => {
    const ids: readonly string[] = SEO_RULE_SPECS.map((spec) => spec.id);
    expect(ids).not.toContain('title-too-long');
    expect(ids).not.toContain('meta-description-too-long');
    expect(ids).toContain('title-too-short');
    expect(ids).toContain('meta-description-too-short');
    expect(SEO_RULE_SPECS.find((spec) => spec.id === 'title-too-wide')).toEqual(TITLE_WIDTH_RULE);
    expect(SEO_RULE_SPECS.find((spec) => spec.id === 'meta-description-too-wide')).toEqual(DESCRIPTION_WIDTH_RULE);
    // A long, wide title fails once, on its width.
    const title = runAudit(page({ titles: [text(chars(80, 'W'))] })).findings.filter((f) => f.category === 'title');
    expect(title.map((f) => f.ruleId)).toEqual(['title-too-wide']);
    // Their severities are pinned: the title's a warning, the description's information.
    expect(rule('title-too-wide').severity).toBe('warning');
    expect(rule('meta-description-too-wide').severity).toBe('info');
    expect(runAudit(page({ metaDescriptions: [text(chars(132))] })).findings.find((f) => f.ruleId === 'meta-description-too-wide')?.severity).toBe('info');
  });

  test('meta-description-multiple', () => {
    fails('meta-description-multiple', page({ metaDescriptions: [text(chars(100)), text(chars(90))], metaDescriptionTotal: 2 }));
    passes('meta-description-multiple', cleanSnapshot());
  });
});

describe('headings', () => {
  test('h1-missing', () => {
    fails('h1-missing', page({ headings: [{ level: 2, text: 'Only an H2' }], headingTotal: 1 }));
    fails('h1-missing', page({ headings: [], headingTotal: 0 }));
    passes('h1-missing', cleanSnapshot());
  });

  test('h1-multiple', () => {
    const result = fails('h1-multiple', page({ headings: [{ level: 1, text: 'First' }, { level: 2, text: 'Sub' }, { level: 1, text: 'Second' }], headingTotal: 3 }));
    expect(result.samples).toEqual(['First', 'Second']);
    expect(result.count).toBe(2);
    passes('h1-multiple', cleanSnapshot());
  });

  test('h1-empty', () => {
    fails('h1-empty', page({ headings: [{ level: 1, text: '' }], headingTotal: 1 }));
    passes('h1-empty', cleanSnapshot());
  });

  test('heading-level-skipped', () => {
    const result = fails('heading-level-skipped', page({ headings: [{ level: 1, text: 'Top' }, { level: 3, text: 'Too deep' }], headingTotal: 2 }));
    expect(result.samples).toEqual(['H1 → H3: Too deep']);
    passes('heading-level-skipped', cleanSnapshot());
    // Going back up any number of levels is fine, and the first heading may be any level.
    passes('heading-level-skipped', page({ headings: [{ level: 2, text: 'a' }, { level: 3, text: 'b' }, { level: 4, text: 'c' }, { level: 1, text: 'd' }] }));
  });
});

describe('canonical', () => {
  test('canonical-missing', () => {
    fails('canonical-missing', page({ canonicals: [], canonicalTotal: 0 }));
    passes('canonical-missing', cleanSnapshot());
  });

  test('canonical-multiple', () => {
    const result = fails('canonical-multiple', page({ canonicals: [{ href: PAGE_URL, resolved: PAGE_URL }, { href: '/other', resolved: 'https://example.com/other' }], canonicalTotal: 2 }));
    expect(result.samples).toEqual([PAGE_URL, '/other']);
    passes('canonical-multiple', cleanSnapshot());
  });

  test('canonical-relative', () => {
    fails('canonical-relative', page(canonical('/guides/seo-basics')));
    fails('canonical-relative', page(canonical('//example.com/guides/seo-basics')));
    passes('canonical-relative', page(canonical(PAGE_URL)));
  });

  test('canonical-off-host', () => {
    const result = fails('canonical-off-host', page(canonical('https://other.example.org/copy')));
    expect(factOf(result, 'Canonical host')).toBe('other.example.org');
    passes('canonical-off-host', cleanSnapshot());
    passes('canonical-off-host', page(canonical('https://www.example.com/guides/seo-basics')));
    passes('canonical-off-host', page({ ...canonical('https://example.com/x'), url: 'https://www.example.com/x' }));
  });

  test('canonical-og-url-mismatch', () => {
    fails('canonical-og-url-mismatch', page({ ogUrl: 'https://example.com/elsewhere' }));
    passes('canonical-og-url-mismatch', page({ ogUrl: `${PAGE_URL}#top` }));
    passes('canonical-og-url-mismatch', page({ ogUrl: null }));
    passes('canonical-og-url-mismatch', page({ canonicals: [], canonicalTotal: 0, ogUrl: 'https://example.com/elsewhere' }));
  });

  test('canonical-has-query', () => {
    expect(factOf(fails('canonical-has-query', page(canonical(`${PAGE_URL}?utm_source=x`))), 'Query')).toBe('?utm_source=x');
    passes('canonical-has-query', cleanSnapshot());
  });
});

describe('indexing', () => {
  test('robots-noindex', () => {
    expect(fails('robots-noindex', page({ metaRobots: [robots('noindex')] })).facts).toEqual([{ label: 'Meta robots', value: 'noindex' }]);
    fails('robots-noindex', page({ metaRobots: [robots('max-snippet:50, NOINDEX')] }));
    fails('robots-noindex', page({ metaRobots: [robots('none')] }));
    // A crawler-specific tag alone is enough, and the finding names it.
    const google = fails('robots-noindex', page({ metaRobots: [robots('index, follow'), robots('noindex', 'googlebot')] }));
    expect(google.facts).toEqual([{ label: 'Meta robots (googlebot)', value: 'noindex' }]);
    // Another crawler's tag is not this rule (robots-noindex-other-bot).
    passes('robots-noindex', page({ metaRobots: [robots('noindex', 'bingbot')] }));
    passes('robots-noindex', page({ metaRobots: [robots('none', 'googlebot-news')] }));
    passes('robots-noindex', cleanSnapshot());
    passes('robots-noindex', page({ metaRobots: [] }));
    passes('robots-noindex', page({ metaRobots: [robots('index'), robots('nofollow', 'googlebot')] }));
  });

  test('robots-noindex-other-bot', () => {
    expect(factOf(fails('robots-noindex-other-bot', page({ metaRobots: [robots('noindex', 'bingbot')] })), 'Meta robots (bingbot)')).toBe('noindex');
    expect(factOf(fails('robots-noindex-other-bot', page({ metaRobots: [robots('none', 'googlebot-news')] })), 'Meta robots (googlebot-news)')).toBe('none');
    passes('robots-noindex-other-bot', page({ metaRobots: [robots('noindex'), robots('noindex', 'googlebot')] }));
    passes('robots-noindex-other-bot', cleanSnapshot());
  });

  test('robots-nofollow', () => {
    fails('robots-nofollow', page({ metaRobots: [robots('index,nofollow')] }));
    fails('robots-nofollow', page({ metaRobots: [robots('none')] }));
    expect(factOf(fails('robots-nofollow', page({ metaRobots: [robots('nofollow', 'bingbot')] })), 'Meta robots (bingbot)')).toBe('nofollow');
    passes('robots-nofollow', page({ metaRobots: [robots('noindex')] }));
  });
});

describe('language and mobile', () => {
  test('lang-missing', () => {
    fails('lang-missing', page({ lang: null }));
    fails('lang-missing', page({ lang: ' ' }));
    passes('lang-missing', page({ lang: 'en' }));
  });

  test('viewport-missing', () => {
    fails('viewport-missing', page({ viewport: null }));
    fails('viewport-missing', page({ viewport: '' }));
    passes('viewport-missing', cleanSnapshot());
  });
});

describe('content', () => {
  test('content-thin', () => {
    const result = fails('content-thin', page({ wordCount: THIN_CONTENT_WORDS - 1 }));
    expect(factOf(result, 'Words')).toBe(String(THIN_CONTENT_WORDS - 1));
    passes('content-thin', page({ wordCount: THIN_CONTENT_WORDS }));
    // An incomplete count never accuses the page of being thin.
    passes('content-thin', page({ wordCount: 10, textTruncated: true }));
  });
});

describe('images', () => {
  test('images-missing-alt', () => {
    const result = fails('images-missing-alt', page({ images: [image(), image({ src: 'https://example.com/b.png', alt: null }), image({ src: '', alt: null })], imageTotal: 3 }));
    expect(result.count).toBe(2);
    expect(result.samples).toEqual(['https://example.com/b.png', '(none)']);
    expect(factOf(result, 'Images without alt')).toBe('2 of 3');
    // Decorative images (alt="") pass.
    passes('images-missing-alt', page({ images: [image({ alt: text('') })], imageTotal: 1 }));
    passes('images-missing-alt', cleanSnapshot());
  });

  test('image-alt-too-long', () => {
    fails('image-alt-too-long', page({ images: [image({ alt: text(chars(IMAGE_ALT_MAX_CHARS + 1)) })], imageTotal: 1 }));
    // Measured by the full length, even when the kept text is capped.
    fails('image-alt-too-long', page({ images: [image({ alt: text(chars(50), 5_000) })], imageTotal: 1 }));
    passes('image-alt-too-long', page({ images: [image({ alt: text(chars(IMAGE_ALT_MAX_CHARS)) })], imageTotal: 1 }));
  });
});

describe('image loading and size', () => {
  test('images-missing-dimensions', () => {
    const result = fails(
      'images-missing-dimensions',
      page({ images: [image(), image({ src: 'https://example.com/w.png', height: null }), image({ src: 'https://example.com/h.png', width: ' ' }), image({ src: 'https://example.com/none.png', width: null, height: null })], imageTotal: 4 }),
    );
    expect(result.count).toBe(3);
    expect(result.samples).toEqual(['https://example.com/w.png', 'https://example.com/h.png', 'https://example.com/none.png']);
    expect(factOf(result, 'Images without width and height')).toBe('3 of 4');
    passes('images-missing-dimensions', page({ images: [image()], imageTotal: 1 }));
    // CSS fixes its box (aspect-ratio, or width and height declared together): nothing shifts.
    passes('images-missing-dimensions', page({ images: [image({ width: null, height: null, cssSized: true })], imageTotal: 1 }));
    // An image with no layout box (hidden) shifts nothing.
    passes('images-missing-dimensions', page({ images: [image({ width: null, height: null, rendered: null })], imageTotal: 1 }));
  });

  test('images-oversized', () => {
    const factor = IMAGE_OVERSIZE_FACTOR;
    const result = fails('images-oversized', page({ images: [image({ rendered: { width: 100, height: 50 }, natural: { width: 100 * factor + 1, height: 50 } })], imageTotal: 1 }));
    expect(result.samples).toEqual([`https://example.com/a.png (${100 * factor + 1} × 50 shown at 100 × 50)`]);
    fails('images-oversized', page({ images: [image({ rendered: { width: 100, height: 50 }, natural: { width: 100, height: 50 * factor + 1 } })], imageTotal: 1 }));
    // Exactly the factor is fine (a high-density screen needs it).
    passes('images-oversized', page({ images: [image({ rendered: { width: 100, height: 50 }, natural: { width: 100 * factor, height: 50 * factor } })], imageTotal: 1 }));
    // Unknown sizes (not loaded, no box) and vectors never count.
    passes('images-oversized', page({ images: [image({ natural: null }), image({ rendered: null, natural: { width: 9_000, height: 9_000 } })], imageTotal: 2 }));
    passes('images-oversized', page({ images: [image({ src: 'https://example.com/logo.SVG?v=2', natural: { width: 9_000, height: 9_000 } })], imageTotal: 1 }));
    passes('images-oversized', page({ images: [image({ src: 'data:image/svg+xml,<svg/>', natural: { width: 9_000, height: 9_000 } })], imageTotal: 1 }));
    passes('images-oversized', page({ images: [image({ rendered: { width: 0, height: 0 }, natural: { width: 9_000, height: 9_000 } })], imageTotal: 1 }));
  });

  test('images-lazy-in-first-viewport', () => {
    const result = fails('images-lazy-in-first-viewport', page({ images: [image({ loading: 'LAZY', inFirstViewport: true }), image({ loading: 'lazy' })], imageTotal: 2 }));
    expect(result.count).toBe(1);
    // Lazy below the fold, and eager in the first viewport, are right.
    passes('images-lazy-in-first-viewport', page({ images: [image({ loading: 'lazy', inFirstViewport: false }), image({ loading: 'eager', inFirstViewport: true }), image({ inFirstViewport: true })], imageTotal: 3 }));
  });
});

describe('links', () => {
  test('links-empty-anchor', () => {
    const result = fails('links-empty-anchor', page({ links: [link(), link({ href: 'https://example.com/icon', text: '' })], linkTotal: 2 }));
    expect(result.count).toBe(1);
    expect(result.samples).toEqual(['https://example.com/icon']);
    passes('links-empty-anchor', cleanSnapshot());
  });

  test('links-javascript-href', () => {
    fails('links-javascript-href', page({ links: [link({ href: 'javascript:void(0)', scheme: 'javascript:', kind: 'other', text: 'Open menu' })], linkTotal: 1 }));
    passes('links-javascript-href', page({ links: [link(), link({ href: 'mailto:a@example.com', scheme: 'mailto:', kind: 'other' })], linkTotal: 2 }));
  });

  test('links-nofollow', () => {
    const result = fails('links-nofollow', page({ links: [link({ rel: 'noopener nofollow' }), link()], linkTotal: 5_000 }));
    expect(result.count).toBe(1);
    expect(factOf(result, 'nofollow links')).toBe('1 of the first 2 (page has 5,000)');
    passes('links-nofollow', page({ links: [link({ rel: 'noopener' }), link({ rel: 'sponsored' })], linkTotal: 2 }));
  });
});

describe('url', () => {
  test('url-too-long', () => {
    const base = 'https://example.com/';
    const long = `${base}${chars(URL_MAX_CHARS + 1 - base.length, 'a')}`;
    expect(long.length).toBe(URL_MAX_CHARS + 1);
    fails('url-too-long', page({ url: long }));
    passes('url-too-long', page({ url: long.slice(0, -1) }));
    passes('url-too-long', page({ url: `${PAGE_URL}#${chars(200, 'f')}` }));
  });

  test('url-uppercase', () => {
    expect(factOf(fails('url-uppercase', page({ url: 'https://example.com/Guides/SEO' })), 'Path')).toBe('/Guides/SEO');
    passes('url-uppercase', page({ url: 'https://EXAMPLE.com/guides?Q=Upper' }));
    // Percent-escapes are not letters of the path.
    passes('url-uppercase', page({ url: 'https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC' }));
    fails('url-uppercase', page({ url: 'https://ja.wikipedia.org/Wiki/%E6%9D%B1' }));
  });

  test('url-underscores', () => {
    fails('url-underscores', page({ url: 'https://example.com/seo_basics' }));
    passes('url-underscores', page({ url: 'https://example.com/seo-basics?utm_source=x' }));
  });
});

describe('social', () => {
  const social = (changes: Partial<PageSnapshot['social']>) => page({ social: socialTags(changes) });

  test('og-title-missing', () => {
    expect(factOf(fails('og-title-missing', social({ 'og:title': null })), 'og:title')).toBe('None');
    expect(factOf(fails('og-title-missing', social({ 'og:title': ' ' })), 'og:title')).toBe('Empty');
    passes('og-title-missing', cleanSnapshot());
  });

  test('og-description-missing', () => {
    fails('og-description-missing', social({ 'og:description': null }));
    fails('og-description-missing', social({ 'og:description': '' }));
    passes('og-description-missing', cleanSnapshot());
  });

  test('og-image-missing', () => {
    fails('og-image-missing', social({ 'og:image': null }));
    fails('og-image-missing', social({ 'og:image': '' }));
    // A twitter:image alone does not make an Open Graph image.
    fails('og-image-missing', social({ 'og:image': null, 'twitter:image': 'https://example.com/t.png' }));
    passes('og-image-missing', cleanSnapshot());
  });

  test('og-image-not-https', () => {
    expect(factOf(fails('og-image-not-https', social({ 'og:image': '/img/share.png' })), 'Problem')).toBe('Relative URL');
    expect(factOf(fails('og-image-not-https', social({ 'og:image': '//cdn.example.com/share.png' })), 'Problem')).toBe('Relative URL');
    expect(factOf(fails('og-image-not-https', social({ 'og:image': 'http://example.com/share.png' })), 'Problem')).toBe('http: URL');
    fails('og-image-not-https', social({ 'og:image': 'img/share.png' }));
    passes('og-image-not-https', social({ 'og:image': 'HTTPS://example.com/share.png' }));
    // A missing image is og-image-missing, not this.
    passes('og-image-not-https', social({ 'og:image': null }));
  });

  test('twitter-card-missing', () => {
    fails('twitter-card-missing', social({ 'twitter:card': null }));
    passes('twitter-card-missing', social({ 'twitter:card': 'summary' }));
  });
});
