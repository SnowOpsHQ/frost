// Spec: specs/site-crawl.schema.ts (CrawlSettingsSchema, defaultCrawlSettings, CrawlPageRowSchema, CrawlStatusViewSchema),
// specs/site-crawl.spec.ts (CRAWL_LIMITS, CRAWL_INTERVAL_MS, CRAWL_SCOPES, CRAWL_PRIVATE_START_SCOPES)
// Acceptance: specs/site-crawl.feature.md (Settings); plan docs/plans/phase-12-big-bets.md Decision 6 (scope, private starts) and Task 5
import { describe, expect, test } from 'vitest';
import { CrawlSettingsSchema, CrawlStatusViewSchema, defaultCrawlSettings, type CrawlSettings } from '@app/specs/site-crawl.schema';
import { CRAWL_INTERVAL_MS, CRAWL_LIMITS, CRAWL_PRIVATE_START_SCOPES, CRAWL_SCOPES } from '@app/specs/site-crawl.spec';

const ok = (settings: unknown) => CrawlSettingsSchema.safeParse(settings).success;
const base = (changes: Partial<CrawlSettings> = {}): CrawlSettings => ({ ...defaultCrawlSettings('https://example.com/'), ...changes });

describe('crawl settings', () => {
  test('crawl-settings-schema-bounds', () => {
    // The defaults parse, with the spec's values.
    expect(CrawlSettingsSchema.parse(base())).toEqual({
      startUrl: 'https://example.com/',
      scope: 'host',
      include: [],
      exclude: [],
      maxPages: CRAWL_LIMITS.defaultMaxPages,
      intervalMs: CRAWL_INTERVAL_MS.default,
      sitemaps: true,
    });
    for (const scope of CRAWL_SCOPES) expect(ok(base({ scope })), scope).toBe(true);

    // The start URL: http(s), a host, no credentials, bounded.
    for (const startUrl of ['ftp://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'example.com', '', 'https://user:pw@example.com/', 'https://user@example.com/', `https://example.com/${'a'.repeat(CRAWL_LIMITS.maxUrlChars)}`]) {
      expect(ok(base({ startUrl })), startUrl).toBe(false);
    }
    expect(ok(base({ startUrl: 'http://example.com/blog/post?x=1#top' }))).toBe(true);

    // Prefixes only: literal paths, bounded in number and length; no regular expression field anywhere.
    expect(ok(base({ include: ['/blog/'], exclude: ['/blog/tag/', '/search?'] }))).toBe(true);
    expect(ok(base({ include: ['/.*(a+)+$'] }))).toBe(true); // literal text, never compiled
    for (const prefix of ['blog/', '', ' /blog', '/blog post', '/a\u0000', '/a\n', `/${'a'.repeat(CRAWL_LIMITS.maxPrefixChars)}`]) {
      expect(ok(base({ include: [prefix] })), JSON.stringify(prefix)).toBe(false);
      expect(ok(base({ exclude: [prefix] })), JSON.stringify(prefix)).toBe(false);
    }
    const many = Array.from({ length: CRAWL_LIMITS.maxPrefixes }, (_, i) => `/p${i}/`);
    expect(ok(base({ include: many, exclude: many }))).toBe(true);
    expect(ok(base({ include: [...many, '/one-more/'] }))).toBe(false);
    expect(ok(base({ exclude: [...many, '/one-more/'] }))).toBe(false);
    for (const key of ['pattern', 'regex', 'includeRegex', 'excludePattern', 'userAgent', 'ignoreRobots']) {
      expect(Object.keys(CrawlSettingsSchema.shape)).not.toContain(key);
      expect(ok({ ...base(), [key]: '.*' }), key).toBe(false);
    }

    // Caps: pages and the interval.
    expect(ok(base({ maxPages: CRAWL_LIMITS.maxPagesCap }))).toBe(true);
    for (const maxPages of [0, -1, CRAWL_LIMITS.maxPagesCap + 1, 1.5]) expect(ok(base({ maxPages })), String(maxPages)).toBe(false);
    expect(ok(base({ intervalMs: CRAWL_INTERVAL_MS.min }))).toBe(true);
    expect(ok(base({ intervalMs: CRAWL_INTERVAL_MS.max }))).toBe(true);
    for (const intervalMs of [0, CRAWL_INTERVAL_MS.min - 1, CRAWL_INTERVAL_MS.max + 1, 750.5]) expect(ok(base({ intervalMs })), String(intervalMs)).toBe(false);
    expect(ok({ ...base(), sitemaps: 'yes' })).toBe(false);
    const { sitemaps: _sitemaps, ...missing } = base();
    expect(ok(missing)).toBe(false);

    // A private start stays on its exact origin: `host` only.
    expect(CRAWL_PRIVATE_START_SCOPES).toEqual(['host']);
    for (const startUrl of ['http://127.0.0.1:3000/', 'http://localhost:8080/app/', 'http://dev.local/', 'http://[::1]:5173/', 'http://10.0.0.5/', 'http://intranet/']) {
      expect(ok(base({ startUrl, scope: 'host' })), startUrl).toBe(true);
      expect(ok(base({ startUrl, scope: 'site' })), `${startUrl} site`).toBe(false);
      expect(ok(base({ startUrl, scope: 'path' })), `${startUrl} path`).toBe(false);
    }
    const refused = CrawlSettingsSchema.safeParse(base({ startUrl: 'http://127.0.0.1:3000/', scope: 'site' }));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.path)).toEqual([['scope']]);
    // A public IP start may use `path`, but has no registrable domain for `site`.
    expect(ok(base({ startUrl: 'http://93.184.215.14/', scope: 'path' }))).toBe(true);
    expect(ok(base({ startUrl: 'http://93.184.215.14/', scope: 'site' }))).toBe(false);
  });

  test('crawl-status-view-carries-the-gate', () => {
    // The renderer learns the L6 gate from main's view, never from the constant.
    expect(Object.keys(CrawlStatusViewSchema.shape)).toContain('available');
    expect(CrawlStatusViewSchema.safeParse({ available: false, activeRunId: null, runs: [] }).success).toBe(true);
    expect(CrawlStatusViewSchema.safeParse({ activeRunId: null, runs: [] }).success).toBe(false);
  });
});
