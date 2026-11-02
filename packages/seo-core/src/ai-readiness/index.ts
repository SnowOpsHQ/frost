import type { PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { aiBotVerdicts, type AiBotVerdict } from './bots';

// AI readiness (Phase 9; spec `specs/ai-readiness.spec.ts`). Separate from the SEO health score:
// nothing here is a rule, and `scoreAudit` never reads it.

/** The page's AI-readiness facts (`audit.aiReadiness`). */
export interface AiReadinessReport {
  /** robots.txt's verdict for each `AI_BOTS` token, in catalogue order. */
  readonly bots: readonly AiBotVerdict[];
}

export function aiReadinessReport(s: PageSnapshot): AiReadinessReport {
  return { bots: aiBotVerdicts(s) };
}

export { aiBotVerdicts, type AiBotVerdict } from './bots';
