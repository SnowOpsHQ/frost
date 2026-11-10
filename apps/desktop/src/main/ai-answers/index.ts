import type { AiAnswersRepository } from '@app/db';
import type { AiSearchService } from '../ai-search/service';
import { createAiAnswersMain, type AiAnswersMain } from './service';

// The AI answers view's main-side composition (Phase 12 Task 9; acceptance `specs/ai-answers.feature.md`):
// the view over `sessionStore.aiAnswers` and Task 8's AI search service, the start-up purge run once, and
// the agent's answers no longer listened to on `will-quit`. Main wires it with one line after AI search
// and hands it to the IPC services as `aiAnswers`.

export interface AiAnswersSetupDeps {
  readonly app: { once(event: 'will-quit', listener: () => void): unknown };
  /** `sessionStore.aiAnswers`. */
  readonly store: AiAnswersRepository;
  /** `setupAiSearch(…)`. */
  readonly aiSearch: Pick<AiSearchService, 'context' | 'answer' | 'onAnswer'>;
  readonly log?: (line: string) => void;
}

export function setupAiAnswers(deps: AiAnswersSetupDeps): AiAnswersMain {
  const main = createAiAnswersMain({ store: deps.store, aiSearch: deps.aiSearch, ...(deps.log ? { log: deps.log } : {}) });
  void main.start();
  deps.app.once('will-quit', () => main.dispose());
  return main;
}

export { citedDomainsOf, createAiAnswersMain, type AiAnswersMain, type AiAnswersMainDeps } from './service';
