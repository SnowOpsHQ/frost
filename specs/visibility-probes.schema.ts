/**
 * The Zod side of the visibility probes (Phase 3 Task 5; plain values in `visibility-probes.spec.ts`;
 * acceptance `visibility-probes.feature.md`): what a run reports (`ProbeRowSchema` per agent,
 * `ProbeDiffSchema` per agent against the browser baseline, `ProbeReportSchema`), what
 * `serp.probes` / `serp.watchProbes` and `SerpReadApi.probes` answer (`ProbesStateSchema`), and the
 * SERP worker's `probe` jobs (`ProbeJobSchema`) and their answers (`ProbeJobResultSchema`). Not for
 * the chrome renderer (no Zod there).
 *
 * **Stable after merge** (Phase 5's agent tools read `ProbesState` through `SerpReadApi.probes`): a
 * change is a new field, optional or nullable, never a changed one.
 */
import { z } from 'zod';
import { ROBOTS_FETCH_OUTCOMES } from './seo-indexability.spec';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import { isWebUrl } from './web-url.spec';
import { PROBE_AGENT_IDS, PROBE_DIFF_FACTS, PROBE_LIMITS, PROBE_OUTCOMES, PROBE_ROBOTS_VERDICTS, PROBE_STATUSES } from './visibility-probes.spec';

const tabId = z.int().positive();
const time = z.int().min(0);
const count = z.int().nonnegative().max(SNAPSHOT_LIMITS.maxCount);
const httpStatus = z.int().min(0).max(999);
const urlText = z.string().max(SNAPSHOT_LIMITS.maxUrlChars);
const agent = z.enum(PROBE_AGENT_IDS);

/** Most directives kept per list, and their longest name. */
export const PROBE_DIRECTIVE_LIMITS = { maxDirectives: 32, maxDirectiveChars: 64, maxGroupAgents: 16, maxAgentChars: 128, maxRuleChars: 512 } as const;

const directives = z.array(z.string().min(1).max(PROBE_DIRECTIVE_LIMITS.maxDirectiveChars)).max(PROBE_DIRECTIVE_LIMITS.maxDirectives);

/** Directives an agent obeys from one source: every agent's (`general`) and its own (`agent`). */
export const ProbeDirectivesSchema = z.strictObject({ general: directives, agent: directives });
export type ProbeDirectives = z.infer<typeof ProbeDirectivesSchema>;

/**
 * robots.txt's verdict for an agent's token on the tab's URL: the verdict, the deciding rule (`null`:
 * none matched, or no file), the agents of the groups it follows and the first one's line, and
 * whether those are the `*` groups (`fallback`).
 */
export const ProbeRobotsSchema = z.strictObject({
  verdict: z.enum(PROBE_ROBOTS_VERDICTS),
  rule: z.strictObject({ allow: z.boolean(), raw: z.string().max(PROBE_DIRECTIVE_LIMITS.maxRuleChars), line: z.int().positive() }).nullable(),
  groupAgents: z.array(z.string().max(PROBE_DIRECTIVE_LIMITS.maxAgentChars)).max(PROBE_DIRECTIVE_LIMITS.maxGroupAgents),
  groupLine: z.int().positive().nullable(),
  fallback: z.boolean(),
});
export type ProbeRobots = z.infer<typeof ProbeRobotsSchema>;

/** A redirect an agent's request followed: the URL that answered with it, and its status. */
export const ProbeHopSchema = z.strictObject({ url: urlText, status: httpStatus });

/**
 * One agent's answer. Every fact is `null` until known: `status`, `finalUrl`, the headers' facts and
 * `noindex` / `nofollow` need a response; `canonical`, `wordCount`, `textHash` and `title` a body
 * that was read (`ok`); `robots` the run's robots.txt verdict.
 */
export const ProbeRowSchema = z.strictObject({
  agent,
  outcome: z.enum(PROBE_OUTCOMES),
  status: httpStatus.nullable(),
  hops: z.array(ProbeHopSchema).max(PROBE_LIMITS.maxRedirects),
  finalUrl: urlText.nullable(),
  robots: ProbeRobotsSchema.nullable(),
  metaRobots: ProbeDirectivesSchema.nullable(),
  xRobotsTag: ProbeDirectivesSchema.nullable(),
  noindex: z.boolean().nullable(),
  nofollow: z.boolean().nullable(),
  canonical: urlText.nullable(),
  contentType: z.string().max(256).nullable(),
  bytes: z.int().nonnegative().max(PROBE_LIMITS.maxBytes),
  truncated: z.boolean(),
  wordCount: count.nullable(),
  textHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  title: z.string().max(SNAPSHOT_LIMITS.maxTextChars).nullable(),
  durationMs: z.int().nonnegative().nullable(),
});
export type ProbeRow = z.infer<typeof ProbeRowSchema>;

/** An agent's differences from the baseline (`PROBE_DIFF_FACTS` order); only for settled pairs. */
export const ProbeDiffSchema = z.strictObject({ agent, facts: z.array(z.enum(PROBE_DIFF_FACTS)).max(PROBE_DIFF_FACTS.length) });
export type ProbeDiff = z.infer<typeof ProbeDiffSchema>;

/** The robots.txt the run read: its URL and how the fetch ended (`pending` while it runs). */
export const ProbeRobotsTxtSchema = z.strictObject({ url: urlText, outcome: z.enum(ROBOTS_FETCH_OUTCOMES) });

/**
 * A tab's run: the URL probed (the tab's, fragment aside; `''` for a tab with no web page), where it
 * stands, one row per agent (`PROBE_AGENT_IDS` order; none while `idle`), the diffs against the
 * baseline, the robots.txt read, and when it started and finished (`null` before).
 */
export const ProbeReportSchema = z.strictObject({
  tabId,
  url: urlText,
  status: z.enum(PROBE_STATUSES),
  rows: z.array(ProbeRowSchema).max(PROBE_AGENT_IDS.length),
  diffs: z.array(ProbeDiffSchema).max(PROBE_AGENT_IDS.length),
  robotsTxt: ProbeRobotsTxtSchema.nullable(),
  startedAt: time.nullable(),
  finishedAt: time.nullable(),
});
export type ProbeReport = z.infer<typeof ProbeReportSchema>;

/** What `serp.probes` / `serp.watchProbes` answer: the report and the probes' `version` (`0` before any change). */
export const ProbesStateSchema = ProbeReportSchema.extend({ version: z.int().nonnegative() });
export type ProbesState = z.infer<typeof ProbesStateSchema>;

// ---- The SERP worker's probe jobs -------------------------------------------------------------------

/** robots.txt as main's fetcher answered it (checked as `RobotsFetchSchema` in the worker), and the page it is for. */
export const ProbeRobotsJobSchema = z.strictObject({
  kind: z.literal('robots'),
  url: urlText.refine(isWebUrl, { message: 'not an http(s) URL' }),
  robots: z.unknown(),
});

/**
 * One agent's answer to read: the URL that gave it, its kept headers, whether its body is a 2xx HTML
 * page to parse (`html`) and that body (empty otherwise).
 */
export const ProbePageJobSchema = z.strictObject({
  kind: z.literal('page'),
  agent,
  url: urlText.refine(isWebUrl, { message: 'not an http(s) URL' }),
  contentType: z.string().max(PROBE_LIMITS.maxHeaderChars).nullable(),
  xRobotsTag: z.string().max(PROBE_LIMITS.maxHeaderChars).nullable(),
  link: z.string().max(PROBE_LIMITS.maxHeaderChars).nullable(),
  html: z.boolean(),
  body: z.instanceof(Uint8Array).refine((body) => body.byteLength <= PROBE_LIMITS.maxBytes, { message: 'body over its cap' }),
});

export const ProbeJobSchema = z.discriminatedUnion('kind', [ProbeRobotsJobSchema, ProbePageJobSchema]);
export type ProbeJob = z.infer<typeof ProbeJobSchema>;
export type ProbeRobotsJob = z.infer<typeof ProbeRobotsJobSchema>;
export type ProbePageJob = z.infer<typeof ProbePageJobSchema>;

/** robots.txt's verdict for every agent, and how its fetch ended (`null`: none, a page that is not on the web). */
export const ProbeRobotsAnswerSchema = z.strictObject({
  kind: z.literal('robots'),
  outcome: z.enum(ROBOTS_FETCH_OUTCOMES).nullable(),
  verdicts: z.strictObject(Object.fromEntries(PROBE_AGENT_IDS.map((id) => [id, ProbeRobotsSchema])) as Record<(typeof PROBE_AGENT_IDS)[number], typeof ProbeRobotsSchema>),
});
export type ProbeRobotsAnswer = z.infer<typeof ProbeRobotsAnswerSchema>;

/**
 * What one answer says to its agent: the directives and their verdicts (from the headers, and the
 * body when one was read), and the body's facts (`null` without a body, or when it was not HTML).
 * `partial`: the parse stopped at a cap; `textTruncated`: the text read for the count and hash hit
 * its budget.
 */
export const ProbePageAnswerSchema = z.strictObject({
  kind: z.literal('page'),
  metaRobots: ProbeDirectivesSchema.nullable(),
  xRobotsTag: ProbeDirectivesSchema,
  noindex: z.boolean(),
  nofollow: z.boolean(),
  canonical: urlText.nullable(),
  title: z.string().max(SNAPSHOT_LIMITS.maxTextChars).nullable(),
  wordCount: count.nullable(),
  textHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  textTruncated: z.boolean(),
  partial: z.boolean(),
});
export type ProbePageAnswer = z.infer<typeof ProbePageAnswerSchema>;

/** A probe job's answer: `ok` with the answer, or `failed` (an invalid job, a body that could not be parsed). */
export type ProbeJobResult = { readonly ok: true; readonly answer: ProbeRobotsAnswer | ProbePageAnswer } | { readonly ok: false; readonly reason: 'invalid-job' | 'parse-failed' };
