// Fixtures for the AI-readiness and page-type view tests (`ai-readiness.feature.md`, AI readiness views;
// `page-type.feature.md`, Overview "Page" card): a ready audit with only the parts those views read, and
// a probe run. Built by hand (types only), so no snapshot is needed.
import type { AiBotVerdict, PageTypeReport, SeoAudit } from '@app/seo-core';
import type { LlmsTxtState } from '@app/specs/ai-readiness.schema';
import { AI_BOTS, type AiBotId, type AiBotVerdictValue, type AiBotVia } from '@app/specs/ai-readiness.spec';
import type { ProbeRow, ProbesState } from '@app/specs/visibility-probes.schema';
import type { ProbeAgentId } from '@app/specs/visibility-probes.spec';

export const PAGE = 'https://www.example.com/blog/green-tea';

/** Every `AI_BOTS` token's verdict: allowed by its own group unless `verdicts` / `vias` say otherwise. */
export function bots(verdicts: Partial<Record<AiBotId, AiBotVerdictValue>> = {}, vias: Partial<Record<AiBotId, AiBotVia>> = {}): AiBotVerdict[] {
  return AI_BOTS.map((bot) => {
    const verdict = verdicts[bot.id] ?? 'allowed';
    const judged = verdict === 'allowed' || verdict === 'disallowed';
    return {
      bot: bot.id,
      token: bot.token,
      role: bot.role,
      stance: bot.stance,
      verdict,
      via: judged ? (vias[bot.id] ?? 'own') : null,
      groupLine: judged ? 1 : null,
      rule: verdict === 'disallowed' ? { allow: false, raw: '/blog/', line: 2 } : null,
    };
  });
}

const PAGE_TYPE: PageTypeReport = {
  type: 'article',
  confidence: 'high',
  signals: [
    { signal: 'schema-type', type: 'article', evidence: 'BlogPosting' },
    { signal: 'og-type', type: 'article', evidence: 'article' },
  ],
};

export interface AuditChanges {
  readonly bots?: AiBotVerdict[];
  readonly javascript?: unknown;
  readonly verdict?: SeoAudit['indexability']['verdict'];
  readonly pageType?: PageTypeReport;
  /** Googlebot's and Bingbot's robots.txt verdicts (`true` allowed). */
  readonly search?: { readonly Googlebot: boolean | null; readonly Bingbot: boolean | null };
}

/** A ready audit of `PAGE`: indexable, every AI token allowed, content in the served HTML. */
export function audit(changes: AuditChanges = {}): SeoAudit {
  const search = changes.search ?? { Googlebot: true, Bingbot: false };
  const agent = (name: 'Googlebot' | 'Bingbot') => ({
    agent: name,
    allowed: search[name],
    groupAgents: [],
    groupLine: null,
    fallback: true,
    rule: search[name] === false ? { allow: false, raw: '/blog/', line: 4 } : null,
  });
  return {
    url: PAGE,
    takenAt: 1,
    durationMs: 10,
    score: 92,
    band: 'good',
    indexable: true,
    counts: { error: 0, warning: 0, info: 0 },
    findings: [],
    passed: 0,
    page: { url: PAGE, title: { text: 'Green tea', length: 9 }, description: { text: 'All about green tea.', length: 20 }, partial: false },
    indexability: { verdict: changes.verdict ?? 'indexable', reasons: [], robots: { outcome: 'ok', agents: [agent('Googlebot'), agent('Bingbot')] } },
    javascript: changes.javascript ?? { status: 'ready', verdict: 'independent' },
    aiReadiness: { bots: changes.bots ?? bots() },
    pageType: changes.pageType ?? PAGE_TYPE,
  } as unknown as SeoAudit;
}

const row = (agent: ProbeAgentId, changes: Partial<ProbeRow> = {}): ProbeRow => ({ agent, outcome: 'ok', status: 200, noindex: false, ...changes }) as ProbeRow;

/** A finished probe run for `PAGE`: every agent got the page; `/llms.txt` as given (`null`: no answer). */
export function probes(llmsTxt: LlmsTxtState | null = null, changes: Partial<ProbesState> = {}): ProbesState {
  return {
    tabId: 1,
    url: PAGE,
    status: 'done',
    rows: (['browser', 'googlebot', 'bingbot', 'gptbot', 'claudebot', 'perplexitybot', 'oai-searchbot', 'chatgpt-user'] as const).map((agent) => row(agent)),
    diffs: [],
    robotsTxt: [],
    llmsTxt,
    startedAt: 1,
    finishedAt: 2,
    version: 3,
    ...changes,
  };
}

/** A `/llms.txt` answer. */
export function llms(changes: Partial<LlmsTxtState> = {}): LlmsTxtState {
  return { url: 'https://www.example.com/llms.txt', outcome: 'ok', status: 200, bytes: 120, truncated: false, title: 'Example', sections: 1, links: 3, findings: [], partial: false, readAt: 2, ...changes };
}
