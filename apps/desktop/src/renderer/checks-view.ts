import { linkTargetKey, type PageLink } from '@app/seo-core';
import {
  LINK_REASON_LABELS,
  LINK_STATUS_LABELS,
  LINK_STATUS_KINDS,
  RECIPROCITY_LABELS,
  type CheckRunStatus,
  type ChecksState,
  type LinkCheckResult,
  type LinkRunState,
  type LinkStatusKind,
  type ReciprocityStatus,
} from '@app/specs/seo-checks.spec';
import type { Tone } from './indexability-view';

// What the check surfaces show (acceptance `seo-checks.feature.md`, Panels): pure helpers, unit
// tested. Every URL and status comes from main; these only pick labels and tones.

/** A link's result in a run (looked up by its target: parsed, no fragment; a non-`http(s)` one by its `href`). */
export function linkResultIndex(run: LinkRunState | undefined): (link: PageLink) => LinkCheckResult | undefined {
  const byUrl = new Map((run?.results ?? []).map((result) => [result.url, result]));
  return (link) => (link.href === '' ? undefined : byUrl.get(linkTargetKey(link.href) ?? link.href));
}

/** How many results of each kind. */
export function linkKindCounts(run: LinkRunState | undefined): Record<LinkStatusKind, number> {
  const counts = Object.fromEntries(LINK_STATUS_KINDS.map((kind) => [kind, 0])) as Record<LinkStatusKind, number>;
  for (const result of run?.results ?? []) counts[result.kind] += 1;
  return counts;
}

/** The tone of a link's status chip. */
export function linkTone(kind: LinkStatusKind): Tone {
  switch (kind) {
    case 'ok':
      return 'ok';
    case 'broken':
      return 'error';
    case 'redirect':
    case 'blocked':
      return 'warn';
    default:
      return 'muted';
  }
}

/** A link's status chip text: the status code (or the kind) and why, in frost's words. */
export function linkStatusText(result: LinkCheckResult): string {
  const label = LINK_STATUS_LABELS[result.kind];
  if (result.kind === 'skipped') return `${label}: ${LINK_REASON_LABELS[result.reason ?? 'not-http']}`;
  if (result.kind === 'blocked') return label;
  if (result.status !== null) return result.kind === 'broken' || result.kind === 'redirect' ? `${result.status} ${label}` : String(result.status);
  return result.reason ? `${label}: ${LINK_REASON_LABELS[result.reason]}` : label;
}

/** A run's one-line progress / summary. */
export function runSummary(status: CheckRunStatus, settled: number, total: number): string {
  switch (status) {
    case 'running':
      return `Checking… ${settled.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
    case 'done':
      return `Checked ${total.toLocaleString('en-US')} ${total === 1 ? 'link' : 'links'}`;
    case 'stopped':
      return `Stopped after ${settled.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
    case 'cancelled':
      return 'Cancelled: the page changed';
    case 'failed':
      return 'The check could not run';
    default:
      return 'Not checked yet';
  }
}

export function reciprocityTone(status: ReciprocityStatus): Tone {
  return status === 'reciprocal' ? 'ok' : status === 'skipped' || status === 'unreachable' ? 'muted' : 'error';
}

export function reciprocityText(status: ReciprocityStatus): string {
  return RECIPROCITY_LABELS[status];
}

/** The checks state if it is for `tabId` (main answers for the URL the tab shows now: another URL's runs are idle). */
export function checksFor(state: ChecksState | null, tabId: number): ChecksState | null {
  return state !== null && state.tabId === tabId ? state : null;
}

// The latest state seen per tab (the command palette's "Stop" asks whether a check runs).
const latest = new Map<number, ChecksState>();

export function rememberChecks(state: ChecksState): void {
  latest.set(state.tabId, state);
  while (latest.size > 32) latest.delete(latest.keys().next().value!);
}

export function knownChecks(tabId: number): ChecksState | undefined {
  return latest.get(tabId);
}
