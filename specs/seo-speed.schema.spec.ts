/**
 * The page-speed measurement's schema (Phase 2 Task 5; acceptance `seo-speed.feature.md`). The
 * collector (`apps/desktop/src/main/seo/vitals.ts`) builds a `PerformanceMeasurement` in the tab's
 * isolated world `SPEED_WORLD_ID` from the Performance API, web-vitals' callbacks and the DOM; it is
 * page-derived data, so the analysis worker parses it with `PerformanceMeasurementSchema` (strict,
 * every cap of `SPEED_LIMITS`) before anything reads it. Main only caps sizes; it never parses it.
 *
 * Main-only (Zod): the renderer imports this module for its types only.
 */
import { z } from 'zod';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import { MAX_BLOCKING_SCRIPTS, SPEED_LIMITS as S, VITAL_METRICS } from './seo-speed.spec';
import { isWebUrl } from './web-url.spec';

const count = z.int().nonnegative().max(S.maxCount);
const bytes = z.int().nonnegative().max(S.maxBytes);
/** Milliseconds since the document's navigation started (or a duration), finite and bounded. */
const time = z.number().nonnegative().max(S.maxTimeMs);
const field = z.string().max(S.maxResourceFieldChars);

/**
 * One resource timing entry (`PerformanceResourceTiming`), as the collector keeps it: its URL (cut
 * to `maxResourceUrlChars`; `urlCut` says so), `initiatorType`, the response's MIME type and content
 * encoding where the entry reports them (`null` where the browser has no such field; `''` when it
 * has one but the response did not say, or it is cross-origin without `Timing-Allow-Origin`), its
 * transfer, encoded and decoded body sizes (all `0` for such cross-origin responses), when it
 * started and how long it took, and whether it blocked rendering (`renderBlockingStatus`, `null`
 * where unreported).
 */
export const ResourceRecordSchema = z.strictObject({
  url: z.string().max(S.maxResourceUrlChars),
  urlCut: z.boolean(),
  initiator: field,
  contentType: field.nullable(),
  contentEncoding: field.nullable(),
  transfer: bytes,
  encoded: bytes,
  decoded: bytes,
  start: time,
  duration: time,
  blocking: z.boolean().nullable(),
});

/**
 * The document's navigation timing (`PerformanceNavigationTiming`): its type, redirect count, the
 * phase timestamps (0 where a phase did not happen, e.g. no redirect, a reused connection, no TLS),
 * the DOM milestones (0 until reached) and its sizes.
 */
export const NavigationTimingSchema = z.strictObject({
  type: z.string().max(32),
  redirectCount: count,
  redirectStart: time,
  redirectEnd: time,
  fetchStart: time,
  domainLookupStart: time,
  domainLookupEnd: time,
  connectStart: time,
  secureConnectionStart: time,
  connectEnd: time,
  requestStart: time,
  responseStart: time,
  responseEnd: time,
  domInteractive: time,
  domContentLoadedEventEnd: time,
  loadEventEnd: time,
  activationStart: time,
  transfer: bytes,
  encoded: bytes,
  decoded: bytes,
  contentType: field.nullable(),
  contentEncoding: field.nullable(),
});

/** Each metric's latest value from web-vitals (`reportAllChanges`), `null` until reported. CLS is unitless, the others milliseconds. */
export const VitalValuesSchema = z.strictObject(Object.fromEntries(VITAL_METRICS.map((metric) => [metric, (metric === 'cls' ? z.number().nonnegative().max(1_000) : time).nullable()])) as Record<(typeof VITAL_METRICS)[number], z.ZodNullable<z.ZodNumber>>);

/**
 * The measurement:
 * - `url`: the document's URL when measured (`document.URL`, at most `maxUrlChars`, http(s));
 * - `measuredAt` (epoch ms) and `durationMs` (how long this collection took in the page);
 * - `vitals` (`VitalValuesSchema`);
 * - `loadedHidden`: the page was hidden (a background tab) before its first paint, so paint metrics
 *   are not meaningful and web-vitals reports none;
 * - `navigation` (`null` when the document has no navigation entry);
 * - `resources`: the first `maxResources` entries observed, `resourceTotal` all of them, and
 *   `overflow` the summed sizes of those not itemised (`weight`: each one's transfer size, or its
 *   encoded size when it came from the cache);
 * - `bufferFull`: the browser's resource timing buffer was already full when the collector started
 *   observing, so requests made before then may be missing;
 * - `dom`: the document's element count, and its depth (the deepest element, `html` at 1) from a
 *   walk of at most `maxDomWalk` elements within `domWalkBudgetMs` (`depthComplete` false past it).
 */
export const PerformanceMeasurementSchema = z
  .strictObject({
    url: z.string().min(1).max(SNAPSHOT_LIMITS.maxUrlChars).refine(isWebUrl, { message: 'not an http(s) URL' }),
    measuredAt: z.number().nonnegative(),
    durationMs: time,
    vitals: VitalValuesSchema,
    loadedHidden: z.boolean(),
    navigation: NavigationTimingSchema.nullable(),
    resources: z.array(ResourceRecordSchema).max(S.maxResources),
    resourceTotal: count,
    overflow: z.strictObject({ transfer: bytes, encoded: bytes, decoded: bytes, weight: bytes }),
    bufferFull: z.boolean(),
    dom: z.strictObject({ elements: count, depth: count, depthComplete: z.boolean() }),
  })
  .refine((m) => m.resourceTotal >= m.resources.length, { message: 'a total is below its list' });
export type PerformanceMeasurement = z.infer<typeof PerformanceMeasurementSchema>;
export type ResourceRecord = z.infer<typeof ResourceRecordSchema>;
export type NavigationTiming = z.infer<typeof NavigationTimingSchema>;

/**
 * The page's render-blocking scripts, read by the extractor (`ExtractedSnapshot.blockingScripts`):
 * every `<script src>` in `<head>` that is classic (no `type`, or a JavaScript MIME type), not
 * `async` (the property: a script inserted by script is async by default) and not `defer`, and
 * not `nomodule`. Their resolved URLs (the first `MAX_BLOCKING_SCRIPTS`) and how many there are.
 * Optional, so older snapshots (and test fixtures) without it still parse; the extractor always
 * sends it.
 */
export const BlockingScriptsSchema = z
  .strictObject({ urls: z.array(z.string().max(SNAPSHOT_LIMITS.maxUrlChars)).max(MAX_BLOCKING_SCRIPTS), total: z.int().nonnegative().max(SNAPSHOT_LIMITS.maxCount) })
  .refine((b) => b.total >= b.urls.length, { message: 'a total is below its list' });
export type BlockingScripts = z.infer<typeof BlockingScriptsSchema>;

/**
 * What main collects for the audit beside the snapshot and `PageContext`: the page's speed
 * measurement at audit time (`null`: not measured). Parsed on its own in the worker: an invalid
 * measurement is dropped (`null`), never a failed audit.
 */
export interface PerformanceContext {
  readonly performance?: PerformanceMeasurement | null;
}
