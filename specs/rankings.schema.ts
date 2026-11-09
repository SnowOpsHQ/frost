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
 */
import { z } from 'zod';
import { MAX_STORED_URL_LENGTH } from './browser-session-db.spec';
import { UUIDV7_PATTERN } from './capture-db.spec';
import { utf8Bytes } from './rankings-url.spec';
import { SERP_FILTER_PARAMS, sortedJson, type SearchParamsShape, type SerpFilters, type SerpSnapshotShape } from './rankings.spec';
import { SearchParamsSchema } from './serp-search-params.schema';
import { SerpSnapshotSchema } from './serp-snapshot.schema';
import { MAX_SERP_FILTERS_JSON_BYTES, SERP_READING_SOURCES, SERP_READING_STATUSES } from './workspace-db.spec';

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

// ---- Compile-time proofs: Phase 3's schemas fit the Zod-free shapes -----------------------------

void (SearchParamsSchema satisfies z.ZodType<SearchParamsShape>);
void (SerpSnapshotSchema satisfies z.ZodType<SerpSnapshotShape>);
