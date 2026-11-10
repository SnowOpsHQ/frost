/**
 * The site crawler's shapes (Phase 12 Task 5; plain values and prose in `site-crawl.spec.ts`;
 * acceptance `site-crawl.feature.md`). Main-only Zod: the chrome imports types only.
 *
 * - `CrawlSettingsSchema`: what a run is started with (strict and bounded; prefixes only, never a
 *   pattern; a private start is limited to the `host` scope).
 * - `CrawlFindingSchema`, `CrawlPageRowSchema`: one crawled page as stored (`crawl_pages`) and listed.
 * - `CrawlRunViewSchema`: one run as listed; `CrawlStatusViewSchema`: the crawl view main answers,
 *   carrying `available` (the L6 gate, `CRAWL_AVAILABLE`), so the renderer learns it from main.
 */
import { z } from 'zod';
import { UUIDV7_PATTERN } from './capture-db.spec';
import { isIpLiteral, isPrivateHost } from './private-address.spec';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import { SEO_SEVERITIES } from './seo-rules.spec';
import {
  CRAWL_INTERVAL_MS,
  CRAWL_LIMITS as L,
  CRAWL_PAGE_OUTCOMES,
  CRAWL_PRIVATE_START_SCOPES,
  CRAWL_ROBOTS_VERDICTS,
  CRAWL_RULE_IDS,
  CRAWL_RUN_REASONS,
  CRAWL_RUN_STATES,
  CRAWL_SCOPES,
  type CrawlScope,
} from './site-crawl.spec';
import { parseWebUrl } from './web-url.spec';

const count = z.int().nonnegative();
const time = z.int().nonnegative();
const id = z.string().regex(UUIDV7_PATTERN);

/** An `http(s)` URL with a host and no userinfo, at most `maxUrlChars`. */
export const CrawlUrlSchema = z
  .string()
  .min(1)
  .max(L.maxUrlChars)
  .refine((value) => {
    const url = parseWebUrl(value);
    return url !== null && url.username === '' && url.password === '';
  }, { message: 'not an http(s) URL without credentials' });

/**
 * An include or exclude prefix: literal text a URL's path (and query) must start with, beginning
 * with `/`, with no white space or control character. Never a pattern: `*`, `?` and the like are
 * plain characters.
 */
export const CrawlPrefixSchema = z
  .string()
  .min(1)
  .max(L.maxPrefixChars)
  .refine((value) => value.startsWith('/') && !/[\s\u0000-\u001f\u007f-\u009f]/.test(value), { message: 'a prefix is a path starting with /' });

const prefixes = z.array(CrawlPrefixSchema).max(L.maxPrefixes);

/**
 * A run's settings. A start URL on a private host (`isPrivateHost`) may use only
 * `CRAWL_PRIVATE_START_SCOPES` (`host`, narrowed to its exact origin by the crawl); `site` needs a
 * registrable domain, so an IP-literal start refuses it too.
 */
export const CrawlSettingsSchema = z
  .strictObject({
    startUrl: CrawlUrlSchema,
    scope: z.enum(CRAWL_SCOPES),
    include: prefixes,
    exclude: prefixes,
    maxPages: z.int().min(1).max(L.maxPagesCap),
    intervalMs: z.int().min(CRAWL_INTERVAL_MS.min).max(CRAWL_INTERVAL_MS.max),
    /** Whether the run seeds its frontier from the site's sitemaps (robots.txt `Sitemap:` lines, else `/sitemap.xml`). */
    sitemaps: z.boolean(),
  })
  .superRefine((settings, ctx) => {
    const url = parseWebUrl(settings.startUrl);
    if (url === null) return;
    if (isPrivateHost(url.hostname) && !(CRAWL_PRIVATE_START_SCOPES as readonly CrawlScope[]).includes(settings.scope)) {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'a crawl of a private address stays on its exact origin (scope host)' });
    } else if (settings.scope === 'site' && isIpLiteral(url.hostname)) {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'an IP address has no registrable domain (scope site)' });
    }
  });
export type CrawlSettings = z.infer<typeof CrawlSettingsSchema>;

/** The default settings for a start URL (the start form's initial values). */
export function defaultCrawlSettings(startUrl: string): CrawlSettings {
  return { startUrl, scope: 'host', include: [], exclude: [], maxPages: L.defaultMaxPages, intervalMs: CRAWL_INTERVAL_MS.default, sitemaps: true };
}

/** A failing served-HTML rule on a page (the rule counts once per page, as in the health score). */
export const CrawlFindingSchema = z.strictObject({
  id: z.enum(CRAWL_RULE_IDS),
  severity: z.enum(SEO_SEVERITIES),
});
export type CrawlFinding = z.infer<typeof CrawlFindingSchema>;

/**
 * One page of a run, as stored (`crawl_pages`) and as the Pages view lists it. Fields the fetch or
 * the parse did not produce are `null` (a page refused by robots.txt has no status, a `not-html`
 * page no title). `linkTotal` is every link the served HTML holds; `linksCut` marks a page with more
 * than the served parse keeps (`SNAPSHOT_LIMITS.maxLinks`). Strict on write; on read, a finding whose
 * id is no longer a crawl rule is dropped (the row stays).
 */
export const CrawlPageRowSchema = z.strictObject({
  runId: id,
  url: CrawlUrlSchema,
  depth: z.int().min(0).max(L.maxDepth),
  outcome: z.enum(CRAWL_PAGE_OUTCOMES),
  status: z.int().min(100).max(599).nullable(),
  finalUrl: z.string().min(1).max(L.maxUrlChars).nullable(),
  contentType: z.string().max(256).nullable(),
  title: z.string().max(SNAPSHOT_LIMITS.maxTextChars).nullable(),
  canonical: z.string().max(L.maxUrlChars).nullable(),
  /** Indexable as the sidebar's verdict would say (`null`: not crawled, nothing to judge). */
  indexable: z.boolean().nullable(),
  /** robots.txt for `CRAWL_ROBOTS_TOKEN` (the crawl's own), and for Googlebot from the same file. */
  robotsCrawl: z.enum(CRAWL_ROBOTS_VERDICTS),
  robotsGooglebot: z.enum(CRAWL_ROBOTS_VERDICTS),
  wordCount: count.nullable(),
  linkTotal: count,
  linksCut: z.boolean(),
  /** The served-HTML score (`CRAWL_SCORE_LABEL`), 0–100; `null` unless `crawled`. */
  score: z.int().min(0).max(100).nullable(),
  findings: z.array(CrawlFindingSchema).max(CRAWL_RULE_IDS.length),
  /** Links on the page (its inlinks are its frontier entry's: `crawl_frontier.inlinks`, joined on `(runId, url)`). */
  outlinks: count,
  /** Body bytes read (at most `CRAWL_LIMITS.maxBodyBytes`). */
  bytes: z.int().nonnegative().max(L.maxBodyBytes),
  fetchedAt: time,
});
export type CrawlPageRow = z.infer<typeof CrawlPageRowSchema>;

/**
 * A run's counts: page rows recorded (`pages`), URLs still queued, rows refused by the crawl's policy
 * (`refused`: `CRAWL_REFUSED_OUTCOMES`, robots.txt, scope and the address rule), rows whose fetch failed
 * (`failed`: `CRAWL_FAILED_OUTCOMES`), and body bytes read.
 */
export const CrawlRunCountsSchema = z.strictObject({
  pages: count,
  queued: count,
  refused: count,
  failed: count,
  bytes: count,
});
export type CrawlRunCounts = z.infer<typeof CrawlRunCountsSchema>;

/** One run as listed (`crawl_runs`). */
export const CrawlRunViewSchema = z.strictObject({
  id,
  /** The project it belongs to (deleted with it), or `null` (a crawl started from a tab). */
  projectId: id.nullable(),
  /** The start URL as stored (shown even when `settings` is `null`). */
  startUrl: z.string().min(1).max(L.maxUrlChars),
  /**
   * The run's settings; `null` when the stored settings no longer parse (a newer build's, or a
   * tampered file): such a run is still listed and deletable, never resumed.
   */
  settings: CrawlSettingsSchema.nullable(),
  state: z.enum(CRAWL_RUN_STATES),
  reason: z.enum(CRAWL_RUN_REASONS).nullable(),
  counts: CrawlRunCountsSchema,
  createdAt: time,
  updatedAt: time,
  /** When it reached `done`, `cancelled` or `failed`; `null` before. */
  finishedAt: time.nullable(),
});
export type CrawlRunView = z.infer<typeof CrawlRunViewSchema>;

/**
 * The crawl view main answers: whether a crawl may be started or resumed in this build
 * (`available`, the L6 gate; the renderer hides or disables Start and Resume with the gate's note
 * when it is `false`), the run in progress, if any, and the runs, newest first.
 */
export const CrawlStatusViewSchema = z.strictObject({
  available: z.boolean(),
  activeRunId: id.nullable(),
  runs: z.array(CrawlRunViewSchema).max(L.maxListedRuns),
});
export type CrawlStatusView = z.infer<typeof CrawlStatusViewSchema>;
