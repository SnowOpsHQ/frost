import {
  AI_REACH_AGENTS,
  AI_READINESS_CHECKS,
  AI_READINESS_WEIGHTS,
  aiReadinessScore,
  type AiBotId,
  type AiBotRole,
  type AiCheckStatus,
  type AiReachFact,
  type AiReadinessCheckId,
  type AiReadinessScore,
  type LlmsTxtFinding,
  type LlmsTxtOutcome,
} from '@app/specs/ai-readiness.spec';
import { PROBE_BASELINE, type ProbeAgentId, type ProbeOutcome } from '@app/specs/visibility-probes.spec';
import type { ProbeRow, ProbesState } from '@app/specs/visibility-probes.schema';
import type { SeoAudit } from '../types';

// The AI-readiness checks and score (spec `ai-readiness.spec.ts`, The AI-readiness score; acceptance
// `ai-readiness.feature.md`, Score). Pure: it reads the page's audit and the tab's probe run, and
// nothing else (never AI engines' answers, Phase 12). The static part (indexability, robots.txt, the
// served-vs-rendered verdict) is in the audit; the probe part needs the run, so the Visibility panel
// and the Overview tile call `aiReadinessOf(audit, probes)` with both.

/** What of the audit the checks read. */
export type AiReadinessAudit = Pick<SeoAudit, 'url' | 'indexability' | 'javascript' | 'aiReadiness'>;

interface CheckBase<Id extends AiReadinessCheckId> {
  readonly id: Id;
  readonly status: AiCheckStatus;
  /** `AI_READINESS_WEIGHTS[id]` (0: shown, never scored). */
  readonly weight: number;
}

/** One AI agent's probe row, judged (`AI_REACH_FACTS`; `not-checked`: left out by frost's own limits). */
export interface AgentReach {
  readonly agent: ProbeAgentId;
  readonly status: AiCheckStatus;
  readonly facts: readonly AiReachFact[];
}

export type AiReadinessCheck =
  | (CheckBase<'search-indexable'> & { readonly verdict: SeoAudit['indexability']['verdict'] })
  | (CheckBase<'ai-search-crawlers' | 'live-fetch-agents' | 'training-opt-outs'> & { readonly allowed: readonly AiBotId[]; readonly disallowed: readonly AiBotId[] })
  | (CheckBase<'served-content'> & { readonly verdict: Extract<SeoAudit['javascript'], { readonly verdict: unknown }>['verdict'] | null })
  | (CheckBase<'agent-reachability'> & { readonly agents: readonly AgentReach[] })
  | (CheckBase<'llms-txt'> & { readonly outcome: LlmsTxtOutcome | null; readonly findings: readonly LlmsTxtFinding[] });

export interface AiReadiness {
  /** In `AI_READINESS_CHECKS` order. */
  readonly checks: readonly AiReadinessCheck[];
  readonly score: AiReadinessScore;
}

/** Worst last (an agent is never `info`). */
const RANK: Readonly<Record<AiCheckStatus, number>> = { 'not-checked': 0, info: 0, pass: 1, warn: 2, fail: 3 };
/** Rows frost's own limits left without an answer to judge. */
const LEFT_OUT: ReadonlySet<ProbeOutcome> = new Set(['busy', 'parse-failed', 'private-address', 'pending', 'stopped']);

const withoutFragment = (url: string): string => {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
};

function searchIndexable(audit: AiReadinessAudit): AiReadinessCheck {
  const verdict = audit.indexability.verdict;
  const status: AiCheckStatus = verdict === 'indexable' ? 'pass' : verdict === 'canonicalised' ? 'warn' : verdict === 'not-indexable' ? 'fail' : 'not-checked';
  return { id: 'search-indexable', status, weight: AI_READINESS_WEIGHTS['search-indexable'], verdict };
}

/** robots.txt's verdicts for the tokens of `role`: every one allowed pass, some disallowed warn, all disallowed fail (training: `info` either way). */
function robotsCheck(audit: AiReadinessAudit, id: 'ai-search-crawlers' | 'live-fetch-agents' | 'training-opt-outs', role: AiBotRole): AiReadinessCheck {
  const bots = audit.aiReadiness.bots.filter((bot) => bot.role === role);
  const allowed = bots.filter((bot) => bot.verdict === 'allowed').map((bot) => bot.bot);
  const disallowed = bots.filter((bot) => bot.verdict === 'disallowed').map((bot) => bot.bot);
  const judged = bots.length > 0 && allowed.length + disallowed.length === bots.length;
  let status: AiCheckStatus = 'not-checked';
  if (judged) status = id === 'training-opt-outs' ? 'info' : disallowed.length === 0 ? 'pass' : allowed.length === 0 ? 'fail' : 'warn';
  return { id, status, weight: AI_READINESS_WEIGHTS[id], allowed, disallowed };
}

function servedContent(audit: AiReadinessAudit): AiReadinessCheck {
  const report = audit.javascript;
  const verdict = report.status === 'ready' || report.status === 'identical' ? report.verdict : null;
  const status: AiCheckStatus = verdict === 'independent' ? 'pass' : verdict === 'partly' ? 'warn' : verdict === 'heavily' ? 'fail' : 'not-checked';
  return { id: 'served-content', status, weight: AI_READINESS_WEIGHTS['served-content'], verdict };
}

/** The run, if it finished for the page the audit is of. */
function finishedRun(audit: AiReadinessAudit, probes: ProbesState | null): ProbesState | null {
  if (!probes || probes.status !== 'done') return null;
  return withoutFragment(probes.url) === withoutFragment(audit.url) ? probes : null;
}

/** One AI agent's row against the baseline. */
function reachOf(row: ProbeRow, textDiffers: boolean): AgentReach {
  if (LEFT_OUT.has(row.outcome)) return { agent: row.agent, status: 'not-checked', facts: [] };
  if (row.outcome === 'http-status') return { agent: row.agent, status: 'fail', facts: ['http-status'] };
  if (row.outcome === 'not-html') return { agent: row.agent, status: 'fail', facts: ['not-html'] };
  if (row.outcome !== 'ok') return { agent: row.agent, status: 'fail', facts: ['no-answer'] };
  const facts: AiReachFact[] = [];
  if (row.noindex === true) facts.push('noindex');
  if (textDiffers) facts.push('text');
  return { agent: row.agent, status: row.noindex === true ? 'fail' : textDiffers ? 'warn' : 'pass', facts };
}

function agentReachability(audit: AiReadinessAudit, probes: ProbesState | null): AiReadinessCheck {
  const weight = AI_READINESS_WEIGHTS['agent-reachability'];
  const run = finishedRun(audit, probes);
  const baseline = run?.rows.find((row) => row.agent === PROBE_BASELINE);
  if (!run || !baseline || baseline.outcome !== 'ok') return { id: 'agent-reachability', status: 'not-checked', weight, agents: [] };
  // Only `AI_REACH_AGENTS`, in their order: the training crawlers' rows are information only (refusing them is the owner's opt-out).
  const agents = AI_REACH_AGENTS.flatMap((agent) => {
    const row = run.rows.find((candidate) => candidate.agent === agent);
    return row ? [reachOf(row, run.diffs.find((diff) => diff.agent === agent)?.facts.includes('text') ?? false)] : [];
  });
  const worst = agents.reduce<AiCheckStatus>((status, agent) => (RANK[agent.status] > RANK[status] ? agent.status : status), 'not-checked');
  return { id: 'agent-reachability', status: worst, weight, agents };
}

function llmsTxt(audit: AiReadinessAudit, probes: ProbesState | null): AiReadinessCheck {
  const weight = AI_READINESS_WEIGHTS['llms-txt'];
  const state = finishedRun(audit, probes)?.llmsTxt ?? null;
  if (state === null) return { id: 'llms-txt', status: 'not-checked', weight, outcome: null, findings: [] };
  const status: AiCheckStatus = state.outcome === 'ok' ? 'pass' : state.outcome === 'malformed' ? 'warn' : state.outcome === 'missing' || state.outcome === 'not-text' ? 'fail' : 'not-checked';
  return { id: 'llms-txt', status, weight, outcome: state.outcome, findings: [...state.findings] };
}

/** Every check (`AI_READINESS_CHECKS` order) of the page's audit and the tab's probe run (`null`: none). Pure. */
export function aiReadinessChecks(audit: AiReadinessAudit, probes: ProbesState | null): AiReadinessCheck[] {
  const checks: Record<AiReadinessCheckId, AiReadinessCheck> = {
    'search-indexable': searchIndexable(audit),
    'ai-search-crawlers': robotsCheck(audit, 'ai-search-crawlers', 'ai-search'),
    'served-content': servedContent(audit),
    'agent-reachability': agentReachability(audit, probes),
    'live-fetch-agents': robotsCheck(audit, 'live-fetch-agents', 'live-fetch'),
    'training-opt-outs': robotsCheck(audit, 'training-opt-outs', 'training'),
    'llms-txt': llmsTxt(audit, probes),
  };
  return AI_READINESS_CHECKS.map((id) => checks[id]);
}

/** The checks and their score (`aiReadinessScore`). Pure. */
export function aiReadinessOf(audit: AiReadinessAudit, probes: ProbesState | null): AiReadiness {
  const checks = aiReadinessChecks(audit, probes);
  return { checks, score: aiReadinessScore(Object.fromEntries(checks.map((check) => [check.id, check.status]))) };
}
