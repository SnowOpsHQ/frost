import { decodeRobotsBytes, matchRobots, parseRobotsTxt, parseXRobotsTag, robotsPathOf, type RobotsFile, type XRobotsTag } from '@app/seo-core';
import { ROBOTS_ALLOW_ALL_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { PROBE_BASELINE, PROBE_DIFF_FACTS, PROBE_DIFF_TOLERANCE, PROBE_SETTLED_OUTCOMES, PROBE_TEXT_SIMILARITY, probeAgent, type ProbeAgent, type ProbeAgentId, type ProbeCanonicalConflict, type ProbeDiffFact } from '@app/specs/visibility-probes.spec';
import { PROBE_DIRECTIVE_LIMITS, type ProbeCanonicals, type ProbeDiff, type ProbeDirectives, type ProbeRobots, type ProbeRobotsAnswer, type ProbeRow } from '@app/specs/visibility-probes.schema';

// What each probed agent is told, and how its answer differs from the browser's (spec
// `visibility-probes.spec.ts`, Reading an agent's answer and Against the baseline; acceptance
// `visibility-probes.feature.md`, Agents and reading). Pure, with no Electron or Node APIs: the
// directive and robots.txt readers run in the SERP worker (`probe-parse.ts`, on page-derived text),
// the diff on main over the rows it built from the worker's validated answers.

const ALLOW_ALL: ReadonlySet<string> = new Set(ROBOTS_ALLOW_ALL_OUTCOMES);
/** Directives that carry a value after a colon (`max-snippet: 20`): never a crawler's name. */
const VALUED = new Set(['unavailable_after', 'max-snippet', 'max-image-preview', 'max-video-preview']);
const SCOPE = /^\s*([A-Za-z0-9_.-]+)\s*:/;
const { maxDirectives, maxDirectiveChars, maxGroupAgents, maxAgentChars, maxRuleChars } = PROBE_DIRECTIVE_LIMITS;

/** A blank row for `agent`: nothing known yet (`pending`). */
export function pendingRow(agent: ProbeAgentId): ProbeRow {
  return {
    agent,
    outcome: 'pending',
    status: null,
    hops: [],
    finalUrl: null,
    robots: null,
    metaRobots: null,
    xRobotsTag: null,
    noindex: null,
    nofollow: null,
    canonical: null,
    canonicals: null,
    contentType: null,
    bytes: 0,
    truncated: false,
    textTruncated: false,
    partial: false,
    wordCount: null,
    textHash: null,
    textSignature: null,
    title: null,
    durationMs: null,
  };
}

// ---- Directives ---------------------------------------------------------------------------------

/** Unique directives, in order, cut to the schema's caps. */
const capped = (values: Iterable<string>): string[] => {
  const out: string[] = [];
  for (const value of values) {
    const directive = value.slice(0, maxDirectiveChars);
    if (directive !== '' && !out.includes(directive)) out.push(directive);
    if (out.length >= maxDirectives) break;
  }
  return out;
};

/** A meta robots `content` as directives: comma-separated, trimmed, lowercased, each without its `:value`. */
export function directivesOf(content: string): string[] {
  return content
    .split(',')
    .map((part) => {
      const lower = part.trim().toLowerCase();
      const colon = lower.indexOf(':');
      return (colon < 0 ? lower : lower.slice(0, colon)).trim();
    })
    .filter((part) => part !== '');
}

/**
 * The `X-Robots-Tag` header as the fetcher kept it (repeated values apart, joined with `\n`:
 * `PROBE_SEPARATE_HEADERS`) as tags. Each value is read on its own: a `name:` prefix that is not a
 * valued directive scopes the directives after it, until the next one; directives before any prefix
 * are general (`parseXRobotsTag` reads each run). So `googlebot: nofollow` and a separate `noindex`
 * are Googlebot's `nofollow` and everyone's `noindex`.
 */
export function xRobotsTags(kept: string | null): XRobotsTag[] {
  if (kept === null) return [];
  const runs: string[][] = [];
  for (const value of kept.split('\n')) {
    let first = true;
    for (const piece of value.split(',')) {
      const scope = SCOPE.exec(piece);
      const starts = scope !== null && !VALUED.has(scope[1]!.toLowerCase());
      if (starts || first) runs.push([piece]);
      else runs[runs.length - 1]!.push(piece);
      first = false;
    }
  }
  return runs.map((run) => parseXRobotsTag(run.join(','))).filter((tag) => tag.agent !== null || tag.directives.length > 0);
}

/**
 * The canonicals an answer names: the HTML's (in order, distinct), the `Link` header's, the
 * conflicts between them, and the effective one (the HTML's first, else the header's).
 */
export function canonicalsOf(html: readonly string[], header: string | null): { canonical: string | null; canonicals: ProbeCanonicals } {
  const distinct = [...new Set(html.filter((url) => url !== ''))].slice(0, SNAPSHOT_LIMITS.maxRepeated);
  const conflicts: ProbeCanonicalConflict[] = [];
  if (distinct.length > 1) conflicts.push('several-html');
  if (distinct.length > 0 && header !== null && !distinct.includes(header)) conflicts.push('html-vs-header');
  return { canonical: distinct[0] ?? header, canonicals: { html: distinct, header, conflicts } };
}

/** One `<meta name content>` of the page (`name` compared lowercased). */
export interface ProbeMeta {
  readonly name: string;
  readonly content: string;
}

/** What `agent` obeys of the page's meta robots tags (`null`: no body read) and `X-Robots-Tag`s, and its effective verdicts. */
export function agentDirectives(agent: ProbeAgent, metas: readonly ProbeMeta[] | null, tags: readonly XRobotsTag[]): { metaRobots: ProbeDirectives | null; xRobotsTag: ProbeDirectives; noindex: boolean; nofollow: boolean } {
  const own = agent.metaNames.filter((name) => name !== 'robots');
  const metaRobots =
    metas === null
      ? null
      : {
          general: capped(metas.filter((meta) => meta.name.toLowerCase() === 'robots').flatMap((meta) => directivesOf(meta.content))),
          agent: capped(metas.filter((meta) => own.includes(meta.name.toLowerCase())).flatMap((meta) => directivesOf(meta.content))),
        };
  const xRobotsTag = {
    general: capped(tags.filter((tag) => tag.agent === null).flatMap((tag) => tag.directives)),
    agent: capped(tags.filter((tag) => tag.agent !== null && own.includes(tag.agent)).flatMap((tag) => tag.directives)),
  };
  const all = [...(metaRobots ? [...metaRobots.general, ...metaRobots.agent] : []), ...xRobotsTag.general, ...xRobotsTag.agent];
  return { metaRobots, xRobotsTag, noindex: all.includes('noindex') || all.includes('none'), nofollow: all.includes('nofollow') || all.includes('none') };
}

// ---- robots.txt ---------------------------------------------------------------------------------

/** A verdict with no rule behind it (`url`: the robots.txt judged by, if any). */
export const robotsVerdictOf = (verdict: ProbeRobots['verdict'], url: string | null = null): ProbeRobots => ({ url, verdict, rule: null, groupAgents: [], groupLine: null, fallback: false });

/** robots.txt's (at `url`) verdict for `token` on `path` (`robotsPathOf`), from a parsed file, or a fetch that gave none. */
export function robotsVerdictFor(file: RobotsFile | null, outcome: RobotsFetchOutcome | null, token: string, path: string, url: string | null = null): ProbeRobots {
  if (!file) return robotsVerdictOf(outcome !== null && ALLOW_ALL.has(outcome) ? 'allowed' : 'unknown', url);
  const match = matchRobots(file, token, path);
  return {
    url,
    verdict: match.allowed ? 'allowed' : 'disallowed',
    rule: match.rule && { allow: match.rule.allow, raw: match.rule.raw.slice(0, maxRuleChars), line: match.rule.line },
    groupAgents: match.groups
      .flatMap((group) => group.agents)
      .slice(0, maxGroupAgents)
      .map((name) => name.slice(0, maxAgentChars)),
    groupLine: match.groups[0]?.line ?? null,
    fallback: match.fallback,
  };
}

/**
 * `agent`'s verdict for `url` under robots.txt as main's fetcher answered it (`null`: none asked).
 * Only a fetched file (`ok`) of `url`'s own origin is parsed; no file to obey is `allowed`; one that
 * could not be read (or is still pending, or is another origin's) `unknown`.
 */
export function robotsVerdict(fetched: RobotsFetch | null, agent: ProbeAgentId, url: string): ProbeRobotsAnswer {
  const target = parseWebUrl(url);
  const own = fetched !== null && target !== null && parseWebUrl(fetched.url)?.origin === target.origin;
  const outcome = own ? fetched.outcome : null;
  const file = own && fetched.outcome === 'ok' ? parseRobotsTxt(decodeRobotsBytes(fetched.body)) : null;
  const robots = robotsVerdictFor(file, outcome, probeAgent(agent).robotsToken, target ? robotsPathOf(target) : '/', own ? fetched.url.slice(0, SNAPSHOT_LIMITS.maxUrlChars) : null);
  return { kind: 'robots', outcome, robots };
}

// ---- Against the baseline ---------------------------------------------------------------------------

const SETTLED: ReadonlySet<string> = new Set(PROBE_SETTLED_OUTCOMES);

/** The estimated Jaccard similarity of two text signatures (`PROBE_TEXT_SIMILARITY`): the share of equal positions; two empty texts (no signature) are alike, one empty one not. */
export function textSimilarity(a: readonly number[] | null, b: readonly number[] | null): number {
  if (a === null || b === null) return a === b ? 1 : 0;
  const size = Math.min(a.length, b.length);
  if (size === 0) return 0;
  let same = 0;
  for (let i = 0; i < size; i++) if (a[i] === b[i]) same += 1;
  return same / size;
}

/** Whether two rows' hops differ (each hop's URL and status, in order). */
const hopsDiffer = (a: ProbeRow['hops'], b: ProbeRow['hops']): boolean => a.length !== b.length || a.some((hop, i) => hop.url !== b[i]!.url || hop.status !== b[i]!.status);
/** `|value − base| / max(base, 1)` above `share`. */
const beyond = (value: number, base: number, share: number): boolean => Math.abs(value - base) / Math.max(base, 1) > share;

/**
 * `row`'s differences from `base` (the baseline's row), in `PROBE_DIFF_FACTS` order; `null` until
 * both have settled. Status and the robots.txt verdict always; the final URL when both have one; the
 * redirects when the hops differ; `noindex` when both had a response; the canonical when both bodies
 * were read or both name one; the word count, size and text (`textSimilarity` below
 * `minSimilarity`) when both bodies were read, with `contentTruncated` when either was cut.
 */
export function diffRow(base: ProbeRow, row: ProbeRow, tolerance: typeof PROBE_DIFF_TOLERANCE = PROBE_DIFF_TOLERANCE, similarity: typeof PROBE_TEXT_SIMILARITY = PROBE_TEXT_SIMILARITY): ProbeDiff | null {
  if (!SETTLED.has(base.outcome) || !SETTLED.has(row.outcome)) return null;
  const read = base.outcome === 'ok' && row.outcome === 'ok';
  const textSimilarityOf = read ? (base.textHash !== null && base.textHash === row.textHash ? 1 : textSimilarity(base.textSignature, row.textSignature)) : null;
  const differs: Record<ProbeDiffFact, boolean> = {
    status: base.status !== row.status,
    finalUrl: base.finalUrl !== null && row.finalUrl !== null && base.finalUrl !== row.finalUrl,
    redirects: hopsDiffer(base.hops, row.hops),
    robots: (base.robots?.verdict ?? null) !== (row.robots?.verdict ?? null),
    noindex: base.noindex !== null && row.noindex !== null && base.noindex !== row.noindex,
    canonical: (read || (base.canonical !== null && row.canonical !== null)) && base.canonical !== row.canonical,
    wordCount: read && base.wordCount !== null && row.wordCount !== null && beyond(row.wordCount, base.wordCount, tolerance.wordShare),
    bytes: read && beyond(row.bytes, base.bytes, tolerance.byteShare),
    text: textSimilarityOf !== null && textSimilarityOf < similarity.minSimilarity,
  };
  const cut = (r: ProbeRow): boolean => r.truncated || r.textTruncated || r.partial;
  return { agent: row.agent, facts: PROBE_DIFF_FACTS.filter((fact) => differs[fact]), textSimilarity: textSimilarityOf, contentTruncated: read && (cut(base) || cut(row)) };
}

/** Each settled agent's diff against the baseline row (none while the baseline is unsettled). */
export function diffsOf(rows: readonly ProbeRow[]): ProbeDiff[] {
  const base = rows.find((row) => row.agent === PROBE_BASELINE);
  if (!base) return [];
  return rows.flatMap((row) => {
    if (row.agent === PROBE_BASELINE) return [];
    const diff = diffRow(base, row);
    return diff ? [diff] : [];
  });
}
