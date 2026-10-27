import { NO_RETURN_STATUSES, SITEMAP_LIMITS, type CheckRunStatus, type HreflangRunState, type LinkBrokenReason, type LinkRunState, type SitemapRunState } from '@app/specs/seo-checks.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { ChecksContext, PageLink } from '@app/specs/seo-snapshot.spec';
import { linkTargetKey } from './links';

// What the rules read from the checks that ran on a page (`PageContext.checks`, spec
// `seo-checks.schema.ts`, `ChecksContextSchema`; acceptance `seo-checks.feature.md`, Rules). Main
// builds it from its runs, the audit's worker validates it with the rest of the page's context.
// Only a finished run counts (`done`, or `stopped` by the user with what it had): a running,
// cancelled or failed one is left out, so its rules pass. A URL the context could not hold (not
// `http(s)`, or past `maxUrlChars`) is left out too, so the context always validates.

const FINISHED: ReadonlySet<CheckRunStatus> = new Set(['done', 'stopped']);
const NO_RETURN: ReadonlySet<string> = new Set(NO_RETURN_STATUSES);
/** A URL the context can hold. */
const fits = (url: string | null): url is string => url !== null && url.length > 0 && url.length <= SNAPSHOT_LIMITS.maxUrlChars && /^https?:\/\//i.test(url);

/** The page's link targets (`linkTargetKey`) that are internal. */
function internalTargets(links: readonly PageLink[]): Set<string> {
  const keys = new Set<string>();
  for (const link of links) {
    if (link.kind !== 'internal') continue;
    const key = linkTargetKey(link.href);
    if (key !== null) keys.add(key);
  }
  return keys;
}

/** The checks context of a page from its runs (each `null` until finished); `links` are the audit's links (for which are internal). */
export function checksContextOf(runs: { readonly links: LinkRunState; readonly sitemaps: SitemapRunState; readonly hreflang: HreflangRunState }, links: readonly PageLink[]): ChecksContext {
  let linkPart: ChecksContext['links'] = null;
  if (FINISHED.has(runs.links.status)) {
    const internal = internalTargets(links);
    const fetched = runs.links.results.filter((result) => result.kind !== 'skipped' && result.kind !== 'blocked');
    linkPart = {
      checked: fetched.length,
      broken: fetched.filter((result) => result.kind === 'broken' && fits(result.url)).map((result) => ({ url: result.url, status: result.status, reason: result.reason as LinkBrokenReason })),
      internalRedirects: fetched.filter((result) => result.kind === 'redirect' && fits(result.url) && fits(result.finalUrl) && internal.has(result.url)).map((result) => ({ url: result.url, finalUrl: result.finalUrl!, status: result.status })),
    };
  }
  const sitemaps = runs.sitemaps;
  const sitemapPart: ChecksContext['sitemaps'] = FINISHED.has(sitemaps.status)
    ? { files: Math.min(sitemaps.files.length, SITEMAP_LIMITS.maxFiles), urlCount: Math.min(sitemaps.urlCount, SITEMAP_LIMITS.maxUrls), listed: sitemaps.listed, errors: sitemaps.errors.filter((error) => error.url.length > 0 && error.url.length <= SNAPSHOT_LIMITS.maxUrlChars).slice(0, SITEMAP_LIMITS.maxErrors).map((error) => ({ ...error })) }
    : null;
  const hreflang = runs.hreflang;
  const hreflangPart: ChecksContext['hreflang'] = FINISHED.has(hreflang.status)
    ? {
        checked: hreflang.alternates.filter((alternate) => alternate.status !== 'skipped').length,
        noReturn: hreflang.alternates.filter((alternate) => NO_RETURN.has(alternate.status) && fits(alternate.url)).map((alternate) => ({ lang: alternate.lang.slice(0, SNAPSHOT_LIMITS.maxHreflangChars), url: alternate.url, status: alternate.status as (typeof NO_RETURN_STATUSES)[number] })),
      }
    : null;
  return { links: linkPart, sitemaps: sitemapPart, hreflang: hreflangPart };
}
