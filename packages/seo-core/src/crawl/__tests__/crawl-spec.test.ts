// Spec: specs/site-crawl.spec.ts (CRAWL_AVAILABLE, CRAWL_RULE_IDS, CRAWL_EXCLUDED_CATEGORIES, CRAWL_EXCLUDED_RULES, CRAWL_INTERVAL_MS,
// CRAWL_USER_AGENT_TOKEN, CRAWL_ROBOTS_TOKEN, CRAWL_LIMITS), specs/fetcher.spec.ts (CRAWL_FETCHER_LIMITS, the crawl lane),
// specs/seo-rules.spec.ts (SEO_RULE_SPECS)
// Acceptance: specs/site-crawl.feature.md (Contract); plan docs/plans/phase-12-big-bets.md Decision 6 and Task 5
import { describe, expect, test } from 'vitest';
import { CRAWL_FETCHER_LIMITS, FETCHER_LANES } from '@app/specs/fetcher.spec';
import { SERVED_FETCH_LIMITS } from '@app/specs/seo-javascript.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { SEO_RULE_SPECS } from '@app/specs/seo-rules.spec';
import {
  CRAWL_AVAILABLE,
  CRAWL_EXCLUDED_CATEGORIES,
  CRAWL_EXCLUDED_RULES,
  CRAWL_FAILED_OUTCOMES,
  CRAWL_FETCHED_OUTCOMES,
  CRAWL_INTERVAL_MS,
  CRAWL_LIMITS,
  CRAWL_PAGE_OUTCOMES,
  CRAWL_REFUSED_OUTCOMES,
  CRAWL_ROBOTS_TOKEN,
  CRAWL_RULE_IDS,
  CRAWL_USER_AGENT_TOKEN,
  MAX_CRAWL_DELAY_MS,
} from '@app/specs/site-crawl.spec';
import { productToken } from '../../index';

describe('site crawl contract', () => {
  test('crawl-gate-ships-closed', () => {
    // L6 has no owner's note under docs/research/: the gate ships closed (tests open it by injection).
    expect(CRAWL_AVAILABLE).toBe(false);
  });

  test('crawl-rule-ids-are-catalog-ids', () => {
    const catalogue = new Map<string, string>(SEO_RULE_SPECS.map((rule) => [rule.id, rule.category]));
    expect(new Set(CRAWL_RULE_IDS).size).toBe(CRAWL_RULE_IDS.length);
    const excludedCategories = new Set(Object.keys(CRAWL_EXCLUDED_CATEGORIES));
    const excludedRules = new Set(Object.keys(CRAWL_EXCLUDED_RULES));
    for (const id of CRAWL_RULE_IDS) {
      expect(catalogue.has(id), id).toBe(true);
      expect(excludedCategories.has(catalogue.get(id)!), id).toBe(false);
      expect(excludedRules.has(id), id).toBe(false);
    }
    for (const id of excludedRules) {
      expect(catalogue.has(id), id).toBe(true);
      // Excluded by id only from a category the crawl otherwise audits.
      expect(excludedCategories.has(catalogue.get(id)!), id).toBe(false);
    }
    // The three lists cover the whole catalogue, each rule once.
    const crawl = new Set<string>(CRAWL_RULE_IDS);
    for (const [id, category] of catalogue) {
      const homes = [crawl.has(id), excludedRules.has(id), excludedCategories.has(category)].filter(Boolean);
      expect(homes, id).toHaveLength(1);
    }
    // The plan's excluded categories and rules (Task 5): no layout, no rendering, no microdata.
    expect([...excludedCategories].sort()).toEqual(['accessibility', 'javascript', 'performance', 'security', 'social']);
    for (const id of ['schema-none', 'schema-entity-conflict', 'images-missing-dimensions', 'images-oversized', 'images-lazy-in-first-viewport']) expect(excludedRules.has(id), id).toBe(true);
    for (const reason of [...Object.values(CRAWL_EXCLUDED_CATEGORIES), ...Object.values(CRAWL_EXCLUDED_RULES)]) expect(reason.length).toBeGreaterThan(10);
  });

  test('crawl-outcomes-counted-once', () => {
    // Every page outcome counts in exactly one of fetched, refused (robots, scope, address) and failed.
    const lists = [CRAWL_FETCHED_OUTCOMES, CRAWL_REFUSED_OUTCOMES, CRAWL_FAILED_OUTCOMES].map((list) => [...list] as string[]);
    expect(lists.flat().sort()).toEqual([...CRAWL_PAGE_OUTCOMES].sort());
    expect(CRAWL_REFUSED_OUTCOMES).toEqual(expect.arrayContaining(['blocked-by-robots', 'out-of-scope', 'private-redirect', 'robots-timeout']));
  });

  test('crawl-lane-floor-is-the-minimum-interval', () => {
    expect(CRAWL_FETCHER_LIMITS.perOriginIntervalMs).toBe(CRAWL_INTERVAL_MS.min);
    expect(CRAWL_FETCHER_LIMITS).toEqual({ perOriginConcurrency: 1, perOriginIntervalMs: 500, maxQueuedPerOrigin: 4 });
    // Outside FETCHER_LANES, like the SERP lane.
    expect(Object.keys(FETCHER_LANES)).toEqual(['audit', 'checks']);
    expect(CRAWL_INTERVAL_MS).toEqual({ default: 1_000, min: 500, max: 4_000 });
    expect(CRAWL_INTERVAL_MS.default).toBeGreaterThanOrEqual(CRAWL_INTERVAL_MS.min);
    expect(CRAWL_INTERVAL_MS.default).toBeLessThanOrEqual(CRAWL_INTERVAL_MS.max);
    expect(MAX_CRAWL_DELAY_MS).toBe(10_000);
    // The bounds Task 5 names.
    expect(CRAWL_LIMITS).toMatchObject({ defaultMaxPages: 500, maxPagesCap: 10_000, maxDepth: 10, maxQueryVariantsPerPath: 20, backoffAfter: 5, maxRetryAfterMs: 60_000 });
    expect(CRAWL_LIMITS.maxBodyBytes).toBe(SERVED_FETCH_LIMITS.maxBytes);
    expect(CRAWL_LIMITS.maxLinksStoredPerPage).toBeLessThan(SNAPSHOT_LIMITS.maxLinks);
    expect(CRAWL_LIMITS.defaultMaxPages).toBeLessThanOrEqual(CRAWL_LIMITS.maxPagesCap);
  });

  test('crawl-robots-token-is-the-user-agent-token', () => {
    expect(CRAWL_USER_AGENT_TOKEN).toBe('frost-crawl/1');
    expect(CRAWL_ROBOTS_TOKEN).toBe('frost-crawl');
    expect(productToken(CRAWL_USER_AGENT_TOKEN)).toBe(CRAWL_ROBOTS_TOKEN);
    // The header as sent reads as another product: robots matching is never given it.
    const header = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ${CRAWL_USER_AGENT_TOKEN}`;
    expect(productToken(header)).toBe('mozilla');
    expect(productToken(header)).not.toBe(CRAWL_ROBOTS_TOKEN);
  });
});
