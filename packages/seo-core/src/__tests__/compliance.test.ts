// Spec: specs/seo-compliance.spec.ts (COMPLIANCE_RULE_SPECS, HSTS_MIN_MAX_AGE_SECONDS, REFERRER_POLICIES,
// INSECURE_RESOURCE_KINDS, ACTIVE_RESOURCE_KINDS, SECURITY_VERDICTS, A11Y_SCORED_IMPACTS), specs/seo-rules.spec.ts (SEVERITY_WEIGHTS)
// Acceptance: specs/seo-compliance.feature.md (CSP, Headers, Mixed content, Rules, Accessibility scoring, Report)
import { describe, expect, test } from 'vitest';
import { ACTIVE_RESOURCE_KINDS, COMPLIANCE_RULE_SPECS, HSTS_MIN_MAX_AGE_SECONDS, INSECURE_RESOURCE_KINDS, PASSIVE_RESOURCE_KINDS } from '@app/specs/seo-compliance.spec';
import { FINDING_SAMPLE_LIMIT, SEO_RULE_SPECS, SEVERITY_WEIGHTS, type SeoRuleId } from '@app/specs/seo-rules.spec';
import type { AccessibilityResult } from '@app/specs/seo-snapshot.spec';
import {
  allowsInlineScripts,
  analyseSecurity,
  formatDuration,
  frameAncestors,
  frameAncestorsProtect,
  frameOptionsProtect,
  headerReferrerPolicy,
  scriptSources,
  isActiveKind,
  isLoopbackHost,
  isNosniff,
  metaReferrerPolicy,
  parseCsp,
  parseHsts,
  RULES,
  runAudit,
  securityVerdict,
  sourcesAllowInline,
  type FindingDetails,
  type PageSnapshot,
} from '../index';
import { cleanSecurity, cleanSnapshot, header, okResponse, page, PAGE_URL, SECURITY_HEADERS_OK } from './fixtures';

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

/** The clean page with exactly these response headers (`content-type` beside them). */
const withOnly = (...headers: ReturnType<typeof header>[]) => page({ response: okResponse({ headers: [header('content-type', 'text/html'), ...headers] }) });
/** The clean page with its security headers, `name` replaced by `value` (or dropped for `null`). */
function withSecurityHeader(name: (typeof SECURITY_HEADERS_OK)[number]['name'], value: string | null): PageSnapshot {
  const kept = SECURITY_HEADERS_OK.filter((h) => h.name !== name);
  return withOnly(...kept, ...(value === null ? [] : [header(name, value)]));
}
/** The page without response headers (a back/forward cache restore). */
const headersUnknown = (changes: Partial<PageSnapshot> = {}) => page({ response: okResponse({ source: 'navigation', headersAvailable: false, headers: [] }), ...changes });
const resource = (kind: PageSnapshot['security']['insecureResources'][number]['kind'], url: string, tag = 'img') => ({ kind, url, tag });
const withResources = (...resources: ReturnType<typeof resource>[]) => page({ security: cleanSecurity({ insecureResources: resources, insecureResourceTotal: resources.length }) });

/** A validated accessibility answer for the clean page (`changes` override). */
function a11yResult(changes: Partial<AccessibilityResult> = {}): AccessibilityResult {
  return { url: PAGE_URL, axeVersion: '4.14.0', ranAt: 1_760_000_100_000, durationMs: 420, violations: [], violationTotal: 0, passes: 40, incomplete: 2, inapplicable: 30, partial: false, ...changes };
}
const violation = (id: string, impact: AccessibilityResult['violations'][number]['impact'], nodeTotal = 1): AccessibilityResult['violations'][number] => ({
  id,
  impact,
  help: `Help for ${id}`,
  description: `About ${id}`,
  helpUrl: `https://help.example/rules/${id}`,
  tags: ['wcag2a'],
  nodes: Array.from({ length: Math.min(nodeTotal, 10) }, (_, i) => ({ selector: `#n${i}`, summary: 'Fix any of the following: …' })),
  nodeTotal,
});

describe('catalog', () => {
  test('compliance-rules-in-catalog', () => {
    const ids = SEO_RULE_SPECS.map((spec) => spec.id);
    for (const spec of COMPLIANCE_RULE_SPECS) {
      expect(ids).toContain(spec.id);
      expect(['security', 'accessibility']).toContain(spec.category);
    }
    // The clean page passes every one of them (its headers are the well-configured site's).
    for (const spec of COMPLIANCE_RULE_SPECS) passes(spec.id, cleanSnapshot());
  });
});

describe('CSP', () => {
  test('csp-parser-reads-policies', () => {
    const [policy] = parseCsp("default-src 'self'; Script-Src 'self' https://cdn.example  'unsafe-inline' ;img-src *; script-src 'none'", 'header');
    expect(policy!.directives.map((d) => d.name)).toEqual(['default-src', 'script-src', 'img-src']);
    // First occurrence wins; tokens as written.
    expect(policy!.directives[1]!.sources).toEqual(["'self'", 'https://cdn.example', "'unsafe-inline'"]);
    // A comma separates policies; empty ones are dropped; junk names are skipped.
    expect(parseCsp("default-src 'self', script-src 'none',, ", 'header')).toHaveLength(2);
    expect(parseCsp('b@d x; img-src *', 'header')[0]!.directives.map((d) => d.name)).toEqual(['img-src']);
    expect(parseCsp('', 'header')).toEqual([]);
    // A meta policy cannot set frame-ancestors, report-uri or sandbox.
    expect(parseCsp("frame-ancestors 'none'; sandbox; report-uri /r; script-src 'self'", 'meta')[0]!.directives.map((d) => d.name)).toEqual(['script-src']);
    // Linear on a hostile value.
    const started = performance.now();
    parseCsp(`${'a '.repeat(50_000)};${';'.repeat(50_000)}${','.repeat(50_000)}`, 'header');
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('csp-inline-scripts', () => {
    expect(sourcesAllowInline(["'self'", "'unsafe-inline'"])).toBe(true);
    expect(sourcesAllowInline(["'self'", "'UNSAFE-INLINE'"])).toBe(true);
    // A nonce, a hash or strict-dynamic makes browsers ignore 'unsafe-inline'.
    for (const override of ["'nonce-abc'", "'sha256-xyz'", "'sha384-xyz'", "'sha512-xyz'", "'strict-dynamic'"]) expect(sourcesAllowInline(["'unsafe-inline'", override]), override).toBe(false);
    expect(sourcesAllowInline(["'self'"])).toBe(false);
    // Every policy must allow them; a policy without a script directive does not restrict scripts.
    expect(allowsInlineScripts(parseCsp("script-src 'unsafe-inline'", 'header'))).toBe(true);
    expect(allowsInlineScripts(parseCsp("default-src 'self' 'unsafe-inline'", 'header'))).toBe(true);
    expect(allowsInlineScripts(parseCsp("default-src 'unsafe-inline'; script-src 'self'", 'header'))).toBe(false);
    expect(allowsInlineScripts([...parseCsp("script-src 'unsafe-inline'", 'header'), ...parseCsp("script-src 'self'", 'meta')])).toBe(false);
    expect(allowsInlineScripts([...parseCsp("script-src 'unsafe-inline'", 'header'), ...parseCsp('img-src *', 'header')])).toBe(true);
    expect(allowsInlineScripts(parseCsp('img-src *', 'header'))).toBe(false);
    expect(allowsInlineScripts([])).toBe(false);
  });

  test('frame-ancestors-open-sources', () => {
    expect(frameAncestorsProtect(["'none'"])).toBe(true);
    expect(frameAncestorsProtect(["'self'", 'https://partner.example'])).toBe(true);
    expect(frameAncestorsProtect(['https://*.example.com'])).toBe(true);
    for (const open of [['*'], ['https:'], ['HTTP:'], ["'self'", 'https:'], ['https://*'], ['*://*'], []]) expect(frameAncestorsProtect(open), open.join(' ')).toBe(false);
    // In the page: an open frame-ancestors is clickjacking-unprotected (without X-Frame-Options).
    fails('clickjacking-unprotected', withOnly(header('content-security-policy', 'frame-ancestors https:')));
    fails('clickjacking-unprotected', withOnly(header('content-security-policy', 'frame-ancestors *')));
    passes('clickjacking-unprotected', withOnly(header('content-security-policy', "frame-ancestors 'self' https://partner.example")));
  });

  test('csp-script-src-elem-precedence', () => {
    const [policy] = parseCsp("default-src 'unsafe-inline'; script-src 'unsafe-inline'; script-src-elem 'self'", 'header');
    expect(scriptSources(policy!)).toEqual(["'self'"]);
    expect(allowsInlineScripts(parseCsp("default-src 'self'; script-src-elem 'self' 'unsafe-inline'", 'header'))).toBe(true);
    expect(allowsInlineScripts(parseCsp("script-src 'unsafe-inline'; script-src-elem 'self'", 'header'))).toBe(false);
    fails('csp-unsafe-inline', withSecurityHeader('content-security-policy', "default-src 'self'; script-src-elem 'unsafe-inline'; frame-ancestors 'self'"));
    passes('csp-unsafe-inline', withSecurityHeader('content-security-policy', "script-src 'unsafe-inline'; script-src-elem 'self'; frame-ancestors 'self'"));
  });

  test('csp-cut-is-unknown', () => {
    const cut = (value: string, ...others: ReturnType<typeof header>[]) => withOnly(...others, { name: 'content-security-policy', value, truncated: true });
    // Inline scripts: the rest of the policy could hold a nonce.
    passes('csp-unsafe-inline', cut("script-src 'self' 'unsafe-inline'", header('x-frame-options', 'DENY')));
    // frame-ancestors could come later in the cut policy.
    passes('clickjacking-unprotected', cut("script-src 'self'"));
    // upgrade-insecure-requests could come later: mixed content is unknown, not failing.
    const mixed = page({ ...cut("script-src 'self'"), security: cleanSecurity({ insecureResources: [resource('script', 'http://cdn.example/a.js', 'script'), resource('image', 'http://cdn.example/a.png')], insecureResourceTotal: 2 }) });
    passes('mixed-content-active', mixed);
    passes('mixed-content-passive', mixed);
    expect(analyseSecurity(mixed).cspCut).toBe(true);
    // A CSP header was sent: it is not missing.
    passes('csp-missing', cut("script-src 'self'"));
    // Found before the cut, what is there still counts.
    const found = page({ ...cut("frame-ancestors 'none'; upgrade-insecure-requests; script-src"), security: mixed.security });
    expect(analyseSecurity(found)).toMatchObject({ frameAncestors: true, upgradeInsecure: true });
    // The CSP row says it was cut.
    const row = runAudit(cut("script-src 'self'")).compliance.security.headers.find((h) => h.name === 'content-security-policy')!;
    expect(row).toMatchObject({ state: 'unknown' });
    expect(row.note).toMatch(/cut/i);
  });

  test('frame-ancestors-overrides-frame-options', () => {
    const rows = (snapshot: PageSnapshot) => Object.fromEntries(runAudit(snapshot).compliance.security.headers.map((row) => [row.name, row]));
    // An open frame-ancestors is still enforced: browsers ignore the X-Frame-Options beside it.
    const open = withOnly(header('content-security-policy', 'frame-ancestors *'), header('x-frame-options', 'DENY'));
    expect(analyseSecurity(open)).toMatchObject({ frameAncestorsSet: true, frameAncestors: false, frameOptionsProtect: false });
    const result = fails('clickjacking-unprotected', open);
    expect(factOf(result, 'frame-ancestors')).toBe('*');
    expect(factOf(result, 'X-Frame-Options')).toMatch(/DENY.*overridden/i);
    const openRows = rows(open);
    expect(openRows['x-frame-options']).toMatchObject({ state: 'weak', values: ['DENY'] });
    expect(openRows['x-frame-options']!.note).toMatch(/overridden by CSP frame-ancestors/i);
    expect(openRows['content-security-policy']!.note).toMatch(/frame-ancestors allows framing/i);
    // A restricting frame-ancestors overrides it too, and protects.
    const strict = withOnly(header('content-security-policy', "frame-ancestors 'self'"), header('x-frame-options', 'ALLOWALL'));
    expect(analyseSecurity(strict)).toMatchObject({ frameAncestorsSet: true, frameAncestors: true, frameOptionsProtect: false });
    passes('clickjacking-unprotected', strict);
    expect(rows(strict)['x-frame-options']).toMatchObject({ state: 'good' });
    expect(rows(strict)['x-frame-options']!.note).toMatch(/overridden by CSP frame-ancestors/i);
    // A policy without frame-ancestors, or a meta one (it cannot set it), leaves X-Frame-Options in effect.
    const noDirective = withOnly(header('content-security-policy', "script-src 'self'"), header('x-frame-options', 'DENY'));
    expect(analyseSecurity(noDirective)).toMatchObject({ frameAncestorsSet: false, frameOptionsProtect: true });
    passes('clickjacking-unprotected', noDirective);
    expect(rows(noDirective)['x-frame-options']).toMatchObject({ state: 'good', note: null });
    const meta = page({ ...withOnly(header('x-frame-options', 'DENY')), security: cleanSecurity({ metaCsp: ['frame-ancestors *'] }) });
    expect(analyseSecurity(meta)).toMatchObject({ frameAncestorsSet: false, frameOptionsProtect: true });
    passes('clickjacking-unprotected', meta);
  });

  test('csp-frame-ancestors-header-only', () => {
    expect(frameAncestors(parseCsp("frame-ancestors 'self'", 'header'))).toEqual([["'self'"]]);
    expect(frameAncestors(parseCsp("frame-ancestors 'self'", 'meta'))).toEqual([]);
    expect(frameAncestors(parseCsp("default-src 'self'", 'header'))).toEqual([]);
  });
});

describe('headers', () => {
  test('hsts-parser', () => {
    expect(parseHsts('max-age=31536000; includeSubDomains; preload')).toEqual({ maxAge: 31_536_000, includeSubDomains: true, preload: true });
    expect(parseHsts('MAX-AGE="600"')).toEqual({ maxAge: 600, includeSubDomains: false, preload: false });
    expect(parseHsts(' max-age = 0 ; ')).toEqual({ maxAge: 0, includeSubDomains: false, preload: false });
    // Browsers ignore these.
    for (const bad of ['', 'includeSubDomains', 'max-age=abc', 'max-age=-1', 'max-age=1; max-age=2', 'max-age=1; preload; preload', 'max-age=']) expect(parseHsts(bad), bad).toBeNull();
    expect(parseHsts(`max-age=${'9'.repeat(400)}`)!.maxAge).toBe(Number.MAX_SAFE_INTEGER);
    expect(formatDuration(31_536_000)).toBe('1 year');
    expect(formatDuration(86_400 * 30)).toBe('30 days');
    expect(formatDuration(3_600)).toBe('1 hour');
    expect(formatDuration(5)).toBe('5 seconds');
  });

  test('frame-options-and-nosniff', () => {
    expect(isNosniff(['nosniff'])).toBe(true);
    expect(isNosniff([' NoSniff, other'])).toBe(true);
    expect(isNosniff(['sniff'])).toBe(false);
    expect(isNosniff([])).toBe(false);
  });

  test('frame-options-html-algorithm', () => {
    // One value: DENY or SAMEORIGIN block framing (case and spaces aside); repeats are one value.
    expect(frameOptionsProtect(['DENY'])).toBe(true);
    expect(frameOptionsProtect([' sameorigin '])).toBe(true);
    expect(frameOptionsProtect(['SAMEORIGIN, SAMEORIGIN'])).toBe(true);
    // ALLOWALL, obsolete ALLOW-FROM and unknown values allow it; so does nothing.
    expect(frameOptionsProtect(['ALLOWALL'])).toBe(false);
    expect(frameOptionsProtect(['ALLOW-FROM https://example.com'])).toBe(false);
    expect(frameOptionsProtect(['bogus'])).toBe(false);
    expect(frameOptionsProtect([])).toBe(false);
    expect(frameOptionsProtect([' , '])).toBe(false);
    // Several distinct values block if one of them is DENY, SAMEORIGIN or ALLOWALL; else they are ignored.
    expect(frameOptionsProtect(['DENY', 'SAMEORIGIN'])).toBe(true);
    expect(frameOptionsProtect(['SAMEORIGIN, ALLOWALL'])).toBe(true);
    expect(frameOptionsProtect(['ALLOWALL', 'bogus'])).toBe(true);
    expect(frameOptionsProtect(['bogus', 'other'])).toBe(false);
  });

  test('referrer-policy-reading', () => {
    // The last known token wins, across values.
    expect(headerReferrerPolicy(['no-referrer, strict-origin-when-cross-origin'])).toBe('strict-origin-when-cross-origin');
    expect(headerReferrerPolicy(['unsafe-url', 'bogus'])).toBe('unsafe-url');
    expect(headerReferrerPolicy(['bogus'])).toBeNull();
    expect(headerReferrerPolicy([])).toBeNull();
    // Meta: known values and the legacy ones; others are not a policy.
    expect(metaReferrerPolicy(' Same-Origin ')).toBe('same-origin');
    expect(metaReferrerPolicy('always')).toBe('unsafe-url');
    expect(metaReferrerPolicy('never')).toBe('no-referrer');
    expect(metaReferrerPolicy('__proto__')).toBeNull();
    expect(metaReferrerPolicy('constructor')).toBeNull();
    expect(metaReferrerPolicy(null)).toBeNull();
  });
});

describe('mixed content', () => {
  test('mixed-content-classification', () => {
    expect(INSECURE_RESOURCE_KINDS.filter(isActiveKind)).toEqual([...ACTIVE_RESOURCE_KINDS]);
    expect(INSECURE_RESOURCE_KINDS.filter((kind) => !isActiveKind(kind))).toEqual([...PASSIVE_RESOURCE_KINDS]);
    const facts = analyseSecurity(withResources(resource('script', 'http://cdn.example/a.js', 'script'), resource('image', 'http://cdn.example/a.png'), resource('frame', 'http://x.example/', 'iframe'), resource('media', 'http://x.example/v.mp4', 'video')));
    expect(facts.mixed.active.map((r) => r.kind)).toEqual(['script', 'frame']);
    expect(facts.mixed.passive.map((r) => r.kind)).toEqual(['image', 'media']);
    expect(facts.mixed.total).toBe(4);
    // An http page has no mixed content to speak of.
    const http = page({ url: 'http://example.com/', security: cleanSecurity({ insecureResources: [resource('script', 'http://cdn.example/a.js', 'script')], insecureResourceTotal: 1 }) });
    expect(analyseSecurity(http).mixed).toEqual({ active: [], passive: [], upgraded: [], upgradeUnknown: false, total: 0, truncated: false });
  });

  test('mixed-content-upgraded-by-csp', () => {
    const resources = [resource('script', 'http://cdn.example/a.js', 'script'), resource('image', 'http://cdn.example/a.png')];
    const upgradedBy = (csp: ReturnType<typeof header>[], metaCsp: string[] = []) => page({ response: okResponse({ headers: [header('content-type', 'text/html'), ...csp] }), security: cleanSecurity({ insecureResources: resources, insecureResourceTotal: 2, metaCsp }) });
    for (const snapshot of [upgradedBy([header('content-security-policy', "upgrade-insecure-requests; default-src 'self'")]), upgradedBy([], ['upgrade-insecure-requests'])]) {
      passes('mixed-content-active', snapshot);
      passes('mixed-content-passive', snapshot);
      const facts = analyseSecurity(snapshot);
      expect(facts.upgradeInsecure).toBe(true);
      expect(facts.mixed).toMatchObject({ active: [], passive: [], upgraded: resources, total: 2 });
      expect(runAudit(snapshot).compliance.security.verdict).not.toBe('insecure');
    }
    // A report-only policy enforces nothing.
    const reportOnly = upgradedBy([header('content-security-policy-report-only', 'upgrade-insecure-requests')]);
    fails('mixed-content-active', reportOnly);
    expect(analyseSecurity(reportOnly).mixed.upgraded).toEqual([]);
  });

  test('loopback-hosts', () => {
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.255.0.9', '[::1]', 'localhost.']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['example.com', 'localhost.example.com', '128.0.0.1', '127.0.0.256', '127.1', '10.0.0.1', '[::2]']) expect(isLoopbackHost(host), host).toBe(false);
  });
});

describe('security rules', () => {
  test('https-missing', () => {
    const result = fails('https-missing', page({ url: 'http://example.com/guides/seo-basics' }));
    expect(factOf(result, 'Scheme')).toBe('http');
    passes('https-missing', cleanSnapshot());
    // This computer: browsers treat it as secure.
    passes('https-missing', page({ url: 'http://127.0.0.1:8080/' }));
    passes('https-missing', page({ url: 'http://localhost:3000/' }));
  });

  test('mixed-content-active', () => {
    const result = fails('mixed-content-active', withResources(resource('script', 'http://cdn.example/a.js', 'script'), resource('stylesheet', 'http://cdn.example/a.css', 'link'), resource('image', 'http://cdn.example/a.png')));
    expect(result.count).toBe(2);
    expect(result.samples).toEqual(['Script (<script>): http://cdn.example/a.js', 'Stylesheet (<link>): http://cdn.example/a.css']);
    expect(factOf(result, 'Kinds')).toBe('Script, Stylesheet');
    passes('mixed-content-active', withResources(resource('image', 'http://cdn.example/a.png')));
    passes('mixed-content-active', cleanSnapshot());
    // A truncated scan says so.
    const truncated = page({ security: cleanSecurity({ insecureResources: [resource('font', 'http://f.example/a.woff2', 'link')], insecureResourceTotal: 1, resourcesTruncated: true }) });
    expect(factOf(fails('mixed-content-active', truncated), 'Scan')).toMatch(/Stopped early/);
  });

  test('mixed-content-passive', () => {
    const result = fails('mixed-content-passive', withResources(resource('image', 'http://cdn.example/a.png'), resource('media', 'http://cdn.example/a.mp4', 'video')));
    expect(result.count).toBe(2);
    passes('mixed-content-passive', withResources(resource('script', 'http://cdn.example/a.js', 'script')));
    passes('mixed-content-passive', cleanSnapshot());
  });

  test('hsts-missing', () => {
    expect(factOf(fails('hsts-missing', withSecurityHeader('strict-transport-security', null)), 'Strict-Transport-Security')).toBe('Not sent');
    expect(factOf(fails('hsts-missing', withSecurityHeader('strict-transport-security', 'includeSubDomains')), 'Strict-Transport-Security')).toBe('includeSubDomains (not valid)');
    fails('hsts-missing', withSecurityHeader('strict-transport-security', 'max-age=0'));
    passes('hsts-missing', cleanSnapshot());
    // Not on an http page (browsers ignore HSTS there), and not when the headers are unknown.
    passes('hsts-missing', page({ url: 'http://example.com/', response: okResponse({ headers: [] }) }));
    passes('hsts-missing', headersUnknown());
  });

  test('hsts-short-max-age', () => {
    const result = fails('hsts-short-max-age', withSecurityHeader('strict-transport-security', 'max-age=86400'));
    expect(factOf(result, 'max-age')).toBe('86,400 seconds (1 day)');
    passes('hsts-short-max-age', withSecurityHeader('strict-transport-security', `max-age=${HSTS_MIN_MAX_AGE_SECONDS}`));
    fails('hsts-short-max-age', withSecurityHeader('strict-transport-security', `max-age=${HSTS_MIN_MAX_AGE_SECONDS - 1}`));
    // max-age=0 is "no HSTS" (hsts-missing), not a short one.
    passes('hsts-short-max-age', withSecurityHeader('strict-transport-security', 'max-age=0'));
    passes('hsts-short-max-age', cleanSnapshot());
  });

  test('csp-missing', () => {
    fails('csp-missing', withSecurityHeader('content-security-policy', null));
    passes('csp-missing', cleanSnapshot());
    // A meta policy counts; unknown headers without one are not a failure.
    passes('csp-missing', page({ ...withSecurityHeader('content-security-policy', null), security: cleanSecurity({ metaCsp: ["script-src 'self'"] }) }));
    passes('csp-missing', headersUnknown());
    passes('csp-missing', headersUnknown({ security: cleanSecurity({ metaCsp: ["default-src 'self'"] }) }));
  });

  test('csp-unsafe-inline', () => {
    const result = fails('csp-unsafe-inline', withSecurityHeader('content-security-policy', "script-src 'self' 'unsafe-inline'"));
    expect(result.samples).toEqual(["'self' 'unsafe-inline'"]);
    passes('csp-unsafe-inline', withSecurityHeader('content-security-policy', "script-src 'self' 'unsafe-inline' 'nonce-r4nd0m'"));
    // Two policies are both enforced: one that blocks inline scripts is enough.
    passes('csp-unsafe-inline', withOnly(header('content-security-policy', "script-src 'unsafe-inline'"), header('content-security-policy', "script-src 'self'")));
    // From a meta policy too (headers unknown).
    fails('csp-unsafe-inline', headersUnknown({ security: cleanSecurity({ metaCsp: ["default-src 'self' 'unsafe-inline'"] }) }));
    passes('csp-unsafe-inline', cleanSnapshot());
  });

  test('nosniff-missing', () => {
    expect(factOf(fails('nosniff-missing', withSecurityHeader('x-content-type-options', null)), 'X-Content-Type-Options')).toBe('Not sent');
    expect(factOf(fails('nosniff-missing', withSecurityHeader('x-content-type-options', 'sniff')), 'X-Content-Type-Options')).toBe('sniff');
    passes('nosniff-missing', cleanSnapshot());
    passes('nosniff-missing', headersUnknown());
  });

  test('clickjacking-unprotected', () => {
    const neither = withOnly(...SECURITY_HEADERS_OK.filter((h) => h.name !== 'x-frame-options' && h.name !== 'content-security-policy'), header('content-security-policy', "default-src 'self'"));
    fails('clickjacking-unprotected', neither);
    fails('clickjacking-unprotected', withOnly(header('x-frame-options', 'ALLOW-FROM https://example.com')));
    // Either protects.
    passes('clickjacking-unprotected', withOnly(header('x-frame-options', 'DENY')));
    passes('clickjacking-unprotected', withOnly(header('content-security-policy', "frame-ancestors 'none'")));
    // frame-ancestors in a meta policy does not count.
    fails('clickjacking-unprotected', page({ ...withOnly(), security: cleanSecurity({ metaCsp: ["frame-ancestors 'none'"] }) }));
    passes('clickjacking-unprotected', headersUnknown());
    passes('clickjacking-unprotected', cleanSnapshot());
  });

  test('referrer-policy-missing', () => {
    fails('referrer-policy-missing', withSecurityHeader('referrer-policy', null));
    expect(factOf(fails('referrer-policy-missing', withSecurityHeader('referrer-policy', 'bogus')), 'Referrer-Policy')).toBe('bogus (no known value)');
    // A meta tag sets it too; with headers unknown and no meta, nothing is known.
    passes('referrer-policy-missing', page({ ...withSecurityHeader('referrer-policy', null), security: cleanSecurity({ metaReferrer: 'origin' }) }));
    passes('referrer-policy-missing', headersUnknown());
    fails('referrer-policy-missing', headersUnknown({ security: cleanSecurity({ metaReferrer: 'bogus' }) }));
    passes('referrer-policy-missing', cleanSnapshot());
  });

  test('referrer-policy-unsafe', () => {
    expect(factOf(fails('referrer-policy-unsafe', withSecurityHeader('referrer-policy', 'unsafe-url')), 'Policy')).toBe('unsafe-url');
    fails('referrer-policy-unsafe', withSecurityHeader('referrer-policy', 'no-referrer-when-downgrade'));
    // The last known value wins; a meta tag takes precedence over the header.
    passes('referrer-policy-unsafe', withSecurityHeader('referrer-policy', 'unsafe-url, same-origin'));
    passes('referrer-policy-unsafe', page({ ...withSecurityHeader('referrer-policy', 'unsafe-url'), security: cleanSecurity({ metaReferrer: 'no-referrer' }) }));
    expect(factOf(fails('referrer-policy-unsafe', page({ security: cleanSecurity({ metaReferrer: 'always' }) })), 'Set by')).toBe('<meta name="referrer">');
    passes('referrer-policy-unsafe', cleanSnapshot());
  });
});

describe('accessibility rules', () => {
  test('a11y-critical', () => {
    const result = fails('a11y-critical', page({ accessibility: a11yResult({ violations: [violation('image-alt', 'critical', 3), violation('label', 'critical', 12)], violationTotal: 2 }) }));
    expect(factOf(result, 'Rules')).toBe('2');
    expect(factOf(result, 'Elements')).toBe('15');
    // Most elements first.
    expect(result.samples[0]).toBe('label: Help for label (12)');
    passes('a11y-critical', page({ accessibility: a11yResult({ violations: [violation('color-contrast', 'serious')], violationTotal: 1 }) }));
    passes('a11y-critical', cleanSnapshot());
  });

  test('a11y-serious', () => {
    fails('a11y-serious', page({ accessibility: a11yResult({ violations: [violation('color-contrast', 'serious', 4)], violationTotal: 1 }) }));
    passes('a11y-serious', page({ accessibility: a11yResult({ violations: [violation('image-alt', 'critical')], violationTotal: 1 }) }));
    passes('a11y-serious', cleanSnapshot());
  });

  test('a11y-only-scored-once-run', () => {
    const clean = runAudit(cleanSnapshot());
    expect(clean.score).toBe(100);
    expect(clean.compliance.accessibility).toEqual({ status: 'not-run' });
    // Moderate and minor violations are shown, never scored.
    const mild = runAudit(page({ accessibility: a11yResult({ violations: [violation('heading-order', 'moderate'), violation('meta-viewport-large', 'minor')], violationTotal: 2 }) }));
    expect(mild.score).toBe(100);
    expect(mild.compliance.accessibility.status).toBe('done');
    // Critical and serious count once each, as warnings, however many rules and elements.
    const bad = runAudit(page({ accessibility: a11yResult({ violations: [violation('image-alt', 'critical', 40), violation('label', 'critical', 9), violation('color-contrast', 'serious', 80)], violationTotal: 3 }) }));
    expect(bad.score).toBe(Math.round(100 * (1 - SEVERITY_WEIGHTS.warning) ** 2));
    // An answer for another URL (the page moved on) is not this page's: not run.
    const other = runAudit(page({ accessibility: a11yResult({ url: 'https://example.com/other', violations: [violation('image-alt', 'critical')], violationTotal: 1 }) }));
    expect(other.compliance.accessibility).toEqual({ status: 'not-run' });
    expect(other.score).toBe(100);
    // The fragment does not matter.
    expect(runAudit(page({ accessibility: a11yResult({ url: `${PAGE_URL}#top` }) })).compliance.accessibility.status).toBe('done');
    // An answer the worker rejected: shown as invalid, not scored.
    const invalid = runAudit(page({ accessibility: 'invalid' }));
    expect(invalid.compliance.accessibility).toEqual({ status: 'invalid' });
    expect(invalid.score).toBe(100);
  });

  test('a11y-report-groups-by-impact', () => {
    const report = runAudit(
      page({ accessibility: a11yResult({ violations: [violation('a', 'minor'), violation('b', 'critical', 2), violation('c', 'critical', 5), violation('d', 'serious')], violationTotal: 9, passes: 41 }) }),
    ).compliance.accessibility;
    if (report.status !== 'done') throw new Error('not done');
    expect(report.groups.map((g) => [g.impact, g.rules.map((r) => r.id), g.nodeTotal])).toEqual([
      ['critical', ['c', 'b'], 7],
      ['serious', ['d'], 1],
      ['moderate', [], 0],
      ['minor', ['a'], 1],
    ]);
    expect(report).toMatchObject({ truncated: true, violationTotal: 9, passes: 41, incomplete: 2, inapplicable: 30, axeVersion: '4.14.0' });
  });
});

describe('security report', () => {
  test('security-verdicts', () => {
    expect(securityVerdict({ https: true, loopback: false }, [])).toBe('secure');
    expect(securityVerdict({ https: true, loopback: false }, ['info', 'info'])).toBe('secure');
    expect(securityVerdict({ https: true, loopback: false }, ['warning', 'info'])).toBe('attention');
    expect(securityVerdict({ https: true, loopback: false }, ['error', 'warning'])).toBe('insecure');
    expect(securityVerdict({ https: false, loopback: true }, ['info'])).toBe('local');
    // Local only while nothing above info fails.
    expect(securityVerdict({ https: false, loopback: true }, ['warning'])).toBe('attention');
    expect(runAudit(page({ url: 'http://127.0.0.1:8080/', response: okResponse({ url: 'http://127.0.0.1:8080/', headers: [header('referrer-policy', 'unsafe-url')] }) })).compliance.security.verdict).toBe('attention');
    expect(runAudit(cleanSnapshot()).compliance.security.verdict).toBe('secure');
    expect(runAudit(page({ url: 'http://example.com/' })).compliance.security.verdict).toBe('insecure');
    expect(runAudit(withResources(resource('image', 'http://a.example/i.png'))).compliance.security.verdict).toBe('attention');
    // Only security rules decide it (an SEO error elsewhere does not).
    expect(runAudit(page({ titles: [], titleTotal: 0 })).compliance.security.verdict).toBe('secure');
  });

  test('security-header-rows', () => {
    const rows = (snapshot: PageSnapshot) => Object.fromEntries(runAudit(snapshot).compliance.security.headers.map((row) => [row.name, row]));
    const clean = rows(cleanSnapshot());
    expect(Object.keys(clean)).toEqual(['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']);
    expect(clean['strict-transport-security']).toMatchObject({ state: 'good', values: ['max-age=31536000; includeSubDomains'], note: 'max-age 1 year · includeSubDomains' });
    expect(clean['content-security-policy']).toMatchObject({ state: 'good', note: 'Restricts scripts · frame-ancestors set' });
    expect(clean['permissions-policy']).toMatchObject({ state: 'missing', values: [] });
    // The referrer row says which policy is in effect only when the value does not already.
    expect(clean['referrer-policy']).toMatchObject({ state: 'good', note: null });
    expect(rows(withSecurityHeader('referrer-policy', 'no-referrer, unsafe-url'))['referrer-policy']).toMatchObject({ state: 'weak', note: 'In effect: unsafe-url' });
    expect(rows(page({ security: cleanSecurity({ metaReferrer: 'no-referrer' }) }))['referrer-policy']!.note).toBe('In effect: no-referrer (set by a meta tag)');
    // Weak values.
    const weak = rows(withOnly(header('strict-transport-security', 'max-age=60'), header('content-security-policy', "script-src 'unsafe-inline'"), header('x-content-type-options', 'sniff'), header('x-frame-options', 'ALLOWALL'), header('referrer-policy', 'unsafe-url')));
    for (const name of ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy']) expect(weak[name]!.state, name).toBe('weak');
    // Unknown headers: every row unknown (never missing), a meta tag still counts.
    const unknown = rows(headersUnknown({ security: cleanSecurity({ metaReferrer: 'same-origin' }) }));
    expect(unknown['content-security-policy']!.state).toBe('unknown');
    expect(unknown['x-frame-options']!.state).toBe('unknown');
    expect(unknown['referrer-policy']).toMatchObject({ state: 'good', fromMeta: true, values: ['same-origin'] });
    // frame-ancestors protects: X-Frame-Options is not called weak, whatever it says.
    const superseded = rows(withOnly(header('content-security-policy', "frame-ancestors 'self'"), header('x-frame-options', 'ALLOWALL')));
    expect(superseded['x-frame-options']).toMatchObject({ state: 'good' });
    expect(superseded['x-frame-options']!.note).toMatch(/frame-ancestors/);
    // HSTS on an http page does not apply.
    expect(rows(page({ url: 'http://example.com/' }))['strict-transport-security']!.state).toBe('not-applicable');
    // No response recorded at all: unknown too.
    expect(rows(page({ response: null }))['x-content-type-options']!.state).toBe('unknown');
  });
});
