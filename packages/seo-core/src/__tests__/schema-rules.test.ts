// Spec: specs/seo-rules.spec.ts (the schema rules), specs/schema-types.spec.ts (SCHEMA_TYPE_RULES and the property sets)
// Acceptance: specs/seo-schema.feature.md (Rules)
import { describe, expect, test } from 'vitest';
import { FINDING_SAMPLE_LIMIT, type SeoRuleId } from '@app/specs/seo-rules.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { analyseSchema, RULES, type FindingDetails, type PageSnapshot } from '../index';
import { cleanSnapshot, item, jsonLd, page, withJsonLd } from './fixtures';

function rule(id: SeoRuleId) {
  const found = RULES.find((r) => r.id === id);
  if (!found) throw new Error(`no rule ${id}`);
  return found;
}
function fails(id: SeoRuleId, snapshot: PageSnapshot): FindingDetails {
  const result = rule(id).check(snapshot);
  expect(result, `${id} should fail`).not.toBeNull();
  expect(result!.samples.length).toBeLessThanOrEqual(FINDING_SAMPLE_LIMIT);
  return result!;
}
function passes(id: SeoRuleId, snapshot: PageSnapshot): void {
  expect(rule(id).check(snapshot), `${id} should pass`).toBeNull();
}

const CTX = 'https://schema.org';
/** A JSON-LD node with the schema.org context. */
const node = (type: string | string[] | undefined, props: Record<string, unknown> = {}) => ({ '@context': CTX, ...(type === undefined ? {} : { '@type': type }), ...props });
const ORG = { name: 'Acme', url: 'https://acme.example/', logo: 'https://acme.example/logo.png', sameAs: 'https://social.example/acme' };
const OFFER = { '@type': 'Offer', price: '19.99', priceCurrency: 'USD' };
const PRODUCT = { name: 'Trail shoe', image: 'https://acme.example/shoe.png', description: 'A shoe.', brand: { '@type': 'Brand', name: 'Acme' }, sku: 'TS-1', offers: OFFER };
const product = (props: Record<string, unknown> = {}) => withJsonLd(node('Product', { ...PRODUCT, ...props }));
const crumbs = (...positions: unknown[]) =>
  withJsonLd(node('BreadcrumbList', { itemListElement: positions.map((position, i) => ({ '@type': 'ListItem', ...(position === undefined ? {} : { position }), name: `Step ${i + 1}`, item: `https://acme.example/${i}` })) }));
const microdata = (items: PageSnapshot['microdata']) => page({ jsonLd: [], jsonLdTotal: 0, microdata: items, microdataTotal: items.length });
const rdfa = (items: PageSnapshot['rdfa']) => page({ jsonLd: [], jsonLdTotal: 0, rdfa: items, rdfaTotal: items.length });

describe('schema rules', () => {
  test('schema-none', () => {
    expect(fails('schema-none', page({ jsonLd: [], jsonLdTotal: 0 })).facts).toEqual([{ label: 'Structured data', value: 'None found' }]);
    passes('schema-none', cleanSnapshot());
    passes('schema-none', microdata([item(['https://schema.org/Thing'], [])]));
    passes('schema-none', rdfa([item(['Thing'], [], { vocab: CTX })]));
    // Blocks past the cap still count.
    passes('schema-none', page({ jsonLd: [], jsonLdTotal: 40 }));
  });

  test('schema-json-invalid', () => {
    const result = fails('schema-json-invalid', page({ jsonLd: [jsonLd(node('Thing')), jsonLd('{\n  "@type": "Thing",\n}')], jsonLdTotal: 2 }));
    expect(result.facts).toEqual([
      { label: 'Block', value: '2 of 2' },
      { label: 'Position', value: 'Line 2, column 19' },
      { label: 'Error', value: 'Trailing comma: a property must follow it before "}"' },
    ]);
    expect(result.samples[0]).toBe('JSON-LD block 2: Line 2, column 19: Trailing comma: a property must follow it before "}"');
    fails('schema-json-invalid', page({ jsonLd: [jsonLd('')], jsonLdTotal: 1 }));
    passes('schema-json-invalid', cleanSnapshot());
    // A cut block is not parsed, so it is not called invalid.
    passes('schema-json-invalid', page({ jsonLd: [jsonLd('{"@type": "Th', 5_000_000)], jsonLdTotal: 1 }));
  });

  test('schema-over-limit', () => {
    expect(fails('schema-over-limit', page({ jsonLd: [jsonLd('{"@type": "Th', 5_000_000)], jsonLdTotal: 1 })).samples[0]).toBe('JSON-LD block 1: 5,000,000 characters (frost reads blocks of up to 131,072): not read');
    expect(fails('schema-over-limit', page({ jsonLd: [jsonLd('x'.repeat(10)), jsonLd('', 900)], jsonLdTotal: 2 })).count).toBe(1);
    const usedUp = page({ jsonLd: [...Array.from({ length: 4 }, () => jsonLd(`"${'x'.repeat(SNAPSHOT_LIMITS.maxJsonLdChars - 2)}"`)), jsonLd('', 900)], jsonLdTotal: 5 });
    expect(fails('schema-over-limit', usedUp).samples[0]).toMatch(/after the page’s first 524,288 characters/);
    fails('schema-over-limit', withJsonLd(node('Thing', { deep: JSON.parse(`${'['.repeat(100)}1${']'.repeat(100)}`) as unknown })));
    passes('schema-over-limit', cleanSnapshot());
  });

  test('schema-context-missing', () => {
    expect(fails('schema-context-missing', withJsonLd({ '@type': 'Organization', ...ORG })).samples[0]).toBe('Organization “Acme”: No @context');
    // An array's entries each need their own.
    fails('schema-context-missing', withJsonLd([node('Thing', { name: 'a' }), { '@type': 'Thing', name: 'b' }]));
    expect(fails('schema-context-missing', rdfa([item(['Product'], [{ name: 'name', value: 'x' }])])).samples[0]).toBe('Product “x”: typeof “Product” with no vocab');
    expect(fails('schema-context-missing', microdata([item(['Product'], [])])).samples[0]).toMatch(/itemtype “Product” is not a full IRI/);
    passes('schema-context-missing', cleanSnapshot());
    passes('schema-context-missing', microdata([item(['https://schema.org/Product'], [])]));
    passes('schema-context-missing', rdfa([item(['schema:Product'], [])]));
    // Nested nodes inherit their top-level node's context.
    passes('schema-context-missing', product({ brand: { '@type': 'Brand', name: 'Acme' } }));
  });

  test('schema-context-not-schema-org', () => {
    expect(fails('schema-context-not-schema-org', withJsonLd({ '@context': 'https://schema.example', '@type': 'Thing' })).samples[0]).toBe('Thing: @context “https://schema.example”');
    fails('schema-context-not-schema-org', withJsonLd({ '@context': { '@vocab': 'http://xmlns.example/foaf/' }, '@type': 'Thing' }));
    fails('schema-context-not-schema-org', microdata([item(['https://vocab.example/Product'], [])]));
    fails('schema-context-not-schema-org', rdfa([item(['Product'], [], { vocab: 'https://vocab.example/' })]));
    fails('schema-context-not-schema-org', rdfa([item(['og:Thing'], [])]));
    for (const context of ['http://schema.org', 'https://schema.org/', 'https://www.schema.org', 'https://schema.org/docs/jsonldcontext.json', ['https://schema.org', { '@language': 'en' }], { '@vocab': 'https://schema.org/' }, { schema: 'http://schema.org/' }]) {
      passes('schema-context-not-schema-org', withJsonLd({ '@context': context, '@type': 'Thing', name: 'x' }));
    }
    passes('schema-context-not-schema-org', microdata([item(['http://schema.org/Product', 'https://schema.org/Thing'], [])]));
    passes('schema-context-not-schema-org', rdfa([item(['Product'], [], { vocab: 'http://schema.org/' })]));
  });

  test('schema-type-missing', () => {
    expect(fails('schema-type-missing', withJsonLd(node(undefined, { name: 'What am I' }))).samples[0]).toBe('Untyped JSON-LD node “What am I”: No @type');
    expect(fails('schema-type-missing', microdata([item([], [{ name: 'name', value: 'x' }])])).samples[0]).toMatch(/No itemtype/);
    fails('schema-type-missing', withJsonLd({ '@context': CTX, '@graph': [{ name: 'untyped member' }] }));
    passes('schema-type-missing', cleanSnapshot());
    // Untyped nested objects and @id-only references are not top-level nodes.
    passes('schema-type-missing', withJsonLd(node('Organization', { ...ORG, address: { streetAddress: '1 Road' } }), { '@context': CTX, '@graph': [{ '@id': '#x' }] }));
    // A node that adds properties to a typed node with the same @id (in another block) extends it.
    const parts = withJsonLd(node('Recipe', { '@id': '#r', name: 'Soup', image: 'https://a.example/s.png' }), { '@context': CTX, '@id': '#r', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4 } });
    passes('schema-type-missing', parts);
    const report = analyseSchema(parts);
    expect(report.entities.map((e) => e.extends)).toEqual([null, report.entities[0]!.key]);
  });

  test('schema-type-unknown', () => {
    expect(fails('schema-type-unknown', withJsonLd(node('product', { name: 'x' }))).samples[0]).toBe('product “x”: “product” is not a common schema.org type');
    fails('schema-type-unknown', withJsonLd(node('Organisation', ORG)));
    // Nested types are checked too.
    fails('schema-type-unknown', product({ brand: { '@type': 'Brandd', name: 'Acme' } }));
    passes('schema-type-unknown', cleanSnapshot());
    passes('schema-type-unknown', withJsonLd(node(['Restaurant', 'TouristAttraction'], { name: 'x' }), node('https://vocab.example/Widget')));
  });

  test('schema-required-missing', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['Organization', { url: 'https://a.example/' }, 'Missing name'],
      ['WebSite', { name: 'Site' }, 'Missing url'],
      ['BreadcrumbList', {}, 'Missing itemListElement'],
      ['Article', { image: 'https://a.example/i.png' }, 'Missing headline'],
      ['NewsArticle', {}, 'Missing headline'],
      ['BlogPosting', {}, 'Missing headline'],
      ['Product', { name: 'P' }, 'Missing offers, review or aggregateRating'],
      ['FAQPage', {}, 'Missing mainEntity'],
      ['LocalBusiness', { name: 'Shop' }, 'Missing address'],
      ['Restaurant', { name: 'Diner' }, 'Missing address'],
      ['Event', { name: 'Gig', location: 'Hall' }, 'Missing startDate'],
      ['Recipe', { name: 'Soup' }, 'Missing image'],
      ['VideoObject', { name: 'Clip' }, 'Missing thumbnailUrl; uploadDate'],
      ['Person', { url: 'https://a.example/' }, 'Missing name'],
    ];
    for (const [type, props, detail] of cases) {
      const result = fails('schema-required-missing', withJsonLd(node(type, props)));
      expect(result.samples[0], type).toMatch(new RegExp(`${detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    }
    // Nested nodes are held to their required set too.
    expect(fails('schema-required-missing', withJsonLd(node('FAQPage', { mainEntity: [{ '@type': 'Question', name: 'Why?' }] }))).samples[0]).toBe('Question “Why?”: Missing acceptedAnswer');
    fails('schema-required-missing', withJsonLd(node('BreadcrumbList', { itemListElement: [{ '@type': 'ListItem', position: 1 }] })));
    passes('schema-required-missing', cleanSnapshot());
    // An alternative is enough; a ListItem's name may come from its item; a property may come from another node with the same @id.
    passes('schema-required-missing', withJsonLd(node('Product', { name: 'P', aggregateRating: { '@type': 'AggregateRating', ratingValue: 4 } })));
    passes('schema-required-missing', withJsonLd(node('BreadcrumbList', { itemListElement: [{ '@type': 'ListItem', position: 1, item: { '@id': 'https://a.example/', name: 'Home' } }] })));
    passes('schema-required-missing', withJsonLd(node('BreadcrumbList', { itemListElement: [{ '@type': 'ListItem', position: 1, item: { '@id': '#home' } }] }), node('WebPage', { '@id': '#home', name: 'Home' })));
    passes('schema-required-missing', withJsonLd({ '@context': CTX, '@graph': [{ '@type': 'Organization', '@id': '#o' }, { '@id': '#o', name: 'Acme' }] }));
    // Blank text is not a value.
    fails('schema-required-missing', withJsonLd(node('Person', { name: '  ' })));
  });

  test('schema-recommended-missing', () => {
    expect(fails('schema-recommended-missing', withJsonLd(node('Organization', { name: 'Acme' }))).samples[0]).toBe('Organization “Acme”: Could add url; logo; sameAs');
    expect(fails('schema-recommended-missing', product({ sku: undefined, image: undefined })).samples[0]).toBe('Product “Trail shoe”: Could add image; sku, gtin, gtin8, gtin12, gtin13, gtin14 or mpn');
    passes('schema-recommended-missing', cleanSnapshot());
    // Nested nodes (the article's author) are not held to a full profile.
    passes('schema-recommended-missing', product({ brand: { '@type': 'Organization', name: 'Acme' } }));
  });

  test('schema-url-not-absolute', () => {
    expect(fails('schema-url-not-absolute', withJsonLd(node('Organization', { ...ORG, url: '/about', logo: '//cdn.example/l.png' }))).samples[0]).toBe('Organization “Acme”: url “/about”; logo “//cdn.example/l.png”');
    fails('schema-url-not-absolute', withJsonLd(node('Organization', { ...ORG, sameAs: ['https://ok.example/', 'javascript:alert(1)'] })));
    fails('schema-url-not-absolute', product({ image: 'data:image/png;base64,AAAA' }));
    fails('schema-url-not-absolute', microdata([item(['https://schema.org/Organization'], [{ name: 'name', value: 'Acme' }, { name: 'url', value: 'about.html' }])]));
    passes('schema-url-not-absolute', cleanSnapshot());
    // A node in a URL property is checked through its own properties.
    passes('schema-url-not-absolute', product({ image: { '@type': 'ImageObject', url: 'https://acme.example/shoe.png' } }));
    passes('schema-url-not-absolute', withJsonLd(node('Organization', { ...ORG, url: 'HTTPS://ACME.example/' })));
  });

  test('schema-date-invalid', () => {
    const article = (props: Record<string, unknown>) => withJsonLd(node('Article', { headline: 'H', image: 'https://a.example/i.png', author: 'A', datePublished: '2024-05-01', dateModified: '2024-05-02', ...props }));
    expect(fails('schema-date-invalid', article({ datePublished: 'May 1, 2024' })).samples[0]).toBe('Article “H”: datePublished “May 1, 2024”');
    for (const bad of ['2024-13-01', '2024-02-30', '2024-05-01 09:30', '01/05/2024', '2024-5-1', '2024-05-01T25:00']) fails('schema-date-invalid', article({ dateModified: bad }));
    fails('schema-date-invalid', withJsonLd(node('Recipe', { name: 'Soup', image: 'https://a.example/s.png', cookTime: '90 minutes' })));
    fails('schema-date-invalid', withJsonLd(node('VideoObject', { name: 'V', thumbnailUrl: 'https://a.example/t.png', uploadDate: '2024-05-01', duration: 'PT' })));
    passes('schema-date-invalid', cleanSnapshot());
    for (const good of ['2024', '2024-05', '2024-02-29', '2024-05-01T09:30', '2024-05-01T09:30:15.250Z', '2024-05-01T09:30:00+02:00', '2024-05-01T09:30-0500']) passes('schema-date-invalid', article({ dateModified: good }));
    for (const duration of ['PT1H30M', 'P1D', 'P1Y2M3DT4H5M6S', 'PT0.5S', 'P2W']) passes('schema-date-invalid', withJsonLd(node('Recipe', { name: 'Soup', image: 'https://a.example/s.png', totalTime: duration })));
  });

  test('schema-breadcrumb-positions', () => {
    expect(fails('schema-breadcrumb-positions', crumbs(1, 3, 4)).samples[0]).toBe('BreadcrumbList: Positions are 1, 3, 4, not 1 to 3');
    fails('schema-breadcrumb-positions', crumbs(1, 1, 2));
    fails('schema-breadcrumb-positions', crumbs(0, 1, 2));
    expect(fails('schema-breadcrumb-positions', crumbs(1, undefined)).samples[0]).toMatch(/Item 2 has no position/);
    expect(fails('schema-breadcrumb-positions', crumbs(1, 'two')).samples[0]).toMatch(/Item 2 has position “two”, not a whole number/);
    fails('schema-breadcrumb-positions', crumbs(1, 2.5));
    passes('schema-breadcrumb-positions', crumbs(1, 2, 3));
    passes('schema-breadcrumb-positions', crumbs(2, 1, 3));
    passes('schema-breadcrumb-positions', crumbs('1', '2'));
    passes('schema-breadcrumb-positions', cleanSnapshot());
    // Items given by reference are looked up.
    passes('schema-breadcrumb-positions', withJsonLd({ '@context': CTX, '@graph': [{ '@type': 'BreadcrumbList', itemListElement: [{ '@id': '#c1' }, { '@id': '#c2' }] }, { '@type': 'ListItem', '@id': '#c1', position: 1, name: 'A' }, { '@type': 'ListItem', '@id': '#c2', position: 2, name: 'B' }] }));
  });

  test('schema-price-invalid', () => {
    expect(fails('schema-price-invalid', product({ offers: { ...OFFER, price: '$19.99' } })).samples[0]).toBe('Product “Trail shoe”: Offer price “$19.99” is not a plain number');
    fails('schema-price-invalid', product({ offers: { ...OFFER, price: '1,299' } }));
    expect(fails('schema-price-invalid', product({ offers: { '@type': 'Offer', priceCurrency: 'USD' } })).samples[0]).toMatch(/Offer has no price$/);
    expect(fails('schema-price-invalid', product({ offers: { '@type': 'Offer', price: 5 } })).samples[0]).toMatch(/Offer has no priceCurrency$/);
    fails('schema-price-invalid', product({ offers: { ...OFFER, priceCurrency: 'dollars' } }));
    fails('schema-price-invalid', product({ offers: [OFFER, { '@type': 'Offer', price: 'free', priceCurrency: 'USD' }] }));
    passes('schema-price-invalid', product());
    passes('schema-price-invalid', product({ offers: { ...OFFER, price: 1299 } }));
    passes('schema-price-invalid', product({ offers: { '@type': 'Offer', priceSpecification: { '@type': 'UnitPriceSpecification', price: '4.50', priceCurrency: 'GBP' } } }));
    passes('schema-price-invalid', product({ offers: { '@type': 'AggregateOffer', lowPrice: '10', highPrice: '20', priceCurrency: 'EUR' } }));
    passes('schema-price-invalid', withJsonLd({ '@context': CTX, '@graph': [{ '@type': 'Product', ...PRODUCT, offers: { '@id': '#offer' } }, { ...OFFER, '@id': '#offer' }] }));
    passes('schema-price-invalid', cleanSnapshot());
  });

  test('schema-entity-conflict', () => {
    expect(fails('schema-entity-conflict', withJsonLd(node('Organization', ORG), node('Organization', { ...ORG, name: 'Acme Inc' }))).samples[0]).toBe('Organization “Acme Inc”: Its name “Acme Inc” differs from another Organization’s “Acme”');
    fails('schema-entity-conflict', withJsonLd(node('WebSite', { name: 'S', url: 'https://a.example/' }), node('WebSite', { name: 'S', url: 'https://b.example/' })));
    passes('schema-entity-conflict', cleanSnapshot());
    passes('schema-entity-conflict', withJsonLd(node('Organization', ORG), node('Organization', { ...ORG, url: 'https://ACME.example' })));
    passes('schema-entity-conflict', withJsonLd(node('Organization', { ...ORG, '@id': '#o' }), node('Organization', { '@id': '#o', name: 'Other' })));
    passes('schema-entity-conflict', withJsonLd(node('Organization', ORG), node('Organization', { logo: 'https://acme.example/l2.png' })));
  });

  test('schema-issues-belong-to-nodes', () => {
    const snapshot = withJsonLd(node('Product', { name: 'P', offers: { '@type': 'Offer', price: '$1' } }), '{oops}');
    const report = analyseSchema(snapshot);
    expect(report.issues.length).toBeGreaterThan(0);
    for (const issue of report.issues) {
      expect(issue.entity !== null || issue.block !== null, issue.ruleId).toBe(true);
      if (issue.entity !== null) expect(report.entities.some((e) => e.key === issue.entity) || report.entityCount > report.entities.length).toBe(true);
    }
    expect(report.issues.find((issue) => issue.ruleId === 'schema-json-invalid')).toMatchObject({ entity: null, block: 1 });
    expect(report.issues.find((issue) => issue.ruleId === 'schema-price-invalid')).toMatchObject({ entity: report.entities[0]!.key, block: 0, severity: 'warning' });
    // A finding counts its rule's issues; the analysis is shared (memoised) between rules.
    expect(fails('schema-recommended-missing', snapshot).count).toBe(report.issues.filter((issue) => issue.ruleId === 'schema-recommended-missing').length);
    expect(analyseSchema(snapshot)).toBe(report);
  });
});
