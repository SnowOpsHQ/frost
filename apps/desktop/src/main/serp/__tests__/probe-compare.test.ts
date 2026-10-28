// Spec: specs/visibility-probes.spec.ts (PROBE_AGENTS, PROBE_AGENT_IDS, probeUserAgent, PROBE_LIMITS, PROBE_DIFF_TOLERANCE,
// PROBE_DIFF_FACTS, PROBE_HONESTY_NOTE, PROBE_DISCLOSURE), specs/visibility-probes.schema.ts (ProbeRowSchema, ProbeDiffSchema,
// ProbeRobotsAnswerSchema, ProbePageAnswerSchema), specs/render-profile.spec.ts (USER_AGENT_TEMPLATES), specs/fetcher.spec.ts (FETCH_DISCLOSURE)
// Acceptance: specs/visibility-probes.feature.md (Agents and reading)
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { FETCH_DISCLOSURE } from '@app/specs/fetcher.spec';
import { USER_AGENT_TEMPLATES } from '@app/specs/render-profile.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { PROBE_AGENT_IDS, PROBE_AGENTS, PROBE_BASELINE, PROBE_DIFF_FACTS, PROBE_DIFF_TOLERANCE, PROBE_DISCLOSURE, PROBE_HONESTY_NOTE, PROBE_LIMITS, probeAgent, probeUserAgent } from '@app/specs/visibility-probes.spec';
import { ProbeDiffSchema, ProbePageAnswerSchema, ProbeRobotsAnswerSchema, ProbeRowSchema, type ProbePageAnswer, type ProbeRow } from '@app/specs/visibility-probes.schema';
import { agentDirectives, diffRow, diffsOf, directivesOf, pendingRow, robotsVerdicts, xRobotsTags } from '../probe-compare';
import { runProbeJob } from '../probe-parse';

const PAGE = 'https://www.example.com/guide/shoes?size=9';
const enc = (text: string) => new TextEncoder().encode(text);
const robotsFetch = (text: string | null, outcome: RobotsFetch['outcome'] = 'ok'): RobotsFetch => ({
  url: 'https://www.example.com/robots.txt',
  outcome,
  status: outcome === 'ok' ? 200 : outcome === 'unavailable' ? 404 : null,
  finalUrl: outcome === 'ok' ? 'https://www.example.com/robots.txt' : null,
  redirects: 0,
  body: text === null ? new Uint8Array() : enc(text),
  truncated: false,
});

describe('probe agents and reading', () => {
  test('probes-agent-table', () => {
    expect(PROBE_AGENTS.map((agent) => agent.id)).toEqual([...PROBE_AGENT_IDS]);
    expect(PROBE_AGENT_IDS).toEqual(['browser', 'googlebot', 'bingbot', 'gptbot', 'claudebot', 'perplexitybot']);
    expect(PROBE_BASELINE).toBe('browser');
    expect(PROBE_AGENTS.length).toBeLessThanOrEqual(PROBE_LIMITS.maxFetches);
    expect(PROBE_LIMITS).toMatchObject({ maxFetches: 6, maxConcurrent: 2, maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000, maxRunsPerTab: 1 });
    const browser = probeAgent('browser');
    expect(browser).toMatchObject({ kind: 'browser', userAgent: null, robotsToken: '*', metaNames: ['robots'] });
    expect(probeUserAgent(browser, '140.0.7339.80')).toBeNull();
    // The render profiles' crawler strings, with the app's Chromium version.
    expect(probeAgent('googlebot').userAgent).toBe(USER_AGENT_TEMPLATES['googlebot-smartphone']);
    expect(probeAgent('bingbot').userAgent).toBe(USER_AGENT_TEMPLATES.bingbot);
    expect(probeUserAgent(probeAgent('googlebot'), '140.0.7339.80')).toBe(
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    );
    expect(probeUserAgent(probeAgent('bingbot'), 'garbage')).toContain('Chrome/0.0.0.0');
    // The AI crawlers' published strings, verbatim.
    expect(probeUserAgent(probeAgent('gptbot'), '1.2.3.4')).toContain('GPTBot/1.1; +https://openai.com/gptbot');
    expect(probeUserAgent(probeAgent('claudebot'), '1.2.3.4')).toContain('ClaudeBot/1.0; +claudebot@anthropic.com');
    expect(probeUserAgent(probeAgent('perplexitybot'), '1.2.3.4')).toContain('PerplexityBot/1.0; +https://perplexity.ai/perplexitybot');
    for (const agent of PROBE_AGENTS) {
      if (agent.id !== 'browser') {
        expect(agent.userAgent, agent.id).toMatch(/^[\x20-\x7e]+$/);
        expect(agent.metaNames, agent.id).toEqual(['robots', agent.id]);
        expect(agent.robotsToken.toLowerCase(), agent.id).toBe(agent.id);
      }
      expect(agent.label.length, agent.id).toBeGreaterThan(0);
    }
    expect(PROBE_AGENTS.filter((agent) => agent.kind === 'ai').map((agent) => agent.robotsToken)).toEqual(['GPTBot', 'ClaudeBot', 'PerplexityBot']);
    expect(PROBE_AGENTS.filter((agent) => agent.kind === 'search').map((agent) => agent.robotsToken)).toEqual(['Googlebot', 'bingbot']);
    // The honesty note, always beside the fetch disclosure.
    expect(PROBE_HONESTY_NOTE).toMatch(/user-agent/i);
    expect(PROBE_HONESTY_NOTE).toMatch(/network/);
    expect(PROBE_HONESTY_NOTE).toMatch(/render/);
    expect(PROBE_HONESTY_NOTE).toMatch(/verify/);
    expect(PROBE_DISCLOSURE).toContain(PROBE_HONESTY_NOTE);
    expect(PROBE_DISCLOSURE).toContain(FETCH_DISCLOSURE);
  });

  test('probes-per-agent-robots', () => {
    const file = ['User-agent: *', 'Disallow: /private', '', 'User-agent: GPTBot', 'Disallow: /guide/', '', 'User-agent: Googlebot', 'Allow: /'].join('\n');
    const answer = robotsVerdicts(robotsFetch(file), PAGE);
    expect(ProbeRobotsAnswerSchema.safeParse(answer).success).toBe(true);
    expect(answer.outcome).toBe('ok');
    expect(answer.verdicts.gptbot).toEqual({ verdict: 'disallowed', rule: { allow: false, raw: '/guide/', line: 5 }, groupAgents: ['GPTBot'], groupLine: 4, fallback: false });
    expect(answer.verdicts.googlebot).toMatchObject({ verdict: 'allowed', rule: { allow: true, raw: '/' }, groupAgents: ['Googlebot'], fallback: false });
    // The browser by `*`; the other crawlers fall back to `*`.
    expect(answer.verdicts.browser).toMatchObject({ verdict: 'allowed', rule: null, groupAgents: ['*'], groupLine: 1, fallback: false });
    for (const id of ['bingbot', 'claudebot', 'perplexitybot'] as const) expect(answer.verdicts[id], id).toMatchObject({ verdict: 'allowed', rule: null, groupAgents: ['*'], fallback: true });
    // No file to obey: allowed; unreadable: unknown (crawlers assume disallowed); none asked: unknown.
    const none = robotsVerdicts(robotsFetch(null, 'unavailable'), PAGE);
    for (const id of PROBE_AGENT_IDS) expect(none.verdicts[id].verdict, id).toBe('allowed');
    const down = robotsVerdicts(robotsFetch(null, 'server-error'), PAGE);
    for (const id of PROBE_AGENT_IDS) expect(down.verdicts[id].verdict, id).toBe('unknown');
    expect(robotsVerdicts(null, PAGE)).toMatchObject({ outcome: null, verdicts: { browser: { verdict: 'unknown' }, gptbot: { verdict: 'unknown' } } });
    // Through the worker job (validated there).
    expect(runProbeJob({ kind: 'robots', url: PAGE, robots: robotsFetch(file) })).toEqual({ ok: true, answer });
    expect(runProbeJob({ kind: 'robots', url: PAGE, robots: { outcome: 'ok', body: 'not bytes' } })).toMatchObject({ ok: true, answer: { outcome: null, verdicts: { gptbot: { verdict: 'unknown' } } } });
    expect(runProbeJob({ kind: 'robots', url: 'file:///etc/passwd', robots: null })).toEqual({ ok: false, reason: 'invalid-job' });
  });

  test('probes-agent-scoped-x-robots-tag', () => {
    expect(xRobotsTags('googlebot: noindex').map((tag) => [tag.agent, tag.directives])).toEqual([['googlebot', ['noindex']]]);
    expect(xRobotsTags('noindex, gptbot: nofollow, noarchive').map((tag) => [tag.agent, tag.directives])).toEqual([
      [null, ['noindex']],
      ['gptbot', ['nofollow', 'noarchive']],
    ]);
    expect(xRobotsTags('max-snippet: 20, noindex').map((tag) => [tag.agent, tag.directives])).toEqual([[null, ['max-snippet', 'noindex']]]);
    expect(xRobotsTags(null)).toEqual([]);
    const tags = xRobotsTags('GoogleBot: noindex');
    const google = agentDirectives(probeAgent('googlebot'), null, tags);
    expect(google).toEqual({ metaRobots: null, xRobotsTag: { general: [], agent: ['noindex'] }, noindex: true, nofollow: false });
    for (const id of ['browser', 'bingbot', 'gptbot', 'claudebot', 'perplexitybot'] as const) expect(agentDirectives(probeAgent(id), null, tags), id).toMatchObject({ xRobotsTag: { general: [], agent: [] }, noindex: false });
    const joined = xRobotsTags('noindex, gptbot: nofollow');
    expect(agentDirectives(probeAgent('gptbot'), null, joined)).toMatchObject({ xRobotsTag: { general: ['noindex'], agent: ['nofollow'] }, noindex: true, nofollow: true });
    expect(agentDirectives(probeAgent('browser'), null, joined)).toMatchObject({ noindex: true, nofollow: false });
    expect(agentDirectives(probeAgent('claudebot'), null, xRobotsTags('claudebot: none'))).toMatchObject({ noindex: true, nofollow: true });
  });

  test('probes-meta-per-agent', () => {
    expect(directivesOf(' NoIndex , max-snippet:20,, follow ')).toEqual(['noindex', 'max-snippet', 'follow']);
    const metas = [
      { name: 'claudebot', content: 'noindex' },
      { name: 'robots', content: 'noarchive' },
      { name: 'otherbot', content: 'noindex, nofollow' },
    ];
    expect(agentDirectives(probeAgent('claudebot'), metas, [])).toEqual({ metaRobots: { general: ['noarchive'], agent: ['noindex'] }, xRobotsTag: { general: [], agent: [] }, noindex: true, nofollow: false });
    for (const id of ['browser', 'googlebot', 'bingbot', 'gptbot', 'perplexitybot'] as const) expect(agentDirectives(probeAgent(id), metas, []), id).toMatchObject({ metaRobots: { general: ['noarchive'], agent: [] }, noindex: false, nofollow: false });
    expect(agentDirectives(probeAgent('browser'), [{ name: 'ROBOTS', content: 'none' }], [])).toMatchObject({ noindex: true, nofollow: true });
  });

  test('probes-page-facts', () => {
    const html = (body: string, head = '') =>
      enc(`<!doctype html><html><head><title> Running  shoes </title><link rel="canonical" href="/guide/shoes"><meta name="claudebot" content="noindex"><meta name="robots" content="max-image-preview:large">${head}</head><body>${body}</body></html>`);
    const job = (body: Uint8Array, extra: Record<string, unknown> = {}) => ({ kind: 'page', agent: 'claudebot', url: PAGE, contentType: 'text/html; charset=utf-8', xRobotsTag: null, link: null, html: true, body, ...extra });
    const result = runProbeJob(job(html('<h1>Best  running shoes</h1><p hidden>secret words</p><script>var x = 1</script><style>p{}</style><p>for\n wet   trails</p>')));
    expect(result.ok).toBe(true);
    const answer = (result as { answer: ProbePageAnswer }).answer;
    expect(ProbePageAnswerSchema.safeParse(answer).success).toBe(true);
    expect(answer).toMatchObject({ kind: 'page', title: 'Running shoes', canonical: 'https://www.example.com/guide/shoes', wordCount: 6, metaRobots: { general: ['max-image-preview'], agent: ['noindex'] }, noindex: true, partial: false });
    // The visible text, as the word count reads it, whitespace collapsed.
    expect(answer.textHash).toBe(createHash('sha256').update('Best running shoes for wet trails', 'utf8').digest('hex'));
    const same = runProbeJob(job(html('<h1>Best running shoes</h1>\n\n<p>for wet trails</p>', '<meta name="x" content="y">')));
    expect((same as { answer: ProbePageAnswer }).answer.textHash).toBe(answer.textHash);
    const other = runProbeJob(job(html('<h1>Best running shoes</h1><p>for dry roads</p>')));
    expect((other as { answer: ProbePageAnswer }).answer.textHash).not.toBe(answer.textHash);
    // No canonical in the HTML: the Link header's.
    const linked = runProbeJob(job(enc('<html><body>hi</body></html>'), { link: '<https://www.example.com/canonical>; rel="canonical"' }));
    expect((linked as { answer: ProbePageAnswer }).answer.canonical).toBe('https://www.example.com/canonical');
    // A non-HTML answer: its headers only.
    const headersOnly = runProbeJob(job(new Uint8Array(), { contentType: 'application/pdf', xRobotsTag: 'claudebot: noindex', html: false }));
    expect(headersOnly).toEqual({
      ok: true,
      answer: { kind: 'page', metaRobots: null, xRobotsTag: { general: [], agent: ['noindex'] }, noindex: true, nofollow: false, canonical: null, title: null, wordCount: null, textHash: null, textTruncated: false, partial: false },
    });
    // An invalid job is refused.
    for (const bad of [null, 'x', { kind: 'page' }, job(enc('x'), { agent: 'evilbot' }), job(enc('x'), { url: 'javascript:alert(1)' }), job('not bytes' as never), job(enc('x'), { html: 'yes' }), { kind: 'eval', code: '1' }]) expect(runProbeJob(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: 'invalid-job' });
  });

  test('probes-diff-against-browser', () => {
    const settled = (agent: ProbeRow['agent'], extra: Partial<ProbeRow> = {}): ProbeRow => ({
      ...pendingRow(agent),
      outcome: 'ok',
      status: 200,
      finalUrl: PAGE,
      robots: { verdict: 'allowed', rule: null, groupAgents: [], groupLine: null, fallback: false },
      metaRobots: { general: [], agent: [] },
      xRobotsTag: { general: [], agent: [] },
      noindex: false,
      nofollow: false,
      canonical: PAGE,
      contentType: 'text/html',
      bytes: 10_000,
      wordCount: 1_000,
      textHash: 'a'.repeat(64),
      title: 'Shoes',
      durationMs: 5,
      ...extra,
    });
    const base = settled('browser');
    expect(ProbeRowSchema.safeParse(base).success).toBe(true);
    expect(ProbeRowSchema.safeParse(pendingRow('gptbot')).success).toBe(true);
    expect(diffRow(base, settled('bingbot'))).toEqual({ agent: 'bingbot', facts: [] });
    // A redirect for one agent only.
    expect(diffRow(base, settled('googlebot', { hops: [{ url: PAGE, status: 301 }], finalUrl: 'https://m.example.com/guide/shoes' }))?.facts).toEqual(['finalUrl', 'redirects']);
    // robots.txt disallows GPTBot only.
    expect(diffRow(base, settled('gptbot', { robots: { verdict: 'disallowed', rule: { allow: false, raw: '/', line: 2 }, groupAgents: ['GPTBot'], groupLine: 1, fallback: false } }))?.facts).toEqual(['robots']);
    expect(diffRow(base, settled('googlebot', { noindex: true }))?.facts).toEqual(['noindex']);
    expect(diffRow(base, settled('claudebot', { canonical: 'https://www.example.com/other' }))?.facts).toEqual(['canonical']);
    // Smaller content: beyond the tolerance, word count, size and text; within it, the text only.
    expect(diffRow(base, settled('perplexitybot', { wordCount: 200, bytes: 3_000, textHash: 'b'.repeat(64) }))?.facts).toEqual(['wordCount', 'bytes', 'text']);
    const within = 1 - PROBE_DIFF_TOLERANCE.wordShare / 2;
    expect(diffRow(base, settled('perplexitybot', { wordCount: Math.round(1_000 * within), bytes: 9_500, textHash: 'b'.repeat(64) }))?.facts).toEqual(['text']);
    // A failed request: its status differs; content facts need both bodies.
    const failed = { ...pendingRow('gptbot'), outcome: 'http-status' as const, status: 403, finalUrl: PAGE, robots: base.robots, metaRobots: null, xRobotsTag: { general: [], agent: [] }, noindex: false, nofollow: false };
    expect(diffRow(base, failed)?.facts).toEqual(['status']);
    const unreachable = { ...pendingRow('gptbot'), outcome: 'unreachable' as const, robots: base.robots };
    expect(diffRow(base, unreachable)?.facts).toEqual(['status', 'finalUrl']);
    // Unsettled rows (or an unsettled baseline): no diff.
    expect(diffRow(base, pendingRow('gptbot'))).toBeNull();
    expect(diffRow(base, { ...pendingRow('gptbot'), outcome: 'stopped' })).toBeNull();
    expect(diffRow(pendingRow('browser'), settled('gptbot'))).toBeNull();
    // Every fact at once, in `PROBE_DIFF_FACTS` order; `diffsOf` skips the baseline.
    const all = settled('gptbot', { status: 203, finalUrl: `${PAGE}#x`, hops: [{ url: PAGE, status: 302 }], robots: { verdict: 'unknown', rule: null, groupAgents: [], groupLine: null, fallback: false }, noindex: true, canonical: null, wordCount: 0, bytes: 0, textHash: 'c'.repeat(64) });
    expect(diffRow(base, all)?.facts).toEqual([...PROBE_DIFF_FACTS]);
    const diffs = diffsOf([base, settled('googlebot'), all, pendingRow('claudebot')]);
    expect(diffs).toEqual([
      { agent: 'googlebot', facts: [] },
      { agent: 'gptbot', facts: [...PROBE_DIFF_FACTS] },
    ]);
    for (const diff of diffs) expect(ProbeDiffSchema.safeParse(diff).success).toBe(true);
    expect(diffsOf([settled('googlebot')])).toEqual([]);
  });
});
