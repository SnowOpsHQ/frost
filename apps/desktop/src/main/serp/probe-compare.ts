import { decodeRobotsBytes, matchRobots, parseRobotsTxt, parseXRobotsTag, robotsPathOf, type RobotsFile, type XRobotsTag } from '@app/seo-core';
import { ROBOTS_ALLOW_ALL_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { PROBE_AGENTS, PROBE_BASELINE, PROBE_DIFF_FACTS, PROBE_DIFF_TOLERANCE, PROBE_SETTLED_OUTCOMES, type ProbeAgent, type ProbeAgentId, type ProbeDiffFact } from '@app/specs/visibility-probes.spec';
import { PROBE_DIRECTIVE_LIMITS, type ProbeDiff, type ProbeDirectives, type ProbeRobots, type ProbeRobotsAnswer, type ProbeRow } from '@app/specs/visibility-probes.schema';

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
  return { agent, outcome: 'pending', status: null, hops: [], finalUrl: null, robots: null, metaRobots: null, xRobotsTag: null, noindex: null, nofollow: null, canonical: null, contentType: null, bytes: 0, truncated: false, wordCount: null, textHash: null, title: null, durationMs: null };
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
 * An `X-Robots-Tag` value as the fetcher kept it (repeated headers joined with `, `) as tags: a
 * `name:` prefix that is not a valued directive scopes the directives after it, until the next one;
 * directives before any prefix are general (`parseXRobotsTag` reads each run).
 */
export function xRobotsTags(joined: string | null): XRobotsTag[] {
  if (joined === null) return [];
  const runs: string[][] = [];
  for (const piece of joined.split(',')) {
    const scope = SCOPE.exec(piece);
    const starts = scope !== null && !VALUED.has(scope[1]!.toLowerCase());
    if (starts || runs.length === 0) runs.push([piece]);
    else runs[runs.length - 1]!.push(piece);
  }
  return runs.map((run) => parseXRobotsTag(run.join(','))).filter((tag) => tag.agent !== null || tag.directives.length > 0);
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

const verdictOf = (verdict: ProbeRobots['verdict']): ProbeRobots => ({ verdict, rule: null, groupAgents: [], groupLine: null, fallback: false });

/** robots.txt's verdict for `token` on `path` (`robotsPathOf`), from a parsed file, or a fetch that gave none. */
export function robotsVerdictFor(file: RobotsFile | null, outcome: RobotsFetchOutcome | null, token: string, path: string): ProbeRobots {
  if (!file) return verdictOf(outcome !== null && ALLOW_ALL.has(outcome) ? 'allowed' : 'unknown');
  const match = matchRobots(file, token, path);
  return {
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
 * Every agent's verdict for `pageUrl` under robots.txt as main's fetcher answered it (`null`: none
 * asked). Only a fetched file (`ok`) is parsed; no file to obey is `allowed`; one that could not be
 * read (or is still pending) `unknown`.
 */
export function robotsVerdicts(fetched: RobotsFetch | null, pageUrl: string): ProbeRobotsAnswer {
  const page = parseWebUrl(pageUrl);
  const outcome = fetched?.outcome ?? null;
  const file = fetched && fetched.outcome === 'ok' && page ? parseRobotsTxt(decodeRobotsBytes(fetched.body)) : null;
  const path = page ? robotsPathOf(page) : '/';
  const verdicts = Object.fromEntries(PROBE_AGENTS.map((agent) => [agent.id, robotsVerdictFor(file, page ? outcome : null, agent.robotsToken, path)])) as Record<ProbeAgentId, ProbeRobots>;
  return { kind: 'robots', outcome, verdicts };
}

// ---- Against the baseline ---------------------------------------------------------------------------

const SETTLED: ReadonlySet<string> = new Set(PROBE_SETTLED_OUTCOMES);
/** `|value − base| / max(base, 1)` above `share`. */
const beyond = (value: number, base: number, share: number): boolean => Math.abs(value - base) / Math.max(base, 1) > share;

/**
 * `row`'s differences from `base` (the baseline's row), in `PROBE_DIFF_FACTS` order; `null` until
 * both have settled. Status, final URL, redirects and the robots.txt verdict always; `noindex` when
 * both had a response; the canonical, word count, size and text when both bodies were read.
 */
export function diffRow(base: ProbeRow, row: ProbeRow, tolerance: typeof PROBE_DIFF_TOLERANCE = PROBE_DIFF_TOLERANCE): ProbeDiff | null {
  if (!SETTLED.has(base.outcome) || !SETTLED.has(row.outcome)) return null;
  const read = base.outcome === 'ok' && row.outcome === 'ok';
  const differs: Record<ProbeDiffFact, boolean> = {
    status: base.status !== row.status,
    finalUrl: base.finalUrl !== row.finalUrl,
    redirects: base.hops.length !== row.hops.length,
    robots: (base.robots?.verdict ?? null) !== (row.robots?.verdict ?? null),
    noindex: base.noindex !== null && row.noindex !== null && base.noindex !== row.noindex,
    canonical: read && base.canonical !== row.canonical,
    wordCount: read && base.wordCount !== null && row.wordCount !== null && beyond(row.wordCount, base.wordCount, tolerance.wordShare),
    bytes: read && beyond(row.bytes, base.bytes, tolerance.byteShare),
    text: read && base.textHash !== null && row.textHash !== null && base.textHash !== row.textHash,
  };
  return { agent: row.agent, facts: PROBE_DIFF_FACTS.filter((fact) => differs[fact]) };
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
