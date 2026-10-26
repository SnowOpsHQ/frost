// Spec: specs/seo-rules.spec.ts (SEO_RULE_SPECS, thresholds), specs/seo-snapshot.spec.ts (PageSnapshot)
// Acceptance: specs/seo-rules.feature.md (Catalog, one scenario per rule)
import { describe, expect, test } from 'vitest';
import {
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MIN_CHARS,
  FINDING_SAMPLE_LIMIT,
  IMAGE_ALT_MAX_CHARS,
  SEO_RULE_SPECS,
  THIN_CONTENT_WORDS,
  TITLE_MAX_CHARS,
  TITLE_MIN_CHARS,
  URL_MAX_CHARS,
  type SeoRuleId,
} from '@app/specs/seo-rules.spec';
import { RULES, runAudit, type FindingDetails, type PageSnapshot } from '../index';
import { chars, cleanSnapshot, page, PAGE_URL, text } from './fixtures';

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
  ...changes,
});
const image = (changes: Partial<PageSnapshot['images'][number]> = {}): PageSnapshot['images'][number] => ({
  src: 'https://example.com/a.png',
  alt: text('An image'),
  width: null,
  height: null,
  loading: null,
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
  });

  test('title-too-long', () => {
    fails('title-too-long', page({ titles: [text(chars(TITLE_MAX_CHARS + 1))] }));
    passes('title-too-long', page({ titles: [text(chars(TITLE_MAX_CHARS))] }));
    // A 10 MB title: the kept text is capped, the full length is what is measured.
    const huge = fails('title-too-long', page({ titles: [text(chars(1_024), 10_485_760)] }));
    expect(factOf(huge, 'Length')).toBe('10,485,760 characters');
  });
});

describe('meta description', () => {
  test('meta-description-missing', () => {
    expect(factOf(fails('meta-description-missing', page({ metaDescriptions: [], metaDescriptionTotal: 0 })), 'Meta description')).toBe('None');
    expect(factOf(fails('meta-description-missing', page({ metaDescriptions: [text('')], metaDescriptionTotal: 1 })), 'Meta description')).toBe('Empty');
    passes('meta-description-missing', cleanSnapshot());
  });

  test('meta-description-too-short', () => {
    fails('meta-description-too-short', page({ metaDescriptions: [text(chars(DESCRIPTION_MIN_CHARS - 1))] }));
    passes('meta-description-too-short', page({ metaDescriptions: [text(chars(DESCRIPTION_MIN_CHARS))] }));
  });

  test('meta-description-too-long', () => {
    fails('meta-description-too-long', page({ metaDescriptions: [text(chars(DESCRIPTION_MAX_CHARS + 1))] }));
    passes('meta-description-too-long', page({ metaDescriptions: [text(chars(DESCRIPTION_MAX_CHARS))] }));
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
    fails('robots-noindex', page({ metaRobots: ['noindex'] }));
    fails('robots-noindex', page({ metaRobots: ['max-snippet:50, NOINDEX'] }));
    fails('robots-noindex', page({ metaRobots: ['none'] }));
    passes('robots-noindex', cleanSnapshot());
    passes('robots-noindex', page({ metaRobots: [] }));
  });

  test('robots-nofollow', () => {
    fails('robots-nofollow', page({ metaRobots: ['index,nofollow'] }));
    fails('robots-nofollow', page({ metaRobots: ['none'] }));
    passes('robots-nofollow', page({ metaRobots: ['noindex'] }));
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
  });

  test('url-underscores', () => {
    fails('url-underscores', page({ url: 'https://example.com/seo_basics' }));
    passes('url-underscores', page({ url: 'https://example.com/seo-basics?utm_source=x' }));
  });
});
