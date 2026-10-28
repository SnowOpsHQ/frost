/**
 * The `changes.*` procedures' inputs and answers, the region extraction's answer, and the read API
 * Phase 5 calls (Phase 6 Task 3; acceptance `changes-capture.feature.md`). Main-only (Zod): the
 * chrome imports the plain values and types of `changes.spec.ts` (re-exported here) instead. Every
 * schema is strict: an unknown key, an over-long value or a malformed id is refused before main
 * does anything with it.
 */
import { z } from 'zod';
import { CAPTURE_LIMITS as L, DIFF_REGIONS, PAGE_REGIONS, type PageRegion } from './capture.spec';
import { MAX_HISTORY_PAGE, SHA256_HEX_PATTERN, UUIDV7_PATTERN } from './capture-db.spec';
import { CaptureSnapshotSchema, SnapshotDiffSchema } from './capture-snapshot.schema';
import { SearchParamsSchema } from './capture-search-params.schema';
import {
  CAPTURE_REFUSALS,
  type CaptureAnswer,
  type CaptureInput,
  type DiffInput,
  type DiffSummary,
  type HistoryAnswer,
  type HistoryInput,
  type PagesAnswer,
  type PagesInput,
  type RegionAnswer,
  type RegionTextAnswer,
  type VersionInput,
} from './changes.spec';
import { RenderProfileSchema } from './render-profile.schema.spec';
import { ScreenshotsAnswerSchema, ScreenshotsInputSchema } from './screenshot.schema';
import { isWebUrl } from './web-url.spec';

export * from './changes.spec';

const id = z.string().regex(UUIDV7_PATTERN);
const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = count;
/** A captured page's URL: `http(s)`, at most a snapshot's `maxUrlChars` (main drops its `#fragment`). */
const pageUrl = z.string().min(1).max(L.maxUrlChars).refine(isWebUrl, { message: 'not an http(s) URL' });
const limit = z.int().min(1).max(MAX_HISTORY_PAGE);
const region = z.enum(PAGE_REGIONS);

// ---- Inputs ------------------------------------------------------------------------------------

/** `changes.capture`: the active tab, and the project to file the capture in (default Unfiled). */
export const CaptureInputSchema = z.strictObject({ tabId: z.int().positive(), projectId: id.optional() }) satisfies z.ZodType<CaptureInput>;

export const HistoryCursorSchema = z.strictObject({ createdAt: time, id });

/** `changes.history`: a page's versions (one project's when given), newest first, a page at a time. */
export const HistoryInputSchema = z.strictObject({ url: pageUrl, projectId: id.optional(), cursor: HistoryCursorSchema.optional(), limit: limit.optional() }) satisfies z.ZodType<HistoryInput>;

/** `changes.version`: one version's snapshot. */
export const VersionInputSchema = z.strictObject({ versionId: id }) satisfies z.ZodType<VersionInput>;

/** `changes.diff`: two versions of one lane (main refuses two lanes with `null`). */
export const DiffInputSchema = z.strictObject({ fromVersionId: id, toVersionId: id }) satisfies z.ZodType<DiffInput>;

/** `changes.pages`: captured pages (one project's when given), most recently captured first. */
export const PagesInputSchema = z.strictObject({ projectId: id.optional(), limit: limit.optional() }) satisfies z.ZodType<PagesInput>;

// ---- Answers -----------------------------------------------------------------------------------

export const CaptureAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('captured'), captureId: id, versionId: id, newVersion: z.boolean(), changeCount: count.nullable() }),
  z.strictObject({ status: z.literal('refused'), reason: z.enum(CAPTURE_REFUSALS) }),
]) satisfies z.ZodType<CaptureAnswer>;

const CountsSchema = z.strictObject({ added: count, removed: count, changed: count });
/** A stored diff's summary (`ci_diffs.summary`): counts for every diff region. */
export const DiffSummarySchema = z.strictObject(Object.fromEntries(DIFF_REGIONS.map((name) => [name, CountsSchema])) as Record<(typeof DIFF_REGIONS)[number], typeof CountsSchema>) satisfies z.ZodType<DiffSummary>;

export const HistoryVersionSchema = z.strictObject({
  versionId: id,
  createdAt: time,
  captureCount: count,
  lastCapturedAt: time.nullable(),
  laneKey: z.string().regex(SHA256_HEX_PATTERN),
  renderProfile: RenderProfileSchema.nullable(),
  searchParams: SearchParamsSchema.nullable(),
  parentVersionId: id.nullable(),
  summary: DiffSummarySchema.nullable(),
  changeCount: count.nullable(),
});

export const HistoryAnswerSchema = z.strictObject({ versions: z.array(HistoryVersionSchema).max(MAX_HISTORY_PAGE), next: HistoryCursorSchema.nullable() }) satisfies z.ZodType<HistoryAnswer>;

export const VersionAnswerSchema = CaptureSnapshotSchema.nullable();

export const DiffAnswerSchema = SnapshotDiffSchema.nullable();

export const PagesAnswerSchema = z.strictObject({
  pages: z.array(z.strictObject({ url: z.string().min(1).refine(isWebUrl, { message: 'not an http(s) URL' }), captureCount: count, lastCapturedAt: time })).max(MAX_HISTORY_PAGE),
}) satisfies z.ZodType<PagesAnswer>;

// ---- The region extraction's answer ------------------------------------------------------------

/**
 * One region's text (`RegionTextAnswer`): blocks within the caps, `text` (H) within
 * `maxHashedRegionChars`, and exactly `blocks.join('\n')` when the region is not `truncated`.
 */
const RegionTextAnswerSchema = z
  .strictObject({
    words: count,
    blocks: z.array(z.string().min(1).max(L.maxBlockChars)).max(L.maxBlocksPerRegion),
    truncated: z.boolean(),
    text: z.string().max(L.maxHashedRegionChars),
  })
  .refine((text) => text.blocks.reduce((sum, block) => sum + block.length, 0) <= L.maxRegionChars, { message: 'region text is over maxRegionChars', path: ['blocks'] })
  .refine((text) => text.truncated || text.text === text.blocks.join('\n'), { message: 'an untruncated region hashes exactly its blocks', path: ['text'] }) satisfies z.ZodType<RegionTextAnswer>;

/**
 * The region extraction's answer (`RegionAnswer`): page data, so main parses it with this before
 * anything else reads it. Every list and string is within `CAPTURE_LIMITS`; the link counters never
 * exceed the total.
 */
export const RegionAnswerSchema = z.strictObject({
  url: z.string().max(L.maxUrlChars),
  partial: z.boolean(),
  headings: z.array(z.strictObject({ level: z.int().min(1).max(6), text: z.string().max(L.maxHeadingChars), region })).max(L.maxHeadings),
  links: z
    .strictObject({
      total: count,
      internal: count,
      external: count,
      nofollow: count,
      list: z.array(z.strictObject({ href: z.string().max(L.maxUrlChars), text: z.string().max(L.maxAnchorChars), rel: z.string().max(L.maxAnchorChars), region })).max(L.maxLinks),
    })
    .refine((links) => links.internal + links.external <= links.total && links.nofollow <= links.total && links.list.length <= links.total, { message: 'link counters exceed the total' }),
  regions: z.strictObject(Object.fromEntries(PAGE_REGIONS.map((name) => [name, RegionTextAnswerSchema])) as Record<PageRegion, typeof RegionTextAnswerSchema>),
}) satisfies z.ZodType<RegionAnswer>;

// ---- The read API (Phase 5) --------------------------------------------------------------------

/** One read operation: what it is for, and the schemas of what it takes and answers. */
export interface ReadOperation<I extends z.ZodType, O extends z.ZodType> {
  readonly description: string;
  readonly input: I;
  readonly output: O;
}

/**
 * The change-history reads another part of frost (Phase 5's agent) may call, through
 * `ChangesReadService` in main. Read-only, bounded by `MAX_HISTORY_PAGE` and the snapshot caps, and
 * answered only from what main validated.
 */
export const CHANGES_READ_API = {
  listPages: {
    description: 'Pages that have been captured, most recently captured first, with how many captures each has. Optionally only one project’s.',
    input: PagesInputSchema,
    output: PagesAnswerSchema,
  },
  history: {
    description: 'The distinct versions of one page, newest first, each with its lane (render profile and search parameters), how often it was captured, and how many changes it brought against the version before it.',
    input: HistoryInputSchema,
    output: HistoryAnswerSchema,
  },
  getVersion: {
    description: 'Everything one version recorded about the page: head tags, HTTP status, audit score and failing checks, structured data, headings, links and the text of each page region.',
    input: VersionInputSchema,
    output: VersionAnswerSchema,
  },
  diff: {
    description: 'What changed between two versions of the same lane, change by change and grouped by page region. Null when either version is missing or they are in different lanes.',
    input: DiffInputSchema,
    output: DiffAnswerSchema,
  },
  listScreenshots: {
    description: 'Screenshots taken of one page and/or in one project, newest first: kind (viewport, full page or a selected area), pixel size, file size, the render profile and search parameters they were taken with, and when. Images are not included.',
    input: ScreenshotsInputSchema,
    output: ScreenshotsAnswerSchema,
  },
} as const satisfies Record<string, ReadOperation<z.ZodType, z.ZodType>>;
export type ChangesReadApi = typeof CHANGES_READ_API;
