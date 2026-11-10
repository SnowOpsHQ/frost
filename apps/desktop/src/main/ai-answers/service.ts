import { registrableDomain } from '@app/seo-core';
import type { AiAnswersRepository, AiAnswerWrite } from '@app/db';
import type { AiAnswersService } from '@app/ipc-contract';
import { AI_ANSWER_PURGE_INTERVAL_MS, AI_ANSWERS_LIMITS, AI_ANSWERS_RUN_REFUSAL_TEXT, aiAnswersRunRefusalOf, type AiAnswerOrigin, type AiAnswersRunRefusal } from '@app/specs/ai-answers.spec';
import type { AiAnswerRecord, AiAnswersRunAnswer, AiAnswersView } from '@app/specs/ai-answers.schema';
import { AI_SEARCH_API_PROVIDER, AI_SEARCH_ENGINES, aiSearchVia, resolveAiSearch, type AiSearchEngine } from '@app/specs/ai-search.spec';
import type { AiAnswer, AiCitation } from '@app/specs/ai-search.schema';
import { parseWebUrl } from '@app/specs/web-url.spec';
import type { AiSearchService } from '../ai-search/service';

// The AI answers view, main side (Phase 12 Task 9; spec `specs/ai-answers.spec.ts`; acceptance
// `specs/ai-answers.feature.md`, Main; plan Decision 9). Three jobs:
// - **Storage.** Every answer the agent's approved `run_ai_search` gets (Task 8's `onAnswer`) and every
//   answer of the view's own run is kept in `ai_answers` (`store.add`, which honours the retention:
//   `off` keeps nothing), with its cited registrable domains (`registrableDomain` of each citation's
//   host). The chat id is `null`: the tool's port carries none. `start()` purges by the retention
//   (start-up), then daily while frost runs (an unref'd interval, `AI_ANSWER_PURGE_INTERVAL_MS`, as
//   the chats' prune; cleared by `dispose()` on `will-quit`); every write and every retention change
//   purges too (the repository).
// - **The view's run** is the user's own action: no broker, no approval card (the renderer shows the
//   cost note and asks before it calls). It resolves the engine and via exactly as the agent's call is
//   resolved (`resolveAiSearch` over Task 8's `context()`: the same legal gates, keys and settings) and
//   runs through Task 8's `answer` (the via checked again, the fixed body, Task 1's client with its
//   caps, the worker parse). While the engine's provider is gated off (as shipped) it answers
//   `unavailable` with `LEGAL_GATE_NOTE` and sends nothing. One view run at a time (`busy`). The
//   per-engine bound (`cooldown`) is the service's one clock, shared with the agent's calls (lead ruling).
// - **Settings.** Task 8's via per engine and default engine (`app_settings`). Switching an engine
//   `off` is never gated; `api`, or a default engine, whose provider is gated off answers
//   `unavailable`; `google-ai-mode` has no API (`no-api`).

export interface AiAnswersMainDeps {
  readonly store: AiAnswersRepository;
  /** Task 8's service: its context (gates, keys, settings), the view's `answer` and the agent's answers. */
  readonly aiSearch: Pick<AiSearchService, 'context' | 'answer' | 'onAnswer'>;
  readonly now?: () => number;
  /** The daily purge's timer (default: the global `setInterval`, unref'd). */
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** One line per event (never a query, a key or an answer). */
  readonly log?: (line: string) => void;
}

export interface AiAnswersMain extends AiAnswersService {
  /** Purges by the retention (start-up), then daily until `dispose`. Never rejects. */
  start(): Promise<void>;
  /** Stops the daily purge and listening for the agent's answers. */
  dispose(): void;
}

/** The registrable domains `citations` cite, in their first order, distinct, at most `maxCitedDomains`. */
export function citedDomainsOf(citations: readonly AiCitation[]): string[] {
  const domains: string[] = [];
  for (const citation of citations) {
    const parsed = parseWebUrl(citation.url);
    if (parsed === null) continue;
    const domain = registrableDomain(parsed.hostname);
    if (domain === '' || domain.length > AI_ANSWERS_LIMITS.maxDomainChars || domains.includes(domain)) continue;
    domains.push(domain);
    if (domains.length === AI_ANSWERS_LIMITS.maxCitedDomains) break;
  }
  return domains;
}

/** Task 8's answer as a row to keep. */
function writeOf(answer: AiAnswer, origin: AiAnswerOrigin): AiAnswerWrite {
  return {
    query: answer.query,
    engine: answer.engine,
    via: answer.via,
    provider: answer.provider,
    origin,
    answer: answer.answer,
    answerTruncated: answer.answerTruncated,
    citations: answer.citations,
    citationsTotal: answer.citationsTotal,
    citedDomains: citedDomainsOf(answer.citations),
    chatId: null,
  };
}

const refused = (reason: AiAnswersRunRefusal): AiAnswersRunAnswer => ({ status: 'refused', reason, note: AI_ANSWERS_RUN_REFUSAL_TEXT[reason] });

export function createAiAnswersMain(deps: AiAnswersMainDeps): AiAnswersMain {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  let running = false;
  const setTimer = deps.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms).unref());
  const clearTimer = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  let purging: unknown = null;
  let disposed = false;

  /** Keeps `answer`; its id, or `null` (retention `off`, or the write failed). */
  const keep = async (answer: AiAnswer, origin: AiAnswerOrigin, at: number): Promise<number | null> => {
    try {
      return await deps.store.add(writeOf(answer, origin), at);
    } catch {
      log('ai answers: an answer could not be stored');
      return null;
    }
  };

  const arrivedAt = (answer: AiAnswer): number => {
    const at = Date.parse(answer.fetchedAt);
    return Number.isSafeInteger(at) && at >= 0 ? at : now();
  };

  const unsubscribe = deps.aiSearch.onAnswer((answer) => void keep(answer, 'agent', arrivedAt(answer)));

  const view = async (): Promise<AiAnswersView> => {
    const [context, retention] = await Promise.all([deps.aiSearch.context(), deps.store.retention()]);
    return {
      retention,
      defaultEngine: context.settings.defaultEngine,
      engines: AI_SEARCH_ENGINES.map((engine) => {
        const provider = AI_SEARCH_API_PROVIDER[engine];
        return {
          engine,
          provider,
          available: provider !== null && context.gates[provider] === true,
          hasKey: provider !== null && context.keys[provider] === true,
          via: context.settings.via[engine],
          usable: aiSearchVia(engine, context) !== null,
        };
      }),
    };
  };

  /** Whether `engine` may be named in a setting now: `ok`, or why not. */
  const settable = async (engine: AiSearchEngine): Promise<'ok' | 'unavailable' | 'no-api'> => {
    const provider = AI_SEARCH_API_PROVIDER[engine];
    if (provider === null) return 'no-api';
    const context = await deps.aiSearch.context();
    return context.gates[provider] === true ? 'ok' : 'unavailable';
  };

  const purge = async (): Promise<void> => {
    try {
      await deps.store.purge(now());
    } catch {
      log('ai answers: a purge failed');
    }
  };

  return {
    async start() {
      if (purging === null && !disposed) purging = setTimer(() => void purge(), AI_ANSWER_PURGE_INTERVAL_MS);
      await purge();
    },

    dispose() {
      disposed = true;
      unsubscribe();
      if (purging !== null) clearTimer(purging);
      purging = null;
    },

    view,

    list: (input) => deps.store.list(input),

    get: (id) => deps.store.get(id),

    async run({ query, engine }) {
      // One at a time: claimed before anything is awaited.
      if (running) return refused('busy');
      running = true;
      try {
        const resolved = resolveAiSearch(engine === undefined ? {} : { engine }, await deps.aiSearch.context());
        if (!resolved.ok) return refused(aiAnswersRunRefusalOf(resolved.reason));
        const result = await deps.aiSearch.answer({ query, engine: resolved.engine, via: resolved.via });
        if (!result.ok) {
          log(`ai answers: a view run was refused (${result.reason})`);
          return refused(aiAnswersRunRefusalOf(result.reason));
        }
        const createdAt = arrivedAt(result.answer);
        const id = await keep(result.answer, 'view', createdAt);
        const kept: Omit<AiAnswerRecord, 'id'> & { id: number | null } = { ...writeOf(result.answer, 'view'), id, createdAt };
        return { status: 'ok', answer: kept };
      } finally {
        running = false;
      }
    },

    delete: (id) => deps.store.delete(id),

    async deleteAll() {
      await deps.store.deleteAll();
      return true;
    },

    setRetention: (retention) => deps.store.setRetention(retention, now()),

    async setVia(engine, via) {
      if (via === 'api') {
        const allowed = await settable(engine);
        if (allowed !== 'ok') return allowed;
      }
      return (await deps.store.setAiSearchVia(engine, via, now())) ? 'ok' : 'failed';
    },

    async setDefaultEngine(engine) {
      if (engine !== null) {
        const allowed = await settable(engine);
        if (allowed !== 'ok') return allowed;
      }
      return (await deps.store.setAiSearchDefaultEngine(engine, now())) ? 'ok' : 'failed';
    },
  };
}
