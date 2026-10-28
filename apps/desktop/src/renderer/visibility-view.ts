import { INTENT_LIMITS } from '@app/specs/intent-classifier.spec';
import { SERP_PARAM_LIMITS } from '@app/specs/serp.spec';
import {
  PROBE_AGENTS,
  PROBE_BASELINE,
  PROBE_CANONICAL_CONFLICT_MESSAGES,
  PROBE_MODELLED_DIRECTIVES_NOTE,
  PROBE_OUTCOME_MESSAGES,
  PROBE_ROBOTS_SERVED_NOTE,
  PROBE_ROBOTS_VERDICT_LABELS,
  PROBE_STATUS_LABELS,
  PROBE_TRUNCATED_NOTE,
  type ProbeAgentId,
  type ProbeAgentKind,
  type ProbeDiffFact,
  type ProbeOutcome,
  type ProbeRobotsVerdict,
} from '@app/specs/visibility-probes.spec';
// Types only (the schema's Zod stays out of this bundle: strict Trusted Types).
import type { ProbeDiff, ProbeDirectives, ProbeRow, ProbesState } from '@app/specs/visibility-probes.schema';
import { formatCount } from './seo-view';
import { percent } from './serp-view';

// The Visibility panel's view model (acceptance `serp-panels.feature.md`, Visibility panel view
// model): main's `ProbesState` as a table with one column per agent and one row per fact, each cell
// marked where main's diff says it differs from the browser baseline. Pure; page- and
// server-derived strings (URLs, directives) pass through as text.

/** The facts the table shows, in order. */
export const PROBE_TABLE_FACTS = ['status', 'redirects', 'robots', 'noindex', 'nofollow', 'canonical', 'wordCount', 'bytes', 'text'] as const;
export type ProbeTableFact = (typeof PROBE_TABLE_FACTS)[number];

export const PROBE_TABLE_FACT_LABELS: Readonly<Record<ProbeTableFact, string>> = {
  status: 'HTTP status',
  redirects: 'Redirects',
  robots: 'robots.txt',
  noindex: 'noindex',
  nofollow: 'nofollow',
  canonical: 'Canonical',
  wordCount: 'Word count',
  bytes: 'Size',
  text: 'Visible text',
};

/** The diff facts that mark each table row (`nofollow` has none: main compares `noindex` only). */
const MARKED_BY: Readonly<Record<ProbeTableFact, readonly ProbeDiffFact[]>> = {
  status: ['status'],
  redirects: ['redirects', 'finalUrl'],
  robots: ['robots'],
  noindex: ['noindex'],
  nofollow: [],
  canonical: ['canonical'],
  wordCount: ['wordCount'],
  bytes: ['bytes'],
  text: ['text'],
};

/** A short word for an answer with no HTTP status (the full sentence is the cell's title). */
const OUTCOME_SHORT: Readonly<Record<ProbeOutcome, string>> = {
  pending: 'Waiting…',
  ok: 'OK',
  'http-status': 'Error',
  'not-html': 'Not HTML',
  'parse-failed': 'Unread',
  'private-address': 'Not requested',
  'private-redirect': 'Private redirect',
  'too-many-redirects': 'Too many redirects',
  'bad-redirect': 'Bad redirect',
  'no-location': 'No location',
  unreachable: 'Unreachable',
  timeout: 'Timed out',
  busy: 'Busy',
  stopped: 'Stopped',
};

const VERDICT_SHORT: Readonly<Record<ProbeRobotsVerdict, string>> = { allowed: 'Allowed', disallowed: 'Disallowed', unknown: 'Unknown' };

const DASH = '—';

export interface ProbeCell {
  readonly text: string;
  /** The longer wording, for the cell's tooltip. */
  readonly title?: string;
  /** Main's diff marks this fact for this agent. */
  readonly diff: boolean;
  /** A URL: shown in the monospaced face. */
  readonly mono?: boolean;
}

export interface ProbeColumn {
  readonly agent: ProbeAgentId;
  readonly label: string;
  readonly kind: ProbeAgentKind;
  readonly baseline: boolean;
  /** Its meta robots / `X-Robots-Tag` handling is frost's model (`PROBE_MODELLED_DIRECTIVES_NOTE`). */
  readonly modelled: boolean;
  /** Main's diff lists at least one fact for it. */
  readonly differs: boolean;
}

export interface ProbeTableRow {
  readonly fact: ProbeTableFact;
  readonly label: string;
  readonly cells: readonly ProbeCell[];
}

export interface ProbeTable {
  readonly columns: readonly ProbeColumn[];
  readonly rows: readonly ProbeTableRow[];
}

/** `n` bytes as B, KB or MB (one decimal, trailing `.0` dropped). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${formatCount(n)} B`;
  const [value, unit] = n < 1024 * 1024 ? [n / 1024, 'KB'] : [n / (1024 * 1024), 'MB'];
  return `${(Math.round(value * 10) / 10).toLocaleString('en-US')} ${unit}`;
}

/** Whether the agent got an HTTP answer (a final status). */
const answered = (row: ProbeRow): boolean => row.status !== null;
const waiting = (row: ProbeRow): boolean => row.outcome === 'pending' || row.outcome === 'stopped';

function directivesText(label: string, directives: ProbeDirectives | null): string | null {
  if (directives === null) return null;
  const parts = [directives.general.length > 0 ? `all: ${directives.general.join(', ')}` : null, directives.agent.length > 0 ? `own: ${directives.agent.join(', ')}` : null].filter((part) => part !== null);
  return parts.length === 0 ? null : `${label} ${parts.join('; ')}`;
}

function cellOf(fact: ProbeTableFact, row: ProbeRow, diff: ProbeDiff | undefined, baseline: boolean): Omit<ProbeCell, 'diff'> {
  switch (fact) {
    case 'status':
      return { text: row.status !== null ? String(row.status) : OUTCOME_SHORT[row.outcome], title: PROBE_OUTCOME_MESSAGES[row.outcome] };
    case 'redirects': {
      if (!answered(row) && row.hops.length === 0) return { text: DASH };
      const title = [...row.hops.map((hop) => `${hop.status} ${hop.url}`), ...(row.finalUrl === null ? [] : [`→ ${row.finalUrl}`])].join('\n');
      return { text: row.hops.length === 0 ? 'None' : `${row.hops.length} (${row.hops.map((hop) => hop.status).join(' → ')})`, title: title === '' ? undefined : title };
    }
    case 'robots': {
      if (row.robots === null) return { text: DASH };
      const rule = row.robots.rule === null ? null : `${row.robots.rule.raw} (line ${row.robots.rule.line})`;
      return { text: VERDICT_SHORT[row.robots.verdict], title: [PROBE_ROBOTS_VERDICT_LABELS[row.robots.verdict], rule, row.robots.url].filter((part) => part !== null).join('\n') };
    }
    case 'noindex':
    case 'nofollow': {
      const value = row[fact];
      if (value === null) return { text: DASH };
      const title = [directivesText('meta robots', row.metaRobots), directivesText('X-Robots-Tag', row.xRobotsTag)].filter((part) => part !== null).join('\n');
      return { text: value ? 'Yes' : 'No', title: title === '' ? undefined : title };
    }
    case 'canonical': {
      if (!answered(row)) return { text: DASH };
      const conflicts = row.canonicals?.conflicts.map((conflict) => PROBE_CANONICAL_CONFLICT_MESSAGES[conflict]) ?? [];
      if (row.canonical === null) return { text: 'None', title: conflicts.length > 0 ? conflicts.join('\n') : undefined };
      return { text: row.canonical, title: [row.canonical, ...conflicts].join('\n'), mono: true };
    }
    case 'wordCount':
      return { text: row.wordCount === null ? DASH : formatCount(row.wordCount) };
    case 'bytes':
      return answered(row) ? { text: `${formatBytes(row.bytes)}${row.truncated ? ' (cut)' : ''}` } : { text: DASH };
    case 'text':
      if (baseline) return { text: waiting(row) || row.wordCount === null ? DASH : 'Baseline' };
      return diff?.textSimilarity === null || diff?.textSimilarity === undefined ? { text: DASH } : { text: `${percent(diff.textSimilarity)} alike` };
  }
}

/** The table for a run (`null` while there are no rows: nothing run yet). */
export function probeTable(state: ProbesState): ProbeTable | null {
  if (state.rows.length === 0) return null;
  const agents = PROBE_AGENTS.filter((agent) => state.rows.some((row) => row.agent === agent.id));
  const diffs = new Map(state.diffs.map((diff) => [diff.agent, diff]));
  const columns: ProbeColumn[] = agents.map((agent) => ({
    agent: agent.id,
    label: agent.label,
    kind: agent.kind,
    baseline: agent.id === PROBE_BASELINE,
    modelled: agent.directives === 'frost-model',
    differs: agent.id !== PROBE_BASELINE && (diffs.get(agent.id)?.facts.length ?? 0) > 0,
  }));
  const rows = PROBE_TABLE_FACTS.map((fact) => ({
    fact,
    label: PROBE_TABLE_FACT_LABELS[fact],
    cells: columns.map((column): ProbeCell => {
      const row = state.rows.find((candidate) => candidate.agent === column.agent)!;
      const diff = diffs.get(column.agent);
      const marked = !column.baseline && diff !== undefined && MARKED_BY[fact].some((marker) => diff.facts.includes(marker));
      return { ...cellOf(fact, row, diff, column.baseline), diff: marked };
    }),
  }));
  return { columns, rows };
}

/** One line on where the run stands. */
export function probeSummary(state: ProbesState): string {
  if (state.status === 'idle') return PROBE_STATUS_LABELS.idle;
  if (state.status === 'running') {
    const settled = state.rows.filter((row) => row.outcome !== 'pending').length;
    return `${PROBE_STATUS_LABELS.running} ${settled} of ${state.rows.length} answered`;
  }
  if (state.status === 'stopped') return PROBE_STATUS_LABELS.stopped;
  const compared = state.diffs.filter((diff) => diff.agent !== PROBE_BASELINE).length;
  const differ = state.diffs.filter((diff) => diff.agent !== PROBE_BASELINE && diff.facts.length > 0).length;
  if (differ === 0) return `${PROBE_STATUS_LABELS.done}: no agent differs from the browser`;
  return `${PROBE_STATUS_LABELS.done}: ${differ} of ${compared} agents ${differ === 1 ? 'differs' : 'differ'} from the browser`;
}

export interface ProbeNotes {
  readonly truncated: string | null;
  readonly modelled: string | null;
  readonly robots: readonly { readonly url: string; readonly outcome: string; readonly readAt: number | null }[];
  readonly robotsNote: string | null;
}

/** The notes a run carries: cut content, the AI crawlers' modelled directives, robots.txt as served to frost. */
export function probeNotes(state: ProbesState): ProbeNotes {
  return {
    truncated: state.diffs.some((diff) => diff.contentTruncated) ? PROBE_TRUNCATED_NOTE : null,
    modelled: state.rows.length > 0 ? PROBE_MODELLED_DIRECTIVES_NOTE : null,
    robots: state.robotsTxt.map((file) => ({ url: file.url, outcome: file.outcome, readAt: file.readAt })),
    robotsNote: state.robotsTxt.length > 0 ? PROBE_ROBOTS_SERVED_NOTE : null,
  };
}

/** The query box's cap: `serp.classify`'s input (`SerpClassifyInputSchema`). */
export const CLASSIFY_QUERY_MAX = Math.max(SERP_PARAM_LIMITS.maxQueryChars, INTENT_LIMITS.maxQueryChars);

/** The typed query as sent to `serp.classify`: trimmed, cut to the cap (never splitting a surrogate pair); `null` when blank. */
export function classifyQueryInput(value: string): string | null {
  let query = value.trim();
  if (query.length > CLASSIFY_QUERY_MAX) {
    const code = query.charCodeAt(CLASSIFY_QUERY_MAX - 1);
    query = query.slice(0, code >= 0xd800 && code <= 0xdbff ? CLASSIFY_QUERY_MAX - 1 : CLASSIFY_QUERY_MAX);
  }
  return query === '' ? null : query;
}

// ---- What the palette knows (`serp-palette.ts`) ----------------------------------------------------

const latest = new Map<number, ProbesState>();

/** Keeps the last probes state the chrome saw for a tab (the palette's availability reads it). */
export function rememberProbes(state: ProbesState): void {
  latest.delete(state.tabId);
  latest.set(state.tabId, state);
  while (latest.size > 32) latest.delete(latest.keys().next().value!);
}

/** Forgets a tab's probes once no panel watches them (stale is worse than unknown: main decides). */
export function forgetProbes(tabId: number): void {
  latest.delete(tabId);
}

export function knownProbes(tabId: number): ProbesState | undefined {
  return latest.get(tabId);
}
