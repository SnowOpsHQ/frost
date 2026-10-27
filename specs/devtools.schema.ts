/**
 * The `devtools.*` procedures' inputs and the analysis worker's robots.txt verdict job (Phase 2.5
 * Task 5; acceptance `devtools.feature.md`, Router). Main-only (Zod): the chrome imports the plain
 * values and types of `devtools.spec.ts`. Every procedure is `enforceSender`-first; these schemas are
 * strict, so an unknown key or an over-long value is refused before the service is called.
 */
import { z } from 'zod';
import { COOKIE_LIMITS, NETWORK_LIMITS, ROBOTS_VERDICT_BATCH } from './devtools.spec';
import { RobotsFetchSchema } from './seo-snapshot.spec';
import { isWebUrl } from './web-url.spec';

const tabId = z.int().positive();

/** `devtools.network` / `redirects` / `console` / `storage` / `clearSiteData`: the tab (the active one, from the drawer). */
export const DevtoolsTabInputSchema = z.strictObject({ tabId });
export type DevtoolsTabInput = z.infer<typeof DevtoolsTabInputSchema>;

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
