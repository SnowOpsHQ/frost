/**
 * The search parameters of a result page (Phase 3 Task 3; acceptance `serp-overlay.feature.md`,
 * Detection; plain limits in `serp.spec.ts`, `SERP_PARAM_LIMITS`). `matchSerp`
 * (`apps/desktop/src/main/serp/engines.ts`) reads them from the tab's URL by the selector pack's
 * parameter names, and the device from the tab's render profile (`SERP_DEVICE_OF_PRESET`).
 *
 * **This is the shape every capture records** (Phase 6, change intelligence, imports it: stable
 * after merge). A change is a new field, never a changed one, and **every field added later must be
 * optional or nullable**, so records written before it still parse:
 * - `engine`: the pack's engine id (`google`, `bing`, `duckduckgo`); `engineLabel`: its label;
 * - `query`: the query, whitespace collapsed and trimmed, at most `maxQueryChars`;
 * - `gl`: the country parameter's value, lowercase (`us`; DuckDuckGo's region `us-en`), or `null`
 *   when the URL has none;
 * - `hl`: the language parameter's value, lowercase (`en`, `en-gb`), or `null`;
 * - `device`: `desktop`, `mobile` or `tablet` (`SERP_DEVICES`), from the tab's render profile;
 * - `page`: the result page number, from 1 (from an offset parameter: (offset − base) / per page + 1);
 * - `offset`: the offset parameter's value as the URL gave it (Google's `start=20`, Bing's
 *   `first=11`; clamped to `maxOffset`), or `null` when the engine pages by number or the URL has
 *   none;
 * - `url`: the page's canonical URL: the engine's host and path with only the known parameters
 *   (the query, `gl`, `hl` and the offset or page, by the pack's names, in that order). The
 *   engine's session and tracking parameters are never recorded, so two captures of one search
 *   have one URL;
 * - `location` (Phase 12, plan Decision 7; optional): where the results were asked for, when not
 *   from the user's own connection: `via` how (`proxy`: a location profile's proxy, Task 10b; `api`:
 *   a data API's own location parameter, `serp-api.spec.ts`; `uule`: reserved for the deferred
 *   proposal D2, nothing writes it in Phase 12) and `label` the place as the user typed it (printable,
 *   trimmed, at most `SEARCH_LOCATION_MAX_CHARS`). Absent: the user's own connection. **It is meant
 *   to split series**: Phase 10's search key (`rankings.spec.ts`, `searchIdentityJson`) and Phase
 *   6's lane key (`laneKeyFor`) take every field present, so a Berlin reading never shares a trend
 *   line or a lane with a home-connection one, while records without it keep the key they always had.
 *   There is **no `source` field**: which path wrote a reading (a tab capture or a data API) is the
 *   reading row's `source` (Phase 10 Decision 4), never part of the search, so an API reading of a
 *   saved search with no location joins the tab captures' series. Rows whose parameters carry
 *   `location` stay device-local until a sync-schema bump (plan Decision 7; Task 10b).
 */
import { z } from 'zod';
import { SERP_DEVICES, SERP_PARAM_LIMITS } from './serp.spec';

const L = SERP_PARAM_LIMITS;
const printable = /^[^\u0000-\u001f\u007f]*$/;

/** A location label, at most (UTF-16 code units). */
export const SEARCH_LOCATION_MAX_CHARS = 128;

/** How a reading's location was asked for (`location.via`). */
export const SEARCH_LOCATION_VIAS = ['proxy', 'uule', 'api'] as const;
export type SearchLocationVia = (typeof SEARCH_LOCATION_VIAS)[number];

/**
 * A place as the user typed it: printable (no C0 or C1 controls, DEL, or bidirectional formatting
 * characters), trimmed, 1–`SEARCH_LOCATION_MAX_CHARS`.
 */
export const SearchLocationLabelSchema = z
  .string()
  .min(1)
  .max(SEARCH_LOCATION_MAX_CHARS)
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/)
  .refine((value) => value === value.trim(), { message: 'location must be trimmed' });

export const SearchLocationSchema = z.strictObject({
  via: z.enum(SEARCH_LOCATION_VIAS),
  label: SearchLocationLabelSchema,
});
export type SearchLocation = z.infer<typeof SearchLocationSchema>;

export const SearchParamsSchema = z.strictObject({
  engine: z
    .string()
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/),
  engineLabel: z.string().min(1).max(64).regex(printable),
  query: z.string().min(1).max(L.maxQueryChars).regex(printable),
  gl: z
    .string()
    .max(L.maxLocaleChars)
    .regex(/^[a-z0-9_-]+$/)
    .nullable(),
  hl: z
    .string()
    .max(L.maxLocaleChars)
    .regex(/^[a-z0-9_-]+$/)
    .nullable(),
  device: z.enum(SERP_DEVICES),
  page: z.int().min(1).max(L.maxPage),
  offset: z.int().min(0).max(L.maxOffset).nullable(),
  url: z
    .string()
    .max(L.maxUrlChars)
    .regex(/^https?:\/\//),
  location: SearchLocationSchema.optional(),
});

/** The search parameters of one result page, as every capture records them. */
export type SearchParams = z.infer<typeof SearchParamsSchema>;
