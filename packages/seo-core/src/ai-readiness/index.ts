import type { PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { aiBotVerdicts, type AiBotVerdict } from './bots';

// AI readiness (Phase 9; spec `specs/ai-readiness.spec.ts`). Separate from the SEO health score:
// nothing here is a rule, and `scoreAudit` never reads it. `audit.aiReadiness` holds the static
// robots.txt verdicts; the checks and the AI-readiness score also need the tab's probe run, so they
// are computed on demand (`aiReadinessOf(audit, probes)`, `score.ts`), and `parseLlmsTxt` (`llms.ts`)
// runs in the probes' SERP worker.

/** The page's AI-readiness facts (`audit.aiReadiness`). */
export interface AiReadinessReport {
  /** robots.txt's verdict for each `AI_BOTS` token, in catalogue order. */
  readonly bots: readonly AiBotVerdict[];
}

export function aiReadinessReport(s: PageSnapshot): AiReadinessReport {
  return { bots: aiBotVerdicts(s) };
}

export { aiBotVerdicts, type AiBotVerdict } from './bots';
export { parseLlmsTxt, type LlmsTxtParse } from './llms';
export { aiReadinessChecks, aiReadinessOf, type AgentReach, type AiReadiness, type AiReadinessAudit, type AiReadinessCheck } from './score';
