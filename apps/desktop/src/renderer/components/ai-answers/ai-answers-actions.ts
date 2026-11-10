// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { AiAnswerRecord, AiAnswersListAnswer, AiAnswersListInput, AiAnswersRunAnswer, AiAnswersRunInput, AiAnswersView } from '@app/specs/ai-answers.schema';
import type { AiAnswerRetention, AiSearchSettingResult } from '@app/specs/ai-answers.spec';
import type { AiSearchEngine, AiSearchViaSetting } from '@app/specs/ai-search.spec';
import { ipc } from '../../ipc';

// The AI answers sheet's calls to main (Phase 12 Task 9; the sender-guarded `aiAnswers.*` procedures). Each
// answers main's answer, or `null` (`false` for the booleans) when the call failed: the sheet says so.

export const aiAnswersActions = {
  view: (): Promise<AiAnswersView | null> => ipc.aiAnswers.view.query().catch(() => null),
  list: (input: AiAnswersListInput): Promise<AiAnswersListAnswer | null> => ipc.aiAnswers.list.query(input).catch(() => null),
  get: (id: number): Promise<AiAnswerRecord | null> => ipc.aiAnswers.get.query({ id }).catch(() => null),
  run: (input: AiAnswersRunInput): Promise<AiAnswersRunAnswer | null> => ipc.aiAnswers.run.mutate(input).catch(() => null),
  delete: (id: number): Promise<boolean> => ipc.aiAnswers.delete.mutate({ id }).catch(() => false),
  deleteAll: (): Promise<boolean> => ipc.aiAnswers.deleteAll.mutate().catch(() => false),
  setRetention: (retention: AiAnswerRetention): Promise<boolean> => ipc.aiAnswers.setRetention.mutate({ retention }).catch(() => false),
  setVia: (engine: AiSearchEngine, via: AiSearchViaSetting): Promise<AiSearchSettingResult | null> => ipc.aiAnswers.setVia.mutate({ engine, via }).catch(() => null),
  setDefaultEngine: (engine: AiSearchEngine | null): Promise<AiSearchSettingResult | null> => ipc.aiAnswers.setDefaultEngine.mutate({ engine }).catch(() => null),
};
