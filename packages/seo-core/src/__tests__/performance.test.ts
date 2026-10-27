// Spec: specs/seo-speed.spec.ts (VITAL_THRESHOLDS, PERFORMANCE_RULE_SPECS, RESOURCE_TYPES, the rule thresholds),
// specs/seo-speed.schema.spec.ts (PerformanceMeasurement, BlockingScripts)
// Acceptance: specs/seo-speed.feature.md (Bands, Rules, Summary)
import { describe, expect, test } from 'vitest';
import { FINDING_SAMPLE_LIMIT, SEO_RULE_SPECS, SEVERITY_WEIGHTS } from '@app/specs/seo-rules.spec';
import {
  DOM_ELEMENTS_WARN,
  PAGE_WEIGHT_WARN_BYTES,
  PERFORMANCE_RULE_SPECS,
  LOW_RESOURCES_MIN_HINTS,
  MULTI_PART_SUFFIXES,
  REQUEST_COUNT_WARN,
  RESOURCE_TYPES,
  THIRD_PARTY_RULE,
  SPEED_PANEL_LIMITS,
  UNCOMPRESSED_MIN_BYTES,
  VITAL_METRICS,
  VITAL_THRESHOLDS,
  type PerformanceRuleId,
} from '@app/specs/seo-speed.spec';
import { panelStatus, RULES, runAudit, summariseSpeed, vitalBand, speedReport, resourceType, isThirdParty, registrableDomain, isUncompressedText, formatBytes, formatMs, formatCls, navigationReport, type FindingDetails, type PageSnapshot } from '../index';
import { cleanSnapshot, page, PAGE_URL } from './fixtures';
import { measurement, navigation, resource, withVitals } from './performance-fixtures';

function rule(id: PerformanceRuleId) {
  const found = RULES.find((r) => r.id === id);
  if (!found) throw new Error(`no rule ${id}`);
  return found;
}
const measured = (m = measurement(), changes: Partial<PageSnapshot> = {}): PageSnapshot => ({ ...cleanSnapshot(), performance: m, ...changes });
function fails(id: PerformanceRuleId, snapshot: PageSnapshot): FindingDetails {
  const result = rule(id).check(snapshot);
  expect(result, `${id} should fail`).not.toBeNull();
  expect(result!.samples.length).toBeLessThanOrEqual(FINDING_SAMPLE_LIMIT);
  return result!;
}
function passes(id: PerformanceRuleId, snapshot: PageSnapshot): void {
  expect(rule(id).check(snapshot), `${id} should pass`).toBeNull();
}
const fact = (result: FindingDetails, label: string) => result.facts.find((f) => f.label === label)?.value;

describe('catalog', () => {
  test('performance-rules-in-catalog', () => {
    // Every performance rule is in the catalog, category `performance`, in the spec's order.
    const ids = SEO_RULE_SPECS.filter((spec) => spec.category === 'performance').map((spec) => spec.id);
    expect(ids).toEqual(PERFORMANCE_RULE_SPECS.map((spec) => spec.id));
    expect(ids).toHaveLength(15);
    for (const metric of VITAL_METRICS) {
      expect(PERFORMANCE_RULE_SPECS.find((s) => s.id === `${metric}-poor`)?.severity).toBe('warning');
      expect(PERFORMANCE_RULE_SPECS.find((s) => s.id === `${metric}-needs-improvement`)?.severity).toBe('info');
    }
    // The lab caveat is part of every measured rule's condition.
    for (const spec of PERFORMANCE_RULE_SPECS.filter((s) => s.id.endsWith('-poor') || s.id.endsWith('-needs-improvement'))) expect(spec.condition).toMatch(/lab data/);
  });

  test('clean-measurement-passes-every-performance-rule', () => {
    const audit = runAudit(measured());
    expect(audit.findings.filter((f) => f.category === 'performance')).toEqual([]);
    expect(audit.performance?.findings).toEqual([]);
    expect(audit.score).toBe(100);
  });

  test('no-measurement-passes-and-reports-none', () => {
    const audit = runAudit(cleanSnapshot());
    expect(audit.performance).toBeNull();
    expect(audit.findings.filter((f) => f.category === 'performance')).toEqual([]);
    expect(runAudit({ ...cleanSnapshot(), performance: null }).performance).toBeNull();
  });
});

describe('bands', () => {
  test('vital-bands-follow-the-thresholds', () => {
    for (const metric of VITAL_METRICS) {
      const { good, poor } = VITAL_THRESHOLDS[metric];
      expect(vitalBand(metric, 0)).toBe('good');
      expect(vitalBand(metric, good)).toBe('good');
      expect(vitalBand(metric, good + (metric === 'cls' ? 0.001 : 1))).toBe('needs-improvement');
      expect(vitalBand(metric, poor)).toBe('needs-improvement');
      expect(vitalBand(metric, poor + (metric === 'cls' ? 0.001 : 1))).toBe('poor');
    }
    expect(VITAL_THRESHOLDS).toEqual({ lcp: { good: 2500, poor: 4000 }, cls: { good: 0.1, poor: 0.25 }, inp: { good: 200, poor: 500 }, fcp: { good: 1800, poor: 3000 }, ttfb: { good: 800, poor: 1800 } });
  });

  test('verdict-is-the-worst-core-vital-measured', () => {
    expect(summariseSpeed(measurement()).verdict).toBe('good');
    expect(summariseSpeed(withVitals({ cls: 0.15 })).verdict).toBe('needs-improvement');
    expect(summariseSpeed(withVitals({ cls: 0.15, inp: 900 })).verdict).toBe('poor');
    // FCP and TTFB are diagnostics: they never decide the verdict.
    expect(summariseSpeed(withVitals({ fcp: 9_000, ttfb: 9_000 })).verdict).toBe('good');
    expect(summariseSpeed(withVitals({ lcp: null, cls: null, inp: null })).verdict).toBeNull();
  });
});

describe('vital rules', () => {
  for (const metric of VITAL_METRICS) {
    const { good, poor } = VITAL_THRESHOLDS[metric];
    const step = metric === 'cls' ? 0.01 : 10;
    test(`${metric}-poor`, () => {
      const result = fails(`${metric}-poor` as PerformanceRuleId, measured(withVitals({ [metric]: poor + step })));
      expect(result.facts[0]!.label).toBe(metric.toUpperCase());
      passes(`${metric}-poor` as PerformanceRuleId, measured(withVitals({ [metric]: poor })));
      passes(`${metric}-poor` as PerformanceRuleId, measured(withVitals({ [metric]: null })));
      // Poor is not also "needs improvement".
      passes(`${metric}-needs-improvement` as PerformanceRuleId, measured(withVitals({ [metric]: poor + step })));
    });
    test(`${metric}-needs-improvement`, () => {
      fails(`${metric}-needs-improvement` as PerformanceRuleId, measured(withVitals({ [metric]: good + step })));
      fails(`${metric}-needs-improvement` as PerformanceRuleId, measured(withVitals({ [metric]: poor })));
      passes(`${metric}-needs-improvement` as PerformanceRuleId, measured(withVitals({ [metric]: good })));
      passes(`${metric}-needs-improvement` as PerformanceRuleId, measured(withVitals({ [metric]: null })));
    });
  }

  test('lcp-facts-are-formatted', () => {
    const result = fails('lcp-poor', measured(withVitals({ lcp: 4_640 })));
    expect(result.facts).toEqual([
      { label: 'LCP', value: '4.6 s' },
      { label: 'Poor above', value: '4.0 s' },
    ]);
    expect(fact(fails('cls-needs-improvement', measured(withVitals({ cls: 0.123 }))), 'CLS')).toBe('0.123');
  });

  test('poor-is-a-warning-needs-improvement-is-info', () => {
    const poor = runAudit(measured(withVitals({ lcp: 5_000 })));
    expect(poor.findings.map((f) => [f.ruleId, f.severity])).toEqual([['lcp-poor', 'warning']]);
    expect(poor.score).toBe(Math.round(100 * (1 - SEVERITY_WEIGHTS.warning)));
    const meh = runAudit(measured(withVitals({ lcp: 3_000 })));
    expect(meh.findings.map((f) => [f.ruleId, f.severity])).toEqual([['lcp-needs-improvement', 'info']]);
    // The Speed rail dot: warn for poor, pass for needs improvement (info never colours a dot).
    expect(panelStatus(poor.findings, ['performance'])).toBe('warn');
    expect(panelStatus(meh.findings, ['performance'])).toBe('pass');
  });
});

describe('other rules', () => {
  test('page-weight-heavy', () => {
    const heavy = measurement({ resources: [resource({ transfer: PAGE_WEIGHT_WARN_BYTES, encoded: PAGE_WEIGHT_WARN_BYTES })], resourceTotal: 1 });
    const result = fails('page-weight-heavy', measured(heavy));
    expect(fact(result, 'Page weight')).toBe('3.0 MB');
    expect(result.samples[0]).toBe('3.0 MB · https://example.com/app.js');
    passes('page-weight-heavy', measured());
    // A cached response weighs its encoded size; not-itemised requests count through the overflow.
    const cached = measurement({ navigation: null, resources: [resource({ transfer: 0, encoded: PAGE_WEIGHT_WARN_BYTES + 1 })], resourceTotal: 1 });
    fails('page-weight-heavy', measured(cached));
    const overflow = measurement({ navigation: null, resources: [], resourceTotal: 2_000, overflow: { transfer: PAGE_WEIGHT_WARN_BYTES + 1, encoded: 0, decoded: 0, weight: PAGE_WEIGHT_WARN_BYTES + 1 } });
    fails('page-weight-heavy', measured(overflow));
    // Size-unavailable requests are said, and not counted.
    const opaque = measurement({ resources: [resource({ transfer: PAGE_WEIGHT_WARN_BYTES, encoded: PAGE_WEIGHT_WARN_BYTES }), resource({ url: 'https://cdn.other.net/x.js', transfer: 0, encoded: 0, decoded: 0 })], resourceTotal: 2 });
    expect(fact(fails('page-weight-heavy', measured(opaque)), 'Size unavailable')).toBe('1 requests');
  });

  test('request-count-high', () => {
    const many = (n: number) => measurement({ resources: Array.from({ length: n }, (_, i) => resource({ url: `https://example.com/${i}.js`, transfer: 10, encoded: 10, decoded: 10 })), resourceTotal: n });
    // The document counts: REQUEST_COUNT_WARN resources + the document is one too many.
    expect(fails('request-count-high', measured(many(REQUEST_COUNT_WARN))).count).toBe(REQUEST_COUNT_WARN + 1);
    passes('request-count-high', measured(many(REQUEST_COUNT_WARN - 1)));
    // Requests beyond the itemised cap count too.
    fails('request-count-high', measured(measurement({ resources: [], resourceTotal: 500 })));
  });

  test('dom-size-large', () => {
    const result = fails('dom-size-large', measured(measurement({ dom: { elements: DOM_ELEMENTS_WARN + 1, depth: 40, depthComplete: false } })));
    expect(result.count).toBe(DOM_ELEMENTS_WARN + 1);
    expect(fact(result, 'Depth')).toBe('40+');
    passes('dom-size-large', measured(measurement({ dom: { elements: DOM_ELEMENTS_WARN, depth: 40, depthComplete: true } })));
  });

  test('render-blocking-scripts', () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://example.com/blocking-${i}.js`);
    const result = fails('render-blocking-scripts', page({ blockingScripts: { urls, total: 9 } }));
    expect(result.count).toBe(9);
    expect(result.samples).toEqual(urls.slice(0, FINDING_SAMPLE_LIMIT));
    passes('render-blocking-scripts', page({ blockingScripts: { urls: [], total: 0 } }));
    // An older snapshot without the field passes; so does a page without a measurement (it reads the snapshot).
    passes('render-blocking-scripts', cleanSnapshot());
    expect(runAudit(page({ blockingScripts: { urls, total: 9 } })).findings.map((f) => f.ruleId)).toContain('render-blocking-scripts');
  });

  test('uncompressed-text-resources', () => {
    const plain = resource({ url: 'https://example.com/big.js', contentEncoding: '', transfer: 50_300, encoded: 50_000, decoded: 50_000 });
    const result = fails('uncompressed-text-resources', measured(measurement({ resources: [plain], resourceTotal: 1 })));
    expect(result.count).toBe(1);
    expect(result.samples).toEqual(['50.0 kB · https://example.com/big.js']);
    passes('uncompressed-text-resources', measured());
    // Images are not text; tiny responses are not worth it; unknown sizes are never flagged.
    passes('uncompressed-text-resources', measured(measurement({ resources: [resource({ contentType: 'image/png', contentEncoding: '', encoded: 50_000, decoded: 50_000 })], resourceTotal: 1 })));
    passes('uncompressed-text-resources', measured(measurement({ resources: [resource({ contentEncoding: '', encoded: UNCOMPRESSED_MIN_BYTES - 1, decoded: UNCOMPRESSED_MIN_BYTES - 1 })], resourceTotal: 1 })));
    passes('uncompressed-text-resources', measured(measurement({ resources: [resource({ contentEncoding: '', transfer: 0, encoded: 0, decoded: 0 })], resourceTotal: 1 })));
  });
});

describe('classification', () => {
  test('resource-types-classify', () => {
    const type = (initiator: string, contentType: string | null, url = 'https://example.com/x') => resourceType({ initiator, contentType, url });
    expect(type('navigation', 'text/html')).toBe('document');
    expect(type('iframe', '')).toBe('document');
    expect(type('fetch', 'application/javascript')).toBe('fetch');
    expect(type('xmlhttprequest', 'text/html')).toBe('fetch');
    expect(type('beacon', null)).toBe('fetch');
    expect(type('link', 'text/css; charset=utf-8')).toBe('stylesheet');
    expect(type('css', 'font/woff2')).toBe('font');
    expect(type('css', 'image/png')).toBe('image');
    expect(type('script', 'application/javascript')).toBe('script');
    expect(type('script', '')).toBe('script');
    expect(type('img', '')).toBe('image');
    expect(type('video', '')).toBe('other');
    expect(type('link', '', 'https://cdn.example.net/f/Inter.WOFF2?v=1')).toBe('font');
    expect(type('other', '', 'https://cdn.example.net/app.mjs')).toBe('script');
    expect(type('other', '', 'not a url')).toBe('other');
    expect(type('link', 'application/octet-stream', 'https://x.test/a.css')).toBe('stylesheet');
    expect(RESOURCE_TYPES).toEqual(['document', 'script', 'stylesheet', 'image', 'font', 'fetch', 'other']);
  });

  test('third-party-is-another-registrable-domain', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('Static.Example.com:8443')).toBe('example.com');
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('a.b.example.com.au')).toBe('example.com.au');
    expect(registrableDomain('127.0.0.1:8080')).toBe('127.0.0.1');
    expect(registrableDomain('[::1]:3000')).toBe('[::1]');
    expect(registrableDomain('localhost')).toBe('localhost');
    expect(isThirdParty('example.com', 'example.com')).toBe(false);
    expect(isThirdParty('static.example.com', 'www.example.com')).toBe(false);
    // Sibling subdomains are one site.
    expect(isThirdParty('cdn.example.com', 'shop.example.com')).toBe(false);
    expect(isThirdParty('img.example.co.uk', 'www.example.co.uk')).toBe(false);
    // Ports do not matter.
    expect(isThirdParty('example.com:8443', 'example.com')).toBe(false);
    expect(isThirdParty('cdn.other.net', 'example.com')).toBe(true);
    expect(isThirdParty('notexample.com', 'example.com')).toBe(true);
    expect(isThirdParty('other.co.uk', 'example.co.uk')).toBe(true);
    expect(isThirdParty('upload.wikimedia.org', 'en.wikipedia.org')).toBe(true);
    expect(isThirdParty('127.0.0.2', '127.0.0.1')).toBe(true);
    expect(THIRD_PARTY_RULE).toBe('registrable-domain');
    expect(MULTI_PART_SUFFIXES).toContain('co.uk');
  });

  test('uncompressed-detection', () => {
    expect(isUncompressedText(resource({ contentEncoding: '', encoded: 5_000, decoded: 5_000 }))).toBe(true);
    expect(isUncompressedText(resource({ contentEncoding: 'gzip', encoded: 5_000, decoded: 5_000 }))).toBe(false);
    // Without a reported encoding: by the sizes.
    expect(isUncompressedText(resource({ contentEncoding: null, encoded: 5_000, decoded: 5_000 }))).toBe(true);
    expect(isUncompressedText(resource({ contentEncoding: null, encoded: 1_500, decoded: 5_000 }))).toBe(false);
    expect(isUncompressedText(resource({ contentType: 'image/svg+xml', contentEncoding: '', encoded: 5_000, decoded: 5_000 }))).toBe(true);
    expect(isUncompressedText(resource({ contentType: 'application/json', contentEncoding: '', encoded: 5_000, decoded: 5_000 }))).toBe(true);
    expect(isUncompressedText(resource({ contentType: '', initiator: 'link', url: 'https://x.test/a.css', contentEncoding: null, encoded: 5_000, decoded: 5_000 }))).toBe(true);
  });
});

describe('summary', () => {
  test('summary-counts-requests-and-bytes', () => {
    const s = summariseSpeed(measurement());
    expect(s.url).toBe(PAGE_URL);
    expect(s.requests).toEqual({ total: 4, itemised: 4, notItemised: 0, transfer: 12_300 + 20_300 + 8_300 + 90_300, decoded: 48_000 + 80_000 + 30_000 + 90_000, weight: 12_300 + 20_300 + 8_300 + 90_300, unavailable: 0, cached: 0 });
    const by = Object.fromEntries(s.byType.map((b) => [b.type, b.requests]));
    expect(by).toEqual({ document: 1, script: 1, stylesheet: 1, image: 1, font: 0, fetch: 0, other: 0 });
    expect(s.byType.map((b) => b.type)).toEqual([...RESOURCE_TYPES]);
    expect(s.largest.map((r) => r.url)).toEqual(['https://example.com/hero.webp', 'https://example.com/app.js', PAGE_URL, 'https://example.com/site.css']);
    expect(s.vitals.map((v) => [v.metric, v.value, v.band])).toEqual([
      ['lcp', 1200, 'good'],
      ['cls', 0.02, 'good'],
      ['inp', null, null],
      ['fcp', 900, 'good'],
      ['ttfb', 120, 'good'],
    ]);
  });

  test('summary-lists-are-capped', () => {
    const resources = Array.from({ length: 300 }, (_, i) => resource({ url: `https://h${i % 40}.test/${i}.js`, transfer: 2_000 + i, encoded: 2_000 + i, decoded: 2_000 + i, contentEncoding: '' }));
    const s = summariseSpeed(measurement({ navigation: null, resources, resourceTotal: 5_000, overflow: { transfer: 7, encoded: 7, decoded: 7, weight: 7 } }));
    expect(s.largest).toHaveLength(SPEED_PANEL_LIMITS.largest);
    expect(s.largest[0]!.weight).toBe(2_299);
    expect(s.uncompressed).toHaveLength(SPEED_PANEL_LIMITS.uncompressed);
    expect(s.uncompressedTotal).toBe(300);
    expect(s.thirdParty.hosts).toHaveLength(SPEED_PANEL_LIMITS.hosts);
    expect(s.thirdParty.hostTotal).toBe(40);
    expect(s.requests.total).toBe(5_000);
    expect(s.requests.notItemised).toBe(5_000 - 300);
  });

  test('summary-third-party-share', () => {
    const s = summariseSpeed(
      measurement({
        resources: [resource({ url: 'https://static.example.com/a.js' }), resource({ url: 'https://cdn.tracker.test/t.js', transfer: 5_000, encoded: 5_000 }), resource({ url: 'https://cdn.tracker.test/u.js', transfer: 0, encoded: 0, decoded: 0 })],
        resourceTotal: 3,
      }),
    );
    expect(s.thirdParty.requests).toBe(2);
    expect(s.thirdParty.weight).toBe(5_000);
    expect(s.thirdParty.hosts.find((h) => h.host === 'cdn.tracker.test')).toEqual({ host: 'cdn.tracker.test', requests: 2, weight: 5_000, thirdParty: true });
    expect(s.thirdParty.hosts.find((h) => h.host === 'static.example.com')?.thirdParty).toBe(false);
    // The size-unavailable request is counted as a request, never in bytes, and never "largest".
    expect(s.requests.unavailable).toBe(1);
    expect(s.byType.find((b) => b.type === 'script')?.unavailable).toBe(1);
    expect(s.largest.some((r) => r.url === 'https://cdn.tracker.test/u.js')).toBe(false);
  });

  test('navigation-phases', () => {
    const report = navigationReport(navigation());
    expect(report.spans.map((s) => s.phase)).toEqual(['dns', 'connect', 'tls', 'request', 'response']);
    expect(report.durations).toEqual({ redirect: 0, dns: 10, connect: 8, tls: 20, request: 79, response: 20 });
    expect(report.ttfb).toBe(120);
    expect([report.domContentLoaded, report.load]).toEqual([320, 600]);
    // A reused connection without TLS, a redirect, a page still loading.
    const other = navigationReport(navigation({ redirectCount: 1, redirectStart: 1, redirectEnd: 30, domainLookupStart: 30, domainLookupEnd: 30, connectStart: 30, connectEnd: 30, secureConnectionStart: 0, loadEventEnd: 0, activationStart: 20 }));
    expect(other.spans.map((s) => s.phase)).toEqual(['redirect', 'request', 'response']);
    expect(other.load).toBeNull();
    expect(other.ttfb).toBe(100);
  });

  test('summary-notes-route-change-wayland-and-few-requests', () => {
    const base = summariseSpeed(measurement());
    expect([base.softNavigation, base.paintUnavailable, base.resourcesLow]).toEqual([false, false, false]);
    expect(summariseSpeed(measurement({ softNavigation: true })).softNavigation).toBe(true);
    expect(summariseSpeed(measurement({ paintUnavailable: true })).paintUnavailable).toBe(true);
    // Far fewer requests than the elements that usually fetch: suspicious (a heuristic, not a finding).
    const few = measurement({ resources: [], resourceTotal: 0, resourceHints: LOW_RESOURCES_MIN_HINTS * 10 });
    expect(summariseSpeed(few).resourcesLow).toBe(true);
    expect(speedReport(few).findings).toEqual([]);
    expect(summariseSpeed(measurement({ resources: [], resourceTotal: 0, resourceHints: LOW_RESOURCES_MIN_HINTS - 1 })).resourcesLow).toBe(false);
    // After a route change the requests are counted from it: never "too few".
    expect(summariseSpeed({ ...few, softNavigation: true }).resourcesLow).toBe(false);
  });

  test('speed-report-has-measured-findings-only', () => {
    const report = speedReport(withVitals({ lcp: 5_000, cls: 0.15 }));
    expect(report.findings.map((f) => f.ruleId)).toEqual(['lcp-poor', 'cls-needs-improvement']);
    expect(report.findings.every((f) => f.category === 'performance')).toBe(true);
    expect(report.verdict).toBe('poor');
  });
});

test('formats', () => {
  expect([formatMs(0), formatMs(840.4), formatMs(999.6), formatMs(2_640), formatMs(12_345)]).toEqual(['0 ms', '840 ms', '1.0 s', '2.6 s', '12.3 s']);
  expect([formatCls(0), formatCls(0.004), formatCls(0.1), formatCls(0.1004), formatCls(0.123), formatCls(1.5)]).toEqual(['0.000', '0.004', '0.100', '0.100', '0.123', '1.500']);
  expect([formatBytes(512), formatBytes(12_345), formatBytes(345_678), formatBytes(3_400_000), formatBytes(1_200_000_000)]).toEqual(['512 B', '12.3 kB', '346 kB', '3.4 MB', '1.2 GB']);
});
