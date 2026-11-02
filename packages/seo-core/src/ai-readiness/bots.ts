import { AI_BOTS, type AiBotId, type AiBotRole, type AiBotVerdictValue, type AiRobotsStance } from '@app/specs/ai-readiness.spec';
import { ROBOTS_UNKNOWN_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import type { PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { matchRobots, pageRobotsPath, parsedRobotsOf, type RobotsRuleRef } from '../indexability';

// The AI crawlers' robots.txt verdicts (spec `ai-readiness.spec.ts`, Verdicts; acceptance
// `ai-readiness.feature.md`). Read from the robots.txt the audit already has (`PageContext.robots`),
// with the Indexability panel's parser and matcher: no request of its own. Runs in the analysis
// worker with the rest of the audit.

/** robots.txt's verdict for one catalogue token on the page's path. */
export interface AiBotVerdict {
  readonly bot: AiBotId;
  readonly token: string;
  readonly role: AiBotRole;
  readonly stance: AiRobotsStance;
  readonly verdict: AiBotVerdictValue;
  /** Judged by the `*` groups (the token has none of its own). */
  readonly fallback: boolean;
  /** The line of the first group it follows; `null`: no group, or no file. */
  readonly groupLine: number | null;
  /** The deciding rule; `null`: none matched, or no file. */
  readonly rule: RobotsRuleRef | null;
}

const UNKNOWN: ReadonlySet<RobotsFetchOutcome> = new Set(ROBOTS_UNKNOWN_OUTCOMES);

/** Every `AI_BOTS` token's verdict (`AI_BOTS` order). Pure; one parse of the file per fetch. */
export function aiBotVerdicts(s: PageSnapshot): AiBotVerdict[] {
  const fetched = s.robots;
  const path = pageRobotsPath(s);
  const file = fetched ? parsedRobotsOf(fetched).file : null;
  return AI_BOTS.map((bot) => {
    const base = { bot: bot.id, token: bot.token, role: bot.role, stance: bot.stance };
    if (file === null) {
      // No answer yet (none fetched, or still pending): not checked; unreadable: unknown; no file to obey: allowed.
      const verdict: AiBotVerdictValue = !fetched || fetched.outcome === 'pending' ? 'not-checked' : UNKNOWN.has(fetched.outcome) ? 'unknown' : 'allowed';
      return { ...base, verdict, fallback: false, groupLine: null, rule: null };
    }
    const match = matchRobots(file, bot.token, path);
    return {
      ...base,
      verdict: match.allowed ? 'allowed' : 'disallowed',
      fallback: match.fallback,
      groupLine: match.groups[0]?.line ?? null,
      rule: match.rule && { allow: match.rule.allow, raw: match.rule.raw, line: match.rule.line },
    };
  });
}
