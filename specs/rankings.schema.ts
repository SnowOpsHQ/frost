/**
 * The Zod side of rank tracking (Phase 10; plain values and shapes in `rankings.spec.ts`; acceptance
 * `changes-capture.feature.md`, SERP reading). Main-only: the chrome renderer and `@app/change-intel`
 * use the Zod-free shapes instead, and the compile-time proofs below keep the two in step: Phase 3's
 * `SearchParamsSchema` and `SerpSnapshotSchema` (unchanged) parse to values that fit
 * `SearchParamsShape` and `SerpSnapshotShape`.
 *
 * - `SerpFiltersSchema`: a reading's stored filters (`rankings-url.spec.ts` `serpFiltersOf`): known filter names only
 *   (`SERP_FILTER_PARAMS`), non-empty lowercase values, keys sorted, within
 *   `MAX_SERP_FILTERS_JSON_BYTES`.
 * - `StoredReadingSchema`: a `ci_serp_readings` row with its JSON columns parsed (`params`,
 *   `filters`, `snapshot`), checked on every read: the snapshot is a `SerpSnapshotSchema` reading
 *   whose status and pack version are the row's, whose search parameters (when it has them) are the
 *   row's, filters named for the row's engine, and a `capture` reading names its capture.
 * - The `rankings.*` procedures' inputs and answers (Phase 10 Task 5; acceptance `rankings.feature.md`,
 *   Router and Export): strict inputs (a project id, a range, a stored tag, a search key, reading ids,
 *   a CSV kind; never a path or a file name) and strict answers, so an answer carrying anything more is
 *   a masked internal error, never forwarded. Every answer is bounded: `RANK_LIMITS` rows, points and
 *   comparison rows, `MAX_PROJECT_COMPETITORS` competitors, `MAX_READING_DATES` dates.
 */
import { z } from 'zod';
import { MAX_STORED_URL_LENGTH } from './browser-session-db.spec';
import { RETENTION_MODES, UUIDV7_PATTERN } from './capture-db.spec';
import { DATA_SERP_PROVIDERS, type DataSerpProvider } from './data-sources.spec';
import { utf8Bytes } from './rankings-url.spec';
import {
  COMPARE_MOVEMENTS,
  MAX_READING_DATES,
  RANK_CSV_KINDS,
  RANK_LIMITS,
  RANK_OUTCOMES,
  RANK_POINT_PROVIDERS,
  RANK_RANGES,
  RANKINGS_REFUSALS,
  SERP_FILTER_PARAMS,
  sortedJson,
  type CompareAnswer,
  type CopyCsvAnswer,
  type RankPoint,
  type RankPointProvider,
  type RankRow,
  type RankSeriesAnswer,
  type RankTableAnswer,
  type ReadingDatesAnswer,
  type SaveCsvAnswer,
  type SearchParamsShape,
  type SerpComparison,
  type SerpFilters,
  type SerpSnapshotShape,
} from './rankings.spec';
import { SearchParamsSchema } from './serp-search-params.schema';
import { SerpSnapshotSchema } from './serp-snapshot.schema';
import { SERP_FEATURE_TYPES, SERP_PARAM_LIMITS, SERP_READ_LIMITS } from './serp.spec';
import { DOMAIN_MAX_CHARS, MAX_PROJECT_COMPETITORS, MAX_PROJECT_TAGS, MAX_SERP_FILTERS_JSON_BYTES, MAX_TAGS_PER_ENTRY, SERP_READING_SOURCES, SERP_READING_STATUSES, TAG_MAX_CHARS } from './workspace-db.spec';

/** Every filter name any engine has. */
const FILTER_NAMES: ReadonlySet<string> = new Set(Object.values(SERP_FILTER_PARAMS).flat());
/** The filter names of `engine` (none for an engine without filters, or an unknown one). */
const filterNamesOf = (engine: string): readonly string[] => (Object.prototype.hasOwnProperty.call(SERP_FILTER_PARAMS, engine) ? SERP_FILTER_PARAMS[engine as keyof typeof SERP_FILTER_PARAMS] : []);

export const SerpFiltersSchema = z
  .record(
    z.string().refine((name) => FILTER_NAMES.has(name), { message: 'not a known filter' }),
    z
      .string()
      .min(1)
      .refine((value) => value === value.toLowerCase(), { message: 'not lowercase' }),
  )
  .refine((filters) => Object.keys(filters).every((key, index, keys) => index === 0 || keys[index - 1]! < key), { message: 'keys are not sorted' })
  .refine((filters) => utf8Bytes(sortedJson(filters)) <= MAX_SERP_FILTERS_JSON_BYTES, { message: 'filters too large' }) satisfies z.ZodType<SerpFilters>;

const id = z.string().regex(UUIDV7_PATTERN);

export const StoredReadingSchema = z
  .strictObject({
    id,
    projectId: id,
    captureId: id.nullable(),
    source: z.enum(SERP_READING_SOURCES),
    searchKey: z.string().regex(/^[0-9a-f]{64}$/),
    searchKeyVersion: z.int().min(1),
    params: SearchParamsSchema,
    filters: SerpFiltersSchema,
    pageUrl: z.string().max(MAX_STORED_URL_LENGTH).nullable(),
    status: z.enum(SERP_READING_STATUSES),
    packVersion: z.int().min(1).nullable(),
    snapshot: SerpSnapshotSchema,
    observedAt: z.int().min(0),
  })
  .refine((row) => row.snapshot.status === row.status, { message: 'the snapshot is of another status', path: ['snapshot'] })
  .refine((row) => row.snapshot.packVersion === row.packVersion, { message: 'the snapshot is of another pack version', path: ['snapshot'] })
  .refine((row) => row.snapshot.params === null || sortedJson(row.snapshot.params) === sortedJson(row.params), { message: 'the snapshot is of another search', path: ['snapshot'] })
  .refine((row) => Object.keys(row.filters).every((name) => filterNamesOf(row.params.engine).includes(name)), { message: 'a filter of another engine', path: ['filters'] })
  .refine((row) => row.source !== 'capture' || row.captureId !== null, { message: 'a capture reading without its capture', path: ['captureId'] });
export type StoredReadingRow = z.infer<typeof StoredReadingSchema>;

// ---- The `rankings.*` procedures (Phase 10 Task 5; acceptance `rankings.feature.md`, Router) ------

/** A stored tag (`normalizeTag`'s form): printable, no bidirectional formatting, at most `TAG_MAX_CHARS`. */
const tag = z
  .string()
  .min(1)
  .max(TAG_MAX_CHARS)
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/);
/** The SERP feature types (`alsoIn` lists only these). */
const FEATURE_TYPES: ReadonlySet<string> = new Set<string>(SERP_FEATURE_TYPES);
const searchKey = z.string().regex(/^[0-9a-f]{64}$/);
const range = z.enum(RANK_RANGES);

/** `rankings.table`: the project, the range points are kept in, and optionally one tag (saved searches carrying it only). */
export const RankTableInputSchema = z.strictObject({ projectId: id, range, tag: tag.optional() });
/** `rankings.series`: one search (its key, as the table answered it) of the project, in a range. */
export const RankSeriesInputSchema = z.strictObject({ projectId: id, searchKey, range });
/** `rankings.readingDates`: the readings of one search of the project (the Compare view's date picker). */
export const ReadingDatesInputSchema = z.strictObject({ projectId: id, searchKey });
/** `rankings.compare`: two readings, `a` (the left pick) and `b`, both of this live project. */
export const CompareInputSchema = z.strictObject({ projectId: id, a: id, b: id });
/** `rankings.copyCsv` / `rankings.saveCsv`: what to export (`table` as shown, or every point: `history`); never a path. */
export const RankCsvInputSchema = z.strictObject({ projectId: id, kind: z.enum(RANK_CSV_KINDS), range, tag: tag.optional() });

const refused = z.strictObject({ status: z.literal('refused'), reason: z.enum(RANKINGS_REFUSALS) });
const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const position = z.int().min(1).max(SERP_READ_LIMITS.maxResults);
/** A result's link as Phase 3 stored it (`http(s)`, at most `maxUrlChars`). */
const resultUrl = z
  .string()
  .max(SERP_READ_LIMITS.maxUrlChars)
  .regex(/^https?:\/\//);
/** A stored host (`normalizeSiteDomain`'s form). */
const domain = z.string().min(1).max(DOMAIN_MAX_CHARS).regex(/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/);
/** An owner domain as Phase 3 read it on a result page (`SerpResultSchema`). */
const resultDomain = z.string().min(1).max(253);

export const RankPointSchema = z.strictObject({
  readingId: id,
  at: count,
  outcome: z.enum(RANK_OUTCOMES),
  position: position.nullable(),
  url: resultUrl.nullable(),
  organicRead: z.int().min(0).max(SERP_READ_LIMITS.maxResults),
  page: z.int().min(1).max(SERP_PARAM_LIMITS.maxPage),
  alsoIn: z
    .array(z.string().refine((type) => FEATURE_TYPES.has(type), { message: 'not a SERP feature type' }))
    .max(SERP_FEATURE_TYPES.length)
    .readonly(),
  // Phase 12 Task 4: a SERP API reading's point, and its vendor (absent: a tab capture's).
  source: z.literal('serp-api').optional(),
  provider: z.enum(RANK_POINT_PROVIDERS).optional(),
}) satisfies z.ZodType<RankPoint>;

const competitorPoints = z.record(domain, RankPointSchema.nullable()).refine((points) => Object.keys(points).length <= MAX_PROJECT_COMPETITORS, { message: 'too many competitors' });

export const RankRowSchema = z.strictObject({
  searchKey,
  params: SearchParamsSchema,
  filters: SerpFiltersSchema,
  saved: z.strictObject({ id, tags: z.array(tag).max(MAX_TAGS_PER_ENTRY).readonly() }).nullable(),
  latest: RankPointSchema.nullable(),
  previous: RankPointSchema.nullable(),
  change: z.union([z.int().min(-SERP_READ_LIMITS.maxResults).max(SERP_READ_LIMITS.maxResults), z.enum(['new', 'lost'])]).nullable(),
  best: position.nullable(),
  points: z.array(RankPointSchema).max(RANK_LIMITS.maxPointsPerSeries).readonly(),
  competitors: competitorPoints,
}) satisfies z.ZodType<RankRow>;

/** `rankings.table`'s answer (`RankTableAnswer`): the rows (each with its `capped`), with the project's retention (`rankHistoryNote`), site, competitors and tags. */
export const RankTableSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    rows: z.array(RankRowSchema.extend({ capped: z.boolean() })).max(RANK_LIMITS.maxRows).readonly(),
    truncated: z.boolean(),
    retention: z.strictObject({ mode: z.enum(RETENTION_MODES), value: count.nullable() }),
    site: z.strictObject({ domain, subdomains: z.boolean() }).nullable(),
    competitors: z.array(domain).max(MAX_PROJECT_COMPETITORS).readonly(),
    tags: z.array(tag).max(MAX_PROJECT_TAGS).readonly(),
  }),
  refused,
]) satisfies z.ZodType<RankTableAnswer>;

/** `rankings.series`'s answer (`RankSeriesAnswer`). */
export const RankSeriesSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), searchKey, points: z.array(RankPointSchema).max(RANK_LIMITS.maxPointsPerSeries).readonly(), capped: z.boolean() }),
  refused,
]) satisfies z.ZodType<RankSeriesAnswer>;

/** `rankings.readingDates`'s answer (`ReadingDatesAnswer`). */
export const ReadingDatesSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), dates: z.array(z.strictObject({ readingId: id, at: count, status: z.enum(SERP_READING_STATUSES) })).max(MAX_READING_DATES).readonly() }),
  refused,
]) satisfies z.ZodType<ReadingDatesAnswer>;

const place = z.strictObject({ position, url: resultUrl.nullable() });
const side = z.strictObject({
  readingId: id,
  at: count,
  params: SearchParamsSchema.nullable(),
  filters: SerpFiltersSchema,
  status: z.enum(SERP_READING_STATUSES),
  organicRead: z.int().min(0).max(SERP_READ_LIMITS.maxResults),
  complete: z.boolean(),
  features: z.array(z.enum(SERP_FEATURE_TYPES)).max(SERP_FEATURE_TYPES.length).readonly(),
});

/** Two readings side by side (`SerpComparison`, `compareSerps`). */
export const SerpComparisonSchema = z.strictObject({
  a: side,
  b: side,
  rows: z
    .array(
      z.strictObject({
        domain: resultDomain,
        a: place.nullable(),
        b: place.nullable(),
        movement: z.enum(COMPARE_MOVEMENTS),
        change: z.int().min(-SERP_READ_LIMITS.maxResults).max(SERP_READ_LIMITS.maxResults).nullable(),
        role: z.enum(['site', 'competitor']).nullable(),
      }),
    )
    .max(RANK_LIMITS.maxRows)
    .readonly(),
  features: z
    .array(z.strictObject({ type: z.enum(SERP_FEATURE_TYPES), a: z.boolean(), b: z.boolean() }))
    .max(SERP_FEATURE_TYPES.length)
    .readonly(),
  site: z.strictObject({ a: RankPointSchema, b: RankPointSchema }).nullable(),
  truncated: z.boolean(),
}) satisfies z.ZodType<SerpComparison>;

/** `rankings.compare`'s answer (`CompareAnswer`). */
export const CompareAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok'), comparison: SerpComparisonSchema }), refused]) satisfies z.ZodType<CompareAnswer>;

/** `rankings.copyCsv`'s answer (`CopyCsvAnswer`): the lines written (header aside), or `null`. */
export const CopyCsvAnswerSchema = count.nullable() satisfies z.ZodType<CopyCsvAnswer>;

/** `rankings.saveCsv`'s answer (`SaveCsvAnswer`). */
export const SaveCsvAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('saved'), rows: count }), z.strictObject({ status: z.literal('cancelled') }), refused]) satisfies z.ZodType<SaveCsvAnswer>;

// ---- Compile-time proofs: Phase 3's schemas fit the Zod-free shapes -----------------------------

void (SearchParamsSchema satisfies z.ZodType<SearchParamsShape>);
// Phase 12 Task 4: a rank point's vendors are exactly the SERP vendors (each list assignable to the other).
void ((): readonly DataSerpProvider[] => RANK_POINT_PROVIDERS);
void ((): readonly RankPointProvider[] => DATA_SERP_PROVIDERS);
void (SerpSnapshotSchema satisfies z.ZodType<SerpSnapshotShape>);
