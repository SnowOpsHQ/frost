/**
 * The search parameters of a result page (Phase 3 Task 3; acceptance `serp-overlay.feature.md`,
 * Detection; plain limits in `serp.spec.ts`, `SERP_PARAM_LIMITS`). `matchSerp`
 * (`apps/desktop/src/main/serp/engines.ts`) reads them from the tab's URL by the selector pack's
 * parameter names, and the device from the tab's render profile (`SERP_DEVICE_OF_PRESET`).
 *
 * **This is the shape every capture records** (Phase 6, change intelligence, imports it: stable
 * after merge; a change is a new field, never a changed one):
 * - `engine`: the pack's engine id (`google`, `bing`, `duckduckgo`); `engineLabel`: its label;
 * - `query`: the query, whitespace collapsed and trimmed, at most `maxQueryChars`;
 * - `gl`: the country parameter's value, lowercase (`us`; DuckDuckGo's region `us-en`), or `null`
 *   when the URL has none;
 * - `hl`: the language parameter's value, lowercase (`en`, `en-gb`), or `null`;
 * - `device`: `desktop`, `mobile` or `tablet` (`SERP_DEVICES`), from the tab's render profile;
 * - `page`: the result page number, from 1 (from an offset parameter: (offset − base) / per page + 1);
 * - `url`: the result page's URL as loaded.
 */
import { z } from 'zod';
import { SERP_DEVICES, SERP_PARAM_LIMITS } from './serp.spec';

const L = SERP_PARAM_LIMITS;
const printable = /^[^\u0000-\u001f\u007f]*$/;

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
  url: z
    .string()
    .max(L.maxUrlChars)
    .regex(/^https?:\/\//),
});

/** The search parameters of one result page, as every capture records them. */
export type SearchParams = z.infer<typeof SearchParamsSchema>;
