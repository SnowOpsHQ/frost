// Spec: specs/ai-readiness.spec.ts (AI_BOT_ROLES, AI_ROBOTS_STANCES, AI_BOT_IDS, AI_BOTS, AI_BOT_VERDICTS,
// AI_ASSISTANTS, AI_STANCE_NOTES, AI_RENDERING_NOTE), specs/visibility-probes.spec.ts (PROBE_AGENTS),
// specs/seo-rules.spec.ts (SEO_RULE_SPECS)
// Acceptance: specs/ai-readiness.feature.md (Catalogue and verdicts)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { LlmsTxtState } from '@app/specs/ai-readiness.schema';
import {
  AI_ASSISTANT_IDS,
  AI_ASSISTANTS,
  AI_BOT_IDS,
  AI_BOT_ROLES,
  AI_BOT_VERDICTS,
  AI_BOTS,
  AI_CHECK_STATUSES,
  AI_CHECK_VALUES,
  AI_REACH_AGENTS,
  AI_READINESS_CHECKS,
  AI_READINESS_WEIGHTS,
  AI_RENDERING_NOTE,
  AI_ROBOTS_STANCES,
  AI_SCORE_REQUIRED_CHECKS,
  AI_STANCE_NOTES,
  aiReadinessScore,
  aiScoreBasis,
  LLMS_TXT_FINDING_MESSAGES,
  LLMS_TXT_FINDINGS,
  LLMS_TXT_PARSE_LIMITS,
  type AiBotId,
  type AiCheckStatus,
  type AiReadinessCheckId,
} from '@app/specs/ai-readiness.spec';
import type { JsVerdict } from '@app/specs/seo-javascript.spec';
import { ROBOTS_FETCH_LIMITS } from '@app/specs/seo-indexability.spec';
import { SEO_RULE_SPECS } from '@app/specs/seo-rules.spec';
import { LLMS_TXT_LIMITS, PROBE_AGENT_IDS, PROBE_AGENTS, PROBE_LIMITS, type ProbeAgentId } from '@app/specs/visibility-probes.spec';
import type { ProbeDiff, ProbeRow, ProbesState } from '@app/specs/visibility-probes.schema';
import { aiBotVerdicts, aiReadinessChecks, aiReadinessOf, parseLlmsTxt, runAudit, type AiBotVerdict, type AiReadinessCheck, type JavascriptReport, type PageSnapshot } from '../index';
import { CLEAN_ROBOTS_TXT, okRobots, page, PAGE_URL } from './fixtures';

/** The verdict for `bot` in `verdicts`. */
const of = (verdicts: readonly AiBotVerdict[], bot: AiBotId) => verdicts.find((verdict) => verdict.bot === bot)!;

describe('AI bot catalogue and robots.txt verdicts', () => {
  test('ai-bots-catalogue-has-14-tokens-and-known-roles', () => {
    expect(AI_BOTS).toHaveLength(14);
    expect(AI_BOTS.map((bot) => bot.id)).toEqual([...AI_BOT_IDS]);
    expect(AI_BOTS.map((bot) => bot.token)).toEqual([
      'OAI-SearchBot',
      'ChatGPT-User',
      'GPTBot',
      'Claude-SearchBot',
      'Claude-User',
      'ClaudeBot',
      'PerplexityBot',
      'Perplexity-User',
      'Applebot',
      'Applebot-Extended',
      'Google-Extended',
      'CCBot',
      'Bytespider',
      'Meta-ExternalAgent',
    ]);
    expect(new Set(AI_BOTS.map((bot) => bot.token.toLowerCase())).size).toBe(14);
    const roleOf = Object.fromEntries(AI_BOTS.map((bot) => [bot.token, bot.role]));
    // Task 6's table: by operator, ai-search / live-fetch / training.
    expect(roleOf).toEqual({
      'OAI-SearchBot': 'ai-search',
      'ChatGPT-User': 'live-fetch',
      GPTBot: 'training',
      'Claude-SearchBot': 'ai-search',
      'Claude-User': 'live-fetch',
      ClaudeBot: 'training',
      PerplexityBot: 'ai-search',
      'Perplexity-User': 'live-fetch',
      Applebot: 'ai-search',
      'Applebot-Extended': 'training',
      'Google-Extended': 'training',
      CCBot: 'training',
      Bytespider: 'training',
      'Meta-ExternalAgent': 'training',
    });
    for (const bot of AI_BOTS) {
      expect(AI_BOT_ROLES, bot.id).toContain(bot.role);
      expect(AI_ROBOTS_STANCES, bot.id).toContain(bot.stance);
      expect(bot.id, bot.token).toBe(bot.token.toLowerCase());
      expect(bot.operator.length, bot.id).toBeGreaterThan(0);
      if (bot.docsUrl !== null) expect(new URL(bot.docsUrl).protocol, bot.id).toBe('https:');
      // A probed bot's probe agent sends its token.
      if (bot.probeAgent !== null) expect(PROBE_AGENTS.find((agent) => agent.id === bot.probeAgent)?.robotsToken, bot.id).toBe(bot.token);
    }
    expect(AI_BOTS.filter((bot) => bot.stance === 'may-ignore').map((bot) => bot.token)).toEqual(['ChatGPT-User', 'Perplexity-User']);
    expect(AI_BOTS.filter((bot) => bot.stance === 'not-documented').map((bot) => bot.token)).toEqual(['Bytespider']);
    expect(AI_BOTS.filter((bot) => bot.probeAgent !== null).map((bot) => bot.probeAgent)).toEqual(['oai-searchbot', 'chatgpt-user', 'gptbot', 'claudebot', 'perplexitybot']);
    // Every AI probe agent is in the catalogue.
    expect(PROBE_AGENTS.filter((agent) => agent.kind === 'ai').every((agent) => AI_BOTS.some((bot) => bot.probeAgent === agent.id))).toBe(true);
    // The assistants: their operators' tokens, Copilot and Google AI as frost's model.
    expect(AI_ASSISTANTS.map((assistant) => assistant.id)).toEqual([...AI_ASSISTANT_IDS]);
    const assistants = Object.fromEntries(AI_ASSISTANTS.map((assistant) => [assistant.id, { tokens: assistant.tokens, source: assistant.source }]));
    expect(assistants).toEqual({
      chatgpt: { tokens: ['OAI-SearchBot', 'ChatGPT-User', 'GPTBot'], source: 'operator' },
      claude: { tokens: ['Claude-SearchBot', 'Claude-User', 'ClaudeBot'], source: 'operator' },
      perplexity: { tokens: ['PerplexityBot', 'Perplexity-User'], source: 'operator' },
      copilot: { tokens: ['Bingbot'], source: 'frost-model' },
      'google-ai': { tokens: ['Googlebot', 'Google-Extended'], source: 'frost-model' },
      apple: { tokens: ['Applebot', 'Applebot-Extended'], source: 'operator' },
    });
    for (const stance of AI_ROBOTS_STANCES) expect(AI_STANCE_NOTES[stance].length, stance).toBeGreaterThan(0);
    expect(AI_RENDERING_NOTE).toMatch(/model/);
  });

  test('ai-bots-judged-from-audit-robots', () => {
    const file = [
      'User-agent: *',
      'Disallow: /guides/',
      '',
      'User-agent: OAI-SearchBot',
      'Allow: /',
      '',
      'User-agent: Claude-User',
      'Disallow: /guides/',
      '',
      'User-agent: Claude-SearchBot',
      'Allow: /guides/',
      '',
      'User-agent: GPTBot',
      'User-agent: ClaudeBot',
      'User-agent: CCBot',
      'Disallow: /',
      '',
      'User-agent: Google-Extended',
      'Disallow: /guides/seo',
      '',
      'User-agent: PerplexityBot',
      'Allow: /',
    ].join('\n');
    const audit = runAudit(page({ robots: okRobots(file) }));
    const verdicts = audit.aiReadiness.bots;
    expect(verdicts.map((verdict) => verdict.bot)).toEqual([...AI_BOT_IDS]);
    for (const verdict of verdicts) expect(AI_BOT_VERDICTS).toContain(verdict.verdict);
    const short = Object.fromEntries(verdicts.map((verdict) => [verdict.token, [verdict.verdict, verdict.via]]));
    expect(short).toEqual({
      'OAI-SearchBot': ['allowed', 'own'],
      'ChatGPT-User': ['disallowed', '*'],
      GPTBot: ['disallowed', 'own'],
      'Claude-SearchBot': ['allowed', 'own'],
      'Claude-User': ['disallowed', 'own'],
      ClaudeBot: ['disallowed', 'own'],
      PerplexityBot: ['allowed', 'own'],
      'Perplexity-User': ['disallowed', '*'],
      // No Googlebot group here: Applebot falls back to `*` like the rest.
      Applebot: ['disallowed', '*'],
      'Applebot-Extended': ['disallowed', '*'],
      'Google-Extended': ['disallowed', 'own'],
      CCBot: ['disallowed', 'own'],
      Bytespider: ['disallowed', '*'],
      'Meta-ExternalAgent': ['disallowed', '*'],
    });
    // Each verdict names its deciding rule and group: Claude-SearchBot by its own group, not Claude-User's.
    expect(of(verdicts, 'claude-searchbot')).toMatchObject({ role: 'ai-search', stance: 'documented', groupLine: 10, rule: { allow: true, raw: '/guides/', line: 11 } });
    expect(of(verdicts, 'claude-user')).toMatchObject({ role: 'live-fetch', groupLine: 7, rule: { allow: false, raw: '/guides/', line: 8 } });
    expect(of(verdicts, 'google-extended')).toMatchObject({ groupLine: 18, rule: { allow: false, raw: '/guides/seo', line: 19 } });
    expect(of(verdicts, 'chatgpt-user')).toMatchObject({ stance: 'may-ignore', groupLine: 1, rule: { allow: false, raw: '/guides/', line: 2 } });
    expect(of(verdicts, 'oai-searchbot')).toMatchObject({ groupLine: 4, rule: { allow: true, raw: '/', line: 5 } });
    // The same verdicts straight from the snapshot.
    expect(aiBotVerdicts(page({ robots: okRobots(file) }))).toEqual(verdicts);
    // Another path on the page's origin: the `*` group no longer blocks it.
    expect(of(aiBotVerdicts(page({ url: 'https://example.com/about', robots: okRobots(file) })), 'bytespider')).toMatchObject({ verdict: 'allowed', via: '*', rule: null });
    // No file to obey allows every token; one that could not be read leaves every verdict unknown.
    for (const outcome of ['unavailable', 'forbidden', 'too-many-redirects', 'private-redirect'] as const) {
      expect(aiBotVerdicts(page({ robots: okRobots('', { outcome, status: null }) })).every((verdict) => verdict.verdict === 'allowed' && verdict.rule === null), outcome).toBe(true);
    }
    for (const outcome of ['server-error', 'unreachable', 'timeout', 'bad-redirect', 'no-location'] as const) {
      expect(aiBotVerdicts(page({ robots: okRobots('', { outcome, status: null }) })).every((verdict) => verdict.verdict === 'unknown'), outcome).toBe(true);
    }
  });

  test('applebot-follows-googlebot-when-not-named', () => {
    expect(AI_BOTS.filter((bot) => bot.followsGooglebot).map((bot) => bot.id)).toEqual(['applebot']);
    const judge = (text: string) => aiBotVerdicts(page({ robots: okRobots(text) }));
    // No Applebot group, a Googlebot one: Applebot follows Googlebot's (Apple's documented rule); Applebot-Extended and the rest use `*`.
    const viaGooglebot = judge('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n\nUser-agent: Googlebot-News\nDisallow: /\n');
    expect(of(viaGooglebot, 'applebot')).toMatchObject({ verdict: 'allowed', via: 'googlebot', groupLine: 4, rule: { allow: true, raw: '/', line: 5 } });
    expect(of(viaGooglebot, 'applebot-extended')).toMatchObject({ verdict: 'disallowed', via: '*', groupLine: 1 });
    expect(of(viaGooglebot, 'bytespider')).toMatchObject({ verdict: 'disallowed', via: '*' });
    // No Googlebot group either (Googlebot-News is another crawler): `*`.
    const viaStar = judge('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot-News\nAllow: /\n');
    expect(of(viaStar, 'applebot')).toMatchObject({ verdict: 'disallowed', via: '*', groupLine: 1, rule: { allow: false, raw: '/', line: 2 } });
    // Its own group wins over Googlebot's and `*`.
    const own = judge('User-agent: Googlebot\nAllow: /\n\nUser-agent: Applebot\nDisallow: /guides/\n\nUser-agent: *\nAllow: /\n');
    expect(of(own, 'applebot')).toMatchObject({ verdict: 'disallowed', via: 'own', groupLine: 4, rule: { allow: false, raw: '/guides/', line: 5 } });
  });

  test('control-tokens-never-requested', () => {
    const control = AI_BOTS.filter((bot) => bot.stance === 'control-token');
    expect(control.map((bot) => bot.token)).toEqual(['Applebot-Extended', 'Google-Extended']);
    for (const bot of control) {
      expect(bot.role, bot.id).toBe('training');
      expect(bot.probeAgent, bot.id).toBeNull();
      // No probe agent sends the token or its name.
      expect(PROBE_AGENTS.some((agent) => agent.robotsToken.toLowerCase() === bot.id || (agent.userAgent ?? '').toLowerCase().includes(bot.id)), bot.id).toBe(false);
    }
    // Their verdicts come from the audit's robots.txt alone: the snapshot is all `aiBotVerdicts` reads.
    const verdicts = aiBotVerdicts(page({ robots: okRobots('User-agent: Google-Extended\nUser-agent: Applebot-Extended\nDisallow: /\n') }));
    expect(of(verdicts, 'google-extended')).toMatchObject({ verdict: 'disallowed', via: 'own', stance: 'control-token' });
    expect(of(verdicts, 'applebot-extended')).toMatchObject({ verdict: 'disallowed', via: 'own', stance: 'control-token' });
    expect(of(verdicts, 'applebot')).toMatchObject({ verdict: 'allowed', via: '*' });
  });

  test('robots-pending-is-not-checked', () => {
    const pending = runAudit(page({ robots: okRobots('', { outcome: 'pending', status: null, finalUrl: null }) }));
    expect(pending.aiReadiness.bots).toHaveLength(14);
    for (const verdict of pending.aiReadiness.bots) expect(verdict, verdict.bot).toMatchObject({ verdict: 'not-checked', via: null, groupLine: null, rule: null });
    // Not fetched at all: not checked either.
    expect(aiBotVerdicts(page({ robots: null })).every((verdict) => verdict.verdict === 'not-checked')).toBe(true);
  });

  test('no-new-rule-in-catalog', () => {
    expect(SEO_RULE_SPECS).toHaveLength(111);
    for (const spec of SEO_RULE_SPECS) expect(spec.id, spec.id).not.toMatch(/\bai\b|llms|gpt|claude|perplexity|readiness/i);
    // Blocking every AI token changes no finding and no score.
    const blocked = `${CLEAN_ROBOTS_TXT}\n${AI_BOTS.map((bot) => `User-agent: ${bot.token}`).join('\n')}\nDisallow: /\n`;
    const clean = runAudit(page());
    const blocking = runAudit(page({ robots: okRobots(blocked) }));
    expect(blocking.aiReadiness.bots.every((verdict) => verdict.verdict === 'disallowed' && verdict.via === 'own')).toBe(true);
    expect(clean.aiReadiness.bots.every((verdict) => verdict.verdict === 'allowed' && verdict.via === '*')).toBe(true);
    expect(blocking.findings.map((finding) => finding.ruleId)).toEqual(clean.findings.map((finding) => finding.ruleId));
    expect(blocking.score).toBe(clean.score);
    expect(blocking.band).toBe(clean.band);
    expect(blocking.indexable).toBe(clean.indexable);
  });
});

// ---- Task 7: the score and llms.txt -----------------------------------------------------------------
// Spec: specs/ai-readiness.spec.ts (AI_READINESS_CHECKS, AI_READINESS_WEIGHTS, AI_CHECK_STATUSES, AI_CHECK_VALUES,
// AI_SCORE_REQUIRED_CHECKS, aiReadinessScore, aiScoreBasis, LLMS_TXT_FINDINGS), specs/visibility-probes.schema.ts (ProbesState)
// Acceptance: specs/ai-readiness.feature.md (Score, llms.txt)

const SPECS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../specs');
const SCORE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ai-readiness/score.ts');
const importsOf = (code: string): string[] => [...code.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]!);

/** A settled probe row (a 2xx HTML page read), with `changes`. */
function probeRow(agent: ProbeAgentId, changes: Partial<ProbeRow> = {}): ProbeRow {
  return {
    agent,
    outcome: 'ok',
    status: 200,
    hops: [],
    finalUrl: PAGE_URL,
    robots: null,
    metaRobots: { general: [], agent: [] },
    xRobotsTag: { general: [], agent: [] },
    noindex: false,
    nofollow: false,
    canonical: PAGE_URL,
    canonicals: { html: [PAGE_URL], header: null, conflicts: [] },
    contentType: 'text/html',
    bytes: 1_000,
    truncated: false,
    textTruncated: false,
    partial: false,
    wordCount: 300,
    textHash: 'a'.repeat(64),
    textSignature: null,
    title: 'SEO basics',
    durationMs: 5,
    ...changes,
  };
}

/** A finished run on the page: every agent answered alike, `rows` and `diffs` changing some. */
function probesDone(rows: Partial<Record<ProbeAgentId, Partial<ProbeRow>>> = {}, diffs: Partial<Record<ProbeAgentId, ProbeDiff['facts']>> = {}, changes: Partial<ProbesState> = {}): ProbesState {
  return {
    version: 3,
    tabId: 1,
    url: PAGE_URL,
    status: 'done',
    rows: PROBE_AGENT_IDS.map((agent) => probeRow(agent, rows[agent])),
    diffs: PROBE_AGENT_IDS.filter((agent) => agent !== 'browser').map((agent) => ({ agent, facts: diffs[agent] ?? [], textSimilarity: 1, contentTruncated: false })),
    robotsTxt: [],
    llmsTxt: null,
    startedAt: 1,
    finishedAt: 2,
    ...changes,
  };
}

const llmsState = (changes: Partial<LlmsTxtState> = {}): LlmsTxtState => ({
  url: 'https://example.com/llms.txt',
  outcome: 'ok',
  status: 200,
  bytes: 120,
  truncated: false,
  title: 'Example',
  sections: 1,
  links: 2,
  findings: [],
  partial: false,
  readAt: 10,
  ...changes,
});

/** The audit of a clean page whose served HTML holds what people see (`verdict`), or another JavaScript report. */
function auditWith(javascript: JavascriptReport | JsVerdict = 'independent', changes: Partial<PageSnapshot> = {}) {
  const audit = runAudit(page(changes));
  if (typeof javascript !== 'string') return { ...audit, javascript };
  const base = { status: 'ready', verdict: javascript } as unknown as JavascriptReport;
  return { ...audit, javascript: base };
}

const statusOf = (checks: readonly AiReadinessCheck[], id: AiReadinessCheckId): AiCheckStatus => checks.find((check) => check.id === id)!.status;

describe('AI-readiness score', () => {
  test('score-weights-and-partial', () => {
    expect([...AI_READINESS_CHECKS]).toEqual(['search-indexable', 'ai-search-crawlers', 'served-content', 'agent-reachability', 'live-fetch-agents', 'training-opt-outs', 'llms-txt']);
    expect(AI_READINESS_WEIGHTS).toEqual({ 'search-indexable': 25, 'ai-search-crawlers': 30, 'served-content': 25, 'agent-reachability': 20, 'live-fetch-agents': 0, 'training-opt-outs': 0, 'llms-txt': 0 });
    expect([...AI_CHECK_STATUSES]).toEqual(['pass', 'warn', 'fail', 'info', 'not-checked']);
    expect(AI_CHECK_VALUES).toEqual({ pass: 1, warn: 0.5, fail: 0 });
    expect([...AI_SCORE_REQUIRED_CHECKS]).toEqual(['search-indexable', 'ai-search-crawlers', 'served-content']);
    // Every check passes: 100, on all four weighted checks.
    const all = Object.fromEntries(AI_READINESS_CHECKS.map((id) => [id, 'pass'])) as Record<AiReadinessCheckId, AiCheckStatus>;
    expect(aiReadinessScore(all)).toEqual({ score: 100, checked: 4, total: 4 });
    // Before a probe run: three of four, weighted over what was checked (25 + 0.5 × 30 + 0) / 80.
    const before = { 'search-indexable': 'pass', 'ai-search-crawlers': 'warn', 'served-content': 'fail', 'agent-reachability': 'not-checked' } as const;
    expect(aiReadinessScore(before)).toEqual({ score: 50, checked: 3, total: 4 });
    expect(aiScoreBasis(aiReadinessScore(before))).toBe('Based on 3 of 4 checks');
    // After it: (25 + 15 + 0 + 20) / 100.
    expect(aiReadinessScore({ ...before, 'agent-reachability': 'pass' })).toEqual({ score: 60, checked: 4, total: 4 });
    expect(aiReadinessScore({ ...before, 'agent-reachability': 'warn' })).toEqual({ score: 50, checked: 4, total: 4 });
    // Rounded: (25 × 0.5 + 30 + 25) / 80 = 84.375.
    expect(aiReadinessScore({ 'search-indexable': 'warn', 'ai-search-crawlers': 'pass', 'served-content': 'pass' }).score).toBe(84);
    // From the audit: a clean, indexable page, every AI crawler allowed, served HTML complete; no run yet.
    const report = aiReadinessOf(auditWith('independent'), null);
    expect(report.checks.map((check) => check.id)).toEqual([...AI_READINESS_CHECKS]);
    expect(report.checks.map((check) => check.weight)).toEqual(AI_READINESS_CHECKS.map((id) => AI_READINESS_WEIGHTS[id]));
    expect(report.score).toEqual({ score: 100, checked: 3, total: 4 });
    expect(statusOf(report.checks, 'agent-reachability')).toBe('not-checked');
    // ai-search-crawlers: all allowed pass, some disallowed warn, all disallowed fail.
    const robotsFor = (text: string) => aiReadinessChecks(auditWith('independent', { robots: okRobots(text) }), null);
    expect(statusOf(robotsFor('User-agent: PerplexityBot\nDisallow: /\n'), 'ai-search-crawlers')).toBe('warn');
    const search = AI_BOTS.filter((bot) => bot.role === 'ai-search').map((bot) => `User-agent: ${bot.token}`);
    const blocked = robotsFor(`${search.join('\n')}\nDisallow: /\n`);
    expect(statusOf(blocked, 'ai-search-crawlers')).toBe('fail');
    expect(blocked.find((check) => check.id === 'ai-search-crawlers')).toMatchObject({ allowed: [], disallowed: ['oai-searchbot', 'claude-searchbot', 'perplexitybot', 'applebot'] });
    // Unreadable robots.txt: not checked (and so no score).
    const unreadable = aiReadinessOf(auditWith('independent', { robots: okRobots('', { outcome: 'server-error', status: 503 }) }), null);
    expect(statusOf(unreadable.checks, 'ai-search-crawlers')).toBe('not-checked');
    // search-indexable: indexable pass, canonicalised warn, not-indexable fail.
    expect(statusOf(aiReadinessChecks(auditWith(), null), 'search-indexable')).toBe('pass');
    const canonicalised = auditWith();
    expect(statusOf(aiReadinessChecks({ ...canonicalised, indexability: { ...canonicalised.indexability, verdict: 'canonicalised' } }, null), 'search-indexable')).toBe('warn');
    expect(statusOf(aiReadinessChecks({ ...canonicalised, indexability: { ...canonicalised.indexability, verdict: 'not-indexable' } }, null), 'search-indexable')).toBe('fail');
  });

  test('score-null-until-static-checks', () => {
    for (const missing of AI_SCORE_REQUIRED_CHECKS) {
      const checks = { 'search-indexable': 'pass', 'ai-search-crawlers': 'pass', 'served-content': 'pass', 'agent-reachability': 'pass', [missing]: 'not-checked' } as const;
      expect(aiReadinessScore(checks), missing).toEqual({ score: null, checked: 3, total: 4 });
    }
    expect(aiReadinessScore({})).toEqual({ score: null, checked: 0, total: 4 });
    // From the audit: the served comparison still pending, robots.txt still pending, indexability pending.
    expect(aiReadinessOf(auditWith({ status: 'pending' }), probesDone()).score).toEqual({ score: null, checked: 3, total: 4 });
    const pendingRobots = aiReadinessOf(auditWith('independent', { robots: okRobots('', { outcome: 'pending', status: null, finalUrl: null }) }), null);
    expect(pendingRobots.score.score).toBeNull();
    expect(statusOf(pendingRobots.checks, 'search-indexable')).toBe('not-checked');
    expect(statusOf(pendingRobots.checks, 'ai-search-crawlers')).toBe('not-checked');
  });

  test('training-and-llms-unscored', () => {
    expect(AI_READINESS_WEIGHTS['training-opt-outs']).toBe(0);
    expect(AI_READINESS_WEIGHTS['llms-txt']).toBe(0);
    expect(AI_READINESS_WEIGHTS['live-fetch-agents']).toBe(0);
    // Any status of the unweighted checks leaves the score where it was.
    const base = { 'search-indexable': 'pass', 'ai-search-crawlers': 'warn', 'served-content': 'pass' } as const;
    for (const status of AI_CHECK_STATUSES) {
      expect(aiReadinessScore({ ...base, 'training-opt-outs': status, 'llms-txt': status, 'live-fetch-agents': status }), status).toEqual(aiReadinessScore(base));
    }
    // Training opt-outs are the owner's choice: a read robots.txt passes, blocking every training token or none.
    const training = AI_BOTS.filter((bot) => bot.role === 'training');
    const blockAll = aiReadinessOf(auditWith('independent', { robots: okRobots(`${training.map((bot) => `User-agent: ${bot.token}`).join('\n')}\nDisallow: /\n`) }), null);
    const allowAll = aiReadinessOf(auditWith('independent'), null);
    // Neither good nor bad: the neutral `info` status, whatever the file allows, and `not-checked` before it is read.
    expect(blockAll.checks.find((check) => check.id === 'training-opt-outs')).toMatchObject({ status: 'info', weight: 0, allowed: [], disallowed: training.map((bot) => bot.id) });
    expect(allowAll.checks.find((check) => check.id === 'training-opt-outs')).toMatchObject({ status: 'info', disallowed: [] });
    const someBlocked = aiReadinessOf(auditWith('independent', { robots: okRobots('User-agent: GPTBot\nDisallow: /\n') }), null);
    expect(statusOf(someBlocked.checks, 'training-opt-outs')).toBe('info');
    expect(statusOf(aiReadinessChecks(auditWith('independent', { robots: okRobots('', { outcome: 'pending', status: null, finalUrl: null }) }), null), 'training-opt-outs')).toBe('not-checked');
    expect(statusOf(aiReadinessChecks(auditWith('independent', { robots: okRobots('', { outcome: 'server-error', status: 503 }) }), null), 'training-opt-outs')).toBe('not-checked');
    expect(blockAll.score).toEqual(allowAll.score);
    expect(someBlocked.score).toEqual(allowAll.score);
    // `info` has no value: never scored, never counted in "k of n", even on a weighted check.
    expect(Object.keys(AI_CHECK_VALUES)).not.toContain('info');
    expect(aiReadinessScore({ ...base, 'agent-reachability': 'info' })).toEqual(aiReadinessScore(base));
    expect(aiReadinessScore({ ...base, 'agent-reachability': 'info' }).checked).toBe(3);
    expect(aiReadinessScore({ 'search-indexable': 'info', 'ai-search-crawlers': 'pass', 'served-content': 'pass' }).score).toBeNull();
    // Live-fetch agents: judged like the AI search crawlers, never scored.
    const liveBlocked = aiReadinessOf(auditWith('independent', { robots: okRobots('User-agent: ChatGPT-User\nDisallow: /\n') }), null);
    expect(statusOf(liveBlocked.checks, 'live-fetch-agents')).toBe('warn');
    expect(liveBlocked.score).toEqual(allowAll.score);
    // llms.txt: ok pass, malformed warn, missing / not-text fail, anything else (or no run) not checked; never scored.
    const llms = (state: LlmsTxtState | null) => aiReadinessOf(auditWith('independent'), probesDone({}, {}, { llmsTxt: state }));
    expect(statusOf(aiReadinessChecks(auditWith(), null), 'llms-txt')).toBe('not-checked');
    expect(statusOf(llms(null).checks, 'llms-txt')).toBe('not-checked');
    expect(statusOf(llms(llmsState()).checks, 'llms-txt')).toBe('pass');
    expect(llms(llmsState({ outcome: 'malformed', findings: ['no-links'] })).checks.find((check) => check.id === 'llms-txt')).toMatchObject({ status: 'warn', outcome: 'malformed', findings: ['no-links'] });
    expect(statusOf(llms(llmsState({ outcome: 'missing', status: 404, title: null })).checks, 'llms-txt')).toBe('fail');
    expect(statusOf(llms(llmsState({ outcome: 'not-text' })).checks, 'llms-txt')).toBe('fail');
    for (const outcome of ['pending', 'timeout', 'http-status', 'stopped', 'parse-failed'] as const) expect(statusOf(llms(llmsState({ outcome })).checks, 'llms-txt'), outcome).toBe('not-checked');
    const scores = new Set([llmsState(), llmsState({ outcome: 'missing' }), llmsState({ outcome: 'malformed' }), null].map((state) => llms(state).score.score));
    expect(scores.size).toBe(1);
  });

  test('served-content-from-js-verdict', () => {
    expect(statusOf(aiReadinessChecks(auditWith('independent'), null), 'served-content')).toBe('pass');
    expect(statusOf(aiReadinessChecks(auditWith('partly'), null), 'served-content')).toBe('warn');
    expect(statusOf(aiReadinessChecks(auditWith('heavily'), null), 'served-content')).toBe('fail');
    expect(aiReadinessChecks(auditWith('heavily'), null).find((check) => check.id === 'served-content')).toMatchObject({ verdict: 'heavily', weight: 25 });
    // Identical served and rendered pages carry the verdict too.
    expect(statusOf(aiReadinessChecks(auditWith({ status: 'identical', verdict: 'independent' } as unknown as JavascriptReport), null), 'served-content')).toBe('pass');
    // No comparison: not checked.
    expect(statusOf(aiReadinessChecks(auditWith({ status: 'pending' }), null), 'served-content')).toBe('not-checked');
    expect(aiReadinessChecks(auditWith({ status: 'unavailable', reason: 'timeout', httpStatus: null, finalUrl: null } as unknown as JavascriptReport), null).find((check) => check.id === 'served-content')).toMatchObject({ status: 'not-checked', verdict: null });
  });

  test('agent-reachability-from-probes', () => {
    const audit = auditWith('independent');
    const reach = (probes: ProbesState | null) => aiReadinessChecks(audit, probes).find((check) => check.id === 'agent-reachability') as Extract<AiReadinessCheck, { id: 'agent-reachability' }>;
    // The judged agents: the AI search and live-fetch bots' probe agents (from AI_BOTS), never a training crawler's.
    const ai = AI_BOTS.filter((bot) => (bot.role === 'ai-search' || bot.role === 'live-fetch') && bot.probeAgent !== null).map((bot) => bot.probeAgent!);
    expect([...AI_REACH_AGENTS]).toEqual(ai);
    expect([...AI_REACH_AGENTS]).toEqual(['oai-searchbot', 'chatgpt-user', 'perplexitybot']);
    // Every judged agent served the page as the browser was: pass, each agent listed.
    const clean = reach(probesDone());
    expect(clean.status).toBe('pass');
    expect(clean.agents.map((agent) => agent.agent)).toEqual(ai);
    expect(clean.agents.every((agent) => agent.status === 'pass' && agent.facts.length === 0)).toBe(true);
    // Non-2xx for one AI agent: fail.
    const refused = reach(probesDone({ 'chatgpt-user': { outcome: 'http-status', status: 403, wordCount: null } }, { 'chatgpt-user': ['status'] }));
    expect(refused.status).toBe('fail');
    expect(refused.agents.find((agent) => agent.agent === 'chatgpt-user')).toEqual({ agent: 'chatgpt-user', status: 'fail', facts: ['http-status'] });
    // Visible text that differs from the browser's: warn.
    const text = reach(probesDone({}, { 'oai-searchbot': ['wordCount', 'text'] }));
    expect(text.status).toBe('warn');
    expect(text.agents.find((agent) => agent.agent === 'oai-searchbot')).toEqual({ agent: 'oai-searchbot', status: 'warn', facts: ['text'] });
    // noindex for an AI agent: fail, even with the text alike.
    expect(reach(probesDone({ perplexitybot: { noindex: true } })).status).toBe('fail');
    // The worst agent decides: a warn and a fail make a fail.
    expect(reach(probesDone({ 'chatgpt-user': { noindex: true } }, { 'oai-searchbot': ['text'] })).status).toBe('fail');
    // A 2xx that is not HTML, a refused redirect, a timeout: fail.
    expect(reach(probesDone({ perplexitybot: { outcome: 'not-html' } })).agents.find((agent) => agent.agent === 'perplexitybot')?.facts).toEqual(['not-html']);
    expect(reach(probesDone({ perplexitybot: { outcome: 'private-redirect', status: 302 } })).status).toBe('fail');
    expect(reach(probesDone({ perplexitybot: { outcome: 'timeout', status: null } })).agents.find((agent) => agent.agent === 'perplexitybot')).toEqual({ agent: 'perplexitybot', status: 'fail', facts: ['no-answer'] });
    // frost's own limits leave an agent out; the rest decide.
    const busy = reach(probesDone({ perplexitybot: { outcome: 'busy', status: null } }));
    expect(busy.status).toBe('pass');
    expect(busy.agents.find((agent) => agent.agent === 'perplexitybot')).toEqual({ agent: 'perplexitybot', status: 'not-checked', facts: [] });
    expect(reach(probesDone(Object.fromEntries(ai.map((agent) => [agent, { outcome: 'parse-failed' }])))).status).toBe('not-checked');
    // A search crawler's answer is not this check's (its own panels show it).
    expect(reach(probesDone({ googlebot: { outcome: 'http-status', status: 403 } })).status).toBe('pass');
    // Not checked: no run, a run still going or stopped, a run for another URL, a browser with no page.
    expect(reach(null)).toMatchObject({ status: 'not-checked', agents: [] });
    expect(reach(probesDone({}, {}, { status: 'running' })).status).toBe('not-checked');
    expect(reach(probesDone({}, {}, { status: 'stopped' })).status).toBe('not-checked');
    expect(reach(probesDone({}, {}, { url: 'https://example.com/other' })).status).toBe('not-checked');
    expect(reach(probesDone({ browser: { outcome: 'http-status', status: 500 } })).status).toBe('not-checked');
    // In the score: the fourth check.
    expect(aiReadinessOf(audit, probesDone({ 'chatgpt-user': { outcome: 'http-status', status: 403 } })).score).toEqual({ score: 80, checked: 4, total: 4 });
  });

  test('training-crawlers-refused-still-reachable', () => {
    const audit = auditWith('independent');
    const training = PROBE_AGENTS.filter((agent) => AI_BOTS.some((bot) => bot.probeAgent === agent.id && bot.role === 'training')).map((agent) => agent.id);
    expect(training).toEqual(['gptbot', 'claudebot']);
    // A CDN answering 403 to GPTBot and ClaudeBot, and a crawler-scoped noindex for them, with every other agent fine:
    // the owner's training opt-out, not a reachability fault.
    const optedOut = probesDone(
      { gptbot: { outcome: 'http-status', status: 403, wordCount: null, noindex: false }, claudebot: { noindex: true, xRobotsTag: { general: [], agent: ['noindex'] } } },
      { gptbot: ['status', 'text'], claudebot: ['noindex', 'text'] },
    );
    const report = aiReadinessOf(audit, optedOut);
    const reach = report.checks.find((check) => check.id === 'agent-reachability') as Extract<AiReadinessCheck, { id: 'agent-reachability' }>;
    expect(reach.status).toBe('pass');
    expect(reach.agents.map((agent) => agent.agent)).not.toContain('gptbot');
    expect(reach.agents.map((agent) => agent.agent)).not.toContain('claudebot');
    // No points lost: the same score as a run where every agent was served alike.
    expect(report.score).toEqual(aiReadinessOf(audit, probesDone()).score);
    expect(report.score).toEqual({ score: 100, checked: 4, total: 4 });
    // Even every training crawler timing out leaves the check to the others.
    expect(statusOf(aiReadinessChecks(audit, probesDone({ gptbot: { outcome: 'timeout', status: null }, claudebot: { outcome: 'unreachable', status: null } })), 'agent-reachability')).toBe('pass');
  });

  test('score-imports-no-capture-module', () => {
    const code = readFileSync(SCORE_FILE, 'utf8');
    const imports = importsOf(code);
    expect(imports.length).toBeGreaterThan(0);
    // The audit's types and ProbesState's (type-only), and the Zod-free specs' values: nothing else.
    for (const specifier of imports) expect(['../types', '@app/specs/visibility-probes.schema', '@app/specs/ai-readiness.spec', '@app/specs/visibility-probes.spec'], specifier).toContain(specifier);
    for (const line of code.split('\n').filter((l) => /from '(\.\.\/types|@app\/specs\/visibility-probes\.schema)'/.test(l))) expect(line, line).toMatch(/^import type /);
    expect(code).not.toMatch(/capture|citation|engine-answer|phase-12/i);
    // Pure: no clock, no randomness, no I/O.
    expect(code).not.toMatch(/Date\.now|Math\.random|fetch\(|setTimeout/);
  });

  test('no-spec-import-cycle', () => {
    const read = (file: string) => importsOf(readFileSync(path.join(SPECS, file), 'utf8'));
    // The probes' spec owns the `/llms.txt` numbers and imports nothing of AI readiness.
    expect(read('visibility-probes.spec.ts').filter((specifier) => /ai-readiness/.test(specifier))).toEqual([]);
    expect(read('ai-readiness.spec.ts')).toEqual(['./visibility-probes.spec']);
    expect(readFileSync(path.join(SPECS, 'ai-readiness.spec.ts'), 'utf8')).toMatch(/import \{ LLMS_TXT_LIMITS, type ProbeAgentId \} from '\.\/visibility-probes\.spec'/);
    // The schemas one way too: the probes' schema reads AI readiness's, never the reverse.
    expect(read('ai-readiness.schema.ts').filter((specifier) => /visibility-probes\.schema/.test(specifier))).toEqual([]);
    expect(read('visibility-probes.schema.ts')).toContain('./ai-readiness.schema');
    expect(PROBE_LIMITS.llmsTxtRequests).toBe(1 + LLMS_TXT_LIMITS.maxRedirects);
    expect(LLMS_TXT_LIMITS).toMatchObject({ maxBytes: 512_000, maxRedirects: 3, timeoutMs: 5_000, cacheTtlMs: ROBOTS_FETCH_LIMITS.cacheTtlMs });
  });

  test('llms-txt-findings', () => {
    expect([...LLMS_TXT_FINDINGS]).toEqual(['no-h1', 'h1-not-first', 'no-links', 'links-not-markdown']);
    for (const finding of LLMS_TXT_FINDINGS) expect(LLMS_TXT_FINDING_MESSAGES[finding].length, finding).toBeGreaterThan(0);
    // The proposal's shape: an H1, a summary, H2 sections listing [name](url) links with optional notes.
    const good = ['# Example Docs', '', '> Docs for the Example API.', '', 'Some details.', '', '## Docs', '', '- [Quick start](https://example.com/start.md): how to begin', '- [API](https://example.com/api.md)', '', '## Optional', '', '- [Changelog](/changelog.md)'].join('\n');
    expect(parseLlmsTxt(good)).toEqual({ title: 'Example Docs', sections: 2, links: 3, findings: [], partial: false });
    expect(parseLlmsTxt(good.replace(/\n/g, '\r\n')).links).toBe(3);
    // No H1; an H1 after other text; no links; list items that are not links.
    expect(parseLlmsTxt('## Docs\n- [A](https://a.example/)\n').findings).toEqual(['no-h1']);
    expect(parseLlmsTxt('Welcome!\n# Example\n## Docs\n- [A](https://a.example/)\n')).toMatchObject({ title: 'Example', findings: ['h1-not-first'] });
    expect(parseLlmsTxt('# Example\n\n> Summary only.\n').findings).toEqual(['no-links']);
    expect(parseLlmsTxt('# Example\n## Docs\n- https://a.example/\n- [B](https://b.example/)\n- see [C](https://c.example/)\n')).toMatchObject({ links: 1, findings: ['links-not-markdown'] });
    // An HTML page is not an llms.txt; code fences and lists outside sections are ignored.
    expect(parseLlmsTxt('<!doctype html><html><body><h1>Shop</h1></body></html>').findings).toEqual(['no-h1', 'no-links']);
    expect(parseLlmsTxt('# Example\n- not in a section\n## Docs\n```\n- not a link\n```\n- [A](https://a.example/)\n').findings).toEqual([]);
    // Untrusted text: the title is capped and control and bidi characters go.
    const long = parseLlmsTxt(`# ${'x'.repeat(500)}‮\u0007\n`).title!;
    expect(long).toHaveLength(LLMS_TXT_PARSE_LIMITS.maxTitleChars);
    expect(parseLlmsTxt('# Ex‮ample\u0007 #\n').title).toBe('Example');
    // Bounded: past the caps the parse stops (`partial`).
    expect(parseLlmsTxt('# A\n'.repeat(LLMS_TXT_PARSE_LIMITS.maxLines + 5)).partial).toBe(true);
    expect(parseLlmsTxt('x'.repeat(LLMS_TXT_PARSE_LIMITS.maxChars + 1)).partial).toBe(true);
    expect(parseLlmsTxt('')).toEqual({ title: null, sections: 0, links: 0, findings: ['no-h1', 'no-links'], partial: false });
  });
});
