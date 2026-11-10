import { unavailable, type AiSearchAnswer, type AiSearchQuery, type PortAnswer, type PortQueryOptions } from '@app/ai-skills';
import {
  AI_SEARCH_API_PROVIDER,
  AI_SEARCH_ENGINES,
  AI_SEARCH_LIMITS,
  AI_SEARCH_UNAVAILABLE_MESSAGES,
  aiSearchAnswerNote,
  aiSearchVia,
  CLOSED_AI_SEARCH_CONTEXT,
  DEFAULT_AI_SEARCH_SETTINGS,
  isAiSearchEngine,
  isAiSearchVia,
  type AiSearchContext,
  type AiSearchEngine,
  type AiSearchProvider,
  type AiSearchSettings,
  type AiSearchUnavailableReason,
  type AiSearchVia,
} from '@app/specs/ai-search.spec';
import type { AiAnswer, AiAnswerJob, AiAnswerJobResult } from '@app/specs/ai-search.schema';
import { DATA_AI_SEARCH_PROVIDERS, type LegalGateId } from '@app/specs/data-sources.spec';
import type { DataApiClient } from '../data-sources/api-client';
import { aiSearchBuild } from './api';

// `run_ai_search` via the providers' APIs, main side (Phase 12 Task 8; spec `ai-search.spec.ts`;
// acceptance `ai-search.feature.md`; plan Decision 8). Two members:
// - `context()`: the AI search settings (`app_settings`), each provider's legal gate
//   (`legalGates.isOpen`) and whether its key is set (`dataSources.status`), read now. The broker
//   completes and decides each `run_ai_search` call from it. A failed read counts as nothing set up.
// - `ask(query)`: the approved call. It runs only with the approved `engine` and `via`; it reads the
//   context again and, if the engine's via is no longer the approved one, answers `setting-changed`
//   (the tool answers `expired`) and sends nothing. Otherwise it builds the provider's fixed body
//   (`api.ts`) and sends it through Task 1's `dataApiRequest` (gate, turn, key and allowlist checked
//   there; the key read and the request sent inside its `withKey` closure), has the SERP worker parse
//   the answer (`parse`, job kind `ai-answer`: main never parses the provider's JSON) and answers the
//   text and citations with the engine, via and note. The provider's own words are never passed on:
//   a refusal is a fixed message. Nothing is stored here: `onAnswer` (Task 9 wires `ai_answers`) is
//   told each answer. Nothing runs on a timer: every call follows the user's approval.
//   Task 8 review: the call's signal (Stop, or the tool's `AI_SEARCH_TOOL_TIMEOUT_MS`) reaches the
//   client (`dataApiRequest`'s `signal`), the setting is asked again once the provider's turn comes
//   (`beforeSend`: `setting-changed`, nothing sent), and an aborted call tells no listener.
// - `answer(query)` (Task 9): the AI answers view's own run, a user action (no approval card). The
//   same path as `ask` (the via checked again, the fixed body, the client, the worker parse), given
//   the engine and via the view resolved; it answers the `AiAnswer` itself and tells no listener
//   (the view stores it).

export interface AiSearchSettingsReader {
  /** `SettingsRepository.aiSearchSettings`. */
  aiSearchSettings(): Promise<AiSearchSettings>;
}

export interface AiSearchServiceDeps {
  /** Task 1's client (`dataApiRequest`), the one reviewed path to a provider. */
  readonly client: Pick<DataApiClient, 'dataApiRequest'>;
  /** The legal gates (`data-sources/gates.ts`; tests open them by injection). */
  readonly isOpen: (id: LegalGateId) => boolean;
  /** Whether each provider's key is set (`dataSources.status()`'s `hasKey`); never a key. */
  readonly keys: () => Promise<Readonly<Partial<Record<AiSearchProvider, boolean>>>>;
  readonly settings: AiSearchSettingsReader;
  /** The SERP worker's `ai-answer` job (`parser.ts`). */
  readonly parse: (job: AiAnswerJob) => Promise<AiAnswerJobResult>;
  readonly now?: () => number;
  /** One line per call (never a query, a key or an answer). */
  readonly log?: (line: string) => void;
}

export interface AiSearchService {
  /** The settings, gates and keys now (`resolveAiSearch`'s input). Never rejects. */
  context(): Promise<AiSearchContext>;
  /** Runs one approved call. Rejects only with its signal's reason. */
  ask(query: AiSearchQuery, options?: PortQueryOptions): Promise<PortAnswer<AiSearchAnswer>>;
  /** Called with each answer (Task 9 stores it in `ai_answers`); returns the unsubscribe. */
  onAnswer(listener: (answer: AiAnswer) => void): () => void;
  /** Task 9: the AI answers view's run (`ask`'s path; no listener told). Rejects only with its signal's reason. */
  answer(query: AiSearchViewQuery, options?: PortQueryOptions): Promise<AiSearchViewResult>;
}

/** Task 9: the view's question, with the engine and via it resolved (`resolveAiSearch`). */
export interface AiSearchViewQuery {
  readonly query: string;
  readonly engine: AiSearchEngine;
  readonly via: AiSearchVia;
}

/** Task 9: the view's answer, or why there is none (nothing sent unless `request-failed` / `invalid-answer`). */
export type AiSearchViewResult = { readonly ok: true; readonly answer: AiAnswer } | { readonly ok: false; readonly reason: AiSearchUnavailableReason };

const refused = (reason: AiSearchUnavailableReason): PortAnswer<never> => unavailable(AI_SEARCH_UNAVAILABLE_MESSAGES[reason], reason);

/** A settings value as read: unknown or tampered fields fall back to the defaults. */
function cleanSettings(value: unknown): AiSearchSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_AI_SEARCH_SETTINGS;
  const { via, defaultEngine } = value as { via?: unknown; defaultEngine?: unknown };
  const given = typeof via === 'object' && via !== null ? (via as Record<string, unknown>) : {};
  const out = { ...DEFAULT_AI_SEARCH_SETTINGS.via } as Record<(typeof AI_SEARCH_ENGINES)[number], 'api' | 'off' | null>;
  for (const engine of AI_SEARCH_ENGINES) {
    const setting = given[engine];
    out[engine] = setting === 'api' || setting === 'off' ? setting : null;
  }
  return { via: out, defaultEngine: isAiSearchEngine(defaultEngine) ? defaultEngine : null };
}

export function createAiSearchService(deps: AiSearchServiceDeps): AiSearchService {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const listeners = new Set<(answer: AiAnswer) => void>();

  const context = async (): Promise<AiSearchContext> => {
    try {
      const gates = { perplexity: deps.isOpen('perplexity'), 'openai-search': deps.isOpen('openai-search') };
      // Keys are looked up only when a gate is open (as shipped: never).
      const keys = { ...CLOSED_AI_SEARCH_CONTEXT.keys };
      if (DATA_AI_SEARCH_PROVIDERS.some((provider) => gates[provider])) {
        const set = await deps.keys();
        for (const provider of DATA_AI_SEARCH_PROVIDERS) keys[provider] = gates[provider] && set[provider] === true;
      }
      const settings = cleanSettings(await deps.settings.aiSearchSettings());
      return { settings, gates, keys };
    } catch {
      log('ai search: the settings could not be read');
      return CLOSED_AI_SEARCH_CONTEXT;
    }
  };

  const tell = (answer: AiAnswer): void => {
    for (const listener of [...listeners]) {
      try {
        listener(answer);
      } catch {
        log('ai search: an answer listener failed');
      }
    }
  };

  /** One approved call, sent and parsed; told to no listener. */
  const send = async (query: AiSearchQuery, signal: AbortSignal | undefined): Promise<AiSearchViewResult> => {
    signal?.throwIfAborted();
    const { engine, via } = query;
    // Only an approved input carries both; anything else was not approved as it would run.
    if (!isAiSearchEngine(engine) || !isAiSearchVia(via) || typeof query.query !== 'string') return { ok: false, reason: 'setting-changed' };
    // The setting at run time must still give the approved via (what was approved is what runs).
    if (aiSearchVia(engine, await context()) !== via) {
      log(`ai search: ${engine} refused (setting-changed)`);
      return { ok: false, reason: 'setting-changed' };
    }
    signal?.throwIfAborted();
    const provider = AI_SEARCH_API_PROVIDER[engine];
    if (provider === null) return { ok: false, reason: 'no-api' };
    const build = aiSearchBuild(provider, query.query);
    if (build === null) return { ok: false, reason: 'request-failed' };
    // The signal reaches the request (Stop or the tool's deadline: a waiting request is never sent,
    // one in flight is aborted), and the setting is asked again once its turn comes, before any key
    // is read: switched off while it waited, nothing is sent (`setting-changed`).
    const answer = await deps.client.dataApiRequest(provider, 'ai-search', build, {
      ...(signal ? { signal } : {}),
      beforeSend: async () => aiSearchVia(engine, await context()) === via,
    });
    signal?.throwIfAborted();
    if (!answer.ok) {
      log(`ai search: ${engine} request ${answer.refusal}`);
      if (answer.refusal === 'cancelled') return { ok: false, reason: 'setting-changed' };
      return { ok: false, reason: answer.refusal === 'unavailable' ? 'not-available' : 'request-failed' };
    }
    // The client caps the body; checked again before it is posted (the worker checks its bytes).
    if (answer.body.length > AI_SEARCH_LIMITS.maxResponseBytes) return { ok: false, reason: 'invalid-answer' };
    const parsed = await deps.parse({ provider, body: answer.body }).catch((): AiAnswerJobResult => ({ ok: false }));
    signal?.throwIfAborted();
    if (!parsed.ok) {
      log(`ai search: ${engine} answer not read`);
      return { ok: false, reason: 'invalid-answer' };
    }
    const fetchedAt = new Date(now()).toISOString();
    return { ok: true, answer: { query: query.query, engine, via, provider, ...parsed.answer, fetchedAt } };
  };

  return {
    context,
    async ask(query, options) {
      const result = await send(query, options?.signal);
      if (!result.ok) return refused(result.reason);
      // Stopped (or past the tool's deadline) after the answer arrived: nothing is passed on or kept.
      options?.signal?.throwIfAborted();
      const record = result.answer;
      tell(record);
      return {
        status: 'ok',
        data: {
          query: record.query,
          engine: record.engine,
          via: record.via,
          note: aiSearchAnswerNote(record.engine, record.via),
          answer: record.answer,
          answerTruncated: record.answerTruncated,
          citations: record.citations,
          citationsTotal: record.citationsTotal,
          fetchedAt: record.fetchedAt,
        },
      };
    },
    answer: (query, options) => send(query, options?.signal),
    onAnswer(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
