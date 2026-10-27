import type { AccessibilityReport, SecurityHeaderRow, SecurityReport } from '@app/seo-core';
import type { ResponseSource } from '@app/specs/seo-indexability.spec';
import { A11Y_FAIL_MESSAGES, A11Y_IMPACTS, A11Y_PANEL_NODES, A11Y_RUN_MESSAGES, A11Y_TIMEOUT_MS, type A11yImpact, type AccessibilityRunState, type SecurityVerdict } from '@app/specs/seo-compliance.spec';
import type { Tone } from './indexability-view';
import { formatCount } from './seo-view';

// Pure helpers behind the Compliance panel (acceptance `seo-compliance.feature.md`, Renderer
// helpers): frost's own labels and tones for the security card and header rows, and what the
// accessibility section shows for a run state and the audit's report. Every value they take from
// the audit is rendered as text by the panel.

/** What the security verdict card says under its label. */
export function securitySummary(security: Pick<SecurityReport, 'verdict' | 'headersKnown' | 'mixed'>): string {
  const summaries: Readonly<Record<SecurityVerdict, string>> = {
    secure: 'Served over HTTPS with no mixed content or risky settings.',
    attention: 'Served over HTTPS, but something weakens it.',
    insecure: security.mixed.active.length > 0 ? 'The page asks for scripts, styles or frames over plain HTTP.' : 'The page is not served over HTTPS.',
    local: 'Served over http from this computer, which browsers treat as secure.',
  };
  const base = summaries[security.verdict];
  return security.headersKnown ? base : `${base} Its response headers are not available, so header checks are unknown.`;
}

/** A header row's tone: present and good is ok; weak or missing is a warning (Permissions-Policy, which no rule reads, is muted); unknown and not applicable are muted. */
export function headerTone(row: Pick<SecurityHeaderRow, 'name' | 'state'>): Tone {
  switch (row.state) {
    case 'good':
      return 'ok';
    case 'weak':
      return 'warn';
    case 'missing':
      return row.name === 'permissions-policy' ? 'muted' : 'warn';
    default:
      return 'muted';
  }
}

/** Why the header checks are unknown (`null` when the headers are known). */
export function headersUnknownNote(security: Pick<SecurityReport, 'headersKnown' | 'responseSource'>): string | null {
  if (security.headersKnown) return null;
  const notes: Readonly<Record<ResponseSource, string>> = {
    network: 'The response’s headers are not available.',
    cache: 'The response’s headers are not available.',
    navigation: 'Headers unknown: this page came from the back/forward cache or memory, so frost saw no response. Reload to check them.',
    'in-page': 'Headers unknown: the address changed inside the page, so there is no response for it. Reload to check them.',
  };
  return security.responseSource === null ? 'Headers unknown: frost saw no response for this tab. Reload the page to check them.' : notes[security.responseSource];
}

/** The pills on the verdict card: HTTPS, mixed content and HSTS at a glance. */
export function securitySignals(security: SecurityReport): { id: string; label: string; value: string; tone: Tone }[] {
  const hsts = security.headers.find((row) => row.name === 'strict-transport-security');
  const mixed = security.mixed.active.length + security.mixed.passive.length;
  return [
    { id: 'https', label: 'HTTPS', value: security.https ? 'Yes' : security.loopback ? 'Local' : 'No', tone: security.https ? 'ok' : security.loopback ? 'muted' : 'error' },
    {
      id: 'mixed',
      label: 'Mixed content',
      value: !security.https ? 'N/A' : security.mixed.upgradeUnknown ? 'Unknown' : mixed > 0 ? formatCount(security.mixed.total) : security.mixed.upgraded.length > 0 ? 'Upgraded' : 'None',
      tone: !security.https || security.mixed.upgradeUnknown ? 'muted' : security.mixed.active.length > 0 ? 'error' : mixed > 0 ? 'warn' : 'ok',
    },
    {
      id: 'hsts',
      label: 'HSTS',
      value: !hsts || hsts.state === 'not-applicable' ? 'N/A' : hsts.state === 'unknown' ? 'Unknown' : hsts.state === 'good' ? 'On' : hsts.state === 'weak' ? 'Weak' : 'Off',
      tone: !hsts ? 'muted' : headerTone(hsts),
    },
  ];
}

/** What the mixed content card adds under its list: upgraded by the CSP, or maybe (a cut CSP); `null` otherwise. */
export function mixedNote(mixed: SecurityReport['mixed']): string | null {
  if (mixed.upgraded.length > 0) return 'The page’s Content Security Policy has upgrade-insecure-requests: browsers fetch these over https, so they are not mixed content.';
  if (mixed.upgradeUnknown) return 'The page’s Content Security Policy was cut (it is longer than frost reads), so whether it upgrades these to https is unknown: not counted as issues.';
  return null;
}

/** What the accessibility section shows. */
export type A11yView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly startedAt: number }
  | { readonly kind: 'scoring' }
  | { readonly kind: 'results'; readonly report: Extract<AccessibilityReport, { status: 'done' }> }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'invalid' };

/**
 * The accessibility section for a run state and the audit's report: a run in progress shows its
 * progress; results in the audit show them (also when the run state is `idle` but the audit has
 * them: an earlier run of the same document); an answer not scored yet shows "Scoring".
 */
export function a11yView(run: AccessibilityRunState, report: AccessibilityReport): A11yView {
  if (run.status === 'running') return { kind: 'running', startedAt: run.startedAt ?? 0 };
  if (run.status === 'timed-out') return { kind: 'timed-out' };
  if (run.status === 'failed') return { kind: 'failed', message: run.reason ? A11Y_FAIL_MESSAGES[run.reason] : A11Y_RUN_MESSAGES.failed };
  if (report.status === 'done') return { kind: 'results', report };
  if (report.status === 'invalid') return { kind: 'invalid' };
  return run.status === 'done' ? { kind: 'scoring' } : { kind: 'idle' };
}

/** Whole seconds since `startedAt`, at most the run's time cap (for the progress line). */
export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.min(Math.floor((now - startedAt) / 1_000), A11Y_TIMEOUT_MS / 1_000));
}

/** How far through the time cap a run is, 0–1 (the progress bar's fill, an SVG attribute). */
export function runProgress(startedAt: number, now: number): number {
  return Math.max(0, Math.min((now - startedAt) / A11Y_TIMEOUT_MS, 1));
}

/** Violated rules per impact, worst first (every impact, zeros included). */
export function impactCounts(report: Extract<AccessibilityReport, { status: 'done' }>): { impact: A11yImpact; rules: number; nodes: number }[] {
  return A11Y_IMPACTS.map((impact) => {
    const group = report.groups.find((g) => g.impact === impact);
    return { impact, rules: group?.rules.length ?? 0, nodes: group?.nodeTotal ?? 0 };
  });
}

/** How many of a rule's kept elements are listed (`A11Y_PANEL_NODES`, all when expanded), and how many the page has beyond the kept ones. */
export function nodesShown(kept: number, total: number, all: boolean): { shown: number; hidden: number; beyond: number } {
  const shown = all ? kept : Math.min(kept, A11Y_PANEL_NODES);
  return { shown, hidden: kept - shown, beyond: Math.max(0, total - kept) };
}

/** `n rule(s)` / `n element(s)`. */
export function countLabel(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** A note under the accessibility section: a partial run, or a timed-out one that may keep the page busy; `null` otherwise. */
export function a11yNote(view: A11yView): string | null {
  if (view.kind === 'results' && view.report.partial) return 'The check reached its time limit before every rule ran: these are the results of the rules it ran. Not every rule was checked.';
  if (view.kind === 'timed-out') return A11Y_RUN_MESSAGES['timed-out'];
  return null;
}

/** The run button's label. */
export function runButtonLabel(view: A11yView): string {
  if (view.kind === 'running') return 'Checking…';
  if (view.kind === 'idle' || view.kind === 'scoring') return 'Run accessibility check';
  return 'Run again';
}
