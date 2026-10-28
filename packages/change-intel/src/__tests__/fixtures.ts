// Test fixtures: a valid capture snapshot and a diff helper that checks every diff against the schema.
import { createHash } from 'node:crypto';
import { type CaptureRegionText, type CaptureSnapshot, type SnapshotDiff } from '@app/specs/capture.spec';
import { CaptureSnapshotSchema, SnapshotDiffSchema } from '@app/specs/capture-snapshot.schema';
import { diffSnapshots, type DiffProbe } from '../index';

export const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** A region with these blocks, its word count taken from them. */
export function region(blocks: string[] = []): CaptureRegionText {
  const words = blocks.reduce((sum, block) => sum + block.split(/\s+/).filter(Boolean).length, 0);
  return { words, textHash: sha(blocks.join('\n')), blocks, truncated: false };
}

export const LONG_INTRO = 'Frost is a browser for search work: it audits each page you open and keeps what it found over time.';

/** A small, schema-valid page. */
export function base(): CaptureSnapshot {
  return {
    version: 1,
    url: 'https://example.com/pricing',
    takenAt: 1_760_000_000_000,
    partial: false,
    http: { status: 200, xRobotsTag: null, indexable: true },
    head: {
      title: 'Frost pricing',
      metaDescription: 'Plans and prices for Frost.',
      canonical: 'https://example.com/pricing',
      robotsMeta: 'index, follow',
      lang: 'en',
      viewport: 'width=device-width, initial-scale=1',
      ogTitle: 'Pricing',
      ogDescription: null,
      ogImage: null,
      hreflang: [
        { hreflang: 'en', href: 'https://example.com/pricing' },
        { hreflang: 'de', href: 'https://example.com/de/preise' },
      ],
    },
    audit: { score: 87, findings: ['meta-description-too-short', 'title-too-short'] },
    structuredData: {
      types: ['Organization', 'Product'],
      blocks: [
        { types: ['Organization'], hash: sha('org'), text: '{"@type":"Organization","name":"Frost"}' },
        { types: ['Product'], hash: sha('product-1'), text: '{"@type":"Product","name":"Frost Pro","offers":{"price":"10"}}' },
      ],
    },
    headings: [
      { level: 1, text: 'Pricing', region: 'main' },
      { level: 2, text: 'Plans', region: 'main' },
      { level: 2, text: 'FAQ', region: 'main' },
      { level: 2, text: 'Company', region: 'footer' },
    ],
    links: {
      total: 5,
      internal: 4,
      external: 1,
      nofollow: 1,
      list: [
        { href: 'https://example.com/', text: 'Home', rel: '', region: 'nav' },
        { href: 'https://example.com/docs', text: 'Docs', rel: '', region: 'nav' },
        { href: 'https://example.com/signup', text: 'Sign up', rel: '', region: 'main' },
        { href: 'https://partner.example/', text: 'Partner', rel: 'nofollow', region: 'footer' },
      ],
    },
    images: { total: 3, missingAlt: 1 },
    regions: {
      main: region([LONG_INTRO, 'Plans start at ten dollars a month for one seat.', 'Contact us for team pricing.']),
      nav: region(['Home Docs']),
      header: region(['Frost']),
      aside: region([]),
      footer: region(['Company Partner']),
      other: region([]),
    },
  };
}

/** `base()` (or `from`) changed by `edit`. */
export function edited(edit: (s: CaptureSnapshot) => void, from: CaptureSnapshot = base()): CaptureSnapshot {
  const copy = structuredClone(from);
  edit(copy);
  return copy;
}

/** Every diff the tests make goes through here, so `SnapshotDiffSchema` checks each one. */
export let diffsChecked = 0;
export function diff(before: CaptureSnapshot | null, after: CaptureSnapshot, probe?: DiffProbe): SnapshotDiff {
  const result = diffSnapshots(before, after, probe);
  SnapshotDiffSchema.parse(result);
  diffsChecked += 1;
  return result;
}

/** Parses with the snapshot schema (fixtures must be valid unless a test says otherwise). */
export const valid = (s: CaptureSnapshot) => CaptureSnapshotSchema.parse(s);

/** A seeded pseudo-random number generator (mulberry32): the same seed, the same sequence in [0, 1). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
