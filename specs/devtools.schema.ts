/**
 * The `devtools.*` procedures' inputs and the analysis worker's robots.txt verdict job (Phase 2.5
 * Task 5; acceptance `devtools.feature.md`, Router). Main-only (Zod): the chrome imports the plain
 * values and types of `devtools.spec.ts`. Every procedure is `enforceSender`-first; these schemas are
 * strict, so an unknown key or an over-long value is refused before the service is called.
 */
import { z } from 'zod';
import {
  COOKIE_LIMITS,
  HAR_CREATOR,
  HAR_VERSION,
  NETWORK_EXPORT_FORMATS,
  NETWORK_LIMITS,
  NETWORK_RESOURCE_TYPES,
  ROBOTS_VERDICT_BATCH,
  WEB_STORAGE_AREAS,
  WEB_STORAGE_LIMITS,
  WEB_STORAGE_UNAVAILABLE_REASONS,
} from './devtools.spec';
import { RobotsFetchSchema } from './seo-snapshot.spec';
import { isWebUrl } from './web-url.spec';

const tabId = z.int().positive();

/** `devtools.redirects` / `console` / `storage` / `clearSiteData`: the tab (the active one, from the drawer). */
export const DevtoolsTabInputSchema = z.strictObject({ tabId });
export type DevtoolsTabInput = z.infer<typeof DevtoolsTabInputSchema>;

/** `devtools.network`: the tab and the chrome's cursor (`since`: the last `rev` it merged; 0 or left out: everything). */
export const DevtoolsNetworkInputSchema = z.strictObject({ tabId, since: z.int().nonnegative().optional() });
export type DevtoolsNetworkInput = z.infer<typeof DevtoolsNetworkInputSchema>;

/** `devtools.requestHeaders`: one row of the tab's log, by its key. */
export const RequestHeadersInputSchema = z.strictObject({ tabId, requestKey: z.int().positive() });
export type RequestHeadersInput = z.infer<typeof RequestHeadersInputSchema>;

/** `devtools.watch`: the tab and the last devtools version the chrome saw (`0` before the first). */
export const DevtoolsWatchInputSchema = z.strictObject({ tabId, sinceVersion: z.int().nonnegative() });
export type DevtoolsWatchInput = z.infer<typeof DevtoolsWatchInputSchema>;

/** `devtools.setOpen`: whether the sending window's drawer is open (the recording decision, `NETWORK_LIMITS`). */
export const DevtoolsSetOpenInputSchema = z.strictObject({ open: z.boolean() });
export type DevtoolsSetOpenInput = z.infer<typeof DevtoolsSetOpenInputSchema>;

/** `devtools.setPreserveLog`: "Preserve log" for the tab's network log (session-only). */
export const DevtoolsPreserveInputSchema = z.strictObject({ tabId, preserve: z.boolean() });
export type DevtoolsPreserveInput = z.infer<typeof DevtoolsPreserveInputSchema>;

/** `devtools.revealCookie`: one cookie of the tab's URL, by name, domain and path (as `devtools.storage` listed it). */
export const RevealCookieInputSchema = z.strictObject({
  tabId,
  name: z.string().max(COOKIE_LIMITS.maxNameChars),
  domain: z.string().max(COOKIE_LIMITS.maxDomainChars),
  path: z.string().max(COOKIE_LIMITS.maxPathChars),
});
export type RevealCookieInput = z.infer<typeof RevealCookieInputSchema>;

/**
 * The analysis worker's robots.txt verdict job (`kind: 'robots'`): the page origin's robots.txt as the
 * fetcher answered it, and the request URLs (same origin, crawlable types) to decide, at most
 * `ROBOTS_VERDICT_BATCH`. Validated in the worker, which answers one verdict per URL.
 */
export const RobotsVerdictJobSchema = z.strictObject({
  robots: RobotsFetchSchema,
  urls: z.array(z.string().min(1).max(NETWORK_LIMITS.maxUrlChars).refine(isWebUrl, { message: 'not an http(s) URL' })).max(ROBOTS_VERDICT_BATCH),
});
export type RobotsVerdictJob = z.infer<typeof RobotsVerdictJobSchema>;

// ---- Phase 11 Task 4: network export and web storage (Decisions 5, 6) ---------------------------

/**
 * `devtools.storage`: the tab, and whether to run the web storage reader now (`readWebStorage`: the
 * Storage tab was opened, or Refresh). Left out or `false`: the keys of the last read are answered
 * (and a revealed key read again), no listing is read.
 */
export const DevtoolsStorageInputSchema = z.strictObject({ tabId, readWebStorage: z.boolean().optional() });
export type DevtoolsStorageInput = z.infer<typeof DevtoolsStorageInputSchema>;

/** `devtools.exportNetwork`: the (active) tab and the format. Nothing else: main builds the file from its own log. */
export const ExportNetworkInputSchema = z.strictObject({ tabId, format: z.enum(NETWORK_EXPORT_FORMATS) });
export type ExportNetworkInput = z.infer<typeof ExportNetworkInputSchema>;

/** `devtools.revealStorageItem`: one key of one area, as the last read listed it (`maxKeyChars`). */
export const RevealStorageItemInputSchema = z.strictObject({ tabId, area: z.enum(WEB_STORAGE_AREAS), key: z.string().max(WEB_STORAGE_LIMITS.maxKeyChars) });
export type RevealStorageItemInput = z.infer<typeof RevealStorageItemInputSchema>;

const MAX_ORIGIN_CHARS = NETWORK_LIMITS.maxUrlChars;
/** Sizes and totals a page can report: any count a real storage can hold, never a float or negative. */
const count = z.int().nonnegative().max(1_000_000_000);
const bytes = z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER).nullable();
const unavailable = z.strictObject({ status: z.literal('unavailable'), reason: z.enum(WEB_STORAGE_UNAVAILABLE_REASONS) });

const WebStorageKeyItemSchema = z.strictObject({
  key: z.string().max(WEB_STORAGE_LIMITS.maxKeyChars),
  keyTruncated: z.boolean(),
  size: count,
});

const WebStorageKeysAreaSchema = z.discriminatedUnion('status', [
  z
    .strictObject({ status: z.literal('ready'), items: z.array(WebStorageKeyItemSchema).max(WEB_STORAGE_LIMITS.maxKeys), total: count })
    .refine((area) => area.total >= area.items.length, { message: 'total below the items listed' }),
  unavailable,
]);

/**
 * The reader's `keys` answer (untrusted: the page can answer anything): per area the capped keys with
 * their value sizes (never a value) and the total, or why the area is unavailable; the document's
 * origin; `navigator.storage.estimate()`'s usage and quota (`null`: none).
 */
export const WebStorageKeysAnswerSchema = z.strictObject({
  op: z.literal('keys'),
  origin: z.string().max(MAX_ORIGIN_CHARS),
  local: WebStorageKeysAreaSchema,
  session: WebStorageKeysAreaSchema,
  usage: bytes,
  quota: bytes,
});
export type WebStorageKeysAnswer = z.infer<typeof WebStorageKeysAnswerSchema>;

/** The reader's `value` answer for one key (untrusted): its capped value (`null`: no such key now), or why it is unavailable. */
export const WebStorageValueAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    op: z.literal('value'),
    status: z.literal('ready'),
    origin: z.string().max(MAX_ORIGIN_CHARS),
    area: z.enum(WEB_STORAGE_AREAS),
    key: z.string().max(WEB_STORAGE_LIMITS.maxKeyChars),
    value: z.string().max(WEB_STORAGE_LIMITS.maxValueChars).nullable(),
    truncated: z.boolean(),
  }),
  z.strictObject({ op: z.literal('value'), status: z.literal('unavailable'), origin: z.string().max(MAX_ORIGIN_CHARS), reason: z.enum(WEB_STORAGE_UNAVAILABLE_REASONS) }),
]);
export type WebStorageValueAnswer = z.infer<typeof WebStorageValueAnswerSchema>;

// ---- The HAR frost writes (a strict subset of HAR 1.2) -----------------------------------------

const HarNameValueSchema = z.strictObject({ name: z.string(), value: z.string() });
/** `-1`: unknown (HAR 1.2), the only size frost writes for headers and bodies. */
const unknownSize = z.literal(-1);

const HarRequestSchema = z.strictObject({
  method: z.string().min(1),
  url: z.string(),
  httpVersion: z.string(),
  cookies: z.array(z.never()).max(0),
  headers: z.array(HarNameValueSchema),
  queryString: z.array(HarNameValueSchema),
  headersSize: unknownSize,
  bodySize: unknownSize,
  comment: z.string(),
});

const HarResponseSchema = z.strictObject({
  status: z.int().nonnegative(),
  statusText: z.string(),
  httpVersion: z.string(),
  cookies: z.array(z.never()).max(0),
  headers: z.array(HarNameValueSchema),
  // Never a body: no `text`, no `encoding`; the size is unknown.
  content: z.strictObject({ size: unknownSize, mimeType: z.string(), comment: z.string() }),
  redirectURL: z.string(),
  headersSize: unknownSize,
  bodySize: unknownSize,
});

const HarEntrySchema = z.strictObject({
  pageref: z.string().optional(),
  startedDateTime: z.iso.datetime(),
  time: z.number().nonnegative(),
  request: HarRequestSchema,
  response: HarResponseSchema,
  cache: z.strictObject({}),
  timings: z.strictObject({ send: z.number().nonnegative(), wait: z.number().nonnegative(), receive: z.number().nonnegative() }),
  /** frost's type of the request (custom fields start with `_`, HAR 1.2). */
  _resourceType: z.enum(NETWORK_RESOURCE_TYPES),
  comment: z.string().optional(),
});

const HarPageSchema = z.strictObject({
  startedDateTime: z.iso.datetime(),
  id: z.string().min(1),
  title: z.string(),
  pageTimings: z.strictObject({}),
});

/** The network export's HAR (`devtools.exportNetwork`, `har`): HAR 1.2 as frost writes it, no body anywhere. */
export const HarLogSchema = z.strictObject({
  log: z.strictObject({
    version: z.literal(HAR_VERSION),
    creator: z.strictObject({ name: z.literal(HAR_CREATOR.name), version: z.string() }),
    pages: z.array(HarPageSchema),
    entries: z.array(HarEntrySchema),
    comment: z.string(),
  }),
});
export type HarLog = z.infer<typeof HarLogSchema>;
export type HarEntry = z.infer<typeof HarEntrySchema>;
