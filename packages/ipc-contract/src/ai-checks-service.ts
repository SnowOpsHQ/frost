import type { AiCheckMode } from '@app/specs/ai-checks.spec';
import type { AiChecksState } from '@app/specs/ai-checks.schema';

// The AI checks as the `aiChecks.*` procedures see them (Phase 9 Task 10; spec `ai-checks.schema.ts`;
// acceptance `ai-checks.feature.md`, Router). Main implements it (`apps/desktop/src/main/ai-checks/`);
// this package only knows the interface. Nothing here carries a key, a token or the page's text:
// the state holds the mode, the route and model names, the page URL and the check's answer.

export interface AiChecksService {
  /** The tab's AI check for the page it shows now. */
  state(tabId: number): AiChecksState;
  /**
   * Resolves with the state once the service's version exceeds `sinceVersion` (at once if it
   * already does), or when `signal` aborts.
   */
  watch(tabId: number, sinceVersion: number, signal?: AbortSignal): Promise<AiChecksState>;
  /**
   * Asks for `mode`. Leaving `off` shows main's consent dialog first (`AI_CHECKS_ENABLE_PROMPT`); the
   * answer is the mode in effect afterwards (still `off` when the dialog was cancelled).
   */
  setMode(mode: AiCheckMode): Promise<AiCheckMode>;
  /** "Check this page" (`again`: "Check again"): `true` when a check runs or waits for its turn now. */
  checkNow(tabId: number, again: boolean): Promise<boolean>;
}
