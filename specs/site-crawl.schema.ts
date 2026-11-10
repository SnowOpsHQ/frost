/**
 * The site crawler's shapes (Phase 12 Task 5; plain values and prose in `site-crawl.spec.ts`;
 * acceptance `site-crawl.feature.md`). Main-only Zod: the chrome imports types only.
 *
 * - `CrawlSettingsSchema`: what a run is started with (strict and bounded; prefixes only, never a
 *   pattern; a private start is limited to the `host` scope).
 * - `CrawlFindingSchema`, `CrawlPageRowSchema`: one crawled page as stored (`crawl_pages`) and listed.
 * - `CrawlRunViewSchema`: one run as listed; `CrawlStatusViewSchema`: the crawl view main answers,
 *   carrying `available` (the L6 gate, `CRAWL_AVAILABLE`), so the renderer learns it from main.
 * - `CrawlStartInputSchema`: what the crawl service's `start` takes (Task 6b; Task 7's IPC parses it).
 * - `CrawlPacingSnapshotSchema`: a run's per-host pacing as stored (`crawl_runs.pacing`), main only.
 * - `CrawlPageJobSchema`, `CrawlPageAnalysisSchema` (Task 6b): one page's job for the crawl worker
 *   (the served HTML as fetched, what the fetch kept, the origin's robots.txt) and its answer (the
 *   served-HTML audit's findings and score, the facts a row keeps, the links found), each checked on
 *   arrival: the worker checks the job, main checks the answer (it is derived from crawled HTML).
 */
import { z } from 'zod';
import { UUIDV7_PATTERN } from './capture-db.spec';
import { isIpLiteral, isPrivateHost } from './private-address.spec';
import { RESPONSE_LIMITS } from './seo-indexability.spec';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import { SEO_SEVERITIES } from './seo-rules.spec';
import {
  CRAWL_INDEXABLE_FILTERS,
  CRAWL_INTERVAL_MS,
  CRAWL_KEEP_HEADERS,
  CRAWL_LIMITS as L,
  CRAWL_PACING_LIMITS,
  CRAWL_PAGE_OUTCOMES,
  CRAWL_PAGE_SORTS,
  CRAWL_PAGES_LIMITS,
  CRAWL_READ_REFUSALS,
  CRAWL_REFUSALS,
  CRAWL_SORT_DIRECTIONS,
  CRAWL_STATUS_CLASSES,
  CRAWL_TREE_LIMITS,
  CRAWL_PRIVATE_START_SCOPES,
  CRAWL_ROBOTS_VERDICTS,
  CRAWL_RULE_IDS,
  CRAWL_RUN_REASONS,
  CRAWL_RUN_STATES,
  CRAWL_SCOPES,
  type CrawlScope,
  type CrawlServiceAnswer,
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
 * plain characters. Compared case-sensitively against the URL's percent-normalised form (unreserved
 * escapes decoded, the rest upper-case hex; `CRAWL_SCOPES`), the prefix normalised the same way.
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
  /** This session's latest note about the run (`CRAWL_RUN_NOTES`; not stored); absent: none. */
  note: z.string().min(1).max(256).optional(),
});
export type CrawlRunView = z.infer<typeof CrawlRunViewSchema>;

/**
 * One host's pacing as a run keeps it (`crawl_runs.pacing`; `CRAWL_PACING_LIMITS` in
 * `site-crawl.spec.ts`): the host name (the pacing key), when its next request may start (ms since the
 * epoch) and its back-off (429 / 503 answers in a row). Main only: never sent to the renderer.
 */
export const CrawlPacedHostSchema = z.strictObject({
  host: z.string().min(1).max(CRAWL_PACING_LIMITS.maxHostChars),
  waitUntil: time,
  inARow: z.int().min(0).max(L.backoffAfter),
});
export type CrawlPacedHost = z.infer<typeof CrawlPacedHostSchema>;

/** A run's stored pacing: at most `CRAWL_LIMITS.maxPacedHosts` hosts, one entry each. */
export const CrawlPacingSnapshotSchema = z.array(CrawlPacedHostSchema).max(L.maxPacedHosts);
export type CrawlPacingSnapshot = z.infer<typeof CrawlPacingSnapshotSchema>;

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

/** What the crawl service's `start` takes: the run's settings and the project it belongs to (`null`: none). */
export const CrawlStartInputSchema = z.strictObject({ settings: CrawlSettingsSchema, projectId: id.nullable() });
export type CrawlStartInput = z.infer<typeof CrawlStartInputSchema>;

// ---- The crawl worker's page job (Task 6b) ------------------------------------------------------

/** Characters of one kept header the crawl fetch keeps (its repeated values joined): as the fetch cuts it. */
export const CRAWL_MAX_HEADER_CHARS = RESPONSE_LIMITS.maxHeaderValueChars * RESPONSE_LIMITS.maxValuesPerHeader;
/** Redirect hops a crawl page's chain holds: the fetch's own (`SERVED_FETCH_LIMITS.maxRedirects`) and a refused one. */
export const CRAWL_MAX_CHAIN = 16;

const status = z.int().min(100).max(599);
const header = z.string().max(CRAWL_MAX_HEADER_CHARS);

/**
 * One crawled page for the crawl worker (`crawl` job): the URL the HTML came from (the fetch's final
 * URL), its media type, the body as read (at most `CRAWL_LIMITS.maxBodyBytes`, cut by main before it
 * is sent), the final status, the kept headers (`CRAWL_KEEP_HEADERS`; `x-robots-tag` values apart in
 * `xRobotsTag`), the redirect hops followed, when the fetch started and how long it took, and the
 * origin's robots.txt as main's robots fetcher answered (checked in the worker with
 * `RobotsFetchSchema`; anything else reads as none).
 */
export const CrawlPageJobSchema = z.strictObject({
  url: CrawlUrlSchema,
  contentType: z.string().max(256).nullable(),
  body: z.instanceof(Uint8Array).refine((body) => body.byteLength <= L.maxBodyBytes, { message: 'body over its cap' }),
  status,
  headers: z.strictObject(Object.fromEntries(CRAWL_KEEP_HEADERS.map((name) => [name, header.optional()])) as Record<(typeof CRAWL_KEEP_HEADERS)[number], z.ZodOptional<typeof header>>),
  xRobotsTag: z.array(z.string().max(RESPONSE_LIMITS.maxHeaderValueChars * RESPONSE_LIMITS.maxValuesPerHeader)).max(RESPONSE_LIMITS.maxValuesPerHeader),
  chain: z.array(z.strictObject({ url: z.string().min(1).max(L.maxUrlChars), status, location: z.string().min(1).max(L.maxUrlChars) })).max(CRAWL_MAX_CHAIN),
  extractedAt: time,
  durationMs: z.number().nonnegative(),
  robots: z.unknown(),
});
export type CrawlPageJob = z.infer<typeof CrawlPageJobSchema>;

/** A link the served HTML holds (an `http(s)` target, resolved), and whether its `rel` says `nofollow`. */
export const CrawlFoundLinkSchema = z.strictObject({ url: z.string().min(1).max(SNAPSHOT_LIMITS.maxUrlChars), nofollow: z.boolean() });
export type CrawlFoundLink = z.infer<typeof CrawlFoundLinkSchema>;

/**
 * The crawl worker's answer for one page (`crawl` job): the served-HTML audit (`runAudit` with
 * `CRAWL_RULES` only) as a score, an indexable verdict and its findings (id and severity, once per
 * rule), the first title, the effective canonical, the word count, every link the page has
 * (`linkTotal`) and the `http(s)` ones the served parse kept (at most `SNAPSHOT_LIMITS.maxLinks`).
 * Nothing else: no source text, no lead text (`skipExtraText`).
 */
export const CrawlPageAnalysisSchema = z.strictObject({
  score: z.int().min(0).max(100),
  indexable: z.boolean(),
  findings: z.array(CrawlFindingSchema).max(CRAWL_RULE_IDS.length),
  title: z.string().max(SNAPSHOT_LIMITS.maxTextChars).nullable(),
  canonical: z.string().max(SNAPSHOT_LIMITS.maxUrlChars).nullable(),
  wordCount: count,
  linkTotal: count,
  links: z.array(CrawlFoundLinkSchema).max(SNAPSHOT_LIMITS.maxLinks),
});
export type CrawlPageAnalysis = z.infer<typeof CrawlPageAnalysisSchema>;


// ---- Pages and Site structure: the `crawl.*` procedures (Task 7) ---------------------------------

/** A run named by its id (`pause`, `resume`, `cancel`, `delete`). */
export const CrawlRunIdInputSchema = z.strictObject({ runId: id });

/** `crawl.watch`'s input: the last version the renderer saw (`0`: none). */
export const CrawlWatchInputSchema = z.strictObject({ sinceVersion: z.int().min(0).max(Number.MAX_SAFE_INTEGER) });

/** `crawl.watch`'s answer: the crawl view (`CrawlStatusViewSchema`) and the change counter it was read at. */
export const CrawlWatchViewSchema = z.strictObject({ version: z.int().min(0).max(Number.MAX_SAFE_INTEGER), status: CrawlStatusViewSchema });
export type CrawlWatchView = z.infer<typeof CrawlWatchViewSchema>;

/** The crawl service's answers as they cross IPC (`CrawlServiceAnswer`): `unavailable` carries the gate's note. */
export const CrawlServiceAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.enum(['started', 'resumed']), runId: id }),
  z.strictObject({ status: z.literal('ok') }),
  z.strictObject({ status: z.literal('refused'), reason: z.enum(CRAWL_REFUSALS), note: z.string().min(1).max(256).optional() }),
]) satisfies z.ZodType<CrawlServiceAnswer>;

/** The Pages view's filters (`CRAWL_PAGE_FILTERS`), each optional, combined with AND. */
export const CrawlPageFilterSchema = z.strictObject({
  status: z.enum(CRAWL_STATUS_CLASSES).optional(),
  indexable: z.enum(CRAWL_INDEXABLE_FILTERS).optional(),
  finding: z.enum(CRAWL_RULE_IDS).optional(),
  depth: z.int().min(0).max(L.maxDepth).optional(),
  linksCut: z.literal(true).optional(),
});
export type CrawlPageFilter = z.infer<typeof CrawlPageFilterSchema>;

const sorted = {
  filter: CrawlPageFilterSchema,
  sort: z.enum(CRAWL_PAGE_SORTS),
  direction: z.enum(CRAWL_SORT_DIRECTIONS),
};

/** `crawl.pages`: one page of a run's pages, filtered and sorted in SQL, at most `CRAWL_PAGES_LIMITS.maxPageSize` rows. */
export const CrawlPagesInputSchema = z.strictObject({
  runId: id,
  ...sorted,
  offset: z.int().min(0).max(L.maxPagesCap),
  limit: z.int().min(1).max(CRAWL_PAGES_LIMITS.maxPageSize),
});
export type CrawlPagesInput = z.infer<typeof CrawlPagesInputSchema>;

/** One row of the Pages view: the stored page (`CrawlPageRowSchema`, without its run id) and its in-links (the frontier's count). */
export const CrawlPageListRowSchema = z.strictObject({ ...CrawlPageRowSchema.shape, inlinks: count }).omit({ runId: true });
export type CrawlPageListRow = z.infer<typeof CrawlPageListRowSchema>;

const readRefused = z.strictObject({ status: z.literal('refused'), reason: z.enum(CRAWL_READ_REFUSALS) });

/** `crawl.pages`' answer: the rows asked for, from `offset`, and how many pages the filter selects (`total`). */
export const CrawlPagesAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), total: count, offset: count, rows: z.array(CrawlPageListRowSchema).max(CRAWL_PAGES_LIMITS.maxPageSize) }),
  readRefused,
]);
export type CrawlPagesAnswer = z.infer<typeof CrawlPagesAnswerSchema>;

/**
 * A node of the path tree: a URL text prefix ending in `/` (an origin's root, `https://example.com/`,
 * or a folder under it, `https://example.com/blog/`).
 */
export const CrawlTreePrefixSchema = z
  .string()
  .min(1)
  .max(L.maxUrlChars)
  .refine((value) => value.endsWith('/') && parseWebUrl(value) !== null, { message: 'a tree prefix is an http(s) URL ending in /' });

/** `crawl.structure`: the tree's level under `prefix` (`null`: the run's origins), its depth histogram and its orphans. */
export const CrawlStructureInputSchema = z.strictObject({ runId: id, prefix: CrawlTreePrefixSchema.nullable() });
export type CrawlStructureInput = z.infer<typeof CrawlStructureInputSchema>;

/**
 * One node of a tree level: its label (an origin, or one path segment as stored, percent-encoded; `''`
 * is the folder's own page), the pages under it (itself and below, query variants included), the
 * prefix to read its children with (`null`: no page below it), and its own page's URL when the crawl
 * recorded one exactly there (`null`: none).
 */
export const CrawlTreeNodeSchema = z.strictObject({
  label: z.string().max(L.maxUrlChars),
  pages: count,
  prefix: z.string().min(1).max(L.maxUrlChars).nullable(),
  url: z.string().min(1).max(L.maxUrlChars).nullable(),
});
export type CrawlTreeNode = z.infer<typeof CrawlTreeNodeSchema>;

/** `crawl.structure`'s answer. `tree.more`: nodes of this level not sent (the level holds `nodes.length + more`). */
export const CrawlStructureAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    tree: z.strictObject({ prefix: z.string().min(1).max(L.maxUrlChars).nullable(), nodes: z.array(CrawlTreeNodeSchema).max(CRAWL_TREE_LIMITS.maxChildren), more: count }),
    depths: z.array(z.strictObject({ depth: z.int().min(0).max(L.maxDepth), pages: count })).max(L.maxDepth + 1),
    orphans: z.strictObject({ urls: z.array(z.string().min(1).max(L.maxUrlChars)).max(CRAWL_TREE_LIMITS.maxOrphansShown), total: count }),
  }),
  readRefused,
]);
export type CrawlStructureAnswer = z.infer<typeof CrawlStructureAnswerSchema>;

/** `crawl.exportCsv`: a run's pages the filter selects, in the sort. Never a path or a file name: main asks in its own dialog. */
export const CrawlCsvInputSchema = z.strictObject({ runId: id, ...sorted });
export type CrawlCsvInput = z.infer<typeof CrawlCsvInputSchema>;

/** `crawl.exportCsv`'s answer: written (`rows` lines, the header aside), the dialog cancelled (nothing written), or refused. */
export const CrawlCsvAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('saved'), rows: count }), z.strictObject({ status: z.literal('cancelled') }), readRefused]);
export type CrawlCsvAnswer = z.infer<typeof CrawlCsvAnswerSchema>;
