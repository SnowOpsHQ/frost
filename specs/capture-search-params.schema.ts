/**
 * Search parameters (Phase 6 Task 2; acceptance `changes-diff.feature.md`, Search parameters): what a
 * project query, a capture or a screenshot of a results page records about the search it ran, stored
 * as canonical JSON (`ci_project_queries.search_params`, `ci_captures.search_params`, part of a
 * capture's lane key).
 *
 * Every key is always present (`null` when unset) and no other is allowed, and nothing is
 * normalised on the way in (a value is valid as it is or refused), so one search has exactly one
 * canonical JSON: two equal searches always share a lane, and the live-query unique index holds.
 *
 * TODO(phase-3-merge): replace this schema with `specs/serp-search-params.schema.ts` from Phase 3.
 * Rows already stored with this shape must stay readable after the swap: either map this shape onto
 * Phase 3's when reading, or migrate the stored JSON (and recompute the lane keys built from it) in a
 * Phase 6 migration (`0040`–`0059`).
 */
import { z } from 'zod';
import { SEARCH_ENGINE_IDS } from './browser-polish.spec';
import { PROJECT_QUERY_MAX_CHARS } from './capture-db.spec';

/** Longest `language` tag (a BCP 47 tag's practical maximum). */
export const SEARCH_LANGUAGE_MAX_CHARS = 35;
/** Longest free-text `location`. */
export const SEARCH_LOCATION_MAX_CHARS = 100;
/** Devices a search can be run as. */
export const SEARCH_DEVICES = ['desktop', 'mobile'] as const;

/** No control characters (C0, DEL, C1): the text is shown and stored as written. */
const PRINTABLE = /^[^\u0000-\u001f\u007f-\u009f]*$/;
const trimmed = (value: string) => value === value.trim();

/** Search parameters: every key present, nullable where a search can leave it unset. */
export const SearchParamsSchema = z.strictObject({
  engine: z.enum(SEARCH_ENGINE_IDS),
  /** The query as typed, already trimmed, not blank. */
  query: z.string().min(1).max(PROJECT_QUERY_MAX_CHARS).regex(PRINTABLE).refine(trimmed, { message: 'query must be trimmed' }),
  /** ISO 3166-1 alpha-2, lowercase. */
  country: z.string().regex(/^[a-z]{2}$/).nullable(),
  /** A BCP 47-style language tag (`en`, `pt-BR`, `zh-Hant-TW`). */
  language: z.string().max(SEARCH_LANGUAGE_MAX_CHARS).regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i).nullable(),
  /** A free-text place (a city, a region), trimmed, not blank. */
  location: z.string().min(1).max(SEARCH_LOCATION_MAX_CHARS).regex(PRINTABLE).refine(trimmed, { message: 'location must be trimmed' }).nullable(),
  device: z.enum(SEARCH_DEVICES).nullable(),
});
export type SearchParams = z.infer<typeof SearchParamsSchema>;
