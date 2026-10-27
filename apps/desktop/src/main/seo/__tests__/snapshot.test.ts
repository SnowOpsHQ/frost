// Spec: specs/seo-snapshot.spec.ts (PageSnapshotSchema), specs/seo-limits.spec.ts (SNAPSHOT_LIMITS)
// Acceptance: specs/seo-sidebar.feature.md (Snapshot schema)
import { describe, expect, test } from 'vitest';
import { PageSnapshotSchema, SNAPSHOT_LIMITS as L, type PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import { parseSnapshot } from '../snapshot';

const URL_A = 'https://example.com/a';
const ok = (s: unknown) => PageSnapshotSchema.safeParse(s).success;
const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const link = (i: number) => ({ href: `https://example.com/${i}`, scheme: 'https:', rel: '', text: 'x', kind: 'internal' as const, target: null });
const image = (i: number) => ({ src: `https://example.com/${i}.png`, alt: null, width: null, height: null, loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false });
const social = (changes: Partial<PageSnapshot['social']>) => ({ social: { ...rawSnapshot(URL_A).social, ...changes } });
const capped = (text: string) => ({ text, length: text.length });

describe('snapshot schema', () => {
  test('snapshot-schema-accepts-valid', () => {
    const snapshot = rawSnapshot(URL_A);
    expect(PageSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(parseSnapshot(snapshot)).toEqual({ ok: true, snapshot });
  });

  test('snapshot-caps-lists', () => {
    const lists: [keyof PageSnapshot, keyof PageSnapshot, number, (i: number) => unknown][] = [
      ['titles', 'titleTotal', L.maxRepeated, () => capped('t')],
      ['metaDescriptions', 'metaDescriptionTotal', L.maxRepeated, () => capped('d')],
      ['canonicals', 'canonicalTotal', L.maxRepeated, () => ({ href: URL_A, resolved: URL_A })],
      ['headings', 'headingTotal', L.maxHeadings, () => ({ level: 2, text: 'h' })],
      ['links', 'linkTotal', L.maxLinks, link],
      ['images', 'imageTotal', L.maxImages, image],
    ];
    for (const [list, total, cap, make] of lists) {
      expect(ok(rawSnapshot(URL_A, { [list]: many(cap, make), [total]: 100_000 })), `${list} at cap`).toBe(true);
      expect(ok(rawSnapshot(URL_A, { [list]: many(cap + 1, make), [total]: 100_000 })), `${list} over cap`).toBe(false);
    }
    const noindex = { name: 'googlebot' as const, content: 'noindex' };
    expect(ok(rawSnapshot(URL_A, { metaRobots: many(L.maxRepeated, () => noindex) }))).toBe(true);
    expect(ok(rawSnapshot(URL_A, { metaRobots: many(L.maxRepeated + 1, () => noindex) }))).toBe(false);
  });

  test('snapshot-caps-strings', () => {
    const x = (n: number) => 'x'.repeat(n);
    const url = (n: number) => `https://example.com/${x(n - 'https://example.com/'.length)}`;
    const cases: [string, (n: number) => Partial<PageSnapshot>, number][] = [
      ['url', (n) => ({ url: url(n) }), L.maxUrlChars],
      ['title', (n) => ({ titles: [capped(x(n))] }), L.maxTextChars],
      ['description', (n) => ({ metaDescriptions: [capped(x(n))] }), L.maxTextChars],
      ['robots', (n) => ({ metaRobots: [{ name: 'robots', content: x(n) }] }), L.maxAttributeChars],
      ['viewport', (n) => ({ viewport: x(n) }), L.maxAttributeChars],
      ['lang', (n) => ({ lang: x(n) }), L.maxLangChars],
      ['og:url', (n) => ({ ogUrl: url(n) }), L.maxUrlChars],
      ['canonical', (n) => ({ canonicals: [{ href: url(n), resolved: url(n) }] }), L.maxUrlChars],
      ['heading', (n) => ({ headings: [{ level: 1, text: x(n) }] }), L.maxHeadingChars],
      ['anchor', (n) => ({ links: [{ ...link(0), text: x(n) }] }), L.maxAnchorChars],
      ['link href', (n) => ({ links: [{ ...link(0), href: url(n) }] }), L.maxUrlChars],
      ['rel', (n) => ({ links: [{ ...link(0), rel: x(n) }] }), L.maxAttributeChars],
      ['alt', (n) => ({ images: [{ ...image(0), alt: capped(x(n)) }] }), L.maxAltChars],
      ['img src', (n) => ({ images: [{ ...image(0), src: url(n) }] }), L.maxUrlChars],
      ['img width', (n) => ({ images: [{ ...image(0), width: x(n) }] }), L.maxImageAttributeChars],
      ['link target', (n) => ({ links: [{ ...link(0), target: x(n) }] }), L.maxTargetChars],
      ['og:title', (n) => social({ 'og:title': x(n) }), L.maxSocialChars],
      ['twitter:site', (n) => social({ 'twitter:site': x(n) }), L.maxSocialChars],
      ['og:image', (n) => social({ 'og:image': url(n) }), L.maxUrlChars],
      ['twitter:image', (n) => social({ 'twitter:image': url(n) }), L.maxUrlChars],
    ];
    for (const [name, make, cap] of cases) {
      expect(ok(rawSnapshot(URL_A, make(cap))), `${name} at cap`).toBe(true);
      expect(ok(rawSnapshot(URL_A, make(cap + 1))), `${name} over cap`).toBe(false);
    }
    // Image sizes are integers up to maxImagePixels.
    for (const key of ['rendered', 'natural'] as const) {
      expect(ok(rawSnapshot(URL_A, { images: [{ ...image(0), [key]: { width: L.maxImagePixels, height: 0 } }] })), `${key} at cap`).toBe(true);
      expect(ok(rawSnapshot(URL_A, { images: [{ ...image(0), [key]: { width: L.maxImagePixels + 1, height: 1 } }] })), `${key} over cap`).toBe(false);
    }
    // A capped text may report a longer full length (a 10 MB title), never a shorter one.
    expect(ok(rawSnapshot(URL_A, { titles: [{ text: 'abc', length: 10_485_760 }] }))).toBe(true);
    expect(ok(rawSnapshot(URL_A, { titles: [{ text: 'abc', length: 2 }] }))).toBe(false);
  });

  test('snapshot-is-strict', () => {
    const bad: unknown[] = [
      rawSnapshot('ftp://example.com/a'),
      rawSnapshot('javascript:alert(1)'),
      rawSnapshot(URL_A, { metaRobots: [{ name: 'otherbot' as never, content: 'noindex' }] }),
      rawSnapshot(URL_A, { metaRobots: ['noindex' as never] }),
      rawSnapshot(URL_A, { partial: 'yes' as never }),
      { ...rawSnapshot(URL_A), extra: 1 },
      (() => {
        const { lang: _lang, ...rest } = rawSnapshot(URL_A);
        return rest;
      })(),
      rawSnapshot(URL_A, { titles: [{ text: 't', length: 1, html: '<b>' } as never] }),
      rawSnapshot(URL_A, { links: [{ ...link(0), onclick: 'x' } as never] }),
      rawSnapshot(URL_A, { wordCount: -1 }),
      rawSnapshot(URL_A, { wordCount: 1.5 }),
      rawSnapshot(URL_A, { wordCount: Number.POSITIVE_INFINITY }),
      rawSnapshot(URL_A, { wordCount: L.maxCount + 1 }),
      rawSnapshot(URL_A, { durationMs: Number.NaN }),
      rawSnapshot(URL_A, { headings: [{ level: 7, text: 'h' }] }),
      rawSnapshot(URL_A, { headings: [{ level: 0, text: 'h' }] }),
      rawSnapshot(URL_A, { links: [{ ...link(0), kind: 'sideways' as never }] }),
      rawSnapshot(URL_A, { lang: 5 as never }),
      rawSnapshot(URL_A, { url: '' }),
      rawSnapshot(URL_A, { links: [link(0), link(1)], linkTotal: 1 }),
      rawSnapshot(URL_A, { titles: [capped('a'), capped('b')], titleTotal: 1 }),
      rawSnapshot(URL_A, { textTruncated: 'no' as never }),
      rawSnapshot(URL_A, { images: [{ ...image(0), rendered: { width: 1.5, height: 2 } }] }),
      rawSnapshot(URL_A, { images: [{ ...image(0), natural: { width: -1, height: 2 } }] }),
      rawSnapshot(URL_A, { images: [{ ...image(0), natural: { width: 1, height: 2, depth: 3 } as never }] }),
      rawSnapshot(URL_A, { images: [{ ...image(0), inFirstViewport: 1 as never }] }),
      rawSnapshot(URL_A, { images: [{ ...image(0), cssSized: 'yes' as never }] }),
      rawSnapshot(URL_A, { links: [{ ...link(0), target: 5 as never }] }),
      rawSnapshot(URL_A, social({ 'og:audio': 'x' } as never)),
      rawSnapshot(URL_A, social({ 'og:title': 1 as never })),
      (() => {
        const { 'og:type': _type, ...rest } = rawSnapshot(URL_A).social;
        return rawSnapshot(URL_A, { social: rest as never });
      })(),
    ];
    for (const value of bad) expect(ok(value), JSON.stringify(value).slice(0, 120)).toBe(false);
  });

  test('parse-snapshot-never-throws', () => {
    const cyclic: Record<string, unknown> = { ...rawSnapshot(URL_A) };
    cyclic['self'] = cyclic;
    const throwing = Object.defineProperty({ ...rawSnapshot(URL_A) }, 'url', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    for (const value of [undefined, null, 'snapshot', 42, [], [rawSnapshot(URL_A)], cyclic, throwing]) {
      expect(parseSnapshot(value)).toEqual({ ok: false, reason: 'invalid-snapshot' });
    }
  });

  test('snapshot-validates-structured-data', () => {
    const block = (text: string, length = text.length) => ({ text, length });
    const item = (properties: PageSnapshot['microdata'][number]['properties'] = []) => ({ types: ['https://schema.org/Thing'], id: null, vocab: null, properties });
    const markup = (key: 'microdata' | 'rdfa', items: unknown[]) => rawSnapshot(URL_A, { [key]: items, [`${key}Total`]: 100_000 } as Partial<PageSnapshot>);
    // Lists at their caps parse; one over is rejected.
    expect(ok(rawSnapshot(URL_A, { jsonLd: many(L.maxJsonLdBlocks, () => block('{}')), jsonLdTotal: 1_000 }))).toBe(true);
    expect(ok(rawSnapshot(URL_A, { jsonLd: many(L.maxJsonLdBlocks + 1, () => block('{}')), jsonLdTotal: 1_000 }))).toBe(false);
    for (const key of ['microdata', 'rdfa'] as const) {
      expect(ok(markup(key, many(L.maxMarkupItems, () => item()))), `${key} at cap`).toBe(true);
      expect(ok(markup(key, many(L.maxMarkupItems + 1, () => item()))), `${key} over cap`).toBe(false);
      expect(ok(markup(key, [item(many(L.maxItemProperties, () => ({ name: 'a', value: 'b' })))]))).toBe(true);
      expect(ok(markup(key, [item(many(L.maxItemProperties + 1, () => ({ name: 'a', value: 'b' })))]))).toBe(false);
      expect(ok(markup(key, [{ ...item(), types: many(L.maxItemTypes + 1, () => 'T') }]))).toBe(false);
    }
    // Strings at their caps parse; one over is rejected.
    const x = (n: number) => 'x'.repeat(n);
    const strings: [string, (n: number) => Partial<PageSnapshot>, number][] = [
      ['json-ld text', (n) => ({ jsonLd: [block(x(n))] }), L.maxJsonLdChars],
      ['property value', (n) => ({ microdata: [item([{ name: 'a', value: x(n) }])] }), L.maxSchemaValueChars],
      ['property name', (n) => ({ microdata: [item([{ name: x(n), value: 'v' }])] }), L.maxSchemaNameChars],
      ['type', (n) => ({ rdfa: [{ ...item(), types: [x(n)] }] }), L.maxSchemaNameChars],
      ['vocab', (n) => ({ rdfa: [{ ...item(), vocab: x(n) }] }), L.maxSchemaNameChars],
      ['id', (n) => ({ microdata: [{ ...item(), id: x(n) }] }), L.maxSchemaValueChars],
    ];
    for (const [name, make, cap] of strings) {
      expect(ok(rawSnapshot(URL_A, { jsonLdTotal: 1, microdataTotal: 1, rdfaTotal: 1, ...make(cap) })), `${name} at cap`).toBe(true);
      expect(ok(rawSnapshot(URL_A, { jsonLdTotal: 1, microdataTotal: 1, rdfaTotal: 1, ...make(cap + 1) })), `${name} over cap`).toBe(false);
    }
    // A cut block may report a longer length, never a shorter one; the page's JSON-LD has a total cap.
    expect(ok(rawSnapshot(URL_A, { jsonLd: [block('{', 5_000_000)] }))).toBe(true);
    expect(ok(rawSnapshot(URL_A, { jsonLd: [block('{}', 1)] }))).toBe(false);
    const full = Math.ceil(L.maxJsonLdTotalChars / L.maxJsonLdChars);
    expect(ok(rawSnapshot(URL_A, { jsonLd: many(full, () => block(x(L.maxJsonLdChars))), jsonLdTotal: full }))).toBe(true);
    expect(ok(rawSnapshot(URL_A, { jsonLd: [...many(full, () => block(x(L.maxJsonLdChars))), block('x')], jsonLdTotal: full + 1 }))).toBe(false);
    // Nested items point forward, within the list, and are held once: a forest.
    expect(ok(markup('microdata', [item([{ name: 'a', item: 1 }]), item([{ name: 'b', item: 2 }]), item()]))).toBe(true);
    for (const items of [
      [item([{ name: 'a', item: 0 }])],
      [item(), item([{ name: 'a', item: 0 }])],
      [item([{ name: 'a', item: 1 }])],
      [item([{ name: 'a', item: 1 }, { name: 'b', item: 1 }]), item()],
      [item([{ name: 'a', item: 2 }]), item([{ name: 'b', item: 2 }]), item()],
    ]) {
      expect(ok(markup('microdata', items)), JSON.stringify(items)).toBe(false);
    }
    // Strict properties: exactly one of value / item, a name, nothing else.
    for (const property of [{ name: 'a' }, { name: 'a', value: 'v', item: 1 }, { name: '', value: 'v' }, { name: 'a', value: 1 }, { name: 'a', item: -1 }, { name: 'a', item: 0.5 }, { name: 'a', value: 'v', extra: 1 }]) {
      expect(ok(markup('rdfa', [item([property as never]), item()])), JSON.stringify(property)).toBe(false);
    }
    // Markup values together stay within maxMarkupTotalChars (microdata and RDFa share it).
    const long = (n: number) => item(many(n, () => ({ name: 'a', value: x(L.maxSchemaValueChars) })));
    const per = L.maxItemProperties * L.maxSchemaValueChars;
    const half = Math.floor(L.maxMarkupTotalChars / 2 / per);
    expect(ok(rawSnapshot(URL_A, { microdata: many(half, () => long(L.maxItemProperties)), microdataTotal: half, rdfa: many(half, () => long(L.maxItemProperties)), rdfaTotal: half }))).toBe(true);
    expect(ok(rawSnapshot(URL_A, { microdata: many(half + 1, () => long(L.maxItemProperties)), microdataTotal: half + 1, rdfa: many(half, () => long(L.maxItemProperties)), rdfaTotal: half }))).toBe(false);
    // Totals are at least their lists.
    expect(ok(rawSnapshot(URL_A, { jsonLd: [block('{}')], jsonLdTotal: 0 }))).toBe(false);
    expect(ok(rawSnapshot(URL_A, { microdata: [item()], microdataTotal: 0 }))).toBe(false);
    expect(ok(rawSnapshot(URL_A, { rdfa: [item()], rdfaTotal: 0 }))).toBe(false);
  });
});
