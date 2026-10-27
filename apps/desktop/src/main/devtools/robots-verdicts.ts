import { decodeRobotsBytes, matchRobots, parseRobotsTxt, robotsPathOf } from '@app/seo-core';
import { RobotsVerdictJobSchema } from '@app/specs/devtools.schema';
import { ROBOTS_VERDICT_AGENT } from '@app/specs/devtools.spec';
import { ROBOTS_ALLOW_ALL_OUTCOMES } from '@app/specs/seo-indexability.spec';

// The devtools drawer's robots.txt verdicts (spec `devtools.spec.ts`, `CRAWLABLE_TYPES`,
// `ROBOTS_VERDICT_AGENT`; acceptance `devtools.feature.md`, Robots verdicts). Runs in the analysis
// worker (`analysis-worker.ts`, `kind: 'robots'`), never on main's thread: the job (the page origin's
// robots.txt as the fetcher answered it, and the request URLs) is validated with
// `RobotsVerdictJobSchema`, the file decoded and parsed once, and each URL matched for Googlebot.
// Pure, with no Electron.

/** One verdict per URL: `true` allowed, `false` blocked, `null` unknown. */
export type RobotsVerdictsResult = { readonly ok: true; readonly verdicts: readonly (boolean | null)[] } | { readonly ok: false; readonly reason: 'invalid-job' | 'analysis-failed' };

const ALLOW_ALL: ReadonlySet<string> = new Set(ROBOTS_ALLOW_ALL_OUTCOMES);

/** The verdicts for `raw` (a `RobotsVerdictJob`). Never throws. */
export function robotsVerdicts(raw: unknown): RobotsVerdictsResult {
  let job;
  try {
    const parsed = RobotsVerdictJobSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'invalid-job' };
    job = parsed.data;
  } catch {
    return { ok: false, reason: 'invalid-job' };
  }
  try {
    const { robots, urls } = job;
    if (robots.outcome !== 'ok') {
      // No file to obey (crawlers may fetch everything), or none readable (or still pending): unknown.
      const verdict = ALLOW_ALL.has(robots.outcome) ? true : null;
      return { ok: true, verdicts: urls.map(() => verdict) };
    }
    const file = parseRobotsTxt(decodeRobotsBytes(robots.body));
    return {
      ok: true,
      verdicts: urls.map((url) => {
        try {
          return matchRobots(file, ROBOTS_VERDICT_AGENT, robotsPathOf(new URL(url))).allowed;
        } catch {
          return null;
        }
      }),
    };
  } catch {
    return { ok: false, reason: 'analysis-failed' };
  }
}
