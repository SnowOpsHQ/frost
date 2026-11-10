import { crawlAudit, crawlContext, crawlRobotsParse, crawlRobotsRulesOf, servedToPageSnapshot, type CrawlRobotsParse } from '@app/seo-core';
import { SitemapJobSchema, type SitemapJob } from '@app/specs/seo-checks.schema';
import type { ServedParseInput } from '@app/specs/seo-javascript.schema';
import { ROBOTS_FETCH_LIMITS } from '@app/specs/seo-indexability.spec';
import { RobotsFetchSchema } from '@app/specs/seo-snapshot.spec';
import { CrawlPageAnalysisSchema, CrawlPageJobSchema, type CrawlPageAnalysis, type CrawlPageJob } from '@app/specs/site-crawl.schema';
import { CRAWL_LIMITS } from '@app/specs/site-crawl.spec';
import { parseSitemap, type SitemapParse } from '../seo/checks-analyse';
import { parseServedHtml } from '../seo/served-parse';

// The crawl worker's jobs (spec `site-crawl.schema.ts`, `CrawlPageJobSchema`, `CrawlPageAnalysisSchema`;
// acceptance `site-crawl.feature.md`, The crawl worker; plan Decision 6 and Task 6b). Run by the analysis
// worker's bundle (`analysis-worker.ts`, job kinds `crawl`, `crawl-robots`, `crawl-sitemap`) in a
// worker instance of the crawl's own (`crawl/index.ts`), never on main's thread. Pure, no Electron:
// - `crawl`: one page's served HTML, parsed with `skipExtraText` (no source text, no lead text), adapted
//   to a page snapshot (`servedToPageSnapshot`) with the fetch's context (`crawlContext`), audited with
//   the crawl rules only (`crawlAudit`); answered as the score, the verdict, the findings, the row's facts
//   and the links found, checked against `CrawlPageAnalysisSchema` before it leaves;
// - `crawl-robots`: robots.txt text parsed for the crawl (groups, sitemaps, `Crawl-delay`), answered as
//   data; main matches URLs against it (`crawlRobotsRulesOf`), always with the bare token;
// - `crawl-sitemap`: one sitemap file read once as the sitemap check reads it (`parseSitemap`,
//   `SITEMAP_LIMITS`), its `<loc>` URLs kept here and handed out a window at a time (`CrawlSitemapInput`).

export type CrawlPageResult = { readonly ok: true; readonly page: CrawlPageAnalysis } | { readonly ok: false; readonly reason: 'parse-failed' | 'analysis-failed' };
export type CrawlRobotsResult = { readonly ok: true; readonly robots: CrawlRobotsParse } | { readonly ok: false; readonly reason: 'invalid-job' | 'analysis-failed' | 'analysis-timeout' };
export type CrawlSitemapResult = { readonly ok: true; readonly sitemap: SitemapParse; readonly urls: readonly string[]; readonly total: number } | { readonly ok: false; readonly reason: 'invalid-job' | 'analysis-failed' | 'analysis-timeout' };

export { crawlRobotsRulesOf };

/** The served parse's input for a crawl job: the bytes, their type and URL, and no extra text (`skipExtraText`). */
export function crawlParseInput(job: Pick<CrawlPageJob, 'url' | 'contentType' | 'body'>): ServedParseInput {
  return { url: job.url, contentType: job.contentType, body: job.body, skipExtraText: true };
}

const tokens = (rel: string): string[] => rel.toLowerCase().split(/\s+/).filter(Boolean);

/** Validates and runs one page's job (`CrawlPageJobSchema`); never throws. */
export function analyseCrawlPage(raw: unknown): CrawlPageResult {
  let job: CrawlPageJob;
  try {
    const parsed = CrawlPageJobSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'parse-failed' };
    job = parsed.data;
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
  const served = parseServedHtml(crawlParseInput(job));
  if (!served.ok) return { ok: false, reason: 'parse-failed' };
  try {
    const robots = RobotsFetchSchema.safeParse(job.robots);
    const snapshot = servedToPageSnapshot(served.snapshot, { extractedAt: job.extractedAt, durationMs: job.durationMs });
    const context = crawlContext({ url: job.url, status: job.status, headers: job.headers, xRobotsTag: job.xRobotsTag, chain: job.chain }, robots.success ? robots.data : null);
    const audit = crawlAudit(snapshot, context);
    const seen = new Set<string>();
    const page: CrawlPageAnalysis = {
      score: audit.score,
      indexable: audit.indexable,
      // One finding per rule (a rule counts once per page, as in the score).
      findings: audit.findings.filter((finding) => !seen.has(finding.ruleId) && seen.add(finding.ruleId)).map((finding) => ({ id: finding.ruleId as CrawlPageAnalysis['findings'][number]['id'], severity: finding.severity })),
      title: served.snapshot.titles[0]?.text ?? null,
      canonical: audit.indexability.canonical.effective,
      wordCount: served.snapshot.wordCount,
      linkTotal: served.snapshot.linkTotal,
      links: served.snapshot.links.filter((link) => link.scheme === 'http:' || link.scheme === 'https:').map((link) => ({ url: link.href, nofollow: tokens(link.rel).includes('nofollow') })),
    };
    const checked = CrawlPageAnalysisSchema.safeParse(page);
    return checked.success ? { ok: true, page: checked.data } : { ok: false, reason: 'analysis-failed' };
  } catch {
    return { ok: false, reason: 'analysis-failed' };
  }
}

/** Parses one robots.txt for the crawl (`{ text }`, at most the robots fetcher's byte cap); never throws. */
export function parseCrawlRobots(raw: unknown): CrawlRobotsResult {
  const text = (raw as { text?: unknown } | null)?.text;
  // Decoded text: at most as many UTF-16 units as the fetch's bytes (a byte decodes to at most one unit).
  if (typeof text !== 'string' || text.length > ROBOTS_FETCH_LIMITS.maxBytes) return { ok: false, reason: 'invalid-job' };
  try {
    return { ok: true, robots: crawlRobotsParse(text) };
  } catch {
    return { ok: false, reason: 'analysis-failed' };
  }
}

/**
 * One sitemap window job (`crawl-sitemap`). The first, with the file (`job`), parses it once and keeps
 * its `<loc>` URLs (at most `job.urlBudget`) in this worker under `key`; the next windows name `key`
 * and `skip` only (the file is neither sent nor parsed again); `release` drops what `key` holds. One
 * file is kept at a time (a new `key` replaces it); a window for a key not held is `invalid-job`.
 */
export type CrawlSitemapInput =
  | { readonly key: string; readonly job: SitemapJob; readonly take: number }
  | { readonly key: string; readonly skip: number; readonly take: number }
  | { readonly key: string; readonly release: true };

/** The one file this worker holds for the crawl's seeding (bounded: one file, at most `urlBudget` URLs). */
let held: { readonly key: string; readonly sitemap: SitemapParse; readonly urls: readonly string[] } | null = null;

const EMPTY_SITEMAP: SitemapParse = { type: null, gzip: false, entries: 0, counted: 0, listed: false, children: [], lastmodInvalid: 0, lastmodFuture: 0, lastmodSamples: [], error: null };
const window = (urls: readonly string[], skip: number, take: number): string[] => urls.slice(skip, skip + take);

/** Runs one sitemap window job (`CrawlSitemapInput`; `take` at most `CRAWL_LIMITS.sitemapUrlsPerJob`); never throws. */
export function parseCrawlSitemap(raw: unknown): CrawlSitemapResult {
  const input = (raw ?? {}) as { key?: unknown; job?: unknown; skip?: unknown; take?: unknown; release?: unknown };
  const key = input.key;
  if (typeof key !== 'string' || key === '' || key.length > 128) return { ok: false, reason: 'invalid-job' };
  if (input.release === true) {
    if (held?.key === key) held = null;
    return { ok: true, sitemap: EMPTY_SITEMAP, urls: [], total: 0 };
  }
  const take = input.take;
  if (!Number.isInteger(take) || (take as number) < 0 || (take as number) > CRAWL_LIMITS.sitemapUrlsPerJob) return { ok: false, reason: 'invalid-job' };
  if (input.job === undefined) {
    const skip = input.skip;
    if (held === null || held.key !== key || !Number.isInteger(skip) || (skip as number) < 0) return { ok: false, reason: 'invalid-job' };
    return { ok: true, sitemap: held.sitemap, urls: window(held.urls, skip as number, take as number), total: held.urls.length };
  }
  const job = SitemapJobSchema.safeParse(input.job);
  if (!job.success) return { ok: false, reason: 'invalid-job' };
  try {
    held = null;
    const urls: string[] = [];
    const sitemap = parseSitemap(job.data as SitemapJob, { skip: 0, take: job.data.urlBudget, into: urls });
    held = { key, sitemap, urls };
    return { ok: true, sitemap, urls: window(urls, 0, take as number), total: urls.length };
  } catch {
    return { ok: false, reason: 'analysis-failed' };
  }
}
