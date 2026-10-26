// Spec: specs/schema-types.spec.ts (SCHEMA_PARSE_LIMITS, SCHEMA_DROPPED_KEYS), specs/seo-snapshot.spec.ts (JsonLdBlockSchema, MarkupItemSchema)
// Acceptance: specs/seo-schema.feature.md (Parsing)
import { describe, expect, test } from 'vitest';
import { SCHEMA_PARSE_LIMITS } from '@app/specs/schema-types.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { analyseSchema, formatJson, locateJsonError, parseJson, type SchemaEntity, type SchemaValue } from '../index';
import { item, jsonLd, page, withJsonLd } from './fixtures';

/** Every entity in the report's tree (nested ones too), in order. */
function allEntities(entities: readonly SchemaEntity[]): SchemaEntity[] {
  const out: SchemaEntity[] = [];
  const walk = (entity: SchemaEntity) => {
    out.push(entity);
    for (const property of entity.properties) for (const value of property.values) if (value.kind === 'entity') walk(value.entity);
  };
  entities.forEach(walk);
  return out;
}

const values = (entity: SchemaEntity, name: string): readonly SchemaValue[] => entity.properties.find((p) => p.name === name)?.values ?? [];
const texts = (entity: SchemaEntity, name: string): string[] => values(entity, name).flatMap((v) => (v.kind === 'text' ? [v.text] : []));

describe('JSON parsing', () => {
  test('json-error-location', () => {
    const at = (text: string) => {
      const parsed = parseJson(text);
      expect(parsed.ok, text).toBe(false);
      return parsed.ok ? null : parsed.error;
    };
    // A trailing comma: reported at the comma.
    expect(at('{\n  "a": 1,\n}')).toMatchObject({ offset: 10, line: 2, column: 9 });
    expect(at('{\n  "a": 1,\n}')!.message).toMatch(/Trailing comma/);
    expect(at('[1, 2,]')).toMatchObject({ offset: 5, line: 1, column: 6 });
    // A missing comma between properties: at the next name.
    const missing = at('{\n  "@type": "Product"\n  "name": "Shoe"\n}')!;
    expect(missing).toMatchObject({ line: 3, column: 3 });
    expect(missing.message).toBe('Expected "," or "}", found """');
    // An unterminated string: at its opening quote.
    expect(at('{"name": "Shoe}')).toMatchObject({ offset: 9, line: 1, column: 10 });
    // A raw newline inside a string.
    expect(at('{"a": "x\ny"}')).toMatchObject({ offset: 8, line: 1, column: 9 });
    // Bad tokens: a single-quoted string, a bare word, an unquoted name.
    expect(at("{'a': 1}")).toMatchObject({ offset: 1 });
    expect(at('{"a": undefined}')).toMatchObject({ offset: 6 });
    expect(at('{a: 1}')!.message).toMatch(/property name in double quotes/);
    // Empty and truncated blocks; text after the value.
    expect(at('   ')).toMatchObject({ offset: 3, line: 1, column: 4 });
    expect(at('   ')!.message).toMatch(/empty/);
    expect(at('{"a": [1, 2')!.message).toMatch(/ends/);
    expect(at('{} {}')).toMatchObject({ offset: 3 });
    // CRLF line ends count once.
    expect(at('{\r\n"a": 1,\r\n}')).toMatchObject({ line: 2 });
    // Valid JSON: no error, and the scanner agrees.
    for (const valid of ['{}', '[]', '{"a": [1, -2.5e3, true, false, null, "x\\u00e9\\n"]}', ' "s" ', '0']) {
      expect(parseJson(valid).ok, valid).toBe(true);
      expect(locateJsonError(valid), valid).toBeNull();
    }
  });

  test('json-ld-malformed-is-reported', () => {
    const report = analyseSchema(page({ jsonLd: [jsonLd('{"@context": "https://schema.org", "@type": "Product" "name": "x"}'), jsonLd({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Fine' })], jsonLdTotal: 2 }));
    expect(report.blocks[0]).toMatchObject({ status: 'invalid', entities: [] });
    expect(report.blocks[0]!.error).toMatchObject({ offset: 54, line: 1, column: 55 });
    expect(report.blocks[1]).toMatchObject({ status: 'valid', error: null });
    expect(report.entities.map((e) => e.types)).toEqual([['Organization']]);
  });

  test('json-ld-huge-nesting-is-bounded', () => {
    const depth = 10_000;
    const arrays = `{"@context":"https://schema.org","@type":"Thing","a":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    const objects = `{"@context":"https://schema.org","@type":"Thing","a":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}`;
    for (const text of [arrays, objects]) {
      const report = analyseSchema(page({ jsonLd: [jsonLd(text)], jsonLdTotal: 1 }));
      expect(report.blocks[0]!.status).toBe('valid');
      expect(report.blocks[0]!.overLimit).toBe(true);
      expect(report.issues.some((issue) => issue.ruleId === 'schema-over-limit')).toBe(true);
    }
    // A root of bare nested arrays holds no node: nothing to read, and no stack overflow either.
    expect(analyseSchema(page({ jsonLd: [jsonLd(`${'['.repeat(depth)}${']'.repeat(depth)}`)], jsonLdTotal: 1 })).entities).toEqual([]);
    // The object chain is read to the depth cap only.
    const report = analyseSchema(page({ jsonLd: [jsonLd(objects)], jsonLdTotal: 1 }));
    expect(allEntities(report.entities).length).toBeLessThanOrEqual(SCHEMA_PARSE_LIMITS.maxDepth + 1);
  });

  test('json-ld-proto-keys-are-dropped', () => {
    const payload =
      '{"@context":"https://schema.org","@type":"Product","name":"P","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},' +
      '"offers":{"@type":"Offer","price":"1","priceCurrency":"EUR","__proto__":{"polluted":"yes"}},"brand":{"@value":"B","__proto__":{"x":1}},"prototype":1}';
    const report = analyseSchema(page({ jsonLd: [jsonLd(payload)], jsonLdTotal: 1 }));
    expect(report.blocks[0]).toMatchObject({ status: 'valid', droppedKeys: 5 });
    const names = allEntities(report.entities).flatMap((entity) => entity.properties.map((p) => p.name));
    for (const bad of ['__proto__', 'constructor', 'prototype', 'polluted']) expect(names).not.toContain(bad);
    expect(texts(report.entities[0]!, 'brand')).toEqual(['B']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    // The report itself holds no object built from page keys.
    for (const entity of allEntities(report.entities)) expect(Object.getPrototypeOf(entity)).toBe(Object.prototype);
  });

  test('json-ld-graph-and-arrays', () => {
    const report = analyseSchema(
      page({
        jsonLd: [
          jsonLd({
            '@context': 'https://schema.org',
            '@graph': [
              { '@type': ['Organization', 'schema:Corporation'], name: 'A', address: { streetAddress: '1 Road' } },
              { '@type': 'https://schema.org/WebSite', 'http://schema.org/name': 'Site', 'schema:url': 'https://a.example/' },
            ],
          }),
          jsonLd([
            { '@context': 'https://schema.org', '@type': 'Person', name: 'P', knowsAbout: { '@list': ['x', 'y'] }, jobTitle: { '@value': 'Chef', '@language': 'en' } },
            { '@context': 'https://schema.org', '@type': 'Thing', name: 'T' },
            'not a node',
          ]),
          // A top-level array of @graph containers keeps each graph (with its own context).
          jsonLd([
            { '@context': 'https://schema.org', '@graph': [{ '@type': 'Brand', name: 'B1' }, { '@type': 'Brand', name: 'B2' }] },
            { '@context': 'https://schema.org', '@graph': { '@type': 'Place', name: 'P1' } },
          ]),
        ],
        jsonLdTotal: 3,
      }),
    );
    expect(report.entities.map((e) => e.types)).toEqual([['Organization', 'Corporation'], ['WebSite'], ['Person'], ['Thing'], ['Brand'], ['Brand'], ['Place']]);
    expect(report.issues.filter((issue) => issue.block === 2 && /context|type-missing/.test(issue.ruleId))).toEqual([]);
    expect(report.entities.every((e) => e.topLevel && e.syntax === 'json-ld')).toBe(true);
    expect(report.blocks.map((b) => b.entities.length)).toEqual([2, 2, 3]);
    expect(report.entities[0]!.block).toBe(0);
    expect(report.entities[2]!.block).toBe(1);
    // Nested objects are untyped nested entities.
    const address = values(report.entities[0]!, 'address')[0]!;
    expect(address.kind === 'entity' && address.entity.topLevel === false && address.entity.types.length === 0).toBe(true);
    expect(texts(report.entities[1]!, 'name')).toEqual(['Site']);
    expect(texts(report.entities[1]!, 'url')).toEqual(['https://a.example/']);
    expect(texts(report.entities[2]!, 'knowsAbout')).toEqual(['x', 'y']);
    expect(texts(report.entities[2]!, 'jobTitle')).toEqual(['Chef']);
    expect(report.entityCount).toBe(8);
  });

  test('json-ld-cyclic-ids-terminate', () => {
    const report = analyseSchema(
      withJsonLd({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'Person', '@id': '#a', name: 'A', knows: { '@id': '#b' }, sameAs: { '@id': '#a' } },
          { '@type': 'Person', '@id': '#b', name: 'B', knows: { '@id': '#a' }, colleague: { '@id': '#nobody' } },
        ],
      }),
    );
    const [a, b] = report.entities;
    expect(values(a!, 'knows')).toEqual([{ kind: 'ref', id: '#b', target: b!.key }]);
    expect(values(a!, 'sameAs')).toEqual([{ kind: 'ref', id: '#a', target: a!.key }]);
    expect(values(b!, 'knows')).toEqual([{ kind: 'ref', id: '#a', target: a!.key }]);
    expect(values(b!, 'colleague')).toEqual([{ kind: 'ref', id: '#nobody', target: null }]);
    expect(report.entityCount).toBe(2);
  });

  test('json-ld-node-limit', () => {
    const many = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: Array.from({ length: SCHEMA_PARSE_LIMITS.maxNodes + 50 }, (_, i) => i) };
    const report = analyseSchema(withJsonLd(many));
    expect(report.blocks[0]!.overLimit).toBe(true);
    expect(values(report.entities[0]!, 'itemListElement').length).toBeLessThan(SCHEMA_PARSE_LIMITS.maxNodes);
    expect(report.issues.find((issue) => issue.ruleId === 'schema-over-limit')!.detail).toMatch(/more than 5,000 values/);
  });

  test('shared-id-graph-is-linear', () => {
    const node = { '@id': 'a', '@type': 'ListItem', position: 1, item: { '@id': 'a' } };
    const text = JSON.stringify({ '@context': 'https://schema.org', '@graph': Array.from({ length: 1_000 }, () => node) });
    expect(text.length).toBeLessThan(SNAPSHOT_LIMITS.maxJsonLdChars);
    const snapshot = page({ jsonLd: [jsonLd(text)], jsonLdTotal: 1 });
    const started = performance.now();
    const report = analyseSchema(snapshot);
    expect(performance.now() - started).toBeLessThan(100);
    expect(report.entityCount).toBe(1_000);
    expect(report.partial).toBe(false);
    // The group is checked once: its issues sit on its first node.
    const keys = new Set(report.issues.filter((issue) => issue.entity !== null).map((issue) => issue.entity));
    expect(keys.size).toBeLessThanOrEqual(1);
  });

  test('schema-work-budget', () => {
    const many = withJsonLd({ '@context': 'https://schema.org', '@graph': Array.from({ length: 40 }, (_, i) => ({ '@type': 'Organization', name: `O${i}`, url: `https://o${i}.example/` })) });
    const full = analyseSchema(many);
    expect(full.partial).toBe(false);
    const cut = analyseSchema(many, { ...SCHEMA_PARSE_LIMITS, maxWork: 50 });
    expect(cut.partial).toBe(true);
    const issue = cut.issues.find((i) => i.ruleId === 'schema-over-limit')!;
    expect(issue.detail).toMatch(/Checked in part/);
    expect(issue.entity).not.toBeNull();
    // The default analysis is memoised; one with other limits is not.
    expect(analyseSchema(many)).toBe(full);
  });

  test('markup-values-count-against-nodes', () => {
    const props = Array.from({ length: SNAPSHOT_LIMITS.maxItemProperties }, (_, i) => ({ name: `p${i}`, value: 'v' }));
    const items = Array.from({ length: Math.ceil(SCHEMA_PARSE_LIMITS.maxNodes / props.length) + 5 }, () => item(['https://schema.org/Thing'], props));
    const report = analyseSchema(page({ jsonLd: [], jsonLdTotal: 0, microdata: items, microdataTotal: items.length }));
    const values = allEntities(report.entities).reduce((sum, e) => sum + e.properties.reduce((n, p) => n + p.values.length, 0), 0);
    expect(values).toBeLessThanOrEqual(SCHEMA_PARSE_LIMITS.maxNodes);
    expect(report.issues.some((issue) => issue.ruleId === 'schema-over-limit' && /values on the page/.test(issue.detail))).toBe(true);
    // Markup cut by the page's node budget (JSON-LD used it up) is reported too, on the last node read.
    const crowded = analyseSchema(withJsonLd({ '@context': 'https://schema.org', '@type': 'Thing', name: 'T' }, { '@context': 'https://schema.org', '@type': 'Thing', name: 'U' }), { ...SCHEMA_PARSE_LIMITS, maxEntities: 2 });
    expect(crowded.issues.some((issue) => issue.ruleId === 'schema-over-limit')).toBe(false);
    const cut = analyseSchema(page({ microdata: [item(['https://schema.org/Thing'], [])], microdataTotal: 1, jsonLd: [jsonLd({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Thing' }, { '@type': 'Thing' }] })], jsonLdTotal: 1 }), { ...SCHEMA_PARSE_LIMITS, maxEntities: 2 });
    expect(cut.entities.filter((e) => e.syntax === 'microdata')).toEqual([]);
    expect(cut.issues.find((issue) => issue.ruleId === 'schema-over-limit')).toMatchObject({ detail: 'Read in part: more than 2 nodes on the page' });
  });

  test('markup-normalises-to-entities', () => {
    const report = analyseSchema(
      page({
        jsonLd: [],
        jsonLdTotal: 0,
        microdata: [
          item(['https://schema.org/Product'], [{ name: 'name', value: 'Shoe' }, { name: 'offers', item: 1 }, { name: 'https://schema.org/color', value: 'Red' }], { id: 'https://shop.example/p/1' }),
          item(['http://schema.org/Offer'], [{ name: 'price', value: '10' }, { name: 'price', value: '12' }]),
        ],
        microdataTotal: 2,
        rdfa: [item(['Recipe'], [{ name: 'schema:name', value: 'Soup' }, { name: 'author', item: 1 }], { vocab: 'https://schema.org/' }), item(['Person'], [{ name: 'name', value: 'Cook' }], { vocab: 'https://schema.org/' })],
        rdfaTotal: 2,
      }),
    );
    expect(report.entities.map((e) => [e.syntax, e.types, e.block])).toEqual([
      ['microdata', ['Product'], null],
      ['rdfa', ['Recipe'], null],
    ]);
    const product = report.entities[0]!;
    expect(product.id).toBe('https://shop.example/p/1');
    expect(texts(product, 'color')).toEqual(['Red']);
    const offer = values(product, 'offers')[0]!;
    expect(offer.kind === 'entity' && offer.entity.types[0] === 'Offer' && !offer.entity.topLevel).toBe(true);
    if (offer.kind === 'entity') expect(texts(offer.entity, 'price')).toEqual(['10', '12']);
    expect(texts(report.entities[1]!, 'name')).toEqual(['Soup']);
    expect(report.entityCount).toBe(4);
    expect(report.markup).toEqual({ microdata: { read: 2, total: 2 }, rdfa: { read: 2, total: 2 } });
  });

  test('format-json-is-bounded', () => {
    expect(formatJson('{"a":[1,{"b":"x, y: {z}"}],"c":{},"d":[ ]}').text).toBe('{\n  "a": [\n    1,\n    {\n      "b": "x, y: {z}"\n    }\n  ],\n  "c": {},\n  "d": []\n}');
    expect(formatJson('"a\\"b"').text).toBe('"a\\"b"');
    // Indentation stops growing at maxPrettyIndent levels.
    const deep = formatJson(`${'['.repeat(40)}1${']'.repeat(40)}`).text;
    const widest = Math.max(...deep.split('\n').map((line) => line.length - line.trimStart().length));
    expect(widest).toBe(2 * SCHEMA_PARSE_LIMITS.maxPrettyIndent);
    // And the output stops at maxChars.
    const long = formatJson(`[${Array.from({ length: 1000 }, () => 1).join(',')}]`, 100);
    expect(long.cut).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(100);
    expect(formatJson('[1]').cut).toBe(false);
  });
});
