// Spec: specs/ai-checks.spec.ts (AI_CHECKS_TABLES, AI_CHECK_LIMITS.maxStoredUrls), specs/ai-checks.schema.ts (AiCheckResultSchema)
// Acceptance: specs/ai-checks.feature.md (Storage)
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { AI_CHECK_LIMITS, AI_CHECKS_TABLES } from '@app/specs/ai-checks.spec';
import type { AiCheckResult } from '@app/specs/ai-checks.schema';
import { createAiChecksRepository, type AiChecksRepository } from '../ai-checks';
import { seoAiChecks } from '../ai-checks-schema';
import { createDrizzle } from '../client';
import { createSettingsRepository } from '../settings';
import { MIGRATIONS, runMigrations } from '../migrations';

let raw: DatabaseSync;
let repo: AiChecksRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createAiChecksRepository(createDrizzle(raw));
});

const HASH = 'a'.repeat(64);
const result = (url: string, changes: Partial<AiCheckResult> = {}): AiCheckResult => ({
  url,
  inputHash: HASH,
  modelId: 'anthropic/claude-sonnet-5-5',
  checkedAt: 1_000,
  output: { pageType: 'article', intent: 'informational', quality: 'adequate', qualityReason: 'Covers the basics.', suggestedTarget: 'how to brew tea' },
  ...changes,
});
const count = () => Number(raw.prepare('SELECT count(*) AS n FROM seo_ai_checks').get()!['n']);

describe('ai checks (db)', () => {
  test('migration-0210', () => {
    expect(AI_CHECKS_TABLES).toEqual(['seo_ai_checks']);
    // Spread last, after Phase 8's `0200` block, so ids stay strictly increasing.
    const ids = MIGRATIONS.map((m) => m.id);
    const at = ids.indexOf('0210_seo_ai_checks');
    expect(at).toBeGreaterThan(ids.indexOf('0200_agent_skill_prefs'));
    expect(ids.indexOf('0200_agent_skill_prefs')).toBeGreaterThan(0);
    expect(ids.every((id, i) => i === 0 || id > ids[i - 1]!)).toBe(true);
    expect(ids.filter((id) => id.startsWith('021'))).toEqual(['0210_seo_ai_checks']);
    const sqlite = raw
      .prepare('PRAGMA table_info(seo_ai_checks)')
      .all()
      .map((row) => ({ name: String(row['name']), type: String(row['type']).toLowerCase(), notNull: row['notnull'] === 1 || row['pk'] !== 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const drizzle = getTableConfig(seoAiChecks)
      .columns.map((column) => ({ name: column.name, type: column.getSQLType().toLowerCase(), notNull: column.notNull || column.primary }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(sqlite).toEqual(drizzle);
    expect(sqlite.map((c) => c.name)).toEqual(['checked_at', 'input_hash', 'model_id', 'result_json', 'url']);
  });

  test('cap-max-stored-urls', async () => {
    expect(await repo.get('https://example.com/a')).toBeNull();
    expect(await repo.put(result('https://example.com/a'))).toBe(true);
    expect(await repo.get('https://example.com/a')).toEqual(result('https://example.com/a'));
    // One row per URL: a new answer replaces it.
    const next = result('https://example.com/a', { inputHash: 'b'.repeat(64), checkedAt: 2_000, output: { ...result('').output, quality: 'weak' } });
    expect(await repo.put(next)).toBe(true);
    expect(await repo.get('https://example.com/a')).toEqual(next);
    expect(count()).toBe(1);
    // Past the cap, the least recently checked go.
    for (let i = 0; i < AI_CHECK_LIMITS.maxStoredUrls + 5; i++) await repo.put(result(`https://example.com/p${i}`, { checkedAt: 10_000 + i }));
    expect(count()).toBe(AI_CHECK_LIMITS.maxStoredUrls);
    expect(await repo.get('https://example.com/a')).toBeNull();
    expect(await repo.get('https://example.com/p4')).toBeNull();
    expect(await repo.get('https://example.com/p5')).not.toBeNull();
    // An invalid answer is refused, nothing written.
    for (const bad of [result('javascript:alert(1)'), result('https://example.com/x', { inputHash: 'nope' }), result('https://example.com/x', { output: { ...result('').output, extra: 1 } as never })]) {
      expect(await repo.put(bad)).toBe(false);
    }
    expect(await repo.get('https://example.com/x')).toBeNull();
    // Clear Browsing Data.
    await repo.clear();
    expect(count()).toBe(0);
  });

  test('ai-checks-mode-setting', async () => {
    const settings = createSettingsRepository(createDrizzle(raw));
    expect(await settings.aiChecksMode()).toBe('off');
    expect(await settings.setAiChecksMode('automatic', 5)).toBe(true);
    expect(await settings.aiChecksMode()).toBe('automatic');
    expect(await settings.setAiChecksMode('always' as never, 6)).toBe(false);
    expect(await settings.aiChecksMode()).toBe('automatic');
    // A tampered value reads as off; the search engine beside it is untouched.
    raw.prepare("UPDATE app_settings SET value = 'everything' WHERE key = 'ai_checks_mode'").run();
    expect(await settings.aiChecksMode()).toBe('off');
    expect(await settings.searchEngine()).toBe('google');
  });

  test('tampered-row-reads-as-none', async () => {
    const insert = raw.prepare('INSERT INTO seo_ai_checks (url, input_hash, result_json, model_id, checked_at) VALUES (?, ?, ?, ?, ?)');
    const good = JSON.stringify(result('').output);
    insert.run('https://example.com/json', HASH, '{not json', 'm', 1);
    insert.run('https://example.com/key', HASH, JSON.stringify({ ...result('').output, script: '<script>' }), 'm', 1);
    insert.run('https://example.com/type', HASH, JSON.stringify({ ...result('').output, pageType: 'casino' }), 'm', 1);
    insert.run('https://example.com/hash', 'zz', good, 'm', 1);
    insert.run('https://example.com/model', HASH, good, '', 1);
    insert.run('https://example.com/time', HASH, good, 'm', -5);
    insert.run('https://example.com/huge', HASH, `${good}${' '.repeat(10_000)}`, 'm', 1);
    insert.run('https://example.com/bidi', HASH, JSON.stringify({ ...result('').output, qualityReason: 'ok‮evil' }), 'm', 1);
    for (const name of ['json', 'key', 'type', 'hash', 'model', 'time', 'huge', 'bidi']) expect(await repo.get(`https://example.com/${name}`), name).toBeNull();
    insert.run('https://example.com/fine', HASH, good, 'm', 1);
    expect(await repo.get('https://example.com/fine')).toEqual({ ...result('https://example.com/fine'), modelId: 'm', checkedAt: 1 });
  });
});
