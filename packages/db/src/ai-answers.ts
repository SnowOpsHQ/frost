import { and, count, desc, eq, lt, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AI_ANSWER_RETENTION_KEY, AI_ANSWERS_LIMITS as L, aiAnswerRetentionCutoff, DEFAULT_AI_ANSWER_RETENTION, isAiAnswerRetention, type AiAnswerRetention } from '@app/specs/ai-answers.spec';
import { AiAnswerRecordSchema, type AiAnswerRecord, type AiAnswerSummary } from '@app/specs/ai-answers.schema';
import { AiCitationSchema } from '@app/specs/ai-search.schema';
import { AI_SEARCH_DEFAULT_ENGINE_KEY, AI_SEARCH_VIA_KEY, isAiSearchEngine, isAiSearchViaSetting, type AiSearchEngine, type AiSearchViaSetting } from '@app/specs/ai-search.spec';
import type { SessionDatabase } from './client';
import { aiAnswers } from './ai-answers-schema';
import { appSettings } from './settings-schema';

// The AI answers (Phase 12 Task 9; spec `specs/ai-answers.spec.ts`; acceptance `specs/ai-answers.feature.md`,
// Storage). Main adds each answer (the agent's, through Task 8's `onAnswer`; the view's own run) with
// `add`, which honours the retention: `off` stores nothing, and every write purges what the setting no
// longer keeps (older than its cutoff, and past `AI_ANSWERS_LIMITS.maxStored`). Main also purges at
// start-up (`purge`) and when the setting changes (`setRetention`). Every value is checked both ways
// (`AiAnswerRecordSchema`): an invalid answer is refused, and a tampered row reads as none (a list skips
// it). The view's AI search settings (Task 8's `AI_SEARCH_VIA_KEY(engine)`, `AI_SEARCH_DEFAULT_ENGINE_KEY`)
// are written here too; `SettingsRepository.aiSearchSettings` reads them.

/** One answer to keep: Task 8's `AiAnswer` (without its time) plus where it came from, its cited domains and chat. */
export type AiAnswerWrite = Omit<AiAnswerRecord, 'id' | 'createdAt'>;

export interface AiAnswersPageInput {
  /** Rows older than this id; none: from the newest. */
  readonly beforeId?: number | undefined;
  readonly limit: number;
}

export interface AiAnswersPage {
  readonly rows: AiAnswerSummary[];
  readonly more: boolean;
  readonly total: number;
}

export interface AiAnswersRepository {
  /** Keeps `answer` (arrived at `at`, Unix ms) and purges by the retention; its id, or `null` (retention `off`, or an invalid answer or time: nothing written). */
  add(answer: AiAnswerWrite, at: number): Promise<number | null>;
  /** The answer `id`, or `null` (none, or a row that is not a well-formed answer). */
  get(id: number): Promise<AiAnswerRecord | null>;
  /** A page of answers, newest first (tampered rows skipped). */
  list(input: AiAnswersPageInput): Promise<AiAnswersPage>;
  /** Deletes the answer `id`; whether one went. */
  delete(id: number): Promise<boolean>;
  /** Deletes every answer; how many went. */
  deleteAll(): Promise<number>;
  /** The retention (`DEFAULT_AI_ANSWER_RETENTION` when unset or tampered). */
  retention(): Promise<AiAnswerRetention>;
  /** Stores the retention and purges by it at once; `false` (nothing written) for an unknown value or an invalid time. */
  setRetention(retention: AiAnswerRetention, at: number): Promise<boolean>;
  /** Deletes what the retention no longer keeps at `now`; how many went. */
  purge(now: number): Promise<number>;
  /** Task 8's via setting for `engine` (`api` | `off`); `false` (nothing written) for anything else. */
  setAiSearchVia(engine: AiSearchEngine, via: AiSearchViaSetting, at: number): Promise<boolean>;
  /** Task 8's default engine (`null` clears it); `false` (nothing written) for anything else. */
  setAiSearchDefaultEngine(engine: AiSearchEngine | null, at: number): Promise<boolean>;
}

/** What `add` accepts: exactly an `AiAnswerWrite`. */
const AiAnswerWriteSchema = AiAnswerRecordSchema.omit({ id: true, createdAt: true });
const CitationsSchema = z.array(AiCitationSchema).max(L.maxCitations);
const DomainsSchema = AiAnswerRecordSchema.shape.citedDomains;

/** Longest setting value read back (a retention is short; anything longer is not one). */
const MAX_SETTING_CHARS = 16;

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** JSON text as a value, or `undefined` when it is not JSON. */
function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `text` on one line, cut at `max` (never between a surrogate pair). */
function previewOf(text: string, max: number): string {
  let line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  line = line.slice(0, max);
  const last = line.charCodeAt(line.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? line.slice(0, -1) : line;
}

// A tampered file may hold values of any size: read no more of each than a valid one can be (one over).
const columns = {
  id: aiAnswers.id,
  query: sql<unknown>`substr(${aiAnswers.query}, 1, ${L.maxQueryChars + 1})`,
  engine: sql<unknown>`substr(${aiAnswers.engine}, 1, 32)`,
  via: sql<unknown>`substr(${aiAnswers.via}, 1, 32)`,
  provider: sql<unknown>`substr(${aiAnswers.provider}, 1, 32)`,
  origin: sql<unknown>`substr(${aiAnswers.origin}, 1, 32)`,
  answer: sql<unknown>`substr(${aiAnswers.answer}, 1, ${L.maxAnswerChars + 1})`,
  answerTruncated: aiAnswers.answerTruncated,
  citationsJson: sql<unknown>`substr(${aiAnswers.citationsJson}, 1, ${L.maxCitationsJsonChars + 1})`,
  citationsTotal: aiAnswers.citationsTotal,
  citedDomainsJson: sql<unknown>`substr(${aiAnswers.citedDomainsJson}, 1, ${L.maxCitedDomainsJsonChars + 1})`,
  chatId: sql<unknown>`substr(${aiAnswers.chatId}, 1, ${L.maxChatIdChars + 1})`,
  createdAt: aiAnswers.createdAt,
};

type Row = { [K in keyof typeof columns]: unknown };

/** A row as an answer, or `null` when any field is not what a stored answer can be. */
function recordOf(row: Row): AiAnswerRecord | null {
  const citations = CitationsSchema.safeParse(parseJson(row.citationsJson));
  const domains = DomainsSchema.safeParse(parseJson(row.citedDomainsJson));
  if (!citations.success || !domains.success || (row.answerTruncated !== 0 && row.answerTruncated !== 1)) return null;
  const record = AiAnswerRecordSchema.safeParse({
    id: row.id,
    query: row.query,
    engine: row.engine,
    via: row.via,
    provider: row.provider,
    origin: row.origin,
    answer: row.answer,
    answerTruncated: row.answerTruncated === 1,
    citations: citations.data,
    citationsTotal: row.citationsTotal,
    citedDomains: domains.data,
    chatId: row.chatId ?? null,
    createdAt: row.createdAt,
  });
  return record.success ? record.data : null;
}

function summaryOf(record: AiAnswerRecord): AiAnswerSummary {
  return {
    id: record.id,
    query: record.query,
    engine: record.engine,
    via: record.via,
    provider: record.provider,
    origin: record.origin,
    preview: previewOf(record.answer, L.previewChars),
    citationCount: record.citations.length,
    citedDomains: record.citedDomains,
    chatId: record.chatId,
    createdAt: record.createdAt,
  };
}

export function createAiAnswersRepository(db: SessionDatabase): AiAnswersRepository {
  const readSetting = async (key: string): Promise<unknown> => {
    const [row] = await db
      .select({ value: sql<unknown>`substr(${appSettings.value}, 1, ${MAX_SETTING_CHARS})` })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    return row?.value;
  };
  const writeSetting = (key: string, value: string, at: number) =>
    db
      .insert(appSettings)
      .values({ key, value, updatedAt: at })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: at } });

  const retention = async (): Promise<AiAnswerRetention> => {
    const value = await readSetting(AI_ANSWER_RETENTION_KEY);
    return isAiAnswerRetention(value) ? value : DEFAULT_AI_ANSWER_RETENTION;
  };

  /** The purge's two deletes: past the cutoff, then past `maxStored` (the newest kept). */
  const purgeStatements = (cutoff: number | null) => {
    const kept = db.select({ id: aiAnswers.id }).from(aiAnswers).orderBy(desc(aiAnswers.createdAt), desc(aiAnswers.id)).limit(L.maxStored);
    const byAge = cutoff === null ? null : cutoff === Number.POSITIVE_INFINITY ? db.delete(aiAnswers).returning({ id: aiAnswers.id }) : db.delete(aiAnswers).where(lt(aiAnswers.createdAt, cutoff)).returning({ id: aiAnswers.id });
    const bySize = db.delete(aiAnswers).where(notInArray(aiAnswers.id, kept)).returning({ id: aiAnswers.id });
    return { byAge, bySize };
  };

  const purge = async (now: number): Promise<number> => {
    if (!isTime(now)) return 0;
    const { byAge, bySize } = purgeStatements(aiAnswerRetentionCutoff(await retention(), now));
    const aged = byAge === null ? [] : await byAge;
    const sized = await bySize;
    return aged.length + sized.length;
  };

  return {
    async add(answer, at) {
      if (!isTime(at)) return null;
      const parsed = AiAnswerWriteSchema.safeParse(answer);
      if (!parsed.success) return null;
      const setting = await retention();
      if (setting === 'off') return null;
      const value = parsed.data;
      const [inserted] = await db
        .insert(aiAnswers)
        .values({
          query: value.query,
          engine: value.engine,
          via: value.via,
          provider: value.provider,
          origin: value.origin,
          answer: value.answer,
          answerTruncated: value.answerTruncated ? 1 : 0,
          citationsJson: JSON.stringify(value.citations),
          citationsTotal: value.citationsTotal,
          citedDomainsJson: JSON.stringify(value.citedDomains),
          chatId: value.chatId,
          createdAt: at,
        })
        .returning({ id: aiAnswers.id });
      await purge(at);
      return inserted && isId(inserted.id) ? inserted.id : null;
    },

    async get(id) {
      if (!isId(id)) return null;
      const [row] = await db.select(columns).from(aiAnswers).where(eq(aiAnswers.id, id)).limit(1);
      return row ? recordOf(row) : null;
    },

    async list({ beforeId, limit }) {
      const size = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), L.maxPageSize) : L.defaultPageSize;
      const where = beforeId !== undefined && isId(beforeId) ? lt(aiAnswers.id, beforeId) : undefined;
      const rows = await db
        .select(columns)
        .from(aiAnswers)
        .where(and(where))
        .orderBy(desc(aiAnswers.id))
        .limit(size + 1);
      const [total] = await db.select({ n: count() }).from(aiAnswers);
      const page = rows.slice(0, size).flatMap((row) => {
        const record = recordOf(row);
        return record === null ? [] : [summaryOf(record)];
      });
      return { rows: page, more: rows.length > size, total: typeof total?.n === 'number' ? total.n : 0 };
    },

    async delete(id) {
      if (!isId(id)) return false;
      const gone = await db.delete(aiAnswers).where(eq(aiAnswers.id, id)).returning({ id: aiAnswers.id });
      return gone.length > 0;
    },

    async deleteAll() {
      const gone = await db.delete(aiAnswers).returning({ id: aiAnswers.id });
      return gone.length;
    },

    retention,

    async setRetention(value, at) {
      if (!isAiAnswerRetention(value) || !isTime(at)) return false;
      await writeSetting(AI_ANSWER_RETENTION_KEY, value, at);
      await purge(at);
      return true;
    },

    purge,

    async setAiSearchVia(engine, via, at) {
      if (!isAiSearchEngine(engine) || !isAiSearchViaSetting(via) || !isTime(at)) return false;
      await writeSetting(AI_SEARCH_VIA_KEY(engine), via, at);
      return true;
    },

    async setAiSearchDefaultEngine(engine, at) {
      if ((engine !== null && !isAiSearchEngine(engine)) || !isTime(at)) return false;
      if (engine === null) await db.delete(appSettings).where(eq(appSettings.key, AI_SEARCH_DEFAULT_ENGINE_KEY));
      else await writeSetting(AI_SEARCH_DEFAULT_ENGINE_KEY, engine, at);
      return true;
    },
  };
}
