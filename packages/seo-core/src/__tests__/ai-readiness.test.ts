// Spec: specs/ai-readiness.spec.ts (AI_BOT_ROLES, AI_ROBOTS_STANCES, AI_BOT_IDS, AI_BOTS, AI_BOT_VERDICTS,
// AI_ASSISTANTS, AI_STANCE_NOTES, AI_RENDERING_NOTE), specs/visibility-probes.spec.ts (PROBE_AGENTS),
// specs/seo-rules.spec.ts (SEO_RULE_SPECS)
// Acceptance: specs/ai-readiness.feature.md (Catalogue and verdicts)
import { describe, expect, test } from 'vitest';
import {
  AI_ASSISTANT_IDS,
  AI_ASSISTANTS,
  AI_BOT_IDS,
  AI_BOT_ROLES,
  AI_BOT_VERDICTS,
  AI_BOTS,
  AI_RENDERING_NOTE,
  AI_ROBOTS_STANCES,
  AI_STANCE_NOTES,
  type AiBotId,
} from '@app/specs/ai-readiness.spec';
import { SEO_RULE_SPECS } from '@app/specs/seo-rules.spec';
import { PROBE_AGENTS } from '@app/specs/visibility-probes.spec';
import { aiBotVerdicts, runAudit, type AiBotVerdict } from '../index';
import { CLEAN_ROBOTS_TXT, okRobots, page } from './fixtures';

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
    const short = Object.fromEntries(verdicts.map((verdict) => [verdict.token, [verdict.verdict, verdict.fallback]]));
    expect(short).toEqual({
      'OAI-SearchBot': ['allowed', false],
      'ChatGPT-User': ['disallowed', true],
      GPTBot: ['disallowed', false],
      'Claude-SearchBot': ['allowed', false],
      'Claude-User': ['disallowed', false],
      ClaudeBot: ['disallowed', false],
      PerplexityBot: ['allowed', false],
      'Perplexity-User': ['disallowed', true],
      Applebot: ['disallowed', true],
      'Applebot-Extended': ['disallowed', true],
      'Google-Extended': ['disallowed', false],
      CCBot: ['disallowed', false],
      Bytespider: ['disallowed', true],
      'Meta-ExternalAgent': ['disallowed', true],
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
    expect(of(aiBotVerdicts(page({ url: 'https://example.com/about', robots: okRobots(file) })), 'bytespider')).toMatchObject({ verdict: 'allowed', fallback: true, rule: null });
    // No file to obey allows every token; one that could not be read leaves every verdict unknown.
    for (const outcome of ['unavailable', 'forbidden', 'too-many-redirects', 'private-redirect'] as const) {
      expect(aiBotVerdicts(page({ robots: okRobots('', { outcome, status: null }) })).every((verdict) => verdict.verdict === 'allowed' && verdict.rule === null), outcome).toBe(true);
    }
    for (const outcome of ['server-error', 'unreachable', 'timeout', 'bad-redirect', 'no-location'] as const) {
      expect(aiBotVerdicts(page({ robots: okRobots('', { outcome, status: null }) })).every((verdict) => verdict.verdict === 'unknown'), outcome).toBe(true);
    }
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
    expect(of(verdicts, 'google-extended')).toMatchObject({ verdict: 'disallowed', fallback: false, stance: 'control-token' });
    expect(of(verdicts, 'applebot-extended')).toMatchObject({ verdict: 'disallowed', fallback: false, stance: 'control-token' });
    expect(of(verdicts, 'applebot')).toMatchObject({ verdict: 'allowed', fallback: true });
  });

  test('robots-pending-is-not-checked', () => {
    const pending = runAudit(page({ robots: okRobots('', { outcome: 'pending', status: null, finalUrl: null }) }));
    expect(pending.aiReadiness.bots).toHaveLength(14);
    for (const verdict of pending.aiReadiness.bots) expect(verdict, verdict.bot).toMatchObject({ verdict: 'not-checked', fallback: false, groupLine: null, rule: null });
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
    expect(blocking.aiReadiness.bots.every((verdict) => verdict.verdict === 'disallowed' && !verdict.fallback)).toBe(true);
    expect(clean.aiReadiness.bots.every((verdict) => verdict.verdict === 'allowed' && verdict.fallback)).toBe(true);
    expect(blocking.findings.map((finding) => finding.ruleId)).toEqual(clean.findings.map((finding) => finding.ruleId));
    expect(blocking.score).toBe(clean.score);
    expect(blocking.band).toBe(clean.band);
    expect(blocking.indexable).toBe(clean.indexable);
  });
});
