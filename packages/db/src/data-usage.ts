import { and, inArray, lt, sql } from 'drizzle-orm';
import { DATA_PROVIDERS, DATA_USAGE_LIMITS, dataUsageMonth, isDataProvider, isDataUsageMonth, oldestDataUsageMonthKept, type DataProvider } from '@app/specs/data-sources.spec';
import type { SessionDatabase } from './client';
import { dataApiUsage } from './data-usage-schema';

// The data API usage counter (Phase 12 Task 2; spec `specs/data-sources.spec.ts`, `DATA_USAGE_LIMITS`;
// acceptance `specs/data-sources.feature.md`, Usage counter). The data API client counts each request
// it sends (after the allowlist, before the fetch) with `increment`; Settings › Data sources reads
// this month's and last month's counts. Each write also deletes rows older than
// `DATA_USAGE_LIMITS.monthsKept` months, so the table stays a handful of rows. A count stops at
// `maxRequests`; a tampered row reads as 0.

export interface DataUsageRepository {
  /** Counts one request to `provider` in the UTC month of `at` (Unix ms) and prunes old months; `false` (nothing written) for an unknown provider or a non-finite time. */
  increment(provider: DataProvider, at: number): Promise<boolean>;
  /** Per provider, the count in each of `months` (`YYYY-MM`), in that order; 0 where none (or the month is not one). */
  counts(months: readonly string[]): Promise<Record<DataProvider, number[]>>;
}

export function createDataUsageRepository(db: SessionDatabase): DataUsageRepository {
  return {
    async increment(provider, at) {
      if (!isDataProvider(provider) || !Number.isFinite(at)) return false;
      const month = dataUsageMonth(at);
      if (!isDataUsageMonth(month)) return false;
      await db.batch([
        db
          .insert(dataApiUsage)
          .values({ provider, month, requests: 1 })
          .onConflictDoUpdate({ target: [dataApiUsage.provider, dataApiUsage.month], set: { requests: sql`min(${dataApiUsage.requests} + 1, ${DATA_USAGE_LIMITS.maxRequests})` } }),
        db.delete(dataApiUsage).where(lt(dataApiUsage.month, oldestDataUsageMonthKept(month))),
      ]);
      return true;
    },

    async counts(months) {
      const wanted = months.filter(isDataUsageMonth);
      const out = Object.fromEntries(DATA_PROVIDERS.map((provider) => [provider, months.map(() => 0)])) as Record<DataProvider, number[]>;
      if (wanted.length === 0) return out;
      const rows = await db
        .select({ provider: dataApiUsage.provider, month: dataApiUsage.month, requests: dataApiUsage.requests })
        .from(dataApiUsage)
        .where(and(inArray(dataApiUsage.provider, [...DATA_PROVIDERS]), inArray(dataApiUsage.month, wanted)));
      for (const row of rows) {
        if (!isDataProvider(row.provider)) continue;
        const count = typeof row.requests === 'number' && Number.isInteger(row.requests) && row.requests >= 0 ? Math.min(row.requests, DATA_USAGE_LIMITS.maxRequests) : 0;
        months.forEach((month, index) => {
          if (month === row.month) out[row.provider as DataProvider][index] = count;
        });
      }
      return out;
    },
  };
}

