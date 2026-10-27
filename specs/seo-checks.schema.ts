/**
 * The Zod side of the link, sitemap and hreflang checks (Phase 2.5 Task 7; plain values in
 * `seo-checks.spec.ts`; acceptance `seo-checks.feature.md`): the `checks.*` procedures' inputs, the
 * jobs main hands the checks' analysis worker (validated there, never on main's thread), and what
 * the audit's rules read (`PageContext.checks`, validated in the audit's worker with the rest of the
 * context). Not for the chrome renderer (no Zod there).
 */
import { z } from 'zod';
import { CHECK_KINDS, HREFLANG_CHECK_LIMITS, LINK_BROKEN_REASONS, LINK_CHECK_LIMITS, NO_RETURN_STATUSES, SITEMAP_ERROR_KINDS, SITEMAP_LIMITS } from './seo-checks.spec';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import { isWebUrl } from './web-url.spec';

const urlText = z.string().max(SNAPSHOT_LIMITS.maxUrlChars);
const webUrl = urlText.min(1).refine(isWebUrl, { message: 'not an http(s) URL' });
const status = z.int().min(100).max(999);
const count = z.int().nonnegative();
const tabId = z.int().positive();

// ---- Procedures ---------------------------------------------------------------------------------

/** `checks.checkLinks` / `checkSitemaps` / `checkHreflang` input: the tab (its ready audit is what main checks). */
export const ChecksTabInputSchema = z.strictObject({ tabId });
export type ChecksTabInput = z.infer<typeof ChecksTabInputSchema>;

/** `checks.watch` input: the tab, and the last version the chrome has (`-1`: none yet, answered at once). */
export const ChecksWatchInputSchema = z.strictObject({ tabId, sinceVersion: z.int().min(-1).max(Number.MAX_SAFE_INTEGER) });
export type ChecksWatchInput = z.infer<typeof ChecksWatchInputSchema>;

/** `checks.stop` input: the tab and which check (`CHECK_KINDS`). */
export const ChecksStopInputSchema = z.strictObject({ tabId, check: z.enum(CHECK_KINDS) });
export type ChecksStopInput = z.infer<typeof ChecksStopInputSchema>;

// ---- Worker jobs --------------------------------------------------------------------------------

/**
 * One sitemap file to parse: its bytes as downloaded (at most `maxBytes`; gzip is detected from its
 * magic bytes and inflated in the worker up to `maxBytes`), the URL it came from, the page URL to
 * look for, how many `<url>` entries the run may still count, and the check's clock.
 */
export const SitemapJobSchema = z.strictObject({
  kind: z.literal('sitemap'),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= SITEMAP_LIMITS.maxBytes, { message: 'sitemap over its cap' }),
  fileUrl: webUrl,
  pageUrl: webUrl,
  /** The page's effective canonical, also looked for (`null`: none, or the page itself). */
  canonicalUrl: webUrl.nullable().optional(),
  urlBudget: z.int().nonnegative().max(SITEMAP_LIMITS.maxUrls),
  now: z.number().nonnegative(),
});
export type SitemapJob = z.infer<typeof SitemapJobSchema>;

/**
 * One alternate's answer to read: the first `maxBytes` of its HTML (empty when it is not HTML), the
 * URL it ended at (the base its hrefs resolve against), its `Link` header (cut), the URLs that are
 * this page (its own and its canonical) and the hreflang values the page gives itself (lowercased).
 */
export const HreflangJobSchema = z.strictObject({
  kind: z.literal('hreflang'),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= HREFLANG_CHECK_LIMITS.maxBytes, { message: 'alternate over its cap' }),
  url: webUrl,
  link: z.string().max(HREFLANG_CHECK_LIMITS.maxHeaderChars).nullable(),
  pageKeys: z.array(webUrl).min(1).max(2),
  selfLangs: z.array(z.string().max(SNAPSHOT_LIMITS.maxHreflangChars)).max(SNAPSHOT_LIMITS.maxHreflang),
});
export type HreflangJob = z.infer<typeof HreflangJobSchema>;

/**
 * Which of `urls` (same-origin link targets) the page origin's robots.txt disallows for
 * `LINK_ROBOTS_AGENT`, and its `Sitemap:` lines (resolved, `http(s)` only, at most
 * `SITEMAP_LIMITS.maxSources`). `robots` is validated as `RobotsFetchSchema` (main's fetch, cached).
 */
export const RobotsJobSchema = z.strictObject({
  kind: z.literal('robots'),
  robots: z.unknown(),
  urls: z.array(webUrl).max(LINK_CHECK_LIMITS.maxLinks),
});
export type RobotsJob = z.infer<typeof RobotsJobSchema>;

export const ChecksJobSchema = z.discriminatedUnion('kind', [SitemapJobSchema, HreflangJobSchema, RobotsJobSchema]);
export type ChecksJob = z.infer<typeof ChecksJobSchema>;

// ---- What the rules read ------------------------------------------------------------------------

const BrokenLinkSchema = z.strictObject({ url: webUrl, status: status.nullable(), reason: z.enum(LINK_BROKEN_REASONS) });
const RedirectedLinkSchema = z.strictObject({ url: webUrl, finalUrl: webUrl, status: status.nullable() });

/**
 * The checks that ran on the page shown, summarised for the rules (`CHECKS_RULE_SPECS`); each part
 * is `null` (or absent) until its check has run on the page's document and URL:
 * - `links`: how many targets were checked, the broken ones and the internal ones that redirected;
 * - `sitemaps`: files read, `<url>` entries counted, whether the page is listed (`null`: no `urlset`
 *   read), the errors (`SITEMAP_ERROR_KINDS`);
 * - `hreflang`: how many alternates were checked, and those that do not link back (`NO_RETURN_STATUSES`).
 */
export const ChecksContextSchema = z.strictObject({
  links: z
    .strictObject({
      checked: count.max(LINK_CHECK_LIMITS.maxLinks),
      broken: z.array(BrokenLinkSchema).max(LINK_CHECK_LIMITS.maxLinks),
      internalRedirects: z.array(RedirectedLinkSchema).max(LINK_CHECK_LIMITS.maxLinks),
    })
    .nullable(),
  sitemaps: z
    .strictObject({
      files: count.max(SITEMAP_LIMITS.maxFiles),
      urlCount: count.max(SITEMAP_LIMITS.maxUrls),
      listed: z.boolean().nullable(),
      errors: z.array(z.strictObject({ url: urlText.min(1), kind: z.enum(SITEMAP_ERROR_KINDS) })).max(SITEMAP_LIMITS.maxErrors),
    })
    .nullable(),
  hreflang: z
    .strictObject({
      checked: count.max(HREFLANG_CHECK_LIMITS.maxAlternates),
      noReturn: z.array(z.strictObject({ lang: z.string().max(SNAPSHOT_LIMITS.maxHreflangChars), url: webUrl, status: z.enum(NO_RETURN_STATUSES) })).max(HREFLANG_CHECK_LIMITS.maxAlternates),
    })
    .nullable(),
});
export type ChecksContext = z.infer<typeof ChecksContextSchema>;

/** No check has run on the page. */
export const NO_CHECKS: ChecksContext = { links: null, sitemaps: null, hreflang: null };
