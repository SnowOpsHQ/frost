/**
 * The capture snapshot and its diff as Zod schemas (Phase 6 Task 2; acceptance
 * `changes-diff.feature.md`). Main parses a snapshot built from the page with `CaptureSnapshotSchema`
 * before storing it, and every snapshot and diff read back from the database before using it (a
 * tampered row is skipped). Strict: exactly these keys, every list and string within
 * `CAPTURE_LIMITS` / `DIFF_LIMITS`, every count a safe non-negative integer.
 *
 * Main-only (Zod): the shapes, limits and labels are `capture.spec.ts` (re-exported here), which the
 * renderer and `@app/change-intel` import instead.
 */
import { z } from 'zod';
import {
  CAPTURE_LIMITS as L,
  CAPTURE_SNAPSHOT_VERSION,
  CHANGE_KINDS,
  DIFF_FIELDS,
  DIFF_LIMITS as D,
  DIFF_REGIONS,
  PAGE_REGIONS,
  type Change,
  type CaptureSnapshot,
  type InlineSegment,
  type SnapshotDiff,
} from './capture.spec';
import { SHA256_HEX_PATTERN } from './capture-db.spec';
import { isWebUrl } from './web-url.spec';

export * from './capture.spec';

const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(SHA256_HEX_PATTERN);
const urlText = z.string().max(L.maxUrlChars);
const headText = z.string().max(L.maxHeadChars).nullable();
const region = z.enum(PAGE_REGIONS);

/** Sorted (by UTF-16 code units, as `Array.prototype.sort` does) with no repeats: one spelling per set. */
function sortedUnique(list: readonly string[]): boolean {
  return list.every((item, index) => index === 0 || list[index - 1]! < item);
}
const typeList = z.array(z.string().min(1).max(L.maxTypeChars)).max(L.maxTypes).refine(sortedUnique, { message: 'types must be sorted and unique' });

/** One region's text (`CaptureRegionText`): its blocks together stay within `maxRegionChars`. */
const RegionTextSchema = z
  .strictObject({
    words: count,
    textHash: sha256,
    blocks: z.array(z.string().min(1).max(L.maxBlockChars)).max(L.maxBlocksPerRegion),
    truncated: z.boolean(),
  })
  .refine((text) => text.blocks.reduce((sum, block) => sum + block.length, 0) <= L.maxRegionChars, { message: 'region text is over maxRegionChars', path: ['blocks'] });

/** A capture snapshot, version 1 (`CaptureSnapshot`; field by field in `changes-diff.feature.md`, The snapshot). */
export const CaptureSnapshotSchema = z.strictObject({
  version: z.literal(CAPTURE_SNAPSHOT_VERSION),
  url: urlText.refine(isWebUrl, { message: 'not an http(s) URL' }),
  takenAt: count,
  partial: z.boolean(),
  http: z.strictObject({
    status: z.int().min(100).max(999).nullable(),
    xRobotsTag: headText,
    indexable: z.boolean(),
  }),
  head: z.strictObject({
    title: headText,
    metaDescription: headText,
    canonical: urlText.nullable(),
    robotsMeta: headText,
    lang: headText,
    viewport: headText,
    ogTitle: headText,
    ogDescription: headText,
    ogImage: urlText.nullable(),
    hreflang: z.array(z.strictObject({ hreflang: z.string().max(L.maxHeadChars), href: urlText })).max(L.maxHreflang),
  }),
  audit: z.strictObject({
    score: z.int().min(0).max(100),
    findings: z.array(z.string().min(1).max(L.maxTypeChars)).max(L.maxFindings).refine(sortedUnique, { message: 'findings must be sorted and unique' }),
  }),
  structuredData: z.strictObject({
    types: typeList,
    blocks: z.array(z.strictObject({ types: typeList, hash: sha256, text: z.string().max(L.maxJsonLdBlockChars) })).max(L.maxJsonLdBlocks),
  }),
  headings: z.array(z.strictObject({ level: z.int().min(1).max(6), text: z.string().max(L.maxHeadingChars), region })).max(L.maxHeadings),
  links: z.strictObject({
    total: count,
    internal: count,
    external: count,
    nofollow: count,
    list: z.array(z.strictObject({ href: urlText, text: z.string().max(L.maxAnchorChars), rel: z.string().max(L.maxAnchorChars), region })).max(L.maxLinks),
  }),
  images: z.strictObject({ total: count, missingAlt: count }),
  regions: z.strictObject(Object.fromEntries(PAGE_REGIONS.map((name) => [name, RegionTextSchema])) as Record<(typeof PAGE_REGIONS)[number], typeof RegionTextSchema>),
}) satisfies z.ZodType<CaptureSnapshot>;

/** A piece of an inline diff (`InlineSegment`); never empty. */
export const InlineSegmentSchema = z.strictObject({
  op: z.enum(['same', 'del', 'ins']),
  text: z.string().min(1).max(D.maxChangeTextChars),
}) satisfies z.ZodType<InlineSegment>;

const changeText = z.string().max(D.maxChangeTextChars).nullable();

/**
 * One change (`Change`): `added` has no `before`, `removed` no `after`, `changed` both. `context` is
 * at most a URL long (a link's `href` is its context; text context is cut to `contextChars`).
 */
export const ChangeSchema = z
  .strictObject({
    region: z.enum(DIFF_REGIONS),
    field: z.enum(DIFF_FIELDS),
    kind: z.enum(CHANGE_KINDS),
    before: changeText,
    after: changeText,
    context: z.string().max(L.maxUrlChars).nullable(),
    segments: z.array(InlineSegmentSchema).min(1).max(2 * D.maxInlineWords).optional(),
  })
  .refine((change) => (change.kind === 'added' ? change.before === null && change.after !== null : change.kind === 'removed' ? change.after === null && change.before !== null : change.before !== null && change.after !== null), {
    message: 'before/after do not match the kind',
  }) satisfies z.ZodType<Change>;

const CountsSchema = z.strictObject({ added: count, removed: count, changed: count });

/**
 * A diff (`SnapshotDiff`). Its numbers agree: the summary adds up to `changeCount`, `changes` holds
 * at most `maxChanges` of them, and `truncated` says exactly whether it holds fewer than all.
 */
export const SnapshotDiffSchema = z
  .strictObject({
    engine: z.int().positive(),
    changes: z.array(ChangeSchema).max(D.maxChanges),
    summary: z.strictObject(Object.fromEntries(DIFF_REGIONS.map((name) => [name, CountsSchema])) as Record<(typeof DIFF_REGIONS)[number], typeof CountsSchema>),
    changeCount: count,
    truncated: z.boolean(),
  })
  .refine((diff) => Object.values(diff.summary).reduce((sum, c) => sum + c.added + c.removed + c.changed, 0) === diff.changeCount, { message: 'summary does not add up to changeCount' })
  .refine((diff) => diff.changes.length <= diff.changeCount && diff.truncated === diff.changes.length < diff.changeCount, { message: 'truncated does not match the changes kept' }) satisfies z.ZodType<SnapshotDiff>;
