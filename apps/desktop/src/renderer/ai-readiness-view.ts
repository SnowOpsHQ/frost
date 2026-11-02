import { aiReadinessOf, scoreBand, type AiReadinessAudit, type AiReadinessCheck } from '@app/seo-core';
import {
  AI_ASSISTANTS,
  AI_BOTS,
  AI_READINESS_COPY as COPY,
  AI_RENDERING_NOTE,
  AI_STANCE_NOTES,
  aiScoreBasis,
  LLMS_TXT_FINDING_MESSAGES,
  LLMS_TXT_OUTCOME_MESSAGES,
  type AiAssistantId,
  type AiBotId,
  type AiBotVerdictValue,
  type AiCheckStatus,
  type AiReadinessCheckId,
  type AiReadinessScore,
} from '@app/specs/ai-readiness.spec';
import type { ScoreBand } from '@app/specs/seo-rules.spec';
import { PROBE_AGENTS, type ProbeAgentId } from '@app/specs/visibility-probes.spec';
// Types only (the schema's Zod stays out of this bundle: strict Trusted Types).
import type { ProbesState } from '@app/specs/visibility-probes.schema';

// The AI-readiness views' model (acceptance `ai-readiness.feature.md`, AI readiness views): the
// score ring, the checks and the assistants list of the Visibility panel's AI-readiness section, and
// the Overview's tile. Pure: it reads seo-core's `aiReadinessOf(audit, probes)` and the audit's
// robots.txt verdicts. Every string it makes is frost's own (`AI_READINESS_COPY`), except the
// `/llms.txt` title and the deciding robots.txt rules, which are untrusted text for `PageText`.

export type AiRingState = 'pending' | 'partial' | 'full';

export interface AiRingView {
  /** `pending`: no score yet; `partial`: scored on some weighted checks; `full`: on all of them. */
  readonly state: AiRingState;
  readonly score: number | null;
  /** What the ring shows: the score, or `AI_READINESS_COPY.pendingValue`. */
  readonly value: string;
  /** "Based on k of n checks", or why there is no score yet. */
  readonly basis: string;
  /** The health score's bands, for its colour only (`null` while pending). */
  readonly band: ScoreBand | null;
  /** What would complete it (`partial` only). */
  readonly hint: string | null;
}

export function aiRingView(score: AiReadinessScore): AiRingView {
  if (score.score === null) return { state: 'pending', score: null, value: COPY.pendingValue, basis: COPY.pendingBasis, band: null, hint: null };
  const full = score.checked >= score.total;
  return { state: full ? 'full' : 'partial', score: score.score, value: String(score.score), basis: aiScoreBasis(score), band: scoreBand(score.score), hint: full ? null : COPY.partialHint };
}

/** No audit yet: nothing is judged. */
const PENDING_RING = aiRingView({ score: null, checked: 0, total: 0 });

export interface AiAgentView {
  readonly agent: ProbeAgentId;
  readonly label: string;
  readonly status: AiCheckStatus;
  readonly statusLabel: string;
  readonly facts: readonly string[];
}

export interface AiLlmsView {
  readonly outcome: string;
  readonly findings: readonly string[];
  /** The file's H1 (capped and control-free by the worker, but the site's text: render it inert). */
  readonly title: string | null;
}

export interface AiCheckView {
  readonly id: AiReadinessCheckId;
  readonly label: string;
  readonly explanation: string;
  readonly status: AiCheckStatus;
  readonly statusLabel: string;
  /** Counts in the score (weight above 0). */
  readonly scored: boolean;
  /** frost's notes beside it (the `may-ignore` note, the neutral training note …). */
  readonly notes: readonly string[];
  /** Labelled token lists (robots.txt checks): "Allowed", "Blocked". */
  readonly lists: readonly { readonly label: string; readonly tokens: readonly string[] }[];
  /** The judged agents (`agent-reachability`). */
  readonly agents: readonly AiAgentView[];
  /** The run's `/llms.txt` answer (`llms-txt`; `null`: none yet). */
  readonly llms: AiLlmsView | null;
}

const tokenOf = (id: AiBotId): string => AI_BOTS.find((bot) => bot.id === id)!.token;
const agentLabel = (id: ProbeAgentId): string => PROBE_AGENTS.find((agent) => agent.id === id)?.label ?? id;

function checkView(check: AiReadinessCheck): AiCheckView {
  const base = {
    id: check.id,
    label: COPY.checks[check.id].label,
    explanation: COPY.checks[check.id].explanation,
    status: check.status,
    statusLabel: COPY.statuses[check.status],
    scored: check.weight > 0,
  };
  const none = { notes: [] as string[], lists: [] as AiCheckView['lists'], agents: [] as AiAgentView[], llms: null };
  switch (check.id) {
    case 'ai-search-crawlers':
    case 'live-fetch-agents':
    case 'training-opt-outs': {
      const lists = [
        { label: COPY.allowedLabel, tokens: check.allowed.map(tokenOf) },
        { label: COPY.blockedLabel, tokens: check.disallowed.map(tokenOf) },
      ].filter((list) => list.tokens.length > 0);
      const notes = check.id === 'live-fetch-agents' ? [COPY.mayIgnoreNote] : check.id === 'training-opt-outs' ? [COPY.trainingNeutral, COPY.controlTokenNote] : [];
      return { ...base, ...none, notes, lists };
    }
    case 'served-content':
      return { ...base, ...none, notes: [AI_RENDERING_NOTE] };
    case 'agent-reachability':
      return {
        ...base,
        ...none,
        notes: check.agents.length === 0 ? [COPY.notRun] : [],
        agents: check.agents.map((agent) => ({ agent: agent.agent, label: agentLabel(agent.agent), status: agent.status, statusLabel: COPY.statuses[agent.status], facts: agent.facts.map((fact) => COPY.reachFacts[fact]) })),
      };
    case 'llms-txt':
      if (check.outcome === null) return { ...base, ...none, notes: [COPY.notRun] };
      return { ...base, ...none, llms: { outcome: LLMS_TXT_OUTCOME_MESSAGES[check.outcome], findings: check.findings.map((finding) => LLMS_TXT_FINDING_MESSAGES[finding]), title: null } };
    default:
      return { ...base, ...none };
  }
}

export interface AiCrawlerView {
  readonly token: string;
  readonly role: string;
  readonly verdict: AiBotVerdictValue;
  readonly verdictLabel: string;
  /** The stance's note (`may-ignore`, `control-token` only) and why other groups decided (`via`). */
  readonly notes: readonly string[];
  /** The path of the robots.txt rule that blocks it (the site's text: render it inert); `null`: not blocked, or no rule. */
  readonly rule: string | null;
}

export interface AiAssistantView {
  readonly id: AiAssistantId;
  readonly label: string;
  /** The mapping is frost's model (`AI_READINESS_COPY.frostModel`). */
  readonly frostModel: boolean;
  readonly crawlers: readonly AiCrawlerView[];
}

/** A classic search crawler's verdict, from the Indexability panel's robots.txt (`ROBOTS_AGENTS`). */
function searchCrawler(audit: AiReadinessAudit, token: string): AiCrawlerView {
  const robots = audit.indexability.robots;
  const verdict = robots === null || robots.outcome === 'pending' ? undefined : robots.agents.find((agent) => agent.agent === token);
  const value: AiBotVerdictValue = verdict === undefined ? 'not-checked' : verdict.allowed === null ? 'unknown' : verdict.allowed ? 'allowed' : 'disallowed';
  return { token, role: COPY.searchRole, verdict: value, verdictLabel: COPY.verdicts[value], notes: [], rule: value === 'disallowed' ? (verdict?.rule?.raw ?? null) : null };
}

function assistantsOf(audit: AiReadinessAudit): AiAssistantView[] {
  return AI_ASSISTANTS.map((assistant) => ({
    id: assistant.id,
    label: assistant.label,
    frostModel: assistant.source === 'frost-model',
    crawlers: assistant.tokens.map((token): AiCrawlerView => {
      const verdict = audit.aiReadiness.bots.find((bot) => bot.token === token);
      if (!verdict) return searchCrawler(audit, token);
      const stance = verdict.stance === 'may-ignore' || verdict.stance === 'control-token' ? [AI_STANCE_NOTES[verdict.stance]] : [];
      const via = verdict.via === null ? null : COPY.vias[verdict.via];
      const rule = verdict.verdict === 'disallowed' ? (verdict.rule?.raw ?? null) : null;
      return { token, role: COPY.roles[verdict.role], verdict: verdict.verdict, verdictLabel: COPY.verdicts[verdict.verdict], notes: via ? [...stance, via] : stance, rule };
    }),
  }));
}

export interface AiReadinessView {
  readonly ring: AiRingView;
  readonly checks: readonly AiCheckView[];
  readonly assistants: readonly AiAssistantView[];
}

/** The section for the tab's ready audit (`null`: none yet) and its probe run (`null`: none). */
export function aiReadinessView(audit: AiReadinessAudit | null, probes: ProbesState | null): AiReadinessView {
  if (audit === null) return { ring: PENDING_RING, checks: [], assistants: [] };
  const readiness = aiReadinessOf(audit, probes);
  const llmsTitle = probes?.llmsTxt?.title ?? null;
  const checks = readiness.checks.map((check) => {
    const view = checkView(check);
    return view.llms ? { ...view, llms: { ...view.llms, title: llmsTitle } } : view;
  });
  return { ring: aiRingView(readiness.score), checks, assistants: assistantsOf(audit) };
}

/** The Overview's tile: the ring only. */
export function aiTileView(audit: AiReadinessAudit | null, probes: ProbesState | null): AiRingView {
  return audit === null ? PENDING_RING : aiRingView(aiReadinessOf(audit, probes).score);
}
