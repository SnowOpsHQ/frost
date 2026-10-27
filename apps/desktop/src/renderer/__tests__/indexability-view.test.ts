// Spec: specs/seo-indexability.spec.ts (RESPONSE_SOURCES, ROBOTS_OUTCOME_LABELS, INDEXABILITY_VERDICTS)
// Acceptance: specs/seo-indexability.feature.md (Renderer helpers)
import { describe, expect, test } from 'vitest';
import type { HreflangEntry, HttpReport, IndexabilityReport, RobotsAgentVerdict, RobotsReport } from '@app/seo-core';
import { formatBytes, hreflangFlags, robotsFetchText, robotsGroupText, robotsRuleText, robotsVerdictLabel, sourceNote, statusText, statusTone, verdictSignals, verdictSummary } from '../indexability-view';

const http = (changes: Partial<HttpReport> = {}): HttpReport => ({ url: 'https://a.example/', source: 'network', status: 200, headersAvailable: true, headers: [], redirects: [], redirectTotal: 0, serverRedirects: 0, ...changes });
const agent = (changes: Partial<RobotsAgentVerdict> = {}): RobotsAgentVerdict => ({ agent: 'Googlebot', allowed: true, groupAgents: ['*'], groupLine: 1, fallback: true, rule: null, ...changes });
const robots = (changes: Partial<RobotsReport> = {}): RobotsReport => ({
  url: 'https://a.example/robots.txt',
  finalUrl: 'https://a.example/robots.txt',
  outcome: 'ok',
  status: 200,
  redirects: 0,
  bytes: 1_234,
  truncated: false,
  groupCount: 1,
  ruleCount: 1,
  sitemaps: [],
  sitemapTotal: 0,
  path: '/',
  agents: [agent()],
  text: '',
  textCut: false,
  ...changes,
});

describe('indexability view helpers', () => {
  test('status-labels-and-tones', () => {
    expect(statusText(200)).toBe('200 OK');
    expect(statusText(404)).toBe('404 Not Found');
    expect(statusText(599)).toBe('599');
    expect(statusText(null)).toBe('Unknown');
    expect([200, 204, 301, 404, 503, null].map(statusTone)).toEqual(['ok', 'ok', 'warn', 'error', 'error', 'muted']);
    expect([0, 999, 1_000, 12_345, 512_000].map(formatBytes)).toEqual(['0 B', '999 B', '1 KB', '12.3 KB', '512 KB']);
  });

  test('source-notes', () => {
    expect(sourceNote(http())).toBeNull();
    expect(sourceNote(http({ source: 'cache' }))).toMatch(/cache/);
    expect(sourceNote(http({ source: 'navigation', headersAvailable: false }))).toMatch(/^Headers unavailable/);
    expect(sourceNote(http({ source: 'in-page', status: null, headersAvailable: false }))).toMatch(/no response of its own/);
  });

  test('robots-labels', () => {
    expect(robotsVerdictLabel({ allowed: true })).toEqual({ label: 'Allowed', tone: 'ok' });
    expect(robotsVerdictLabel({ allowed: false })).toEqual({ label: 'Blocked', tone: 'error' });
    expect(robotsVerdictLabel({ allowed: null })).toEqual({ label: 'Unknown', tone: 'warn' });
    expect(robotsRuleText(agent({ allowed: false, rule: { allow: false, raw: '/private', line: 12 } }), robots())).toBe('Line 12 · Disallow: /private');
    expect(robotsRuleText(agent(), robots())).toBe('No rule matches this URL');
    expect(robotsRuleText(agent({ groupAgents: [] }), robots())).toMatch(/No group applies/);
    expect(robotsRuleText(agent({ groupAgents: [] }), robots({ outcome: 'unavailable' }))).toMatch(/No robots.txt/);
    expect(robotsRuleText(agent({ allowed: null, groupAgents: [] }), robots({ outcome: 'timeout' }))).toMatch(/could not be read/);
    expect(robotsGroupText(agent())).toBe('User-agent: * (fallback)');
    expect(robotsGroupText(agent({ groupAgents: ['a', 'b', 'c', 'd', 'e'], fallback: false }))).toBe('User-agent: a, b, c, +2');
    expect(robotsGroupText(agent({ groupAgents: [] }))).toBe('No group');
    expect(robotsFetchText(robots({ redirects: 1 }))).toBe('Fetched · 200 · 1.2 KB · 1 redirect');
    expect(robotsFetchText(robots({ bytes: 512_000, truncated: true }))).toBe('Fetched · 200 · 512 KB (cut at the limit)');
    expect(robotsFetchText(robots({ outcome: 'unavailable', status: 404 }))).toBe('Not found (no restrictions) · 404');
    expect(robotsFetchText(robots({ outcome: 'timeout', status: null }))).toBe('Timed out');
  });

  test('hreflang-flag-labels', () => {
    const entry = (changes: Partial<HreflangEntry>): HreflangEntry => ({ value: 'en', href: 'https://a.example/', resolved: 'https://a.example/', source: 'html', valid: true, self: false, relative: false, duplicate: false, ...changes });
    expect(hreflangFlags(entry({}))).toEqual([]);
    expect(hreflangFlags(entry({ valid: false, duplicate: true, relative: true, self: true, source: 'header' })).map((flag) => flag.flag)).toEqual(['invalid', 'duplicate', 'relative', 'self', 'header']);
  });

  test('verdict-signals', () => {
    const report = (changes: Partial<IndexabilityReport> = {}): IndexabilityReport => ({
      verdict: 'indexable',
      reasons: [],
      http: http(),
      robotsMeta: [],
      xRobotsTag: [],
      canonical: { html: 'https://a.example/', header: null, effective: 'https://a.example/', elsewhere: false, conflict: false },
      robots: robots(),
      hreflang: { entries: [], total: 0, hasXDefault: false, hasSelf: false },
      ...changes,
    });
    const values = (r: IndexabilityReport) => verdictSignals(r).map((signal) => [signal.id, signal.value, signal.tone]);
    expect(values(report())).toEqual([
      ['http', '200', 'ok'],
      ['meta', 'None', 'ok'],
      ['header', 'None', 'ok'],
      ['robots', 'Allowed', 'ok'],
      ['canonical', 'Self', 'ok'],
    ]);
    const bad = report({
      http: http({ status: 404 }),
      robotsMeta: [{ name: 'googlebot', content: 'noindex, nofollow' }],
      xRobotsTag: [{ agent: null, directives: ['none'], value: 'none' }],
      robots: robots({ agents: [agent({ allowed: false })] }),
      canonical: { html: 'https://a.example/x', header: null, effective: 'https://a.example/x', elsewhere: true, conflict: false },
    });
    expect(values(bad)).toEqual([
      ['http', '404', 'error'],
      ['meta', 'noindex', 'error'],
      ['header', 'noindex', 'error'],
      ['robots', 'Blocked', 'error'],
      ['canonical', 'Elsewhere', 'warn'],
    ]);
    const unknown = report({ http: http({ source: 'navigation', headersAvailable: false }), robots: null, canonical: { html: null, header: null, effective: null, elsewhere: false, conflict: false } });
    expect(values(unknown).slice(2)).toEqual([
      ['header', 'Unknown', 'muted'],
      ['robots', 'Not checked', 'muted'],
      ['canonical', 'None', 'muted'],
    ]);
    expect(values(report({ http: null }))[0]).toEqual(['http', 'Not seen', 'muted']);
    expect(verdictSummary('indexable')).toMatch(/^Nothing/);
    expect(verdictSummary('not-indexable')).toMatch(/will not show/);
    expect(verdictSummary('canonicalised')).toMatch(/another URL/);
  });
});
