// Spec: specs/seo-speed.spec.ts (VITAL_THRESHOLDS, INP_HINT, SNAPSHOT_PERFORMANCE_RULES, NAVIGATION_PHASE_MIN_WIDTH)
// Acceptance: specs/seo-speed.feature.md (Renderer helpers)
import { describe, expect, test } from 'vitest';
import type { Finding, NavigationReport, SeoAudit, SpeedReport } from '@app/seo-core';
import { INP_HINT, LOADED_HIDDEN_HINT, NAVIGATION_PHASE_MIN_WIDTH, SPEED_SOURCE_LABELS, WAYLAND_HINT, WAYLAND_PAINT_NOTE } from '@app/specs/seo-speed.spec';
import { agoText, barWidth, meterGeometry, missingVitalText, speedNotes, openableResource, shareText, shownSpeed, speedIssues, waterfall } from '../speed-view';

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
    const ok = { loadedHidden: false, paintUnavailable: false };
    expect(missingVitalText({ metric: 'inp', value: null, band: null }, ok)).toBe(INP_HINT);
    expect(INP_HINT).toBe('Interact with the page to measure INP');
    expect(missingVitalText({ metric: 'lcp', value: null, band: null }, { ...ok, loadedHidden: true })).toBe(LOADED_HIDDEN_HINT);
    expect(missingVitalText({ metric: 'cls', value: null, band: null }, { ...ok, loadedHidden: true })).toBe(LOADED_HIDDEN_HINT);
    expect(missingVitalText({ metric: 'lcp', value: null, band: null }, ok)).toBe('Not reported yet');
    expect(missingVitalText({ metric: 'lcp', value: 1, band: 'good' }, ok)).toBeNull();
    // Native Wayland without paint timing: the paint metrics say why; TTFB and INP do not.
    for (const metric of ['lcp', 'fcp', 'cls'] as const) expect(missingVitalText({ metric, value: null, band: null }, { ...ok, paintUnavailable: true })).toBe(WAYLAND_HINT);
    expect(missingVitalText({ metric: 'inp', value: null, band: null }, { ...ok, paintUnavailable: true })).toBe(INP_HINT);
  });

  test('speed-notes', () => {
    const base = { softNavigation: false, paintUnavailable: false, resourcesLow: false, bufferFull: false };
    expect(speedNotes(base).map((n) => n.id)).toEqual(['iframes']);
    expect(speedNotes({ softNavigation: true, paintUnavailable: true, resourcesLow: true, bufferFull: true }).map((n) => n.id)).toEqual(['wayland', 'soft-navigation', 'low-resources', 'buffer-full', 'iframes']);
    expect(speedNotes({ ...base, paintUnavailable: true })[0]!.text).toBe(WAYLAND_PAINT_NOTE);
    expect(WAYLAND_PAINT_NOTE).toContain('--ozone-platform=x11');
    expect(SPEED_SOURCE_LABELS).toEqual({ live: 'Live', audit: 'At audit time' });
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
    // DNS (0.1 of the axis) is drawn at the minimum; the request starts where it ends (1.5, not its real 1)
    // and ends at its real end; the response is where it is.
    expect(NAVIGATION_PHASE_MIN_WIDTH).toBe(1.5);
    expect(row.bars).toEqual([
      { phase: 'dns', x: 0, width: 1.5 },
      { phase: 'request', x: 1.5, width: 8.5 },
      { phase: 'response', x: 10, width: 10 },
    ]);
    expect(row.markers).toEqual([
      { id: 'dcl', label: 'DOMContentLoaded', x: 40, ms: 400 },
      { id: 'load', label: 'Load', x: 100, ms: 1_000 },
    ]);
    // Before the load event the row ends at the last phase.
    expect(waterfall({ ...nav, domContentLoaded: null, load: null }).end).toBe(200);
  });

  test('waterfall-shows-every-phase', () => {
    const at = (spans: NavigationReport['spans'], load: number | null): NavigationReport => ({ type: 'navigate', redirectCount: 0, spans, durations: { redirect: 0, dns: 0, connect: 0, tls: 0, request: 0, response: 0 }, ttfb: 0, domInteractive: null, domContentLoaded: null, load });
    // Four short phases in a row (a local page): each is drawn at the minimum, one after another, and the
    // long one after them keeps its real end; none covers another.
    const short = waterfall(
      at(
        [
          { phase: 'dns', start: 0, end: 1 },
          { phase: 'connect', start: 1, end: 2 },
          { phase: 'tls', start: 2, end: 3 },
          { phase: 'request', start: 3, end: 4 },
          { phase: 'response', start: 4, end: 500 },
        ],
        1_000,
      ),
    );
    expect(short.bars).toEqual([
      { phase: 'dns', x: 0, width: 1.5 },
      { phase: 'connect', x: 1.5, width: 1.5 },
      { phase: 'tls', x: 3, width: 1.5 },
      { phase: 'request', x: 4.5, width: 1.5 },
      { phase: 'response', x: 6, width: 44 },
    ]);
    // A short last phase at the axis's end (before the load event): pulled back inside it, the phase
    // before it ending where it starts.
    const late = waterfall(
      at(
        [
          { phase: 'request', start: 0, end: 999 },
          { phase: 'response', start: 999, end: 1_000 },
        ],
        null,
      ),
    );
    expect(late.bars).toEqual([
      { phase: 'request', x: 0, width: 98.5 },
      { phase: 'response', x: 98.5, width: 1.5 },
    ]);
    // Any row: every phase at least the minimum, in order, none overlapping, all inside the axis.
    for (const row of [short, late]) {
      let right = 0;
      for (const bar of row.bars) {
        expect(bar.width).toBeGreaterThanOrEqual(NAVIGATION_PHASE_MIN_WIDTH);
        expect(bar.x).toBeGreaterThanOrEqual(right - 1e-9);
        right = bar.x + bar.width;
      }
      expect(right).toBeLessThanOrEqual(100 + 1e-9);
    }
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
