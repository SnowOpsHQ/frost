// Spec: specs/seo-speed.spec.ts (VITAL_THRESHOLDS, INP_HINT, SNAPSHOT_PERFORMANCE_RULES)
// Acceptance: specs/seo-speed.feature.md (Renderer helpers)
import { describe, expect, test } from 'vitest';
import type { Finding, NavigationReport, SeoAudit, SpeedReport } from '@app/seo-core';
import { INP_HINT } from '@app/specs/seo-speed.spec';
import { agoText, barWidth, meterGeometry, missingVitalText, openableResource, shareText, shownSpeed, speedIssues, waterfall } from '../speed-view';

const finding = (ruleId: string, severity: Finding['severity']): Finding => ({ ruleId: ruleId as Finding['ruleId'], category: 'performance', severity, title: ruleId, why: '', fix: '', details: { facts: [], samples: [] } });

describe('speed view helpers', () => {
  test('meter-geometry', () => {
    // LCP: the scale is 0…6 s (1.5 × poor); good ends at 2.5 s, poor starts at 4 s.
    expect(meterGeometry('lcp', 3_000)).toEqual({ good: 41.7, poor: 66.7, marker: 50 });
    expect(meterGeometry('lcp', 60_000).marker).toBe(100);
    expect(meterGeometry('cls', null).marker).toBeNull();
    expect(meterGeometry('cls', 0).marker).toBe(0);
  });

  test('missing-vital-text', () => {
    expect(missingVitalText({ metric: 'inp', value: null, band: null }, { loadedHidden: false })).toBe(INP_HINT);
    expect(INP_HINT).toBe('Interact with the page to measure INP');
    expect(missingVitalText({ metric: 'lcp', value: null, band: null }, { loadedHidden: true })).toMatch(/background/);
    expect(missingVitalText({ metric: 'lcp', value: null, band: null }, { loadedHidden: false })).toBe('Not reported yet');
    expect(missingVitalText({ metric: 'lcp', value: 1, band: 'good' }, { loadedHidden: false })).toBeNull();
  });

  test('waterfall-geometry', () => {
    const nav: NavigationReport = {
      type: 'navigate',
      redirectCount: 0,
      spans: [
        { phase: 'dns', start: 0, end: 1 },
        { phase: 'request', start: 10, end: 100 },
        { phase: 'response', start: 100, end: 200 },
      ],
      durations: { redirect: 0, dns: 1, connect: 0, tls: 0, request: 90, response: 100 },
      ttfb: 100,
      domInteractive: 300,
      domContentLoaded: 400,
      load: 1_000,
    };
    const row = waterfall(nav);
    expect(row.end).toBe(1_000);
    expect(row.bars).toEqual([
      { phase: 'dns', x: 0, width: 0.8 },
      { phase: 'request', x: 1, width: 9 },
      { phase: 'response', x: 10, width: 10 },
    ]);
    expect(row.markers).toEqual([
      { id: 'dcl', label: 'DOMContentLoaded', x: 40, ms: 400 },
      { id: 'load', label: 'Load', x: 100, ms: 1_000 },
    ]);
    // Before the load event the row ends at the last phase.
    expect(waterfall({ ...nav, domContentLoaded: null, load: null }).end).toBe(200);
  });

  test('bars-and-shares', () => {
    expect([barWidth(0, 10), barWidth(1, 1_000), barWidth(5, 10), barWidth(20, 10), barWidth(3, 0)]).toEqual([0, 1, 50, 100, 0]);
    expect([shareText(0, 10), shareText(1, 1_000), shareText(1, 3), shareText(5, 0)]).toEqual(['0%', '<1%', '33%', '0%']);
  });

  test('shown-speed-prefers-live-for-this-url', () => {
    const live = { url: 'https://a.example/', findings: [] } as unknown as SpeedReport;
    const fromAudit = { url: 'https://a.example/', findings: [] } as unknown as SpeedReport;
    const audit = { performance: fromAudit, findings: [] } as unknown as SeoAudit;
    expect(shownSpeed('https://a.example/', { status: 'ready', url: 'https://a.example/', report: live }, audit)).toEqual({ report: live, source: 'live' });
    // A live answer for another URL, or none yet: the audit's measurement.
    expect(shownSpeed('https://a.example/b', { status: 'ready', url: 'https://a.example/', report: live }, audit)).toEqual({ report: fromAudit, source: 'audit' });
    expect(shownSpeed('https://a.example/', { status: 'unavailable', url: 'https://a.example/', reason: 'timeout' }, audit).source).toBe('audit');
    expect(shownSpeed('https://a.example/', null, { ...audit, performance: null })).toEqual({ report: null, source: null });
  });

  test('speed-issues-merge-measured-and-snapshot-rules', () => {
    const report = { findings: [finding('cls-needs-improvement', 'info'), finding('lcp-poor', 'warning')] };
    const audit = { findings: [finding('render-blocking-scripts', 'warning'), finding('lcp-poor', 'warning'), finding('title-missing', 'error')] };
    // The audit's measured findings are replaced by the live ones; only its snapshot rules are taken.
    expect(speedIssues(report, audit).map((f) => f.ruleId)).toEqual(['lcp-poor', 'render-blocking-scripts', 'cls-needs-improvement']);
    expect(speedIssues(null, audit).map((f) => f.ruleId)).toEqual(['render-blocking-scripts']);
  });

  test('openable-resources-and-ago', () => {
    expect(openableResource('https://example.com/a.js', false)).toBe(true);
    expect(openableResource('https://example.com/a.js', true)).toBe(false);
    expect(openableResource('data:image/png;base64,AAAA', false)).toBe(false);
    expect(openableResource('javascript:alert(1)', false)).toBe(false);
    expect([agoText(1_000, 1_500), agoText(0, 5_000), agoText(0, 125_000)]).toEqual(['just now', '5 s ago', '2 min ago']);
  });
});
