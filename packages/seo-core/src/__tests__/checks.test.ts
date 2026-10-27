// Spec: specs/seo-checks.spec.ts (LINK_STATUS_KINDS, HEAD_FALLBACK_STATUSES, LASTMOD_FUTURE_SLACK_MS,
// HREFLANG_CHECK_LIMITS, RECIPROCITY_STATUSES, CHECKS_RULE_SPECS), specs/seo-checks.schema.ts (ChecksContextSchema)
// Acceptance: specs/seo-checks.feature.md (Classification, Rules)
import { describe, expect, test } from 'vitest';
import { CHECKS_RULE_SPECS, HREFLANG_CHECK_LIMITS, IDLE_HREFLANG_RUN, IDLE_LINK_RUN, IDLE_SITEMAP_RUN, LASTMOD_FUTURE_SLACK_MS, type LinkCheckResult } from '@app/specs/seo-checks.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { FINDING_SAMPLE_LIMIT, SEO_RULE_SPECS, type SeoRuleId } from '@app/specs/seo-rules.spec';
import type { ChecksContext } from '@app/specs/seo-snapshot.spec';
import { alternateHead, checksContextOf, classifyLink, headHreflangLinks, hreflangTargets, lastmodIssue, lastmodTime, linkTargetKey, needsGetFallback, originNeedsGet, reciprocityOf, RULES, type FindingDetails, type HreflangReport, type PageLink, type PageSnapshot } from '../index';
import { cleanSnapshot, page } from './fixtures';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

function fails(id: SeoRuleId, snapshot: PageSnapshot): FindingDetails {
  const result = RULES.find((r) => r.id === id)!.check(snapshot);
  expect(result, `${id} should fail`).not.toBeNull();
  expect(result!.samples.length).toBeLessThanOrEqual(FINDING_SAMPLE_LIMIT);
  return result!;
}
function passes(id: SeoRuleId, snapshot: PageSnapshot): void {
  expect(RULES.find((r) => r.id === id)!.check(snapshot), `${id} should pass`).toBeNull();
}
const withChecks = (checks: Partial<ChecksContext>): PageSnapshot => page({ checks: { links: null, sitemaps: null, hreflang: null, ...checks } });
const result = (url: string, changes: Partial<LinkCheckResult> = {}): LinkCheckResult => ({ url, kind: 'ok', status: 200, finalUrl: null, redirects: 0, reason: null, method: 'HEAD', cached: false, ...changes });
const link = (href: string, kind: PageLink['kind'] = 'internal'): PageLink => ({ href, scheme: href.split(':')[0]! + ':', rel: '', text: 'x', kind, target: null });

describe('classification', () => {
  test('link-target-key', () => {
    expect(linkTargetKey('https://example.com/a#top')).toBe('https://example.com/a');
    expect(linkTargetKey('HTTP://Example.COM:80/a?q=1#x')).toBe('http://example.com/a?q=1');
    expect(linkTargetKey('mailto:a@example.com')).toBeNull();
    expect(linkTargetKey('javascript:void(0)')).toBeNull();
    expect(linkTargetKey('')).toBeNull();
  });

  test('link-classification', () => {
    const base = { redirects: 0, finalUrl: null, method: 'HEAD' as const };
    expect(classifyLink('https://a.test/', { ...base, outcome: 'response', status: 200 })).toMatchObject({ kind: 'ok', status: 200, reason: null, finalUrl: null });
    expect(classifyLink('https://a.test/', { outcome: 'response', status: 204, redirects: 2, finalUrl: 'https://a.test/b', method: 'GET' })).toMatchObject({ kind: 'redirect', redirects: 2, finalUrl: 'https://a.test/b', method: 'GET' });
    expect(classifyLink('https://a.test/', { ...base, outcome: 'response', status: 404 })).toMatchObject({ kind: 'broken', reason: 'http-error', status: 404 });
    // 429 and 503 say "not now": temporary, not broken (Phase 2.5 Task 2 review).
    expect(classifyLink('https://a.test/', { ...base, outcome: 'response', status: 503 })).toMatchObject({ kind: 'temporary', reason: null, status: 503 });
    expect(classifyLink('https://a.test/', { ...base, outcome: 'response', status: 429 })).toMatchObject({ kind: 'temporary', reason: null, status: 429 });
    expect(classifyLink('https://a.test/', { ...base, outcome: 'response', status: 500 })).toMatchObject({ kind: 'broken', reason: 'http-error' });
    expect(classifyLink('https://a.test/', { ...base, outcome: 'response', status: 304 })).toMatchObject({ kind: 'broken', reason: 'other-status' });
    for (const outcome of ['timeout', 'unreachable', 'too-many-redirects', 'bad-redirect', 'no-location'] as const) {
      expect(classifyLink('https://a.test/', { ...base, outcome, status: null })).toMatchObject({ kind: 'broken', reason: outcome });
    }
    expect(classifyLink('https://a.test/', { ...base, outcome: 'private-redirect', status: 302, redirects: 0 })).toMatchObject({ kind: 'skipped', reason: 'private' });
    expect(classifyLink('https://a.test/', { ...base, outcome: 'aborted', status: null })).toBeNull();
  });

  test('head-fallback-statuses', () => {
    for (const status of [403, 404, 405, 501]) expect(needsGetFallback(status)).toBe(true);
    for (const status of [200, 301, 410, 500, null]) expect(needsGetFallback(status)).toBe(false);
    // Only 405 and 501 say the whole origin does not do HEAD.
    expect([403, 404, 405, 501].map(originNeedsGet)).toEqual([false, false, true, true]);
  });

  test('lastmod-w3c-datetime', () => {
    for (const value of ['2024', '2024-05', '2024-05-01', '2024-05-01T09:30Z', '2024-05-01T09:30:15+02:00', '2024-05-01T09:30:15.25-05:00', ' 2024-02-29 ']) expect(lastmodIssue(value, NOW), value).toBeNull();
    for (const value of ['', 'yesterday', '05/01/2024', '2024-5-1', '2024-05-01T09:30', '2024-05-01 09:30:00Z', '2024-13-01', '2023-02-29', '2024-04-31', '2024-05-01T24:00Z', '2024-05-01T09:30+15:00']) expect(lastmodIssue(value, NOW), value).toBe('invalid');
    expect(lastmodTime('2024-05-01T09:30:00+02:00')).toBe(Date.UTC(2024, 4, 1, 7, 30));
  });

  test('lastmod-future', () => {
    const day = (offset: number) => new Date(NOW + offset).toISOString().slice(0, 19) + 'Z';
    expect(lastmodIssue(day(LASTMOD_FUTURE_SLACK_MS - 60_000), NOW)).toBeNull();
    expect(lastmodIssue(day(LASTMOD_FUTURE_SLACK_MS + 60_000), NOW)).toBe('future');
    expect(lastmodIssue('2099', NOW)).toBe('future');
    // The zone moves the moment: 23:00 at -12:00 is 11:00 the next day UTC.
    expect(lastmodIssue('2026-10-28T23:30:00-12:00', NOW)).toBe('future');
    expect(lastmodIssue('2026-10-28T11:00:00+12:00', NOW)).toBeNull();
  });

  test('head-hreflang-bounded-read', () => {
    const html = `<!doctype html><html><head>
      <!-- <link rel="alternate" hreflang="xx" href="/commented"> -->
      <meta charset=utf-8><title>A <link rel=alternate hreflang=yy href=/in-title></title>
      <script>document.write('<link rel="alternate" hreflang="zz" href="/in-script">')</script>
      <LINK REL="Alternate stylesheet" HREFLANG="de" HREF="/de?a=1&amp;b=2">
      <link rel=alternate hreflang=fr href=/fr>
      <link rel='alternate' hreflang='en' href='/en' hreflang='ignored'>
      <link rel="canonical" href="/en">
      <link rel="alternate" href="/no-hreflang">
      </head><body><link rel="alternate" hreflang="it" href="/in-body"></body></html>`;
    expect(headHreflangLinks(html, 10)).toEqual([
      { hreflang: 'de', href: '/de?a=1&b=2' },
      { hreflang: 'fr', href: '/fr' },
      { hreflang: 'en', href: '/en' },
    ]);
    // A start tag a head cannot hold ends it (as the HTML parser does).
    expect(headHreflangLinks('<head><link rel=alternate hreflang=a href=/a><div></div><link rel=alternate hreflang=b href=/b>', 10)).toEqual([{ hreflang: 'a', href: '/a' }]);
    expect(headHreflangLinks(`<head>${'<link rel=alternate hreflang=x href=/x>'.repeat(50)}`, 7)).toHaveLength(7);
    // Linear and never stuck on hostile text.
    const started = performance.now();
    headHreflangLinks(`<head>${'<link a=== b'.repeat(50_000)}${'<'.repeat(100_000)}<!--`, HREFLANG_CHECK_LIMITS.maxLinks);
    headHreflangLinks(`<head><script>${'x'.repeat(500_000)}`, 10);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(headHreflangLinks('', 10)).toEqual([]);
    // The head's first <base> with an href (decoded, trimmed), wherever it is in the head and past the link cap.
    expect(alternateHead('<head><base target=_top><base href=" /e&amp;n/ "><base href="/later/"><link rel=alternate hreflang=en href=page>', 10)).toEqual({ links: [{ hreflang: 'en', href: 'page' }], baseHref: '/e&n/' });
    expect(alternateHead(`<head>${'<link rel=alternate hreflang=x href=/x>'.repeat(5)}<base href="https://example.com/b/">`, 2)).toEqual({ links: [{ hreflang: 'x', href: '/x' }, { hreflang: 'x', href: '/x' }], baseHref: 'https://example.com/b/' });
    expect(alternateHead('<base href="">', 10).baseHref).toBe('');
    // A tag the input ends inside (no closing `>`) does not count, as in a browser.
    expect(alternateHead('<head><base href="https://example.com/x', 10).baseHref).toBeNull();
    expect(alternateHead('<head><base href="/b/"><link rel=alternate hreflang=en href=page', 10)).toEqual({ links: [], baseHref: '/b/' });
    // Not one in a comment, in raw text, or past the head.
    expect(alternateHead('<head><!-- <base href="/c/"> --><script><base href="/s/"></script></head><base href="/after/">', 10).baseHref).toBeNull();
    expect(alternateHead('<head></head><body><base href="/body/">', 10).baseHref).toBeNull();
    expect(alternateHead('<head><div><base href="/div/">', 10).baseHref).toBeNull();
  });
});

describe('hreflang reciprocity', () => {
  const entry = (value: string, resolved: string | null, self = false) => ({ value, href: resolved ?? '', resolved, source: 'html' as const, valid: true, self, relative: false, duplicate: false });
  const report = (entries: ReturnType<typeof entry>[]): HreflangReport => ({ entries, total: entries.length, hasXDefault: false, hasSelf: entries.some((e) => e.self) });

  test('hreflang-targets-capped', () => {
    const plan = hreflangTargets(
      report([entry('en', 'https://example.com/en', true), entry('de', 'https://example.com/de#x'), entry('x-default', 'https://example.com/de'), entry('fr', 'mailto:x'), entry('es', null), entry('it', 'https://example.com/canonical')]),
      'https://example.com/en#top',
      'https://example.com/canonical',
    );
    expect(plan.targets).toEqual([{ url: 'https://example.com/de', lang: 'de, x-default' }]);
    expect(plan.selfLangs).toEqual(['en', 'it']);
    expect(plan.pageKeys).toEqual(['https://example.com/en', 'https://example.com/canonical']);
    const many = hreflangTargets(report(Array.from({ length: 25 }, (_, i) => entry(`l${i}`, `https://example.com/${i}`))), 'https://example.com/', null);
    expect(many.targets).toHaveLength(HREFLANG_CHECK_LIMITS.maxAlternates);
    expect(many.over).toBe(5);
  });

  test('hreflang-reciprocity', () => {
    const keys = ['https://example.com/en', 'https://example.com/canonical'];
    expect(reciprocityOf([{ hreflang: 'EN', resolved: 'https://example.com/en' }], keys, ['en'])).toEqual({ status: 'reciprocal', returnLangs: ['EN'] });
    expect(reciprocityOf([{ hreflang: 'en', resolved: 'https://example.com/canonical' }], keys, ['en'])).toMatchObject({ status: 'reciprocal' });
    expect(reciprocityOf([{ hreflang: 'en-gb', resolved: 'https://example.com/en' }], keys, ['en'])).toEqual({ status: 'wrong-language', returnLangs: ['en-gb'] });
    expect(reciprocityOf([{ hreflang: 'en', resolved: 'https://example.com/other' }, { hreflang: 'x', resolved: null }], keys, ['en'])).toEqual({ status: 'missing-return', returnLangs: [] });
    // The page names no value for itself: any return link counts.
    expect(reciprocityOf([{ hreflang: 'pt', resolved: 'https://example.com/en' }], keys, [])).toMatchObject({ status: 'reciprocal' });
  });

  test('checks-context-of-finished-runs', () => {
    const links = [link('https://example.com/a'), link('https://example.com/b'), link('https://other.test/c', 'external'), link('https://other.test/d', 'external')];
    const results = [
      result('https://example.com/a', { kind: 'redirect', status: 200, redirects: 1, finalUrl: 'https://example.com/a/' }),
      result('https://example.com/b', { kind: 'broken', status: 404, reason: 'http-error' }),
      result('https://other.test/c', { kind: 'redirect', status: 200, redirects: 1, finalUrl: 'https://other.test/c2' }),
      result('https://other.test/d', { kind: 'skipped', status: null, reason: 'over-cap', method: null }),
    ];
    const running = checksContextOf({ links: { ...IDLE_LINK_RUN, status: 'running', results }, sitemaps: IDLE_SITEMAP_RUN, hreflang: IDLE_HREFLANG_RUN }, links);
    expect(running).toEqual({ links: null, sitemaps: null, hreflang: null });
    const done = checksContextOf(
      {
        links: { ...IDLE_LINK_RUN, status: 'stopped', results },
        sitemaps: { ...IDLE_SITEMAP_RUN, status: 'done', listed: false, urlCount: 3, files: [{ url: 'https://example.com/s.xml', depth: 0, type: 'urlset', status: 200, gzip: false, entries: 3, error: null }] },
        hreflang: { ...IDLE_HREFLANG_RUN, status: 'done', alternates: [{ lang: 'de', url: 'https://example.com/de', status: 'missing-return', httpStatus: 200, returnLangs: [] }, { lang: 'fr', url: 'https://example.com/fr', status: 'skipped', httpStatus: null, returnLangs: [] }] },
      },
      links,
    );
    expect(done.links).toEqual({ checked: 3, broken: [{ url: 'https://example.com/b', status: 404, reason: 'http-error' }], internalRedirects: [{ url: 'https://example.com/a', finalUrl: 'https://example.com/a/', status: 200 }] });
    expect(done.sitemaps).toEqual({ files: 1, urlCount: 3, listed: false, errors: [] });
    expect(done.hreflang).toEqual({ checked: 1, noReturn: [{ lang: 'de', url: 'https://example.com/de', status: 'missing-return' }] });
    // A URL the context cannot hold is left out (the context must always validate).
    const long = `https://example.com/${'x'.repeat(SNAPSHOT_LIMITS.maxUrlChars)}`;
    const capped = checksContextOf({ links: { ...IDLE_LINK_RUN, status: 'done', results: [result(long, { kind: 'broken', status: 404, reason: 'http-error' }), result('https://example.com/a', { kind: 'redirect', redirects: 1, finalUrl: long })] }, sitemaps: IDLE_SITEMAP_RUN, hreflang: IDLE_HREFLANG_RUN }, [link(long), link('https://example.com/a')]);
    expect(capped.links).toEqual({ checked: 2, broken: [], internalRedirects: [] });
  });
});

describe('rules', () => {
  test('checks-rules-pass-unchecked', () => {
    const ids = SEO_RULE_SPECS.map((spec) => spec.id);
    for (const spec of CHECKS_RULE_SPECS) {
      expect(ids).toContain(spec.id);
      passes(spec.id, cleanSnapshot());
      passes(spec.id, withChecks({}));
    }
  });

  test('links-broken', () => {
    passes('links-broken', withChecks({ links: { checked: 3, broken: [], internalRedirects: [] } }));
    const found = fails('links-broken', withChecks({ links: { checked: 3, broken: [{ url: 'https://example.com/x', status: 404, reason: 'http-error' }, { url: 'https://example.com/y', status: null, reason: 'timeout' }], internalRedirects: [] } }));
    expect(found.count).toBe(2);
    expect(found.samples).toEqual(['404: https://example.com/x', 'Timed out: https://example.com/y']);
  });

  test('links-internal-redirect', () => {
    passes('links-internal-redirect', withChecks({ links: { checked: 1, broken: [], internalRedirects: [] } }));
    const found = fails('links-internal-redirect', withChecks({ links: { checked: 1, broken: [], internalRedirects: [{ url: 'https://example.com/a', finalUrl: 'https://example.com/a/', status: 200 }] } }));
    expect(found.samples).toEqual(['https://example.com/a → https://example.com/a/']);
  });

  test('sitemap-page-not-listed', () => {
    passes('sitemap-page-not-listed', withChecks({ sitemaps: { files: 1, urlCount: 10, listed: true, errors: [] } }));
    passes('sitemap-page-not-listed', withChecks({ sitemaps: { files: 0, urlCount: 0, listed: null, errors: [] } }));
    fails('sitemap-page-not-listed', withChecks({ sitemaps: { files: 2, urlCount: 10, listed: false, errors: [] } }));
  });

  test('sitemap-unreachable', () => {
    // frost's own caps are not the site's fault.
    passes('sitemap-unreachable', withChecks({ sitemaps: { files: 20, urlCount: 50_000, listed: true, errors: [{ url: 'https://example.com/s21.xml', kind: 'too-many-files' }] } }));
    const found = fails('sitemap-unreachable', withChecks({ sitemaps: { files: 2, urlCount: 0, listed: null, errors: [{ url: 'https://example.com/a.xml', kind: 'http-error' }, { url: 'https://example.com/b.xml', kind: 'dtd-refused' }] } }));
    expect(found.count).toBe(2);
    expect(found.samples[1]).toBe('Has a DOCTYPE (refused): https://example.com/b.xml');
  });

  test('hreflang-no-return-link', () => {
    passes('hreflang-no-return-link', withChecks({ hreflang: { checked: 2, noReturn: [] } }));
    const found = fails('hreflang-no-return-link', withChecks({ hreflang: { checked: 2, noReturn: [{ lang: 'de', url: 'https://example.com/de', status: 'wrong-language' }] } }));
    expect(found.samples).toEqual(['de https://example.com/de: Links back with another language']);
  });
});
