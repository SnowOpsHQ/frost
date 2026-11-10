import type { AiAnswerRetention, AiSearchSettingResult } from '@app/specs/ai-answers.spec';
import type { AiAnswerRecord, AiAnswersListAnswer, AiAnswersListInput, AiAnswersRunAnswer, AiAnswersRunInput, AiAnswersView } from '@app/specs/ai-answers.schema';
import type { AiSearchEngine, AiSearchViaSetting } from '@app/specs/ai-search.spec';

// The AI answers view as the `aiAnswers.*` procedures see it (Phase 12 Task 9; spec `ai-answers.schema.ts`;
// acceptance `ai-answers.feature.md`). Main implements it (`apps/desktop/src/main/ai-answers/service.ts`);
// this package only knows the interface. No member answers a key; the run is the user's own action
// (no approval card), refused `unavailable` with `LEGAL_GATE_NOTE` while the engine's provider is gated off.

export interface AiAnswersService {
  /** The retention, the default engine, and per engine its gate (`available`), key, via setting and whether it is usable now. */
  view(): Promise<AiAnswersView>;
  /** A page of kept answers, newest first. */
  list(input: AiAnswersListInput): Promise<AiAnswersListAnswer>;
  /** One kept answer, or `null`. */
  get(id: number): Promise<AiAnswerRecord | null>;
  /** Asks an AI engine now (Task 8's service: the same gate, body, caps and parse) and keeps the answer by the retention. */
  run(input: AiAnswersRunInput): Promise<AiAnswersRunAnswer>;
  /** Deletes one kept answer; whether it went. */
  delete(id: number): Promise<boolean>;
  /** Deletes every kept answer; whether it worked. */
  deleteAll(): Promise<boolean>;
  /** Stores the retention and purges by it; whether it worked. */
  setRetention(retention: AiAnswerRetention): Promise<boolean>;
  /** Task 8's via setting for `engine`; `api` is refused `unavailable` while its provider is gated off, `no-api` without one. */
  setVia(engine: AiSearchEngine, via: AiSearchViaSetting): Promise<AiSearchSettingResult>;
  /** Task 8's default engine (`null` clears it); likewise refused for a gated or API-less engine. */
  setDefaultEngine(engine: AiSearchEngine | null): Promise<AiSearchSettingResult>;
}
