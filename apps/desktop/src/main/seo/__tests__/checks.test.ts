// Spec: specs/seo-checks.spec.ts (LINK_CHECK_LIMITS, CHECK_RUN_STATUSES, SITEMAP_LIMITS, HREFLANG_CHECK_LIMITS,
// CHECKS_PUSH_INTERVAL_MS), specs/seo-checks.schema.ts (ChecksContextSchema)
// Acceptance: specs/seo-checks.feature.md (Runs); review focus link-checks-are-bounded
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { HreflangReport, PageLink, SeoAudit, SeoAuditResponse } from '@app/seo-core';
import { LINK_CHECK_LIMITS, SITEMAP_NAMESPACE } from '@app/specs/seo-checks.spec';
import { ChecksContextSchema } from '@app/specs/seo-checks.schema';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { createChecks, type ChecksOptions, type ChecksTab } from '../checks';
import { analyseCheck } from '../checks-analyse';
import type { CheckFetch, CheckFetchOptions, CheckFetchResult } from '../checks-fetch';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const PAGE = 'https://example.com/page';
const link = (href: string, kind: PageLink['kind'] = 'internal'): PageLink => ({ href, scheme: 'https:', rel: '', text: 'x', kind, target: null });
const encode = (text: string) => new TextEncoder().encode(text);

function audit(links: PageLink[], hreflang: HreflangReport = { entries: [], total: 0, hasXDefault: false, hasSelf: false }, url = PAGE): SeoAuditResponse {
  return { status: 'ready', url, audit: { url, takenAt: 1, page: { linkList: links }, indexability: { hreflang, canonical: { effective: null } } } as unknown as SeoAudit };
}

const response = (status: number, changes: Partial<CheckFetchResult> = {}): CheckFetchResult => ({ outcome: 'response', status, finalUrl: '', redirects: 0, body: new Uint8Array(0), truncated: false, headers: { contentType: null, contentEncoding: null, link: null }, ...changes });

/** A fetch answering `routes[url]` (default 200) after `delayMs`, recording each request; aborts answer `aborted`. */
function fakeFetch(routes: Record<string, (options: CheckFetchOptions) => CheckFetchResult> = {}, delayMs = 10) {
  const asked: { url: string; options: CheckFetchOptions }[] = [];
  let inflight = 0;
  let aborted = 0;
  const fetch: CheckFetch = (url, options) =>
    new Promise((resolve) => {
      asked.push({ url, options });
      inflight += 1;
      const done = (result: CheckFetchResult) => {
        clearTimeout(timer);
        inflight -= 1;
        resolve(result);
      };
      const timer = setTimeout(() => done({ ...(routes[url]?.(options) ?? response(200)), finalUrl: routes[url]?.(options).finalUrl || url }), delayMs);
      options.signal.addEventListener(
        'abort',
        () => {
          aborted += 1;
          done(response(0, { outcome: 'aborted', status: null }));
        },
        { once: true },
      );
    });
  return { fetch, asked, inflight: () => inflight, aborted: () => aborted };
}

function setup(answer: SeoAuditResponse, overrides: Partial<ChecksOptions> = {}, robotsFile: RobotsFetch | null = null) {
  const tab: { current: ChecksTab | null } = { current: { contentsId: 11, url: PAGE, active: true, userAgent: null, audit: answer } };
  const rescore = vi.fn();
  const robots = vi.fn(async () => robotsFile);
  const net = fakeFetch();
  const checks = createChecks({ fetch: net.fetch, analyse: async (job) => analyseCheck(job), robots, tab: () => tab.current, rescore, ...overrides });
  return { checks, tab, rescore, robots, net };
}

const robotsTxt = (text: string): RobotsFetch => ({ url: 'https://example.com/robots.txt', outcome: 'ok', status: 200, finalUrl: 'https://example.com/robots.txt', redirects: 0, body: encode(text), truncated: false });

describe('runs', () => {
  test('checks-need-active-ready-tab', () => {
    const { checks, tab } = setup(audit([link('https://example.com/a')]));
    tab.current = { ...tab.current!, active: false };
    expect(checks.checkLinks(1)).toBe(false);
    tab.current = { ...tab.current!, active: true, audit: { status: 'pending', url: PAGE } };
    expect(checks.checkLinks(1)).toBe(false);
    // The ready audit is of another URL than the tab shows.
    tab.current = { ...tab.current!, audit: audit([], undefined, 'https://example.com/old') };
    expect(checks.checkSitemaps(1)).toBe(false);
    tab.current = { ...tab.current!, url: 'about:blank', audit: audit([], undefined, 'about:blank') };
    expect(checks.checkHreflang(1)).toBe(false);
    tab.current = null;
    expect(checks.checkLinks(1)).toBe(false);
    expect(checks.state(1)).toMatchObject({ url: '', links: { status: 'idle' } });
  });

  test('link-run-streams-results', async () => {
    const net = fakeFetch({ 'https://example.com/missing': () => response(404), 'https://other.test/moved': () => response(200, { redirects: 1, finalUrl: 'https://other.test/new' }) });
    const { checks, rescore } = setup(audit([link('https://example.com/a#x'), link('https://example.com/missing'), link('https://other.test/moved', 'external'), link('mailto:x@example.com', 'other'), link('https://example.com/a')]), { fetch: net.fetch });
    const first = checks.state(1).version;
    const woken = checks.watch(1, first);
    expect(checks.checkLinks(1)).toBe(true);
    // Running twice is not doubled.
    expect(checks.checkLinks(1)).toBe(true);
    await expect(woken).resolves.toMatchObject({ links: { status: 'running', total: 4 } });
    await vi.runAllTimersAsync();
    const state = checks.state(1);
    expect(state.links.status).toBe('done');
    expect(state.links.results.map((r) => [r.url, r.kind, r.status])).toEqual([
      ['https://example.com/a', 'ok', 200],
      ['https://example.com/missing', 'broken', 404],
      ['https://other.test/moved', 'redirect', 200],
      ['mailto:x@example.com', 'skipped', null],
    ]);
    expect(net.asked.map((a) => [a.url, a.options.method])).toEqual([
      ['https://example.com/a', 'HEAD'],
      ['https://other.test/moved', 'HEAD'],
      ['https://example.com/missing', 'HEAD'],
    ]);
    expect(rescore).toHaveBeenCalledWith(1);
    expect(checks.brokenFor(11)).toEqual(['https://example.com/missing']);
  });

  test('link-run-robots-blocked', async () => {
    const { checks, net, robots } = setup(audit([link('https://example.com/private/x'), link('https://example.com/ok'), link('https://other.test/private/x', 'external')]), {}, robotsTxt('User-agent: *\nDisallow: /private/\n'));
    checks.checkLinks(1);
    await vi.runAllTimersAsync();
    expect(robots).toHaveBeenCalledWith(PAGE);
    expect(checks.state(1).links.results.map((r) => [r.url, r.kind])).toEqual([
      ['https://example.com/private/x', 'blocked'],
      ['https://example.com/ok', 'ok'],
      ['https://other.test/private/x', 'ok'],
    ]);
    expect(net.asked.map((a) => a.url)).not.toContain('https://example.com/private/x');
  });

  test('link-run-cached', async () => {
    const { checks, net } = setup(audit([link('https://example.com/a'), link('https://example.com/b')]));
    checks.checkLinks(1);
    await vi.runAllTimersAsync();
    expect(net.asked).toHaveLength(2);
    expect(checks.cacheSize()).toBe(2);
    checks.checkLinks(1);
    await vi.runAllTimersAsync();
    expect(net.asked).toHaveLength(2);
    expect(checks.state(1).links.results.every((r) => r.cached)).toBe(true);
    checks.clearCache();
    checks.checkLinks(1);
    await vi.runAllTimersAsync();
    expect(net.asked).toHaveLength(4);
  });

  test('link-run-total-cap', async () => {
    const links = Array.from({ length: 600 }, (_, i) => link(`https://site${i % 30}.test/${i}`, 'external'));
    const { checks, net } = setup(audit(links));
    checks.checkLinks(1);
    let peak = 0;
    for (let i = 0; i < 2_000 && checks.state(1).links.status === 'running'; i++) {
      peak = Math.max(peak, net.inflight());
      await vi.advanceTimersByTimeAsync(5);
    }
    const state = checks.state(1);
    expect(state.links.status).toBe('done');
    expect(net.asked).toHaveLength(LINK_CHECK_LIMITS.maxLinks);
    expect(state.links.results.filter((r) => r.reason === 'over-cap')).toHaveLength(100);
    expect(peak).toBeLessThanOrEqual(LINK_CHECK_LIMITS.maxConcurrency);
  });

  test('link-run-private-refused', async () => {
    const { checks, net } = setup(audit([link('http://127.0.0.1:8080/a'), link('http://[::1]/b'), link('http://10.0.0.2/'), link('https://example.com/ok')]));
    checks.checkLinks(1);
    await vi.runAllTimersAsync();
    expect(net.asked.map((a) => a.url)).toEqual(['https://example.com/ok']);
    expect(net.asked[0]!.options.allowPrivate).toBe(false);
    expect(checks.state(1).links.results.filter((r) => r.reason === 'private')).toHaveLength(3);
  });

  test('checks-cancel-on-navigation', async () => {
    const net = fakeFetch({}, 5_000);
    const links = Array.from({ length: 20 }, (_, i) => link(`https://example.com/${i}`));
    const { checks, tab, rescore } = setup(audit(links), { fetch: net.fetch });
    checks.checkLinks(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(net.inflight()).toBeGreaterThan(0);
    const asked = net.asked.length;
    // A new document: every request aborted, nothing more asked, the tab's runs gone.
    checks.dropped(11);
    await vi.advanceTimersByTimeAsync(0);
    expect(net.inflight()).toBe(0);
    expect(net.aborted()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.asked).toHaveLength(asked);
    expect(checks.state(1).links.status).toBe('idle');
    expect(rescore).not.toHaveBeenCalled();
    // An in-page move to another URL cancels too; a fragment change does not.
    checks.checkLinks(1);
    await vi.advanceTimersByTimeAsync(300);
    checks.navigatedInPage(11, `${PAGE}#section`);
    expect(checks.state(1).links.status).toBe('running');
    checks.navigatedInPage(11, 'https://example.com/other');
    tab.current = { ...tab.current!, url: 'https://example.com/other' };
    await vi.advanceTimersByTimeAsync(0);
    expect(net.inflight()).toBe(0);
    expect(checks.state(1).links.status).toBe('idle');
  });

  test('checks-stop-keeps-results', async () => {
    const net = fakeFetch({}, 1_000);
    const { checks, rescore } = setup(audit(Array.from({ length: 10 }, (_, i) => link(`https://example.com/${i}`))), { fetch: net.fetch });
    expect(checks.stop(1, 'links')).toBe(false);
    checks.checkLinks(1);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(checks.stop(1, 'links')).toBe(true);
    await vi.runAllTimersAsync();
    const state = checks.state(1);
    expect(state.links.status).toBe('stopped');
    expect(state.links.results.length).toBeGreaterThan(0);
    expect(state.links.results.length).toBeLessThan(10);
    expect(rescore).toHaveBeenCalledTimes(1);
    expect(ChecksContextSchema.parse(checks.contextFor(11, PAGE)).links?.checked).toBe(state.links.results.length);
  });
});

describe('sitemaps and hreflang', () => {
  const xml = (body: string, root = 'urlset') => () => response(200, { body: encode(`<${root} xmlns="${SITEMAP_NAMESPACE}">${body}</${root}>`) });
  const loc = (url: string, entry = 'url') => `<${entry}><loc>${url}</loc></${entry}>`;

  test('sitemap-run-follows-index', async () => {
    const net = fakeFetch({
      'https://example.com/index.xml': xml(loc('https://example.com/a.xml', 'sitemap') + loc('https://example.com/nested.xml', 'sitemap'), 'sitemapindex'),
      'https://example.com/a.xml': xml(loc('https://example.com/x') + loc(PAGE)),
      'https://example.com/nested.xml': xml(loc('https://example.com/deep.xml', 'sitemap'), 'sitemapindex'),
      'https://example.com/deep.xml': xml(loc('https://example.com/too-deep.xml', 'sitemap'), 'sitemapindex'),
    });
    const { checks, rescore } = setup(audit([]), { fetch: net.fetch }, robotsTxt('Sitemap: /index.xml\n'));
    checks.checkSitemaps(1);
    await vi.runAllTimersAsync();
    const run = checks.state(1).sitemaps;
    expect(run).toMatchObject({ status: 'done', source: 'robots', urlCount: 2, listed: true });
    expect(run.files.map((f) => [f.url, f.depth, f.type, f.entries])).toEqual([
      ['https://example.com/index.xml', 0, 'index', 2],
      ['https://example.com/a.xml', 1, 'urlset', 2],
      ['https://example.com/nested.xml', 1, 'index', 1],
      ['https://example.com/deep.xml', 2, 'index', 1],
    ]);
    expect(run.errors).toEqual([{ url: 'https://example.com/too-deep.xml', kind: 'too-deep' }]);
    expect(net.asked.map((a) => a.url)).not.toContain('https://example.com/too-deep.xml');
    expect(net.asked.every((a) => a.options.method === 'GET' && a.options.maxBytes === 50 * 1024 * 1024)).toBe(true);
    expect(rescore).toHaveBeenCalledWith(1);
    expect(ChecksContextSchema.parse(checks.contextFor(11, PAGE)).sitemaps).toEqual({ files: 4, urlCount: 2, listed: true, errors: [{ url: 'https://example.com/too-deep.xml', kind: 'too-deep' }] });
  });

  test('sitemap-run-fallback-and-errors', async () => {
    const net = fakeFetch({ 'https://example.com/sitemap.xml': () => response(404) });
    const { checks } = setup(audit([]), { fetch: net.fetch });
    checks.checkSitemaps(1);
    await vi.runAllTimersAsync();
    expect(checks.state(1).sitemaps).toMatchObject({ status: 'done', source: 'fallback', listed: null, errors: [{ url: 'https://example.com/sitemap.xml', kind: 'http-error' }] });
    const again = fakeFetch({ 'https://example.com/sitemap.xml': xml(loc('https://example.com/other')) });
    const second = setup(audit([]), { fetch: again.fetch });
    second.checks.checkSitemaps(1);
    await vi.runAllTimersAsync();
    expect(second.checks.state(1).sitemaps).toMatchObject({ listed: false, urlCount: 1, errors: [] });
  });

  test('hreflang-run-statuses', async () => {
    const entry = (value: string, resolved: string, self = false) => ({ value, href: resolved, resolved, source: 'html' as const, valid: true, self, relative: false, duplicate: false });
    const hreflang: HreflangReport = { entries: [entry('en', PAGE, true), entry('de', 'https://example.com/de'), entry('fr', 'https://example.com/fr'), entry('es', 'https://example.com/es'), entry('it', 'http://192.168.0.9/it')], total: 5, hasXDefault: false, hasSelf: true };
    const html = (body: string) => () => response(200, { body: encode(body), headers: { contentType: 'text/html; charset=utf-8', contentEncoding: null, link: null } });
    const net = fakeFetch({
      'https://example.com/de': html(`<head><link rel="alternate" hreflang="en" href="${PAGE}"><link rel="alternate" hreflang="de" href="/de"></head>`),
      'https://example.com/fr': html('<head><link rel="alternate" hreflang="fr" href="/fr"></head>'),
      'https://example.com/es': () => response(500),
    });
    const { checks } = setup(audit([], hreflang), { fetch: net.fetch });
    checks.checkHreflang(1);
    await vi.runAllTimersAsync();
    const run = checks.state(1).hreflang;
    expect(run.status).toBe('done');
    expect(run.alternates.map((a) => [a.lang, a.status, a.httpStatus])).toEqual([
      ['de', 'reciprocal', 200],
      ['fr', 'missing-return', 200],
      ['es', 'unreachable', 500],
      ['it', 'skipped', null],
    ]);
    expect(net.asked.map((a) => a.url)).not.toContain('http://192.168.0.9/it');
    expect(ChecksContextSchema.parse(checks.contextFor(11, PAGE)).hreflang).toEqual({ checked: 3, noReturn: [{ lang: 'fr', url: 'https://example.com/fr', status: 'missing-return' }] });
  });

  test('checks-context-and-broken', async () => {
    const net = fakeFetch({ 'https://example.com/gone': () => response(410) });
    const { checks } = setup(audit([link('https://example.com/gone'), link('https://example.com/ok')]), { fetch: net.fetch });
    expect(checks.contextFor(11, PAGE)).toBeUndefined();
    checks.checkLinks(1);
    await vi.runAllTimersAsync();
    expect(ChecksContextSchema.safeParse(checks.contextFor(11, `${PAGE}#frag`)).success).toBe(true);
    expect(checks.contextFor(11, 'https://example.com/elsewhere')).toBeUndefined();
    expect(checks.contextFor(12, PAGE)).toBeUndefined();
    expect(checks.brokenFor(11)).toEqual(['https://example.com/gone']);
    expect(checks.brokenFor(12)).toEqual([]);
  });
});
