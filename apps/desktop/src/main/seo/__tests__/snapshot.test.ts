// Spec: specs/seo-snapshot.spec.ts (PageSnapshotSchema), specs/seo-limits.spec.ts (SNAPSHOT_LIMITS)
// Acceptance: specs/seo-sidebar.feature.md (Snapshot schema)
import { describe, expect, test } from 'vitest';
import { PageSnapshotSchema, SNAPSHOT_LIMITS as L, type PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import { parseSnapshot } from '../snapshot';

const URL_A = 'https://example.com/a';
const ok = (s: unknown) => PageSnapshotSchema.safeParse(s).success;
const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const link = (i: number) => ({ href: `https://example.com/${i}`, scheme: 'https:', rel: '', text: 'x', kind: 'internal' as const });
const image = (i: number) => ({ src: `https://example.com/${i}.png`, alt: null, width: null, height: null, loading: null });
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
    ];
    for (const [name, make, cap] of cases) {
      expect(ok(rawSnapshot(URL_A, make(cap))), `${name} at cap`).toBe(true);
      expect(ok(rawSnapshot(URL_A, make(cap + 1))), `${name} over cap`).toBe(false);
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
});
