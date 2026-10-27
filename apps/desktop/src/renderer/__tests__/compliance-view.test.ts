// Spec: specs/seo-compliance.spec.ts (SECURITY_VERDICTS, HEADER_STATES, A11Y_RUN_STATUSES, A11Y_PANEL_NODES, A11Y_TIMEOUT_MS)
// Acceptance: specs/seo-compliance.feature.md (Renderer helpers)
import { describe, expect, test } from 'vitest';
import type { AccessibilityReport, SecurityReport } from '@app/seo-core';
import { A11Y_FAIL_MESSAGES, A11Y_PANEL_NODES, A11Y_TIMEOUT_MS, IDLE_A11Y_RUN, type AccessibilityRunState } from '@app/specs/seo-compliance.spec';
import { a11yView, countLabel, elapsedSeconds, headersUnknownNote, headerTone, impactCounts, nodesShown, runButtonLabel, runProgress, securitySignals, securitySummary } from '../compliance-view';

const done: Extract<AccessibilityReport, { status: 'done' }> = {
  status: 'done',
  url: 'https://a.example/',
  axeVersion: '4.14.0',
  ranAt: 1,
  durationMs: 400,
  groups: [
    { impact: 'critical', rules: [], nodeTotal: 0 },
    { impact: 'serious', rules: [{ id: 'color-contrast', impact: 'serious', help: 'h', description: 'd', helpUrl: '', tags: [], nodes: [], nodeTotal: 7 }], nodeTotal: 7 },
    { impact: 'moderate', rules: [], nodeTotal: 0 },
    { impact: 'minor', rules: [], nodeTotal: 0 },
  ],
  violationTotal: 1,
  truncated: false,
  passes: 30,
  incomplete: 1,
  inapplicable: 20,
};
const running = (startedAt = 1_000): AccessibilityRunState => ({ status: 'running', startedAt, finishedAt: null, reason: null });
const ended = (status: AccessibilityRunState['status'], reason: AccessibilityRunState['reason'] = null): AccessibilityRunState => ({ status, startedAt: 1_000, finishedAt: 2_000, reason });

function security(changes: Partial<SecurityReport> = {}): SecurityReport {
  return {
    url: 'https://a.example/',
    https: true,
    loopback: false,
    headersKnown: true,
    responseSource: 'network',
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
    cspPolicies: [],
    inlineScriptsAllowed: false,
    frameAncestors: false,
    frameOptionsProtect: true,
    nosniff: true,
    referrerPolicy: 'same-origin',
    referrerFrom: 'header',
    mixed: { active: [], passive: [], total: 0, truncated: false },
    verdict: 'secure',
    headers: [{ name: 'strict-transport-security', label: 'Strict-Transport-Security', state: 'good', values: ['max-age=31536000'], fromMeta: false, note: null }],
    ...changes,
  };
}

describe('compliance view helpers', () => {
  test('security-card-text', () => {
    expect(securitySummary(security())).toMatch(/HTTPS/);
    expect(securitySummary(security({ verdict: 'insecure', https: false }))).toMatch(/not served over HTTPS/);
    expect(securitySummary(security({ verdict: 'insecure', mixed: { active: [{ kind: 'script', url: 'http://x/', tag: 'script' }], passive: [], total: 1, truncated: false } }))).toMatch(/scripts, styles or frames/);
    expect(securitySummary(security({ verdict: 'local', https: false, loopback: true }))).toMatch(/this computer/);
    expect(securitySummary(security({ headersKnown: false }))).toMatch(/unknown/);
    const signals = Object.fromEntries(securitySignals(security()).map((s) => [s.id, [s.value, s.tone]]));
    expect(signals).toEqual({ https: ['Yes', 'ok'], mixed: ['None', 'ok'], hsts: ['On', 'ok'] });
    const http = Object.fromEntries(securitySignals(security({ https: false, headers: [{ name: 'strict-transport-security', label: '', state: 'not-applicable', values: [], fromMeta: false, note: null }] })).map((s) => [s.id, [s.value, s.tone]]));
    expect(http).toEqual({ https: ['No', 'error'], mixed: ['N/A', 'muted'], hsts: ['N/A', 'muted'] });
    const mixed = Object.fromEntries(securitySignals(security({ mixed: { active: [], passive: [{ kind: 'image', url: 'http://x/', tag: 'img' }], total: 3, truncated: false } })).map((s) => [s.id, [s.value, s.tone]]));
    expect(mixed['mixed']).toEqual(['3', 'warn']);
  });

  test('header-tones-and-notes', () => {
    expect(headerTone({ name: 'content-security-policy', state: 'good' })).toBe('ok');
    expect(headerTone({ name: 'content-security-policy', state: 'weak' })).toBe('warn');
    expect(headerTone({ name: 'x-frame-options', state: 'missing' })).toBe('warn');
    // No rule reads Permissions-Policy: its absence is not flagged.
    expect(headerTone({ name: 'permissions-policy', state: 'missing' })).toBe('muted');
    expect(headerTone({ name: 'referrer-policy', state: 'unknown' })).toBe('muted');
    expect(headerTone({ name: 'strict-transport-security', state: 'not-applicable' })).toBe('muted');
    expect(headersUnknownNote(security())).toBeNull();
    expect(headersUnknownNote(security({ headersKnown: false, responseSource: 'navigation' }))).toMatch(/back\/forward cache/);
    expect(headersUnknownNote(security({ headersKnown: false, responseSource: 'in-page' }))).toMatch(/inside the page/);
    expect(headersUnknownNote(security({ headersKnown: false, responseSource: null }))).toMatch(/no response/);
  });

  test('a11y-view-states', () => {
    const notRun: AccessibilityReport = { status: 'not-run' };
    expect(a11yView(IDLE_A11Y_RUN, notRun)).toEqual({ kind: 'idle' });
    expect(a11yView(running(5), notRun)).toEqual({ kind: 'running', startedAt: 5 });
    // A run in progress shows its progress even over earlier results.
    expect(a11yView(running(5), done).kind).toBe('running');
    // Answered but not scored yet; then the audit's results.
    expect(a11yView(ended('done'), notRun)).toEqual({ kind: 'scoring' });
    expect(a11yView(ended('done'), done)).toEqual({ kind: 'results', report: done });
    expect(a11yView(IDLE_A11Y_RUN, done).kind).toBe('results');
    expect(a11yView(ended('timed-out'), notRun)).toEqual({ kind: 'timed-out' });
    expect(a11yView(ended('failed', 'busy'), notRun)).toEqual({ kind: 'failed', message: A11Y_FAIL_MESSAGES.busy });
    expect(a11yView(ended('done'), { status: 'invalid' })).toEqual({ kind: 'invalid' });
    expect(runButtonLabel({ kind: 'idle' })).toBe('Run accessibility check');
    expect(runButtonLabel({ kind: 'running', startedAt: 0 })).toBe('Checking…');
    expect(runButtonLabel({ kind: 'results', report: done })).toBe('Run again');
  });

  test('a11y-progress-and-counts', () => {
    expect(elapsedSeconds(1_000, 1_000)).toBe(0);
    expect(elapsedSeconds(1_000, 4_600)).toBe(3);
    expect(elapsedSeconds(1_000, 1_000 + A11Y_TIMEOUT_MS * 3)).toBe(A11Y_TIMEOUT_MS / 1_000);
    expect(elapsedSeconds(5_000, 1_000)).toBe(0);
    expect(runProgress(0, A11Y_TIMEOUT_MS / 2)).toBe(0.5);
    expect(runProgress(0, A11Y_TIMEOUT_MS * 2)).toBe(1);
    expect(impactCounts(done)).toEqual([
      { impact: 'critical', rules: 0, nodes: 0 },
      { impact: 'serious', rules: 1, nodes: 7 },
      { impact: 'moderate', rules: 0, nodes: 0 },
      { impact: 'minor', rules: 0, nodes: 0 },
    ]);
    expect(nodesShown(10, 40, false)).toEqual({ shown: A11Y_PANEL_NODES, hidden: 10 - A11Y_PANEL_NODES, beyond: 30 });
    expect(nodesShown(10, 40, true)).toEqual({ shown: 10, hidden: 0, beyond: 30 });
    expect(nodesShown(2, 2, false)).toEqual({ shown: 2, hidden: 0, beyond: 0 });
    expect(countLabel(1, 'rule', 'rules')).toBe('1 rule');
    expect(countLabel(1_200, 'rule', 'rules')).toBe('1,200 rules');
  });
});
