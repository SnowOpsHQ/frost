// Spec: specs/data-sources.spec.ts (DATA_PROVIDERS, DATA_USAGE_TABLES, DATA_USAGE_MIGRATION_IDS, DATA_USAGE_LIMITS,
// dataUsageMonth, dataUsageMonthBefore, DATA_SERP_PROVIDER_KEY); plan docs/plans/phase-12-big-bets.md Global constraints
// (0243 after the site crawl's 0240/0241), Task 2
// Acceptance: specs/data-sources.feature.md (Usage counter: data-usage-migration-creates-table, data-usage-keeps-twelve-months)
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  DATA_PROVIDERS,
  DATA_SERP_PROVIDER_KEY,
  DATA_USAGE_LIMITS,
  DATA_USAGE_MIGRATION_IDS,
  DATA_USAGE_TABLES,
  dataUsageMonth,
  dataUsageMonthBefore,
} from '@app/specs/data-sources.spec';
import { createDrizzle } from '../client';
import { DATA_USAGE_MIGRATIONS } from '../data-usage-migrations';
import { dataApiUsage } from '../data-usage-schema';
import { createDataUsageRepository, type DataUsageRepository } from '../data-usage';
import { MIGRATIONS, runMigrations } from '../migrations';
import { createSettingsRepository } from '../settings';
import { SITE_CRAWL_MIGRATIONS } from '../site-crawl/migrations';

let raw: DatabaseSync;
let usage: DataUsageRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  usage = createDataUsageRepository(createDrizzle(raw));
});

const rows = () => raw.prepare('SELECT provider, month, requests FROM data_api_usage ORDER BY provider, month').all().map((row) => ({ ...row }));
const accepts = (provider: string, month: string, requests: number) => {
  try {
    raw.prepare('INSERT INTO data_api_usage (provider, month, requests) VALUES (?, ?, ?)').run(provider, month, requests);
    return true;
  } catch {
    return false;
  }
};

/** Mid-month UTC instants. */
const NOV = Date.UTC(2026, 10, 10, 12);
const DEC = Date.UTC(2026, 11, 31, 23, 59, 59);
const JAN = Date.UTC(2027, 0, 1, 0, 0, 0);

describe('data usage', () => {
  test('data-usage-migration-creates-table', () => {
    // Its own id, in Phase 12's range, spread after the site crawl's list (0242 goes between when it lands).
    expect(DATA_USAGE_MIGRATIONS.map((m) => m.id)).toEqual([...DATA_USAGE_MIGRATION_IDS]);
    expect(DATA_USAGE_MIGRATIONS.every((m) => m.id >= '0243' && m.id < '0244')).toBe(true);
    const at = MIGRATIONS.indexOf(DATA_USAGE_MIGRATIONS[0]!);
    expect(at).toBeGreaterThan(MIGRATIONS.indexOf(SITE_CRAWL_MIGRATIONS[SITE_CRAWL_MIGRATIONS.length - 1]!));
    expect(MIGRATIONS.slice(at, at + DATA_USAGE_MIGRATIONS.length)).toEqual(DATA_USAGE_MIGRATIONS);

    // Exactly the spec's table, column for column with the Drizzle schema, keyed (provider, month).
    expect(getTableConfig(dataApiUsage).name).toBe(DATA_USAGE_TABLES[0]);
    const columns = raw
      .prepare('PRAGMA table_info(data_api_usage)')
      .all()
      .map((row) => ({ name: String(row['name']), type: String(row['type']).toLowerCase(), notNull: row['notnull'] === 1 || row['pk'] !== 0, pk: Number(row['pk']) }));
    expect(columns).toEqual([
      { name: 'provider', type: 'text', notNull: true, pk: 1 },
      { name: 'month', type: 'text', notNull: true, pk: 2 },
      { name: 'requests', type: 'integer', notNull: true, pk: 0 },
    ]);
    expect(getTableConfig(dataApiUsage).primaryKeys.flatMap((key) => key.columns.map((column) => column.name))).toEqual(['provider', 'month']);

    // The CHECKs accept exactly the spec's providers, well-formed months and counts in range.
    for (const provider of DATA_PROVIDERS) expect(accepts(provider, '2026-11', 0), provider).toBe(true);
    for (const bad of ['SerpApi', 'openai', 'bing', '']) expect(accepts(bad, '2026-11', 1), bad).toBe(false);
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', '2026/11', '']) expect(accepts('serpapi', bad, 1), bad).toBe(false);
    expect(accepts('serper', '2026-10', -1)).toBe(false);
    expect(accepts('serper', '2026-10', 1.5)).toBe(false);
    expect(accepts('serper', '2026-10', DATA_USAGE_LIMITS.maxRequests + 1)).toBe(false);
    expect(accepts('serper', '2026-10', DATA_USAGE_LIMITS.maxRequests)).toBe(true);
    // One row per provider and month.
    expect(accepts('serpapi', '2026-11', 3)).toBe(false);
  });

  test('data-usage-months-are-utc', () => {
    expect(dataUsageMonth(NOV)).toBe('2026-11');
    expect(dataUsageMonth(DEC)).toBe('2026-12');
    expect(dataUsageMonth(JAN)).toBe('2027-01');
    expect(dataUsageMonthBefore('2027-01')).toBe('2026-12');
    expect(dataUsageMonthBefore('2026-03', 3)).toBe('2025-12');
    expect(dataUsageMonthBefore('2026-11', DATA_USAGE_LIMITS.monthsKept - 1)).toBe('2025-12');
  });

  test('data-usage-increments-provider-by-month', async () => {
    await usage.increment('serpapi', NOV);
    await usage.increment('serpapi', NOV + 1_000);
    await usage.increment('serper', NOV);
    await usage.increment('serpapi', DEC);
    expect(rows()).toEqual([
      { provider: 'serpapi', month: '2026-11', requests: 2 },
      { provider: 'serpapi', month: '2026-12', requests: 1 },
      { provider: 'serper', month: '2026-11', requests: 1 },
    ]);
    // Read per provider for any two months, 0 when none.
    expect(await usage.counts(['2026-12', '2026-11'])).toEqual({
      serpapi: [1, 2],
      dataforseo: [0, 0],
      serper: [0, 1],
      perplexity: [0, 0],
      'openai-search': [0, 0],
    });
    // Never an unknown provider or a bad instant.
    expect(await usage.increment('bing' as never, NOV)).toBe(false);
    expect(await usage.increment('serpapi', Number.NaN)).toBe(false);
    expect(rows()).toHaveLength(3);
  });

  test('data-usage-keeps-twelve-months', async () => {
    // Rows from 13 and 12 months ago, and one from 11.
    for (const month of ['2025-10', '2025-11', '2025-12']) raw.prepare("INSERT INTO data_api_usage (provider, month, requests) VALUES ('perplexity', ?, 5)").run(month);
    raw.prepare("INSERT INTO data_api_usage (provider, month, requests) VALUES ('serpapi', '2024-01', 9)").run();
    await usage.increment('serper', NOV);
    // `monthsKept` months, the current one included: 2025-12 … 2026-11; older rows of every provider go.
    expect(rows()).toEqual([
      { provider: 'perplexity', month: '2025-12', requests: 5 },
      { provider: 'serper', month: '2026-11', requests: 1 },
    ]);
  });

  test('data-usage-count-saturates', async () => {
    raw.prepare('INSERT INTO data_api_usage (provider, month, requests) VALUES (?, ?, ?)').run('serpapi', '2026-11', DATA_USAGE_LIMITS.maxRequests);
    expect(await usage.increment('serpapi', NOV)).toBe(true);
    expect(rows()).toEqual([{ provider: 'serpapi', month: '2026-11', requests: DATA_USAGE_LIMITS.maxRequests }]);
  });

  test('data-serp-provider-setting', async () => {
    const settings = createSettingsRepository(createDrizzle(raw));
    expect(await settings.dataSerpProvider()).toBeNull();
    expect(await settings.setDataSerpProvider('dataforseo', 5)).toBe(true);
    expect(await settings.dataSerpProvider()).toBe('dataforseo');
    expect(raw.prepare('SELECT value FROM app_settings WHERE key = ?').get(DATA_SERP_PROVIDER_KEY)).toEqual({ value: 'dataforseo' });
    // Only a SERP vendor is stored; a tampered row reads as none.
    expect(await settings.setDataSerpProvider('perplexity' as never, 6)).toBe(false);
    expect(await settings.setDataSerpProvider('serper', Number.NaN)).toBe(false);
    expect(await settings.dataSerpProvider()).toBe('dataforseo');
    raw.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('bing', DATA_SERP_PROVIDER_KEY);
    expect(await settings.dataSerpProvider()).toBeNull();
  });
});
