// Spec: specs/seo-rules.spec.ts (SEVERITY_WEIGHTS, SCORE_BANDS), specs/seo-sidebar.spec.ts (PanelStatus)
// Acceptance: specs/seo-rules.feature.md (Audit and score)
import { describe, expect, test } from 'vitest';
import { CHECKS_RULE_SPECS } from '@app/specs/seo-checks.spec';
import { NOINDEX_SCORE_CAP, SEO_RULE_SPECS, type SeoRuleId, type SeoSeverity } from '@app/specs/seo-rules.spec';
import { pageFacts, panelStatus, RULES, runAudit, scoreAudit, scoreBand, type Finding, type PageSnapshot } from '../index';
import { cleanSecurity, cleanSnapshot, header, okResponse, okRobots, page, robots, servedOf, text } from './fixtures';
import { withVitals } from './performance-fixtures';

/** A finding of rule `id` as the catalog defines it. */
function finding(id: SeoRuleId): Finding {
  const spec = SEO_RULE_SPECS.find((s) => s.id === id)!;
  return { ruleId: spec.id, category: spec.category, severity: spec.severity, title: spec.title, why: spec.why, fix: spec.fix, details: { facts: [], samples: [] } };
}

/** A finding of some rule with `severity` (the n-th such rule in the catalog). */
function ofSeverity(severity: SeoSeverity, n = 0): Finding {
  return finding(SEO_RULE_SPECS.filter((s) => s.severity === severity)[n]!.id);
}

describe('audit', () => {
  test('run-audit-ranks-findings', () => {
    // No title (error), two H1s (warning), images without alt (warning), noindex (warning),
    // uppercase path (info), no canonical (warning).
    const audit = runAudit(
      page({
        url: 'https://example.com/Bad',
        titles: [],
        titleTotal: 0,
        headings: [
          { level: 1, text: 'One' },
          { level: 1, text: 'Two' },
        ],
        headingTotal: 2,
        images: [{ src: 'https://example.com/a.png', alt: null, width: '1', height: '1', loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false }],
        imageTotal: 1,
        metaRobots: [robots('noindex')],
        canonicals: [],
        canonicalTotal: 0,
        ogUrl: null,
      }),
    );
    expect(audit.findings.map((f) => f.ruleId)).toEqual(['title-missing', 'h1-multiple', 'canonical-missing', 'robots-noindex', 'images-missing-alt', 'url-uppercase']);
    expect(audit.counts).toEqual({ error: 1, warning: 4, info: 1 });
    expect(audit.score).toBe(scoreAudit(audit.findings));
    expect(audit.band).toBe('poor');
    expect(audit.url).toBe('https://example.com/Bad');
    // Each finding carries its catalog text.
    const [first] = audit.findings;
    expect(first).toMatchObject({ severity: 'error', category: 'title', title: 'Page has no title' });
    expect(first!.why.length).toBeGreaterThan(20);
    expect(first!.fix.length).toBeGreaterThan(10);
  });

  test('score-is-100-without-findings', () => {
    expect(scoreAudit([])).toBe(100);
    expect(scoreBand(100)).toBe('good');
    expect(runAudit(cleanSnapshot())).toMatchObject({ score: 100, band: 'good', counts: { error: 0, warning: 0, info: 0 }, findings: [] });
  });

  test('score-weights-by-severity', () => {
    expect(scoreAudit([ofSeverity('error')])).toBe(80);
    expect(scoreAudit([ofSeverity('warning')])).toBe(93);
    expect(scoreAudit([ofSeverity('info')])).toBe(99);
    expect(scoreAudit([ofSeverity('error'), ofSeverity('warning', 0), ofSeverity('warning', 1), ofSeverity('warning', 2)])).toBe(64);
  });

  test('score-caps-noindex', () => {
    expect(scoreAudit([finding('robots-noindex')])).toBe(NOINDEX_SCORE_CAP);
    expect(scoreBand(scoreAudit([finding('robots-noindex')]))).toBe('poor');
    // Lower stays lower.
    const many = ['title-missing', 'h1-missing', 'canonical-multiple', 'robots-noindex'] as const;
    expect(scoreAudit(many.map(finding))).toBe(Math.round(100 * 0.8 ** 3 * 0.93));
    const audit = runAudit(page({ metaRobots: [robots('noindex', 'googlebot')] }));
    expect(audit).toMatchObject({ score: NOINDEX_SCORE_CAP, band: 'poor', indexable: false });
    expect(audit.page.noindexFor).toEqual(['googlebot']);
    expect(runAudit(cleanSnapshot())).toMatchObject({ indexable: true });
    expect(runAudit(cleanSnapshot()).page.noindexFor).toEqual([]);
  });

  test('score-counts-each-rule-once', () => {
    const one = runAudit(page({ images: [{ src: 'a', alt: null, width: '1', height: '1', loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false }], imageTotal: 1 }));
    const fifty = runAudit(page({ images: Array.from({ length: 50 }, (_, i) => ({ src: `${i}`, alt: null, width: '1', height: '1', loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false })), imageTotal: 50 }));
    expect(fifty.score).toBe(one.score);
    expect(scoreAudit([ofSeverity('warning'), ofSeverity('warning')])).toBe(93);
  });

  test('score-is-monotonic', () => {
    const all = SEO_RULE_SPECS.map((s) => finding(s.id));
    let previous = 100;
    for (let n = 1; n <= all.length; n++) {
      const score = scoreAudit(all.slice(0, n));
      expect(score).toBeLessThanOrEqual(previous);
      expect(score).toBeGreaterThanOrEqual(0);
      previous = score;
    }
    // Order does not matter.
    expect(scoreAudit([...all].reverse())).toBe(scoreAudit(all));
  });

  test('score-bands', () => {
    expect(scoreBand(90)).toBe('good');
    expect(scoreBand(89)).toBe('fair');
    expect(scoreBand(60)).toBe('fair');
    expect(scoreBand(59)).toBe('poor');
    expect(scoreBand(0)).toBe('poor');
  });

  test('passed-counts-rules-that-ran', () => {
    // The clean fixture has no speed measurement, render-blocking count, served HTML, accessibility
    // check or site checks: those rules found nothing, but they did not run either.
    const unchecked = [...SEO_RULE_SPECS.filter((s) => s.category === 'performance' || s.category === 'accessibility' || s.category === 'javascript'), ...CHECKS_RULE_SPECS].map((s) => s.id);
    const clean = runAudit(cleanSnapshot());
    expect(clean.findings).toEqual([]);
    expect(clean.passed).toBe(SEO_RULE_SPECS.length - unchecked.length);

    // Everything collected (INP measured too) and passing: every rule ran and passed.
    const collect = (changes: Partial<PageSnapshot> = {}): PageSnapshot => {
      const rendered = page(changes);
      return {
        ...rendered,
        performance: withVitals({ inp: 80 }),
        blockingScripts: { total: 0, urls: [] },
        accessibility: { url: rendered.url, axeVersion: '4.14.0', ranAt: 1, durationMs: 420, violations: [], violationTotal: 0, passes: 40, incomplete: 0, inapplicable: 30, partial: false },
        served: { status: 'ready', fetch: { url: rendered.url, finalUrl: rendered.url, status: 200, redirects: 0, bytes: 12_000, truncated: false, contentType: 'text/html', userAgent: null, durationMs: 40 }, snapshot: servedOf(rendered) },
        checks: { links: { checked: 3, broken: [], internalRedirects: [] }, sitemaps: { files: 1, urlCount: 10, listed: true, errors: [] }, hreflang: { checked: 0, noReturn: [] } },
      };
    };
    const everything = collect();
    expect(runAudit(everything).findings).toEqual([]);
    expect(runAudit(everything).passed).toBe(SEO_RULE_SPECS.length);
    // A measurement without INP (no interaction): its two rules did not run.
    expect(runAudit({ ...everything, performance: withVitals({ inp: null }) }).passed).toBe(SEO_RULE_SPECS.length - 2);

    // Over http, with no response recorded and robots.txt still being fetched: the response, header
    // and robots.txt rules did not run, and the HSTS and mixed-content rules do not apply.
    const http = 'http://example.com/guides/seo-basics';
    const bare = runAudit(collect({ url: http, canonicals: [{ href: http, resolved: http }], ogUrl: http, response: null, robots: okRobots(undefined, { outcome: 'pending' }) }));
    const failed = bare.findings.map((f) => f.ruleId);
    expect(failed).toEqual(['https-missing']);
    const notRun: SeoRuleId[] = [
      ...(['http-status-redirect', 'http-status-client-error', 'http-status-server-error', 'http-redirect-chain'] as const),
      ...(['x-robots-noindex', 'x-robots-noindex-other-bot', 'x-robots-nofollow', 'canonical-header-conflict'] as const),
      ...(['mixed-content-active', 'mixed-content-passive', 'hsts-missing', 'hsts-short-max-age', 'csp-missing', 'csp-unsafe-inline', 'nosniff-missing', 'clickjacking-unprotected', 'referrer-policy-missing', 'referrer-policy-unsafe'] as const),
      ...(['robots-txt-blocks-googlebot', 'robots-txt-blocks-all', 'robots-txt-no-sitemap', 'robots-txt-unreachable'] as const),
    ];
    expect(bare.passed).toBe(SEO_RULE_SPECS.length - failed.length - notRun.length);
    // A meta policy and a meta referrer are read without the headers (a `navigation` response: its
    // status is known, its redirects are not).
    const metas = runAudit(collect({ response: okResponse({ source: 'navigation', headersAvailable: false, headers: [] }), security: cleanSecurity({ metaCsp: ["default-src 'self'"], metaReferrer: 'no-referrer' }) }));
    expect(metas.findings).toEqual([]);
    expect(metas.passed).toBe(SEO_RULE_SPECS.length - ['http-redirect-chain', 'x-robots-noindex', 'x-robots-noindex-other-bot', 'x-robots-nofollow', 'canonical-header-conflict', 'hsts-missing', 'hsts-short-max-age', 'nosniff-missing', 'clickjacking-unprotected'].length);

    /** The rules of `ids` that pass on `snapshot` without counting as passed. */
    const uncounted = (snapshot: PageSnapshot, ids: readonly SeoRuleId[]) => RULES.filter((rule) => ids.includes(rule.id) && rule.check(snapshot) === null && runAudit(snapshot, [rule]).passed === 0).map((rule) => rule.id);
    const responseRules: SeoRuleId[] = ['http-status-redirect', 'http-status-client-error', 'http-status-server-error', 'http-redirect-chain'];
    // `in-page`: no response for this URL, so no status; `navigation`: a status, but no redirects recorded.
    expect(uncounted(collect({ response: okResponse({ source: 'in-page', status: null, headersAvailable: false, headers: [] }) }), responseRules)).toEqual(responseRules);
    expect(uncounted(collect({ response: okResponse({ source: 'navigation', headersAvailable: false, headers: [] }) }), responseRules)).toEqual(['http-redirect-chain']);
    expect(uncounted(collect({ response: okResponse({ source: 'cache' }) }), responseRules)).toEqual([]);

    // A cut CSP header: inline scripts, framing (without X-Frame-Options) and mixed content are unknown.
    const securityRules = SEO_RULE_SPECS.filter((spec) => spec.category === 'security').map((spec) => spec.id);
    const cut = collect({
      response: okResponse({ headers: [header('content-type', 'text/html'), header('strict-transport-security', 'max-age=31536000'), header('x-content-type-options', 'nosniff'), header('referrer-policy', 'no-referrer'), { name: 'content-security-policy', value: "script-src 'self' 'unsafe-inline'", truncated: true }] }),
      security: cleanSecurity({ insecureResources: [{ kind: 'image', url: 'http://cdn.example/a.png', tag: 'img' }], insecureResourceTotal: 1 }),
    });
    expect(runAudit(cut).findings.filter((f) => f.category === 'security')).toEqual([]);
    expect(uncounted(cut, securityRules)).toEqual(['mixed-content-passive', 'csp-unsafe-inline', 'clickjacking-unprotected']);
    // X-Frame-Options does not settle it: any frame-ancestors after the cut would override it.
    expect(uncounted(collect({ response: okResponse({ headers: [...okResponse().headers.filter((h) => h.name !== 'content-security-policy'), { name: 'content-security-policy', value: "script-src 'self'", truncated: true }] }) }), securityRules)).toEqual(['csp-unsafe-inline', 'clickjacking-unprotected']);

    // Headers unknown and no meta tags: no security rule that reads the response headers counts.
    const unknownHeaders = collect({ response: okResponse({ source: 'navigation', headersAvailable: false, headers: [] }) });
    // These read the page itself (its URL and its resources), not the headers.
    const fromPage: SeoRuleId[] = ['https-missing', 'mixed-content-active', 'mixed-content-passive'];
    expect(uncounted(unknownHeaders, securityRules)).toEqual(securityRules.filter((id) => !fromPage.includes(id)));
    // An empty meta policy is no policy: nothing is known about the CSP.
    expect(uncounted(collect({ response: unknownHeaders.response, security: cleanSecurity({ metaCsp: [''] }) }), ['csp-missing'])).toEqual(['csp-missing']);
    // Without an HTML canonical the header's would be read, and the headers are unknown.
    expect(uncounted(collect({ response: unknownHeaders.response, canonicals: [], canonicalTotal: 0 }), ['canonical-elsewhere'])).toEqual(['canonical-elsewhere']);
    // A sitemap check that cannot tell whether the page is listed.
    expect(uncounted({ ...everything, checks: { ...everything.checks!, sitemaps: { files: 0, urlCount: 0, listed: null, errors: [] } } }, ['sitemap-page-not-listed'])).toEqual(['sitemap-page-not-listed']);

    // A crawl audit's subset counts its own rules.
    expect(runAudit(everything, RULES.slice(0, 5)).passed).toBe(5);
  });

  test('passed-counts-rules-that-ran (every rule is classified: needs input or always runs)', () => {
    // The rules with an input in rules/ran.ts: each counts only once its input is known.
    const needsInput: SeoRuleId[] = [
      ...(['http-status-redirect', 'http-status-client-error', 'http-status-server-error', 'http-redirect-chain'] as const),
      ...(['x-robots-noindex', 'x-robots-noindex-other-bot', 'x-robots-nofollow', 'canonical-header-conflict', 'canonical-elsewhere'] as const),
      ...(['robots-txt-blocks-googlebot', 'robots-txt-blocks-all', 'robots-txt-no-sitemap', 'robots-txt-unreachable'] as const),
      ...(['lcp-poor', 'lcp-needs-improvement', 'cls-poor', 'cls-needs-improvement', 'inp-poor', 'inp-needs-improvement', 'fcp-poor', 'fcp-needs-improvement', 'ttfb-poor', 'ttfb-needs-improvement'] as const),
      ...(['page-weight-heavy', 'request-count-high', 'dom-size-large', 'uncompressed-text-resources', 'render-blocking-scripts'] as const),
      ...(['mixed-content-active', 'mixed-content-passive', 'hsts-missing', 'hsts-short-max-age', 'csp-missing', 'csp-unsafe-inline', 'nosniff-missing', 'clickjacking-unprotected', 'referrer-policy-missing', 'referrer-policy-unsafe'] as const),
      ...(['a11y-critical', 'a11y-serious'] as const),
      ...(['js-canonical-changed', 'js-robots-changed', 'js-title-changed', 'js-content-added', 'js-links-added'] as const),
      ...(['links-broken', 'links-internal-redirect', 'sitemap-page-not-listed', 'sitemap-unreachable', 'hreflang-no-return-link'] as const),
    ];
    // The rules that read only the page itself (its HTML and URL): they always run.
    const alwaysRuns: SeoRuleId[] = [
      ...(['title-missing', 'title-empty', 'title-multiple', 'title-too-short', 'title-too-wide'] as const),
      ...(['meta-description-missing', 'meta-description-too-short', 'meta-description-too-wide', 'meta-description-multiple'] as const),
      ...(['h1-missing', 'h1-multiple', 'h1-empty', 'heading-level-skipped'] as const),
      ...(['canonical-missing', 'canonical-multiple', 'canonical-relative', 'canonical-off-host', 'canonical-og-url-mismatch', 'canonical-has-query'] as const),
      ...(['robots-noindex', 'robots-noindex-other-bot', 'robots-nofollow'] as const),
      ...(['hreflang-invalid-code', 'hreflang-missing-self', 'hreflang-no-x-default', 'hreflang-duplicate', 'hreflang-relative-url'] as const),
      ...(['lang-missing', 'viewport-missing', 'content-thin'] as const),
      ...(['images-missing-alt', 'image-alt-too-long', 'images-missing-dimensions', 'images-oversized', 'images-lazy-in-first-viewport'] as const),
      ...(['links-empty-anchor', 'links-javascript-href', 'links-nofollow', 'url-too-long', 'url-uppercase', 'url-underscores'] as const),
      ...(['og-title-missing', 'og-description-missing', 'og-image-missing', 'og-image-not-https', 'twitter-card-missing'] as const),
      ...(['schema-none', 'schema-json-invalid', 'schema-over-limit', 'schema-context-missing', 'schema-context-not-schema-org', 'schema-type-missing', 'schema-type-unknown'] as const),
      ...(['schema-required-missing', 'schema-recommended-missing', 'schema-url-not-absolute', 'schema-date-invalid', 'schema-breadcrumb-positions', 'schema-price-invalid', 'schema-entity-conflict'] as const),
      'https-missing',
    ];
    // Every catalog rule is in exactly one of the two: a new rule must say whether it needs input.
    expect([...needsInput, ...alwaysRuns].sort()).toEqual(SEO_RULE_SPECS.map((spec) => spec.id).sort());

    // Nothing collected: over http (mixed content does not apply), no response (no status or
    // headers), robots.txt still being fetched, no speed measurement, render-blocking count,
    // accessibility check, served HTML or site checks, and no HTML canonical (`canonical-elsewhere`
    // reads one without the headers). Only the rules that always run count as passed; the two that
    // find something here ran too.
    const http = 'http://example.com/guides/seo-basics';
    const empty = page({ url: http, canonicals: [], canonicalTotal: 0, ogUrl: http, response: null, robots: okRobots(undefined, { outcome: 'pending' }) });
    const found = runAudit(empty).findings.map((f) => f.ruleId);
    expect([...found].sort()).toEqual(['canonical-missing', 'https-missing']);
    const passed = RULES.filter((rule) => runAudit(empty, [rule]).passed === 1).map((rule) => rule.id);
    expect(passed.sort()).toEqual(alwaysRuns.filter((id) => !found.includes(id)).sort());
    expect(runAudit(empty).passed).toBe(alwaysRuns.length - found.length);
  });

  test('panel-status', () => {
    expect(panelStatus([finding('title-missing'), finding('h1-multiple')], ['title', 'headings'])).toBe('error');
    expect(panelStatus([finding('title-missing'), finding('h1-multiple')], ['headings'])).toBe('warn');
    expect(panelStatus([finding('url-uppercase')], ['url'])).toBe('pass');
    expect(panelStatus([], ['url'])).toBe('pass');
    expect(panelStatus([finding('title-missing')], [])).toBe('pass');
  });

  test('page-facts-summarise-links-images-and-social', () => {
    const facts = pageFacts(
      page({
        links: [
          { href: 'https://example.com/a', scheme: 'https:', rel: 'nofollow', text: 'a', kind: 'internal', target: null },
          { href: 'https://example.com/b', scheme: 'https:', rel: '', text: 'b', kind: 'internal', target: null },
          { href: 'https://other.org/', scheme: 'https:', rel: 'NoFollow noopener', text: 'c', kind: 'external', target: '_blank' },
          { href: 'javascript:void(0)', scheme: 'javascript:', rel: '', text: 'd', kind: 'other', target: null },
        ],
        linkTotal: 100_000,
        images: [
          { src: 'a', alt: null, width: null, height: null, loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false },
          { src: 'b', alt: text(''), width: null, height: null, loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false },
        ],
        imageTotal: 2,
        metaRobots: [robots('noindex'), robots('nofollow', 'googlebot')],
      }),
    );
    expect(facts.links).toEqual({ analysed: 4, total: 100_000, internal: 2, external: 1, other: 1, nofollow: 2 });
    expect(facts.images).toEqual({ analysed: 2, total: 2, missingAlt: 1 });
    // The lists themselves are the Links and Images panels' rows; the social tags the Social panel's.
    expect(facts.linkList.map((link) => link.text)).toEqual(['a', 'b', 'c', 'd']);
    expect(facts.imageList.map((image) => image.src)).toEqual(['a', 'b']);
    expect(facts.social['og:title']).toBe('SEO basics: a practical guide');
    expect(facts.robots).toBe('robots: noindex · googlebot: nofollow');
    expect(facts.noindexFor).toEqual(['robots']);
    expect(facts.title?.text).toBe('SEO basics: a practical guide for beginners');
    expect(facts.canonical).toBe('https://example.com/guides/seo-basics');
    expect(pageFacts(page({ titles: [], titleTotal: 0, metaRobots: [], canonicals: [], canonicalTotal: 0 }))).toMatchObject({ title: null, robots: null, canonical: null });
    // The description shown is the first one with text.
    expect(pageFacts(page({ metaDescriptions: [text(''), text('Second')], metaDescriptionTotal: 2 })).description?.text).toBe('Second');
  });
});
