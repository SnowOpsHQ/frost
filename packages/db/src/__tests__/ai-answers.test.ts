// Spec: specs/ai-answers.spec.ts (AI_ANSWERS_TABLES, AI_ANSWERS_MIGRATION_IDS, AI_ANSWERS_LIMITS, AI_ANSWER_RETENTIONS,
// DEFAULT_AI_ANSWER_RETENTION, AI_ANSWER_RETENTION_KEY, aiAnswerRetentionCutoff), specs/ai-answers.schema.ts
// (AiAnswerRecordSchema, AiAnswerSummarySchema), specs/ai-search.spec.ts (AI_SEARCH_VIA_KEY, AI_SEARCH_DEFAULT_ENGINE_KEY),
// specs/sync.spec.ts (SYNC_TABLES); plan docs/plans/phase-12-big-bets.md Decision 9, Global constraints (0242 after the
// site crawl's 0240/0241, before 0243), Task 9
// Acceptance: specs/ai-answers.feature.md (Storage)
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  AI_ANSWER_RETENTION_KEY,
  AI_ANSWER_RETENTIONS,
  AI_ANSWERS_LIMITS,
  AI_ANSWERS_MIGRATION_IDS,
  AI_ANSWERS_TABLES,
  aiAnswerRetentionCutoff,
  DEFAULT_AI_ANSWER_RETENTION,
} from '@app/specs/ai-answers.spec';
import { AiAnswerRecordSchema, AiAnswerSummarySchema } from '@app/specs/ai-answers.schema';
import { AI_SEARCH_DEFAULT_ENGINE_KEY, AI_SEARCH_VIA_KEY } from '@app/specs/ai-search.spec';
import { SYNC_TABLES } from '@app/specs/sync.spec';
import { createDrizzle } from '../client';
import { AI_ANSWERS_MIGRATIONS } from '../ai-answers-migrations';
import { aiAnswers } from '../ai-answers-schema';
import { createAiAnswersRepository, type AiAnswersRepository, type AiAnswerWrite } from '../ai-answers';
import { DATA_USAGE_MIGRATIONS } from '../data-usage-migrations';
import { MIGRATIONS, runMigrations } from '../migrations';
import { createSettingsRepository } from '../settings';
import { SITE_CRAWL_MIGRATIONS } from '../site-crawl/migrations';

let raw: DatabaseSync;
let repo: AiAnswersRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createAiAnswersRepository(createDrizzle(raw));
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12);

const write = (patch: Partial<AiAnswerWrite> = {}): AiAnswerWrite => ({
  query: 'how to store green tea',
  engine: 'perplexity',
  via: 'api',
  provider: 'perplexity',
  origin: 'agent',
  answer: 'Keep it airtight, cool and dark [1].',
  answerTruncated: false,
  citations: [
    { url: 'https://tea.example/storage', title: 'Storing green tea' },
    { url: 'https://shop.tea.example/tins', title: 'Tins' },
    { url: 'https://leaf.example.org/guide', title: '' },
  ],
  citationsTotal: 3,
  citedDomains: ['tea.example', 'leaf.example.org'],
  chatId: null,
  ...patch,
});

const count = () => Number(raw.prepare('SELECT count(*) AS n FROM ai_answers').get()!['n']);
const accepts = (sql: string, ...values: (string | number | null)[]) => {
  try {
    raw.prepare(sql).run(...values);
    return true;
  } catch {
    return false;
  }
};
const INSERT = 'INSERT INTO ai_answers (query, engine, via, provider, origin, answer, answer_truncated, citations_json, citations_total, cited_domains_json, chat_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const row = (patch: Record<string, string | number | null> = {}) => {
  const base: Record<string, string | number | null> = { query: 'q', engine: 'perplexity', via: 'api', provider: 'perplexity', origin: 'view', answer: 'a', answer_truncated: 0, citations_json: '[]', citations_total: 0, cited_domains_json: '[]', chat_id: null, created_at: NOW, ...patch };
  return [base['query']!, base['engine']!, base['via']!, base['provider']!, base['origin']!, base['answer']!, base['answer_truncated']!, base['citations_json']!, base['citations_total']!, base['cited_domains_json']!, base['chat_id'] ?? null, base['created_at']!] as const;
};

describe('ai answers storage', () => {
  test('ai-answers-migration-creates-table', () => {
    // Its own id, in Phase 12's range: after the site crawl's list, before the data usage counter's 0243.
    expect(AI_ANSWERS_MIGRATIONS.map((m) => m.id)).toEqual([...AI_ANSWERS_MIGRATION_IDS]);
    const at = MIGRATIONS.indexOf(AI_ANSWERS_MIGRATIONS[0]!);
    expect(at).toBe(MIGRATIONS.indexOf(SITE_CRAWL_MIGRATIONS[SITE_CRAWL_MIGRATIONS.length - 1]!) + 1);
    expect(MIGRATIONS[at + AI_ANSWERS_MIGRATIONS.length]).toBe(DATA_USAGE_MIGRATIONS[0]);
    expect(getTableConfig(aiAnswers).name).toBe(AI_ANSWERS_TABLES[0]);
    const columns = raw.prepare('PRAGMA table_info(ai_answers)').all().map((c) => [c['name'], c['notnull']]);
    expect(columns).toEqual([
      ['id', 0],
      ['query', 1],
      ['engine', 1],
      ['via', 1],
      ['provider', 1],
      ['origin', 1],
      ['answer', 1],
      ['answer_truncated', 1],
      ['citations_json', 1],
      ['citations_total', 1],
      ['cited_domains_json', 1],
      ['chat_id', 0],
      ['created_at', 1],
    ]);
    // A well-formed row goes in; each CHECK refuses its own kind of bad value.
    expect(accepts(INSERT, ...row())).toBe(true);
    expect(accepts(INSERT, ...row({ chat_id: 'chat-1' }))).toBe(true);
    const bads: Record<string, string | number | null>[] = [
      { engine: 'bing' },
      { via: 'tab' },
      { provider: 'serpapi' },
      { origin: 'sync' },
      { query: '' },
      { query: 'q'.repeat(AI_ANSWERS_LIMITS.maxQueryChars + 1) },
      { answer: '' },
      { answer: 'a'.repeat(AI_ANSWERS_LIMITS.maxAnswerChars + 1) },
      { answer_truncated: 2 },
      { citations_json: 'x'.repeat(AI_ANSWERS_LIMITS.maxCitationsJsonChars + 1) },
      { citations_json: '{}' },
      { citations_total: -1 },
      { cited_domains_json: 'x'.repeat(AI_ANSWERS_LIMITS.maxCitedDomainsJsonChars + 1) },
      { chat_id: '' },
      { chat_id: 'c'.repeat(AI_ANSWERS_LIMITS.maxChatIdChars + 1) },
      { created_at: -1 },
      { created_at: 'yesterday' },
    ];
    for (const bad of bads) {
      expect(accepts(INSERT, ...row(bad)), JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    // The newest-first list reads an index.
    const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ai_answers' AND name NOT LIKE 'sqlite_%'").all().map((r) => r['name']);
    expect(indexes).toEqual(getTableConfig(aiAnswers).indexes.map((index) => index.config.name));
  });

  test('ai-answers-retention-purges', async () => {
    // The default: 30 days.
    expect(DEFAULT_AI_ANSWER_RETENTION).toBe('30d');
    expect(await repo.retention()).toBe('30d');
    expect(aiAnswerRetentionCutoff('forever', NOW)).toBeNull();
    expect(aiAnswerRetentionCutoff('off', NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(aiAnswerRetentionCutoff('7d', NOW)).toBe(NOW - 7 * DAY);

    // On write: anything older than the cutoff goes.
    expect(await repo.add(write({ query: 'old' }), NOW - 31 * DAY)).toEqual(expect.any(Number));
    expect(await repo.add(write({ query: 'recent' }), NOW - 8 * DAY)).toEqual(expect.any(Number));
    expect(count()).toBe(2);
    expect(await repo.add(write({ query: 'now' }), NOW)).toEqual(expect.any(Number));
    expect((await repo.list({ limit: 10 })).rows.map((r) => r.query)).toEqual(['now', 'recent']);

    // Changing the setting purges at once.
    expect(await repo.setRetention('7d', NOW)).toBe(true);
    expect((await repo.list({ limit: 10 })).rows.map((r) => r.query)).toEqual(['now']);
    expect(raw.prepare('SELECT value FROM app_settings WHERE key = ?').get(AI_ANSWER_RETENTION_KEY)!['value']).toBe('7d');

    // A purge (start-up) by the clock.
    expect(await repo.purge(NOW + 8 * DAY)).toBe(1);
    expect(count()).toBe(0);

    // forever keeps old ones, but no more than maxStored.
    expect(await repo.setRetention('forever', NOW)).toBe(true);
    await repo.add(write(), NOW - 400 * DAY);
    expect(await repo.purge(NOW)).toBe(0);
    expect(count()).toBe(1);
    const stmt = raw.prepare(INSERT);
    raw.exec('BEGIN');
    for (let i = 0; i < AI_ANSWERS_LIMITS.maxStored + 5; i += 1) stmt.run(...row({ created_at: NOW - i }));
    raw.exec('COMMIT');
    await repo.purge(NOW);
    expect(count()).toBe(AI_ANSWERS_LIMITS.maxStored);
    // The oldest went (the 400-day-old one first).
    expect(Number(raw.prepare('SELECT min(created_at) AS t FROM ai_answers').get()!['t'])).toBe(NOW - (AI_ANSWERS_LIMITS.maxStored - 1));

    // off: what was kept goes, and nothing more is stored.
    expect(await repo.setRetention('off', NOW)).toBe(true);
    expect(count()).toBe(0);
    expect(await repo.add(write(), NOW)).toBeNull();
    expect(count()).toBe(0);

    // A tampered setting reads as the default; an unknown one is never written.
    raw.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('1y', AI_ANSWER_RETENTION_KEY);
    expect(await repo.retention()).toBe('30d');
    expect(await repo.setRetention('1y' as never, NOW)).toBe(false);
    expect(await repo.setRetention('7d', Number.NaN)).toBe(false);
    for (const retention of AI_ANSWER_RETENTIONS) expect(await repo.setRetention(retention, NOW)).toBe(true);
  });

  test('ai-answers-rows-checked', async () => {
    // An invalid answer writes nothing.
    for (const bad of [
      write({ query: '' }),
      write({ engine: 'bing' as never }),
      write({ via: 'tab' as never }),
      write({ answer: 'a'.repeat(AI_ANSWERS_LIMITS.maxAnswerChars + 1) }),
      write({ citations: Array.from({ length: AI_ANSWERS_LIMITS.maxCitations + 1 }, (_, i) => ({ url: `https://x.example/${i}`, title: '' })) }),
      write({ citedDomains: [''] }),
      write({ chatId: '' }),
      { ...write(), extra: 1 } as AiAnswerWrite,
    ]) {
      expect(await repo.add(bad, NOW)).toBeNull();
    }
    expect(await repo.add(write(), Number.NaN)).toBeNull();
    expect(count()).toBe(0);

    // Stored and read back whole; ids rise; list rows are summaries, newest first, paged.
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await repo.add(write({ query: `q${i}`, origin: i % 2 === 0 ? 'agent' : 'view', chatId: i === 0 ? 'chat-a' : null }), NOW + i))!);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const record = await repo.get(ids[0]!);
    expect(AiAnswerRecordSchema.parse(record)).toEqual({ ...write({ query: 'q0', chatId: 'chat-a' }), id: ids[0], createdAt: NOW });
    const first = await repo.list({ limit: 2 });
    expect(first.rows.map((r) => r.query)).toEqual(['q4', 'q3']);
    expect(first.more).toBe(true);
    expect(first.total).toBe(5);
    for (const summary of first.rows) expect(AiAnswerSummarySchema.parse(summary)).toEqual(summary);
    expect(first.rows[0]).toMatchObject({ preview: write().answer, citationCount: 3, citedDomains: ['tea.example', 'leaf.example.org'], origin: 'agent' });
    const second = await repo.list({ beforeId: first.rows[1]!.id, limit: 10 });
    expect(second.rows.map((r) => r.query)).toEqual(['q2', 'q1', 'q0']);
    expect(second.more).toBe(false);
    // A long answer's preview is cut.
    const long = (await repo.add(write({ answer: 'w '.repeat(1000).trim() }), NOW + 10))!;
    expect((await repo.list({ limit: 1 })).rows[0]!.preview.length).toBeLessThanOrEqual(AI_ANSWERS_LIMITS.previewChars);
    expect((await repo.get(long))!.answer.length).toBe(1999);

    // A tampered row reads as none and is skipped in a list (never breaks the page).
    raw.prepare('UPDATE ai_answers SET citations_json = ? WHERE id = ?').run('[{"url":"javascript:alert(1)","title":1}]', ids[3]!);
    raw.prepare('UPDATE ai_answers SET cited_domains_json = ? WHERE id = ?').run('[1, ""]', ids[2]!);
    expect(await repo.get(ids[3]!)).toBeNull();
    expect(await repo.get(ids[2]!)).toBeNull();
    expect((await repo.list({ limit: 10 })).rows.map((r) => r.query)).toEqual(['how to store green tea', 'q4', 'q1', 'q0']);
    expect(await repo.get(9_999)).toBeNull();
    expect(await repo.get(-1)).toBeNull();

    // Delete one, then all.
    expect(await repo.delete(ids[0]!)).toBe(true);
    expect(await repo.delete(ids[0]!)).toBe(false);
    expect(await repo.deleteAll()).toBe(5);
    expect(count()).toBe(0);
    expect((await repo.list({ limit: 10 })).rows).toEqual([]);
  });

  test('ai-answers-not-synced', () => {
    // Device-local: the sync engine never reads the table.
    const synced = SYNC_TABLES.map((table) => table.name as string);
    for (const table of AI_ANSWERS_TABLES) expect(synced).not.toContain(table);
  });

  test('ai-search-settings-written', async () => {
    const settings = createSettingsRepository(createDrizzle(raw));
    expect(await repo.setAiSearchVia('perplexity', 'off', NOW)).toBe(true);
    expect(await repo.setAiSearchVia('chatgpt', 'api', NOW)).toBe(true);
    expect(await repo.setAiSearchDefaultEngine('chatgpt', NOW)).toBe(true);
    expect(await settings.aiSearchSettings()).toEqual({ via: { perplexity: 'off', chatgpt: 'api', 'google-ai-mode': null }, defaultEngine: 'chatgpt' });
    expect(raw.prepare('SELECT value FROM app_settings WHERE key = ?').get(AI_SEARCH_VIA_KEY('perplexity'))!['value']).toBe('off');
    // Anything else writes nothing.
    expect(await repo.setAiSearchVia('perplexity', 'tab' as never, NOW)).toBe(false);
    expect(await repo.setAiSearchVia('bing' as never, 'api', NOW)).toBe(false);
    expect(await repo.setAiSearchDefaultEngine('bing' as never, NOW)).toBe(false);
    expect(await repo.setAiSearchVia('chatgpt', 'off', Number.NaN)).toBe(false);
    expect(await settings.aiSearchSettings()).toEqual({ via: { perplexity: 'off', chatgpt: 'api', 'google-ai-mode': null }, defaultEngine: 'chatgpt' });
    // null clears the default engine.
    expect(await repo.setAiSearchDefaultEngine(null, NOW)).toBe(true);
    expect(raw.prepare('SELECT count(*) AS n FROM app_settings WHERE key = ?').get(AI_SEARCH_DEFAULT_ENGINE_KEY)!['n']).toBe(0);
    expect((await settings.aiSearchSettings()).defaultEngine).toBeNull();
  });
});
