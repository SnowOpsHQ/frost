// Spec: specs/visibility-probes.spec.ts (PROBE_AGENTS, PROBE_OUTCOME_MESSAGES, PROBE_ROBOTS_VERDICT_LABELS,
// PROBE_DIFF_FACTS, PROBE_TRUNCATED_NOTE, PROBE_MODELLED_DIRECTIVES_NOTE, PROBE_ROBOTS_SERVED_NOTE,
// PROBE_STATUS_LABELS), specs/serp-service.schema.ts (SerpClassifyInputSchema's cap)
// Acceptance: specs/serp-panels.feature.md (Visibility panel view model)
import { describe, expect, test } from 'vitest';
import { INTENT_LIMITS } from '@app/specs/intent-classifier.spec';
import { SERP_PARAM_LIMITS } from '@app/specs/serp.spec';
import { PROBE_AGENT_IDS, PROBE_AGENTS, PROBE_MODELLED_DIRECTIVES_NOTE, PROBE_OUTCOME_MESSAGES, PROBE_ROBOTS_SERVED_NOTE, PROBE_ROBOTS_VERDICT_LABELS, PROBE_STATUS_LABELS, PROBE_TRUNCATED_NOTE, type ProbeAgentId } from '@app/specs/visibility-probes.spec';
import type { ProbeDiff, ProbeRow, ProbesState } from '@app/specs/visibility-probes.schema';
import { CLASSIFY_QUERY_MAX, PROBE_TABLE_FACTS, classifyQueryInput, forgetProbes, formatBytes, knownProbes, probeNotes, probeSummary, probeTable, rememberProbes } from '../visibility-view';

const URL_A = 'https://tea.example/guide';

function row(agent: ProbeAgentId, changes: Partial<ProbeRow> = {}): ProbeRow {
  return {
    agent,
    outcome: 'ok',
    status: 200,
    hops: [],
    finalUrl: URL_A,
    robots: { url: 'https://tea.example/robots.txt', verdict: 'allowed', rule: null, groupAgents: ['*'], groupLine: 1, fallback: true },
    metaRobots: { general: [], agent: [] },
    xRobotsTag: { general: [], agent: [] },
    noindex: false,
    nofollow: false,
    canonical: URL_A,
    canonicals: { html: [URL_A], header: null, conflicts: [] },
    contentType: 'text/html',
    bytes: 12_800,
    truncated: false,
    textTruncated: false,
    partial: false,
    wordCount: 420,
    textHash: 'a'.repeat(64),
    textSignature: null,
    title: 'Green tea guide',
    durationMs: 40,
    ...changes,
  };
}

const diff = (agent: ProbeAgentId, facts: ProbeDiff['facts'], changes: Partial<ProbeDiff> = {}): ProbeDiff => ({ agent, facts, textSimilarity: 1, contentTruncated: false, ...changes });

function state(changes: Partial<ProbesState> = {}): ProbesState {
  return {
    version: 4,
    tabId: 3,
    url: URL_A,
    status: 'done',
    rows: PROBE_AGENT_IDS.map((agent) => row(agent)),
    diffs: PROBE_AGENT_IDS.filter((agent) => agent !== 'browser').map((agent) => diff(agent, [])),
    robotsTxt: [{ url: 'https://tea.example/robots.txt', outcome: 'ok', readAt: 1_700_000_000_000 }],
    startedAt: 1,
    finishedAt: 2,
    ...changes,
  };
}

const IDLE: ProbesState = { version: 0, tabId: 3, url: URL_A, status: 'idle', rows: [], diffs: [], robotsTxt: [], startedAt: null, finishedAt: null };

/** The table's cell for `agent` and `fact`. */
function cell(table: NonNullable<ReturnType<typeof probeTable>>, fact: (typeof PROBE_TABLE_FACTS)[number], agent: ProbeAgentId) {
  const at = table.columns.findIndex((column) => column.agent === agent);
  return table.rows.find((r) => r.fact === fact)!.cells[at]!;
}

describe('Visibility panel view model', () => {
  test('probe-table-shape', () => {
    expect(probeTable(IDLE)).toBeNull();
    const table = probeTable(state())!;
    expect(table.columns.map((column) => column.agent)).toEqual(PROBE_AGENTS.map((agent) => agent.id));
    expect(table.columns[0]).toMatchObject({ agent: 'browser', label: PROBE_AGENTS[0]!.label, baseline: true, modelled: false });
    expect(table.columns.filter((column) => column.modelled).map((column) => column.agent)).toEqual(['gptbot', 'claudebot', 'perplexitybot']);
    expect(table.rows.map((r) => r.fact)).toEqual([...PROBE_TABLE_FACTS]);
    expect(PROBE_TABLE_FACTS).toEqual(['status', 'redirects', 'robots', 'noindex', 'nofollow', 'canonical', 'wordCount', 'bytes', 'text']);
    expect(table.rows.map((r) => r.label)).toEqual(['HTTP status', 'Redirects', 'robots.txt', 'noindex', 'nofollow', 'Canonical', 'Word count', 'Size', 'Visible text']);
    for (const r of table.rows) expect(r.cells).toHaveLength(PROBE_AGENTS.length);
  });

  test('probe-table-cells', () => {
    const table = probeTable(
      state({
        rows: [
          row('browser'),
          row('googlebot', { noindex: true, xRobotsTag: { general: [], agent: ['noindex'] } }),
          row('bingbot', { hops: [{ url: 'https://tea.example/old', status: 301 }], truncated: true, bytes: 5 * 1024 * 1024 }),
          row('gptbot', { robots: { url: 'https://tea.example/robots.txt', verdict: 'disallowed', rule: { allow: false, raw: 'Disallow: /', line: 4 }, groupAgents: ['GPTBot'], groupLine: 3, fallback: false } }),
          row('claudebot', { outcome: 'pending', status: null, finalUrl: null, robots: null, metaRobots: null, xRobotsTag: null, noindex: null, nofollow: null, canonical: null, canonicals: null, bytes: 0, wordCount: null, textHash: null, title: null, durationMs: null }),
          row('perplexitybot', { outcome: 'unreachable', status: null, finalUrl: null, metaRobots: null, xRobotsTag: null, noindex: null, nofollow: null, canonical: null, canonicals: null, bytes: 0, wordCount: null, textHash: null, title: null }),
        ],
        diffs: [diff('googlebot', ['noindex']), diff('bingbot', ['finalUrl', 'redirects'], { textSimilarity: 0.42 }), diff('gptbot', ['robots']), diff('perplexitybot', ['status'], { textSimilarity: null })],
      }),
    )!;
    expect(cell(table, 'status', 'browser')).toMatchObject({ text: '200', title: PROBE_OUTCOME_MESSAGES.ok });
    expect(cell(table, 'status', 'claudebot')).toMatchObject({ text: 'Waiting…', title: PROBE_OUTCOME_MESSAGES.pending });
    expect(cell(table, 'status', 'perplexitybot')).toMatchObject({ text: 'Unreachable', title: PROBE_OUTCOME_MESSAGES.unreachable });
    expect(cell(table, 'redirects', 'browser').text).toBe('None');
    expect(cell(table, 'redirects', 'bingbot').text).toBe('1 (301)');
    expect(cell(table, 'redirects', 'bingbot').title).toContain('https://tea.example/old');
    expect(cell(table, 'robots', 'browser')).toMatchObject({ text: 'Allowed' });
    expect(cell(table, 'robots', 'gptbot').text).toBe('Disallowed');
    expect(cell(table, 'robots', 'gptbot').title).toContain('Disallow: /');
    expect(cell(table, 'robots', 'claudebot').text).toBe('—');
    expect(probeTable(state({ rows: [row('browser', { robots: { url: null, verdict: 'unknown', rule: null, groupAgents: [], groupLine: null, fallback: false } })] }))!.rows[2]!.cells[0]).toMatchObject({ text: 'Unknown', title: PROBE_ROBOTS_VERDICT_LABELS.unknown });
    expect(cell(table, 'noindex', 'browser').text).toBe('No');
    expect(cell(table, 'noindex', 'googlebot').text).toBe('Yes');
    expect(cell(table, 'noindex', 'googlebot').title).toContain('noindex');
    expect(cell(table, 'noindex', 'claudebot').text).toBe('—');
    expect(cell(table, 'nofollow', 'browser').text).toBe('No');
    expect(cell(table, 'canonical', 'browser')).toMatchObject({ text: URL_A, mono: true });
    expect(cell(table, 'canonical', 'perplexitybot').text).toBe('—');
    expect(probeTable(state({ rows: [row('browser', { canonical: null, canonicals: { html: [], header: null, conflicts: [] } })] }))!.rows[5]!.cells[0]!.text).toBe('None');
    expect(cell(table, 'wordCount', 'browser').text).toBe('420');
    expect(cell(table, 'wordCount', 'claudebot').text).toBe('—');
    expect(cell(table, 'bytes', 'browser').text).toBe('12.5 KB');
    expect(cell(table, 'bytes', 'bingbot').text).toBe('5 MB (cut)');
    expect(cell(table, 'text', 'browser').text).toBe('Baseline');
    expect(cell(table, 'text', 'bingbot').text).toBe('42% alike');
    expect(cell(table, 'text', 'perplexitybot').text).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  test('probe-diff-marks', () => {
    const marked = state({
      diffs: [diff('googlebot', ['noindex']), diff('bingbot', ['finalUrl']), diff('gptbot', ['robots', 'wordCount', 'bytes', 'text', 'canonical', 'status']), diff('claudebot', []), diff('perplexitybot', ['redirects'])],
    });
    const table = probeTable(marked)!;
    const marks = (agent: ProbeAgentId) => table.rows.filter((r) => r.cells[table.columns.findIndex((c) => c.agent === agent)]!.diff).map((r) => r.fact);
    expect(marks('browser')).toEqual([]);
    expect(marks('googlebot')).toEqual(['noindex']);
    expect(marks('bingbot')).toEqual(['redirects']);
    expect(marks('gptbot')).toEqual(['status', 'robots', 'canonical', 'wordCount', 'bytes', 'text']);
    expect(marks('claudebot')).toEqual([]);
    expect(marks('perplexitybot')).toEqual(['redirects']);
    // Columns say whether they differ at all.
    expect(table.columns.filter((column) => column.differs).map((column) => column.agent)).toEqual(['googlebot', 'bingbot', 'gptbot', 'perplexitybot']);
    expect(probeSummary(marked)).toBe('Done: 4 of 5 agents differ from the browser');
    expect(probeSummary(state())).toBe('Done: no agent differs from the browser');
    expect(probeSummary(IDLE)).toBe(PROBE_STATUS_LABELS.idle);
    expect(probeSummary(state({ status: 'running', rows: [row('browser'), row('googlebot', { outcome: 'pending' }), row('bingbot', { outcome: 'pending' })] }))).toBe('Probing… 1 of 3 answered');
    expect(probeSummary(state({ status: 'stopped', diffs: [] }))).toBe('Stopped');
  });

  test('probe-notes', () => {
    expect(probeNotes(IDLE)).toEqual({ truncated: null, modelled: null, robots: [], robotsNote: null });
    const notes = probeNotes(state({ diffs: [diff('bingbot', ['wordCount'], { contentTruncated: true })] }));
    expect(notes.truncated).toBe(PROBE_TRUNCATED_NOTE);
    expect(notes.modelled).toBe(PROBE_MODELLED_DIRECTIVES_NOTE);
    expect(notes.robotsNote).toBe(PROBE_ROBOTS_SERVED_NOTE);
    expect(notes.robots).toEqual([{ url: 'https://tea.example/robots.txt', outcome: 'ok', readAt: 1_700_000_000_000 }]);
    expect(probeNotes(state()).truncated).toBeNull();
  });

  test('classify-query-input', () => {
    expect(CLASSIFY_QUERY_MAX).toBe(Math.max(SERP_PARAM_LIMITS.maxQueryChars, INTENT_LIMITS.maxQueryChars));
    expect(classifyQueryInput('  green tea  ')).toBe('green tea');
    expect(classifyQueryInput('   ')).toBeNull();
    expect(classifyQueryInput('')).toBeNull();
    expect(classifyQueryInput('a'.repeat(CLASSIFY_QUERY_MAX + 50))).toHaveLength(CLASSIFY_QUERY_MAX);
    // A surrogate pair at the cut is dropped whole.
    const cut = classifyQueryInput(`${'a'.repeat(CLASSIFY_QUERY_MAX - 1)}😀b`)!;
    expect(cut).toBe('a'.repeat(CLASSIFY_QUERY_MAX - 1));
  });

  test('probes-known-state', () => {
    // What the palette reads: the last probes a panel saw for the tab, forgotten once no panel watches them.
    const running = state({ tabId: 8, status: 'running' });
    expect(knownProbes(8)).toBeUndefined();
    rememberProbes(running);
    expect(knownProbes(8)).toBe(running);
    expect(knownProbes(3)).toBeUndefined();
    forgetProbes(8);
    expect(knownProbes(8)).toBeUndefined();
  });
});
