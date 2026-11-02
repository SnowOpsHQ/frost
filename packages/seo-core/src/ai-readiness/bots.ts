import { AI_BOTS, type AiBot, type AiBotId, type AiBotRole, type AiBotVerdictValue, type AiBotVia, type AiRobotsStance } from '@app/specs/ai-readiness.spec';
import { ROBOTS_UNKNOWN_OUTCOMES, type RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import type { PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { groupsFor, matchRobots, pageRobotsPath, parsedRobotsOf, type RobotsFile, type RobotsMatch, type RobotsRuleRef } from '../indexability';

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
  /**
   * Which groups decided (`AI_BOT_VIAS`): its own, Googlebot's (Applebot's documented fallback) or
   * `*`; `null` when no file was judged (`not-checked`, `unknown`, or none to obey).
   */
  readonly via: AiBotVia | null;
  /** The line of the first group it follows; `null`: no group, or no file. */
  readonly groupLine: number | null;
  /** The deciding rule; `null`: none matched, or no file. */
  readonly rule: RobotsRuleRef | null;
}

const UNKNOWN: ReadonlySet<RobotsFetchOutcome> = new Set(ROBOTS_UNKNOWN_OUTCOMES);

/** The groups `bot` follows and why: its own; else Googlebot's when its operator says so and there are some; else `*`. */
function judge(file: RobotsFile, bot: AiBot, path: string): { match: RobotsMatch; via: AiBotVia } {
  const match = matchRobots(file, bot.token, path);
  if (!match.fallback) return { match, via: 'own' };
  if (bot.followsGooglebot && !groupsFor(file, 'Googlebot').fallback) return { match: matchRobots(file, 'Googlebot', path), via: 'googlebot' };
  return { match, via: '*' };
}

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
      return { ...base, verdict, via: null, groupLine: null, rule: null };
    }
    const { match, via } = judge(file, bot, path);
    return {
      ...base,
      verdict: match.allowed ? 'allowed' : 'disallowed',
      via,
      groupLine: match.groups[0]?.line ?? null,
      rule: match.rule && { allow: match.rule.allow, raw: match.rule.raw, line: match.rule.line },
    };
  });
}
