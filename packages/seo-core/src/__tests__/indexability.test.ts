// Spec: specs/seo-rules.spec.ts (indexability and hreflang rules, NOT_INDEXABLE_RULES, NOINDEX_SCORE_CAP),
// specs/seo-indexability.spec.ts (verdicts, ISO tables, ROBOTS_AGENTS), specs/seo-snapshot.spec.ts (PageContext)
// Acceptance: specs/seo-indexability.feature.md (Headers, hreflang, Rules, Verdict)
import { describe, expect, test } from 'vitest';
import { ISO_3166_1_ALPHA_2, ISO_639_1, ROBOTS_PARSE_LIMITS } from '@app/specs/seo-indexability.spec';
import { FINDING_SAMPLE_LIMIT, NOINDEX_SCORE_CAP, NOT_INDEXABLE_RULES, type SeoRuleId } from '@app/specs/seo-rules.spec';
import { analyseIndexability, isValidHreflang, parseHreflangCode, parseLinkHeader, parseXRobotsTag, RULES, runAudit, type FindingDetails, type PageSnapshot } from '../index';
import { cleanSnapshot, header, okResponse, okRobots, page, PAGE_URL, robots } from './fixtures';

function fails(id: SeoRuleId, snapshot: PageSnapshot): FindingDetails {
  const result = RULES.find((r) => r.id === id)!.check(snapshot);
  expect(result, `${id} should fail`).not.toBeNull();
  expect(result!.samples.length).toBeLessThanOrEqual(FINDING_SAMPLE_LIMIT);
  return result!;
}
function passes(id: SeoRuleId, snapshot: PageSnapshot): void {
  expect(RULES.find((r) => r.id === id)!.check(snapshot), `${id} should pass`).toBeNull();
}
const factOf = (result: FindingDetails, label: string) => result.facts.find((f) => f.label === label)?.value;

/** The clean page with these response headers (beside its own). */
const withHeaders = (...headers: ReturnType<typeof header>[]) => page({ response: okResponse({ headers: [...okResponse().headers, ...headers] }) });
const withRobots = (text: string) => page({ robots: okRobots(text) });
const hreflang = (value: string, href: string, resolved: string | null = new URL(href, PAGE_URL).href) => ({ hreflang: value, href, resolved });
const withHreflang = (...links: ReturnType<typeof hreflang>[]) => page({ hreflang: links, hreflangTotal: links.length });
const hop = (url: string, status: number, location: string, internal = false) => ({ url, status, location, internal });

describe('headers', () => {
  test('x-robots-tag-parses-agents-and-directives', () => {
    expect(parseXRobotsTag('noindex, nofollow')).toEqual({ agent: null, directives: ['noindex', 'nofollow'], value: 'noindex, nofollow' });
    expect(parseXRobotsTag('googlebot: noindex')).toMatchObject({ agent: 'googlebot', directives: ['noindex'] });
    expect(parseXRobotsTag('GoogleBot : NoIndex, max-snippet: 20')).toMatchObject({ agent: 'googlebot', directives: ['noindex', 'max-snippet'] });
    // A directive that takes a value is not a crawler name.
    expect(parseXRobotsTag('unavailable_after: 25 Jun 2030 15:00:00 PST')).toMatchObject({ agent: null, directives: ['unavailable_after'] });
    expect(parseXRobotsTag('max-image-preview: large, noarchive')).toMatchObject({ agent: null, directives: ['max-image-preview', 'noarchive'] });
    expect(parseXRobotsTag('')).toMatchObject({ agent: null, directives: [] });
  });

  test('link-header-parses-rfc-8288', () => {
    expect(parseLinkHeader('<https://example.com/c>; rel="canonical"', 10)).toEqual([{ target: 'https://example.com/c', rel: ['canonical'], hreflang: null }]);
    const many = parseLinkHeader('<https://example.com/de/>; rel="alternate"; hreflang="de", <https://example.com/,a;b>; rel=alternate; hreflang=fr ,</x>; rel="preload next"', 10);
    expect(many).toEqual([
      { target: 'https://example.com/de/', rel: ['alternate'], hreflang: 'de' },
      { target: 'https://example.com/,a;b', rel: ['alternate'], hreflang: 'fr' },
      { target: '/x', rel: ['preload', 'next'], hreflang: null },
    ]);
    // Quoted strings may hold commas; the first `rel` counts; garbage is skipped.
    expect(parseLinkHeader('garbage, <a>; title="x, y"; rel="first"; rel="second", <b', 10)).toEqual([{ target: 'a', rel: ['first'], hreflang: null }]);
    expect(parseLinkHeader('<a>, <b>, <c>', 2)).toHaveLength(2);
    expect(parseLinkHeader('', 10)).toEqual([]);
    // Linear on a hostile value.
    const started = performance.now();
    parseLinkHeader(`<a>${'; x="'.repeat(10_000)}`, 300);
    parseLinkHeader(','.repeat(100_000), 300);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('hreflang codes', () => {
  test('hreflang-code-tables', () => {
    expect(new Set(ISO_639_1).size).toBe(ISO_639_1.length);
    expect(ISO_639_1.length).toBeGreaterThanOrEqual(180);
    expect(new Set(ISO_3166_1_ALPHA_2).size).toBe(249);
    expect(ISO_3166_1_ALPHA_2).toHaveLength(249);
    for (const code of ISO_639_1) expect(code).toMatch(/^[a-z]{2}$/);
    for (const code of ISO_3166_1_ALPHA_2) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  test('hreflang-codes-validate', () => {
    for (const valid of ['en', 'EN', 'en-GB', 'en-gb', 'pt-BR', 'zh-Hant', 'zh-hant', 'zh-Hant-TW', 'sr-Latn', 'es-419', 'en-001', 'x-default', 'X-Default', ' de ']) expect(isValidHreflang(valid), valid).toBe(true);
    for (const invalid of ['en-UK', 'en_US', 'eng', 'english', 'xx', 'en-', '', 'en-GB-x', 'en-123', 'es-420', 'zh-Abcd', 'zh-Hant-ZZ', 'qq-ZZ', '-GB', 'GB']) expect(isValidHreflang(invalid), invalid).toBe(false);
    expect(parseHreflangCode('zh-hant-tw')).toEqual({ language: 'zh', script: 'hant', region: 'TW' });
    expect(parseHreflangCode('x-default')).toBe('x-default');
  });
});

describe('indexability rules', () => {
  test('clean-context-passes-every-indexability-rule', () => {
    for (const r of RULES.filter((rule) => rule.category === 'indexability' || rule.category === 'hreflang')) expect(r.check(cleanSnapshot()), r.id).toBeNull();
    // Nothing collected (no response, no robots.txt fetch): nothing to fail on.
    const bare = page({ response: null, robots: null });
    for (const r of RULES.filter((rule) => rule.category === 'indexability')) expect(r.check(bare), r.id).toBeNull();
  });

  test('http-status-redirect', () => {
    expect(factOf(fails('http-status-redirect', page({ response: okResponse({ status: 300 }) })), 'Status')).toBe('300');
    passes('http-status-redirect', cleanSnapshot());
    passes('http-status-redirect', page({ response: okResponse({ status: 404 }) }));
  });

  test('http-status-client-error', () => {
    expect(factOf(fails('http-status-client-error', page({ response: okResponse({ status: 404 }) })), 'Status')).toBe('404');
    fails('http-status-client-error', page({ response: okResponse({ status: 410, source: 'navigation', headersAvailable: false, headers: [] }) }));
    passes('http-status-client-error', page({ response: okResponse({ status: 500 }) }));
    passes('http-status-client-error', page({ response: okResponse({ status: null, source: 'in-page', headersAvailable: false, headers: [] }) }));
  });

  test('http-status-server-error', () => {
    fails('http-status-server-error', page({ response: okResponse({ status: 503 }) }));
    passes('http-status-server-error', page({ response: okResponse({ status: 200 }) }));
  });

  test('http-redirect-chain', () => {
    const two = [hop('http://example.com/a', 301, 'https://example.com/a'), hop('https://example.com/a', 302, PAGE_URL)];
    const result = fails('http-redirect-chain', page({ response: okResponse({ redirects: two, redirectTotal: 2 }) }));
    expect(factOf(result, 'Redirects')).toBe('2');
    expect(result.samples[0]).toBe('301 http://example.com/a → https://example.com/a');
    // One server redirect is fine; an internal (HSTS) hop is not counted; hops past the cap are.
    passes('http-redirect-chain', page({ response: okResponse({ redirects: [two[1]!], redirectTotal: 1 }) }));
    passes('http-redirect-chain', page({ response: okResponse({ redirects: [hop('http://example.com/a', 307, 'https://example.com/a', true), two[1]!], redirectTotal: 2 }) }));
    fails('http-redirect-chain', page({ response: okResponse({ redirects: [two[1]!], redirectTotal: 3 }) }));
  });

  test('x-robots-noindex', () => {
    const generic = fails('x-robots-noindex', withHeaders(header('x-robots-tag', 'noindex')));
    expect(factOf(generic, 'Applies to')).toBe('all crawlers');
    expect(factOf(fails('x-robots-noindex', withHeaders(header('x-robots-tag', 'GoogleBot: NOINDEX'))), 'Applies to')).toBe('googlebot');
    fails('x-robots-noindex', withHeaders(header('x-robots-tag', 'max-snippet: 10'), header('x-robots-tag', 'none')));
    // Another crawler's noindex, or a nofollow, is not this rule.
    passes('x-robots-noindex', withHeaders(header('x-robots-tag', 'bingbot: noindex')));
    passes('x-robots-noindex', withHeaders(header('x-robots-tag', 'googlebot-news: noindex')));
    passes('x-robots-noindex', withHeaders(header('x-robots-tag', 'otherbot: noindex')));
    passes('x-robots-noindex', withHeaders(header('x-robots-tag', 'nofollow')));
    passes('x-robots-noindex', cleanSnapshot());
  });

  test('x-robots-noindex-other-bot', () => {
    expect(factOf(fails('x-robots-noindex-other-bot', withHeaders(header('x-robots-tag', 'BingBot: NOINDEX'))), 'Applies to')).toBe('bingbot');
    expect(factOf(fails('x-robots-noindex-other-bot', withHeaders(header('x-robots-tag', 'googlebot-news: none'))), 'Applies to')).toBe('googlebot-news');
    passes('x-robots-noindex-other-bot', withHeaders(header('x-robots-tag', 'noindex'), header('x-robots-tag', 'googlebot: noindex')));
    passes('x-robots-noindex-other-bot', withHeaders(header('x-robots-tag', 'otherbot: noindex')));
    passes('x-robots-noindex-other-bot', cleanSnapshot());
  });

  test('x-robots-nofollow', () => {
    fails('x-robots-nofollow', withHeaders(header('x-robots-tag', 'nofollow')));
    fails('x-robots-nofollow', withHeaders(header('x-robots-tag', 'googlebot: none')));
    passes('x-robots-nofollow', withHeaders(header('x-robots-tag', 'noindex')));
  });

  test('robots-txt-blocks-googlebot', () => {
    const blocked = fails('robots-txt-blocks-googlebot', withRobots('User-agent: *\nDisallow: /guides/\n'));
    expect(blocked.facts).toEqual([
      { label: 'Rule', value: 'Disallow: /guides/' },
      { label: 'Line', value: '2' },
      { label: 'Group', value: 'User-agent: *' },
      { label: 'Path', value: '/guides/seo-basics' },
    ]);
    fails('robots-txt-blocks-googlebot', withRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n'));
    passes('robots-txt-blocks-googlebot', withRobots('User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n'));
    passes('robots-txt-blocks-googlebot', withRobots('User-agent: *\nDisallow: /guides/\nAllow: /guides/seo-basics\n'));
    // No file, or an unreadable one: not this rule.
    passes('robots-txt-blocks-googlebot', page({ robots: okRobots('', { outcome: 'unavailable', status: 404 }) }));
    passes('robots-txt-blocks-googlebot', page({ robots: okRobots('', { outcome: 'server-error', status: 503 }) }));
  });

  test('robots-txt-blocks-all', () => {
    expect(factOf(fails('robots-txt-blocks-all', withRobots('User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n')), 'Group')).toBe('User-agent: *');
    // When Googlebot is blocked too, only the error fires.
    passes('robots-txt-blocks-all', withRobots('User-agent: *\nDisallow: /\n'));
    passes('robots-txt-blocks-all', cleanSnapshot());
  });

  test('robots-txt-unreachable', () => {
    for (const outcome of ['server-error', 'unreachable', 'timeout', 'bad-redirect', 'no-location'] as const) fails('robots-txt-unreachable', page({ robots: okRobots('', { outcome, status: outcome === 'server-error' ? 503 : null }) }));
    expect(factOf(fails('robots-txt-unreachable', page({ robots: okRobots('', { outcome: 'server-error', status: 503 }) })), 'Status')).toBe('503');
    for (const outcome of ['unavailable', 'forbidden', 'too-many-redirects', 'private-redirect', 'pending'] as const) passes('robots-txt-unreachable', page({ robots: okRobots('', { outcome, status: null }) }));
    passes('robots-txt-unreachable', cleanSnapshot());
    passes('robots-txt-unreachable', page({ robots: null }));
  });

  test('robots-txt-no-sitemap', () => {
    fails('robots-txt-no-sitemap', withRobots('User-agent: *\nDisallow: /private/\n'));
    passes('robots-txt-no-sitemap', cleanSnapshot());
    // No robots.txt at all: nothing to add a Sitemap line to.
    passes('robots-txt-no-sitemap', page({ robots: okRobots('', { outcome: 'unavailable', status: 404 }) }));
  });

  test('canonical-elsewhere', () => {
    const other = 'https://example.com/guides/seo';
    const result = fails('canonical-elsewhere', page({ canonicals: [{ href: other, resolved: other }], canonicalTotal: 1 }));
    expect(result.facts).toEqual([
      { label: 'Canonical', value: other },
      { label: 'From', value: '<link rel="canonical">' },
      { label: 'Page', value: PAGE_URL },
    ]);
    // From the HTTP Link header when the HTML has none (resolved against the page).
    const fromHeader = page({ canonicals: [], canonicalTotal: 0, response: okResponse({ headers: [header('link', '</guides/seo>; rel="canonical"')] }) });
    expect(factOf(fails('canonical-elsewhere', fromHeader), 'From')).toBe('HTTP Link header');
    expect(factOf(fails('canonical-elsewhere', fromHeader), 'Canonical')).toBe(other);
    passes('canonical-elsewhere', cleanSnapshot());
    passes('canonical-elsewhere', page({ canonicals: [{ href: `${PAGE_URL}#top`, resolved: `${PAGE_URL}#top` }], canonicalTotal: 1 }));
    passes('canonical-elsewhere', page({ canonicals: [], canonicalTotal: 0, response: okResponse({ headers: [header('link', `<${PAGE_URL}>; rel="canonical"`)] }) }));
  });

  test('canonical-header-conflict', () => {
    const conflicting = withHeaders(header('link', '<https://example.com/other>; rel="canonical"'));
    expect(fails('canonical-header-conflict', conflicting).facts).toEqual([
      { label: 'HTML canonical', value: PAGE_URL },
      { label: 'Header canonical', value: 'https://example.com/other' },
    ]);
    passes('canonical-header-conflict', withHeaders(header('link', `<${PAGE_URL}>; rel=canonical`)));
    passes('canonical-header-conflict', withHeaders(header('link', '<https://example.com/other>; rel="alternate"')));
  });
});

describe('hreflang rules', () => {
  const good = () => [hreflang('en', PAGE_URL), hreflang('de', 'https://example.com/de/guides/seo-basics'), hreflang('x-default', 'https://example.com/')];

  test('hreflang-invalid-code', () => {
    const result = fails('hreflang-invalid-code', withHreflang(...good(), hreflang('en-UK', 'https://example.com/uk/'), hreflang('en_US', 'https://example.com/us/')));
    expect(result.count).toBe(2);
    expect(result.samples).toEqual(['en-UK → https://example.com/uk/', 'en_US → https://example.com/us/']);
    // From an HTTP Link header too.
    fails('hreflang-invalid-code', withHeaders(header('link', '<https://example.com/x/>; rel="alternate"; hreflang="xx"')));
    passes('hreflang-invalid-code', withHreflang(...good()));
    passes('hreflang-invalid-code', cleanSnapshot());
  });

  test('hreflang-missing-self', () => {
    fails('hreflang-missing-self', withHreflang(hreflang('de', 'https://example.com/de/'), hreflang('x-default', 'https://example.com/')));
    passes('hreflang-missing-self', withHreflang(...good()));
    // The canonical counts as this page.
    const viaCanonical = page({ url: `${PAGE_URL}?ref=nav`, hreflang: good(), hreflangTotal: 3 });
    passes('hreflang-missing-self', viaCanonical);
    passes('hreflang-missing-self', withHeaders(header('link', `<${PAGE_URL}>; rel="alternate"; hreflang="en"`)));
    passes('hreflang-missing-self', cleanSnapshot());
  });

  test('hreflang-no-x-default', () => {
    fails('hreflang-no-x-default', withHreflang(hreflang('en', PAGE_URL)));
    passes('hreflang-no-x-default', withHreflang(...good()));
    passes('hreflang-no-x-default', cleanSnapshot());
  });

  test('hreflang-duplicate', () => {
    const result = fails('hreflang-duplicate', withHreflang(...good(), hreflang('DE', 'https://example.com/de-2/')));
    expect(factOf(result, 'Repeated values')).toBe('de');
    expect(result.count).toBe(2);
    passes('hreflang-duplicate', withHreflang(...good()));
  });

  test('hreflang-relative-url', () => {
    expect(fails('hreflang-relative-url', withHreflang(...good(), hreflang('fr', '/fr/'))).samples).toEqual(['fr → /fr/']);
    fails('hreflang-relative-url', withHreflang(hreflang('fr', '//example.com/fr/')));
    passes('hreflang-relative-url', withHreflang(...good()));
  });
});

describe('verdict', () => {
  test('verdict-indexable', () => {
    const audit = runAudit(cleanSnapshot());
    expect(audit.indexability).toMatchObject({ verdict: 'indexable', reasons: [] });
    expect(audit.indexable).toBe(true);
    expect(audit.indexability.robots?.agents.map((agent) => [agent.agent, agent.allowed])).toEqual([
      ['Googlebot', true],
      ['Bingbot', true],
      ['*', true],
    ]);
    expect(audit.indexability.robots?.sitemaps).toEqual([{ raw: 'https://example.com/sitemap.xml', url: 'https://example.com/sitemap.xml', line: 4 }]);
  });

  test('verdict-not-indexable-caps-the-score', () => {
    const cases: [PageSnapshot, string][] = [
      [page({ metaRobots: [robots('noindex', 'googlebot')] }), 'A robots meta tag asks not to index it (googlebot)'],
      [withHeaders(header('x-robots-tag', 'googlebot: noindex')), 'The X-Robots-Tag header asks not to index it (googlebot)'],
      [withRobots('User-agent: *\nDisallow: /guides\n'), 'robots.txt blocks Googlebot (line 2: Disallow: /guides)'],
      [page({ response: okResponse({ status: 404 }) }), 'The server answered HTTP 404'],
      [page({ response: okResponse({ status: 502 }) }), 'The server answered HTTP 502'],
    ];
    for (const [snapshot, reason] of cases) {
      const audit = runAudit(snapshot);
      expect(audit.indexability.verdict, reason).toBe('not-indexable');
      expect(audit.indexability.reasons).toEqual([reason]);
      expect(audit.indexable).toBe(false);
      expect(audit.score).toBeLessThanOrEqual(NOINDEX_SCORE_CAP);
      expect(audit.band).toBe('poor');
    }
    expect(NOT_INDEXABLE_RULES).toHaveLength(cases.length);
    // Several reasons at once, in NOT_INDEXABLE_RULES order.
    const both = runAudit(page({ metaRobots: [robots('noindex')], response: okResponse({ status: 410 }) }));
    expect(both.indexability.reasons).toEqual(['A robots meta tag asks not to index it (robots)', 'The server answered HTTP 410']);
  });

  test('verdict-other-crawlers-do-not-cap', () => {
    // A noindex for googlebot-news or bingbot alone (meta or header) is a warning, never "Not indexable".
    for (const snapshot of [page({ metaRobots: [robots('noindex', 'bingbot')] }), page({ metaRobots: [robots('noindex', 'googlebot-news')] }), withHeaders(header('x-robots-tag', 'bingbot: noindex'))]) {
      const audit = runAudit(snapshot);
      expect(audit.indexability.verdict).toBe('indexable');
      expect(audit.indexable).toBe(true);
      expect(audit.score).toBeGreaterThan(NOINDEX_SCORE_CAP);
    }
  });

  test('verdict-pending-while-robots-is-fetched', () => {
    const pending = page({ robots: okRobots('', { outcome: 'pending', status: null, finalUrl: null }) });
    const audit = runAudit(pending);
    expect(audit.indexability.verdict).toBe('pending');
    expect(audit.indexable).toBe(true);
    expect(audit.indexability.robots?.agents.map((agent) => agent.allowed)).toEqual([null, null, null]);
    for (const id of ['robots-txt-blocks-googlebot', 'robots-txt-blocks-all', 'robots-txt-unreachable', 'robots-txt-no-sitemap'] as const) passes(id, pending);
    // A reason that does not depend on robots.txt is already final.
    expect(runAudit(page({ robots: pending.robots, response: okResponse({ status: 404 }) })).indexability.verdict).toBe('not-indexable');
    // Pending outranks canonicalised (robots.txt may still block the page).
    expect(runAudit(page({ robots: pending.robots, canonicals: [{ href: 'https://example.com/x', resolved: 'https://example.com/x' }], canonicalTotal: 1 })).indexability.verdict).toBe('pending');
  });

  test('verdict-reads-non-utf8-robots', () => {
    const latin1 = Uint8Array.from([...'User-agent: *\nDisallow: /caf'].map((c) => c.charCodeAt(0)).concat([0xe9]));
    const snapshot = page({ url: 'https://example.com/caf%E9', canonicals: [], canonicalTotal: 0, ogUrl: null, robots: okRobots('', { body: latin1 }) });
    expect(runAudit(snapshot).indexability.verdict).toBe('not-indexable');
    expect(analyseIndexability(snapshot).robots!.text).toBe('User-agent: *\nDisallow: /caf%E9');
  });

  test('verdict-canonicalised', () => {
    const other = 'https://example.com/guides/seo';
    const audit = runAudit(page({ canonicals: [{ href: other, resolved: other }], canonicalTotal: 1, ogUrl: other }));
    expect(audit.indexability).toMatchObject({ verdict: 'canonicalised', reasons: [`Its canonical points to ${other}`] });
    expect(audit.indexable).toBe(true);
    expect(audit.score).toBeGreaterThan(NOINDEX_SCORE_CAP);
    // Not indexable wins over canonicalised.
    expect(runAudit(page({ canonicals: [{ href: other, resolved: other }], canonicalTotal: 1, metaRobots: [robots('noindex')] })).indexability.verdict).toBe('not-indexable');
  });

  test('robots-report-for-the-panel', () => {
    const text = `User-agent: googlebot\nDisallow: /guides/\n\nSitemap: /relative.xml\nSitemap: ftp://example.com/s.xml\n${'#'.repeat(ROBOTS_PARSE_LIMITS.maxViewChars)}`;
    const report = analyseIndexability(page({ robots: okRobots(text, { finalUrl: 'https://www.example.com/robots.txt' }) })).robots!;
    expect(report.agents[0]).toEqual({ agent: 'Googlebot', allowed: false, groupAgents: ['googlebot'], groupLine: 1, fallback: false, rule: { allow: false, raw: '/guides/', line: 2 } });
    expect(report.agents[1]).toEqual({ agent: 'Bingbot', allowed: true, groupAgents: [], groupLine: null, fallback: true, rule: null });
    // Sitemaps resolve against the URL that answered; only http(s) ones are openable.
    expect(report.sitemaps.map((sitemap) => sitemap.url)).toEqual(['https://www.example.com/relative.xml', null]);
    expect(report.text).toHaveLength(ROBOTS_PARSE_LIMITS.maxViewChars);
    expect(report.textCut).toBe(true);
    // Unknown outcomes give unknown verdicts; a missing file allows everything.
    expect(analyseIndexability(page({ robots: okRobots('', { outcome: 'timeout', status: null }) })).robots!.agents.map((agent) => agent.allowed)).toEqual([null, null, null]);
    expect(analyseIndexability(page({ robots: okRobots('', { outcome: 'unavailable', status: 404 }) })).robots!.agents.map((agent) => agent.allowed)).toEqual([true, true, true]);
  });

  test('http-report-for-the-panel', () => {
    const facts = analyseIndexability(withHeaders(header('x-robots-tag', 'noarchive'))).http!;
    expect(facts).toMatchObject({ status: 200, source: 'network', serverRedirects: 0 });
    expect(facts.headers.map((h) => h.name)).toEqual(['content-type', 'cache-control', 'x-robots-tag']);
    // Headers that main marked unavailable are never read.
    const restored = page({ response: okResponse({ source: 'navigation', headersAvailable: false, headers: [] }) });
    expect(analyseIndexability(restored).xRobotsTag).toEqual([]);
  });
});
