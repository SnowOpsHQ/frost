/**
 * The Zod side of signed selector packs (Phase 3 Task 1; plain values in
 * `serp-selector-pack.spec.ts`, trust model there; acceptance `serp-selector-pack.feature.md`).
 * `SelectorPackSchema` is applied by `verifyPack` (`apps/desktop/src/main/serp/pack-verify.ts`) only
 * after the pack's signature has verified. Not for the chrome renderer (no Zod there).
 *
 * A pack holds strings, numbers and booleans only. Every object is strict (an unknown key refuses
 * the pack, so a pack written for a later format is never half-read), and every list and string is
 * capped (`SELECTOR_PACK_LIMITS`). Selectors are checked here for length and shape only: whether one
 * parses is up to the page's `querySelectorAll`, and Task 3's reader treats an invalid one as
 * `bad-selector` (it fails closed, never guesses).
 */
import { z } from 'zod';
import { PAGE_PARAM_KINDS, SELECTOR_PACK_LIMITS, SERP_RESULT_TYPES } from './serp-selector-pack.spec';

const L = SELECTOR_PACK_LIMITS;
/** No ASCII control characters (a selector, label or name is one line of printable text). */
const printable = /^[^\u0000-\u001f\u007f]*$/;

/** A CSS selector (or selector list) for the page's `querySelectorAll`: non-blank, one line, capped. */
export const SelectorSchema = z
  .string()
  .min(1)
  .max(L.maxSelectorChars)
  .regex(printable, { message: 'control characters in a selector' })
  .refine((value) => value.trim().length > 0, { message: 'blank selector' });

/** An engine id: lowercase letters, digits and `-`, starting with a letter (`google`, `bing`). */
const EngineIdSchema = z
  .string()
  .max(L.maxIdChars)
  .regex(/^[a-z][a-z0-9-]*$/, { message: 'not an engine id' });

const LabelSchema = z.string().min(1).max(L.maxLabelChars).regex(printable, { message: 'control characters in a label' });

/**
 * An exact host name, compared with the URL's (lowercase, already IDNA-encoded) `hostname`: lowercase
 * DNS labels of letters, digits and `-`, separated by dots. No wildcards, ports or trailing dot.
 */
const HostSchema = z
  .string()
  .max(L.maxHostChars)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/, { message: 'not a lowercase host name' });

/**
 * A pathname result pages are served at, compared exactly with the URL's `pathname` (`/search`;
 * `/` for an engine whose results are on its home page; a trailing slash is significant): `/`
 * followed by URL path characters, no query or fragment.
 */
const PathSchema = z
  .string()
  .max(L.maxPathChars)
  .regex(/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/, { message: 'not a pathname' });

/** A URL query parameter name (`q`, `gl`, `setlang`). */
const ParamNameSchema = z
  .string()
  .min(1)
  .max(L.maxParamChars)
  .regex(/^[A-Za-z0-9_.\-]+$/, { message: 'not a parameter name' });

/** The names one parameter may go by, first match wins (at least one). */
const ParamNamesSchema = z.array(ParamNameSchema).min(1).max(L.maxParamNames);

/**
 * The page parameter: its name and how it counts. `offset`: the number of results before the page
 * (`perPage` results a page; `offsetBase` is the offset of page 1's first result, 0 for `start=0`,
 * 1 for `first=1`), so page = (value − offsetBase) / perPage + 1. `page`: the page number itself.
 */
export const PageParamSchema = z
  .strictObject({
    param: ParamNameSchema,
    kind: z.enum(PAGE_PARAM_KINDS),
    perPage: z.int().min(1).max(L.maxPerPage).optional(),
    offsetBase: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .refine((page) => page.kind !== 'offset' || page.perPage !== undefined, { message: 'an offset page parameter needs perPage', path: ['perPage'] });

/**
 * The URL parameters of an engine's result page: the query (required: a URL without it is not a
 * result page), the country (`gl`), the language (`hl`) and the page (Task 3, `SearchParamsSchema`).
 */
export const EngineParamsSchema = z.strictObject({
  query: ParamNamesSchema,
  gl: ParamNamesSchema.optional(),
  hl: ParamNamesSchema.optional(),
  page: PageParamSchema.optional(),
});

/**
 * One kind of block on the page (Task 3's reader):
 * - `type`: what the block is (`SERP_RESULT_TYPES`);
 * - `container`: the block's elements on the page;
 * - `item`: each result inside a container (absent: the container is one result);
 * - `link`: the result's link inside an item (absent: the item's first link, or the item itself
 *   when it is one);
 * - `title`: the result's title inside an item (absent: the link's text);
 * - `required`: the page is read only when this block matches (absent: `false`).
 */
export const SelectorBlockSchema = z.strictObject({
  type: z.enum(SERP_RESULT_TYPES),
  container: SelectorSchema,
  item: SelectorSchema.optional(),
  link: SelectorSchema.optional(),
  title: SelectorSchema.optional(),
  required: z.boolean().optional(),
});

/** How an engine's result page is laid out: `results`, the area holding the results (it must match, else the page is unreadable), and its blocks, in no particular order (the page's document order decides positions). */
export const EngineLayoutSchema = z.strictObject({
  results: SelectorSchema,
  blocks: z.array(SelectorBlockSchema).min(1).max(L.maxBlocksPerEngine),
});

/** One search engine's result pages: a URL is one when its host is one of `hosts`, its pathname one of `paths`, and its query parameter is present (Task 3, `engines.ts`). */
export const SelectorEngineSchema = z.strictObject({
  id: EngineIdSchema,
  label: LabelSchema,
  hosts: z.array(HostSchema).min(1).max(L.maxHostsPerEngine),
  paths: z.array(PathSchema).min(1).max(L.maxPathsPerEngine),
  params: EngineParamsSchema,
  layout: EngineLayoutSchema,
});

/**
 * A selector pack: `format` 1 (a later format is another schema, refused here), a `version` that
 * only ever grows (a pack replaces another only when its version is higher), the day it was
 * published (`YYYY-MM-DD`, informational) and its engines. Engine ids are unique, and a host belongs
 * to one engine only, so a URL matches at most one.
 */
export const SelectorPackSchema = z
  .strictObject({
    format: z.literal(1),
    version: z.int().min(1),
    published: z.iso.date(),
    engines: z.array(SelectorEngineSchema).min(1).max(L.maxEngines),
  })
  .superRefine((pack, ctx) => {
    const ids = new Set<string>();
    const hosts = new Set<string>();
    pack.engines.forEach((engine, index) => {
      if (ids.has(engine.id)) ctx.addIssue({ code: 'custom', message: `duplicate engine id ${engine.id}`, path: ['engines', index, 'id'] });
      ids.add(engine.id);
      for (const host of engine.hosts) {
        if (hosts.has(host)) ctx.addIssue({ code: 'custom', message: `host ${host} in more than one place`, path: ['engines', index, 'hosts'] });
        hosts.add(host);
      }
    });
  });

export type SelectorPack = z.infer<typeof SelectorPackSchema>;
export type SelectorEngine = z.infer<typeof SelectorEngineSchema>;
export type SelectorBlock = z.infer<typeof SelectorBlockSchema>;
export type EngineLayout = z.infer<typeof EngineLayoutSchema>;
export type EngineParams = z.infer<typeof EngineParamsSchema>;
export type PageParam = z.infer<typeof PageParamSchema>;
