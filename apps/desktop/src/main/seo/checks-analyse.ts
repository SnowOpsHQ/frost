import { gunzipSync } from 'node:zlib';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { decodeRobotsBytes, headHreflangLinks, lastmodIssue, matchRobots, parseLinkHeader, parseRobotsTxt, reciprocityOf, robotsPathOf, type ReturnLink } from '@app/seo-core';
import { HREFLANG_CHECK_LIMITS, LINK_ROBOTS_AGENT, SITEMAP_LIMITS, SITEMAP_NAMESPACE, type SitemapErrorKind } from '@app/specs/seo-checks.spec';
import { ChecksJobSchema, type HreflangJob, type RobotsJob, type SitemapJob } from '@app/specs/seo-checks.schema';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { RobotsFetchSchema } from '@app/specs/seo-snapshot.spec';

// What the checks' analysis worker does with one job (spec `seo-checks.schema.ts`, `ChecksJobSchema`;
// acceptance `seo-checks.feature.md`, Sitemaps, hreflang reciprocity, Link checks). Everything a
// server sent is read here, never on main's thread: a sitemap file (gzip inflated up to
// `SITEMAP_LIMITS.maxBytes`, then streamed through a non-validating XML parser that refuses any
// DOCTYPE, so no DTD is read and no entity is ever defined or expanded), an alternate's head and
// `Link` header, and robots.txt for which same-origin links it blocks. Pure, with no Electron: the
// worker (`analysis-worker.ts`) runs it.

/** What one sitemap file held, as far as it was read. */
export interface SitemapParse {
  readonly type: 'urlset' | 'index' | null;
  readonly gzip: boolean;
  /** `<url>` or `<sitemap>` entries seen. */
  readonly entries: number;
  /** `<url>` entries counted (at most the job's `urlBudget`). */
  readonly counted: number;
  /** One counted `<loc>` is the page's URL or its canonical (fragment aside). */
  readonly listed: boolean;
  /** An index's `<sitemap>` locations (`http(s)`, at most `SITEMAP_LIMITS.maxFiles`). */
  readonly children: readonly string[];
  readonly lastmodInvalid: number;
  readonly lastmodFuture: number;
  /** The first few `lastmod` problems, as `value (issue)`. */
  readonly lastmodSamples: readonly string[];
  readonly error: SitemapErrorKind | null;
}

export interface HreflangParse {
  readonly status: 'reciprocal' | 'wrong-language' | 'missing-return';
  readonly returnLangs: readonly string[];
}

export interface RobotsParse {
  /** One per job URL: disallowed for `LINK_ROBOTS_AGENT`. */
  readonly blocked: readonly boolean[];
  readonly sitemaps: readonly string[];
}

export type ChecksAnalysis = { readonly kind: 'sitemap'; readonly sitemap: SitemapParse } | { readonly kind: 'hreflang'; readonly hreflang: HreflangParse } | { readonly kind: 'robots'; readonly robots: RobotsParse };
export type ChecksAnalysisResult = ({ readonly ok: true } & ChecksAnalysis) | { readonly ok: false; readonly reason: 'invalid-job' | 'analysis-failed' | 'analysis-timeout' };

/** Stops the XML parse with why. */
class Stop extends Error {
  constructor(readonly kind: SitemapErrorKind) {
    super(kind);
  }
}

/**
 * `value` as a document key (parsed, `http(s)`, no fragment), or `null`. Parsing makes
 * `https://a.example` and `https://a.example/` one key (the root path is always `/`); any other
 * path keeps its trailing slash or lack of one, as servers may treat them as two pages.
 */
function keyOf(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** The bytes to parse: inflated (up to `maxBytes`) when they start with gzip's magic bytes. */
function inflate(bytes: Uint8Array): { ok: true; bytes: Uint8Array; gzip: boolean } | { ok: false; gzip: true; error: SitemapErrorKind } {
  if (bytes.byteLength < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { ok: true, bytes, gzip: false };
  try {
    // Inflates chunk by chunk and stops once the output passes the cap (`ERR_BUFFER_TOO_LARGE`).
    return { ok: true, bytes: gunzipSync(bytes, { maxOutputLength: SITEMAP_LIMITS.maxBytes }), gzip: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ok: false, gzip: true, error: code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError ? 'too-large' : 'malformed' };
  }
}

/** The text is fed to the parser in pieces of this many bytes (decoded as UTF-8, streaming). */
const FEED_BYTES = 256 * 1024;

/** Reads one sitemap file (`SitemapJob`). Never throws. */
export function parseSitemap(job: SitemapJob): SitemapParse {
  // The page is listed under its own URL or its effective canonical.
  const pageKeys = new Set([keyOf(job.pageUrl), job.canonicalUrl ? keyOf(job.canonicalUrl) : null].filter((key): key is string => key !== null));
  let type: SitemapParse['type'] = null;
  let entries = 0;
  let counted = 0;
  let listed = false;
  const children: string[] = [];
  let lastmodInvalid = 0;
  let lastmodFuture = 0;
  const lastmodSamples: string[] = [];
  let error: SitemapErrorKind | null = null;
  const inflated = inflate(job.bytes);
  const result = (): SitemapParse => ({ type, gzip: inflated.gzip, entries, counted, listed, children, lastmodInvalid, lastmodFuture, lastmodSamples, error });
  if (!inflated.ok) {
    error = inflated.error;
    return result();
  }

  const parser = new SaxesParser({ xmlns: true, position: false });
  let depth = 0;
  // The entry being read (`<url>` / `<sitemap>`), and the child whose text is captured.
  let entry: { loc: string | null; lastmod: string | null } | null = null;
  let capture: 'loc' | 'lastmod' | null = null;
  let text = '';
  let overlong = false;
  const take = (chunk: string): void => {
    if (capture === null || overlong) return;
    if (text.length + chunk.length > SITEMAP_LIMITS.maxLocChars) {
      overlong = true;
      return;
    }
    text += chunk;
  };
  parser.on('doctype', () => {
    throw new Stop('dtd-refused');
  });
  parser.on('error', () => {
    throw new Stop('malformed');
  });
  parser.on('opentag', (tag: SaxesTagNS) => {
    depth += 1;
    // A sitemap is three levels deep; nesting far past that only costs the parser (its work grows
    // with the square of the depth): the file is not a sitemap frost reads.
    if (depth > SITEMAP_LIMITS.maxXmlDepth) throw new Stop('malformed');
    if (depth === 1) {
      if (tag.local === 'urlset') type = 'urlset';
      else if (tag.local === 'sitemapindex') type = 'index';
      else throw new Stop('not-sitemap');
      if (tag.uri !== SITEMAP_NAMESPACE) error ??= 'wrong-namespace';
      return;
    }
    if (depth === 2 && ((type === 'urlset' && tag.local === 'url') || (type === 'index' && tag.local === 'sitemap'))) {
      entries += 1;
      entry = { loc: null, lastmod: null };
      return;
    }
    if (depth === 3 && entry !== null && (tag.local === 'loc' || tag.local === 'lastmod')) {
      capture = tag.local;
      text = '';
      overlong = false;
    }
  });
  parser.on('text', take);
  parser.on('cdata', take);
  parser.on('closetag', () => {
    if (depth === 3 && capture !== null && entry !== null) {
      if (!overlong) entry[capture] ??= text.trim();
      capture = null;
    } else if (depth === 2 && entry !== null) {
      const done = entry;
      entry = null;
      if (type === 'urlset') {
        if (counted >= job.urlBudget) throw new Stop('too-many-urls');
        counted += 1;
        if (!listed && done.loc !== null && pageKeys.has(keyOf(done.loc) ?? '')) listed = true;
      } else if (done.loc !== null && children.length < SITEMAP_LIMITS.maxFiles) {
        const child = keyOf(done.loc);
        if (child !== null) children.push(child);
      }
      if (done.lastmod !== null) {
        const issue = lastmodIssue(done.lastmod, job.now);
        if (issue === 'invalid') lastmodInvalid += 1;
        if (issue === 'future') lastmodFuture += 1;
        if (issue !== null && lastmodSamples.length < SITEMAP_LIMITS.maxSamples) lastmodSamples.push(`${done.lastmod.slice(0, 64)} (${issue})`);
      }
    }
    depth -= 1;
  });

  try {
    const decoder = new TextDecoder('utf-8');
    const bytes = inflated.bytes;
    for (let at = 0; at < bytes.byteLength; at += FEED_BYTES) {
      const end = Math.min(bytes.byteLength, at + FEED_BYTES);
      parser.write(decoder.decode(bytes.subarray(at, end), { stream: end < bytes.byteLength }));
    }
    parser.close();
    if (type === null) error ??= 'malformed';
  } catch (stopped) {
    error = stopped instanceof Stop ? stopped.kind : 'malformed';
  }
  return result();
}

/** Reads an alternate's head and `Link` header (`HreflangJob`) and whether they list this page back. */
export function parseAlternate(job: HreflangJob): HreflangParse {
  const html = job.bytes.byteLength === 0 ? '' : new TextDecoder('utf-8').decode(job.bytes);
  const links: ReturnLink[] = headHreflangLinks(html, HREFLANG_CHECK_LIMITS.maxLinks).map((link) => ({ hreflang: link.hreflang.slice(0, SNAPSHOT_LIMITS.maxHreflangChars), resolved: keyOf(link.href, job.url) }));
  if (job.link !== null) {
    for (const value of parseLinkHeader(job.link, HREFLANG_CHECK_LIMITS.maxLinks)) {
      if (value.rel.includes('alternate') && value.hreflang !== null) links.push({ hreflang: value.hreflang.slice(0, SNAPSHOT_LIMITS.maxHreflangChars), resolved: keyOf(value.target, job.url) });
    }
  }
  const answer = reciprocityOf(links, job.pageKeys, job.selfLangs);
  return { status: answer.status, returnLangs: answer.returnLangs.slice(0, HREFLANG_CHECK_LIMITS.maxAlternates) };
}

/** Which job URLs robots.txt blocks for `LINK_ROBOTS_AGENT`, and its sitemaps (`RobotsJob`). Only a fetched file (`ok`) blocks anything. */
export function parseRobots(job: RobotsJob): RobotsParse {
  const fetched = RobotsFetchSchema.safeParse(job.robots);
  if (!fetched.success || fetched.data.outcome !== 'ok') return { blocked: job.urls.map(() => false), sitemaps: [] };
  const file = parseRobotsTxt(decodeRobotsBytes(fetched.data.body));
  const base = fetched.data.finalUrl ?? fetched.data.url;
  const blocked = job.urls.map((url) => {
    try {
      return !matchRobots(file, LINK_ROBOTS_AGENT, robotsPathOf(new URL(url))).allowed;
    } catch {
      return false;
    }
  });
  const sitemaps = [...new Set(file.sitemaps.map((sitemap) => keyOf(sitemap.raw, base)).filter((url): url is string => url !== null && url.length <= SNAPSHOT_LIMITS.maxUrlChars))].slice(0, SITEMAP_LIMITS.maxSources);
  return { blocked, sitemaps };
}

/** Validates and runs one checks job; never throws. */
export function analyseCheck(raw: unknown): ChecksAnalysisResult {
  let job;
  try {
    const parsed = ChecksJobSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'invalid-job' };
    job = parsed.data;
  } catch {
    return { ok: false, reason: 'invalid-job' };
  }
  try {
    switch (job.kind) {
      case 'sitemap':
        return { ok: true, kind: 'sitemap', sitemap: parseSitemap(job) };
      case 'hreflang':
        return { ok: true, kind: 'hreflang', hreflang: parseAlternate(job) };
      default:
        return { ok: true, kind: 'robots', robots: parseRobots(job) };
    }
  } catch {
    return { ok: false, reason: 'analysis-failed' };
  }
}
