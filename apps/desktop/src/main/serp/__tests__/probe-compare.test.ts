// Spec: specs/visibility-probes.spec.ts (PROBE_AGENTS, PROBE_AGENT_IDS, probeUserAgent, PROBE_LIMITS, PROBE_DIFF_TOLERANCE,
// PROBE_TEXT_SIMILARITY, PROBE_DIFF_FACTS, PROBE_DISCLOSURE, PROBE_MODELLED_DIRECTIVES_NOTE, PROBE_CANONICAL_CONFLICTS),
// specs/visibility-probes.schema.ts (ProbeRowSchema, ProbeDiffSchema, ProbeRobotsAnswerSchema, ProbePageAnswerSchema),
// specs/render-profile.spec.ts (USER_AGENT_TEMPLATES), specs/fetcher.spec.ts (FETCH_DISCLOSURE)
// Acceptance: specs/visibility-probes.feature.md (Agents and reading)
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { FETCH_DISCLOSURE } from '@app/specs/fetcher.spec';
import { USER_AGENT_TEMPLATES } from '@app/specs/render-profile.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import {
  PROBE_AGENT_IDS,
  PROBE_AGENTS,
  PROBE_BASELINE,
  PROBE_DIFF_FACTS,
  PROBE_DIFF_TOLERANCE,
  PROBE_DISCLOSURE,
  PROBE_LIMITS,
  PROBE_MODELLED_DIRECTIVES_NOTE,
  PROBE_TEXT_SIMILARITY,
  probeAgent,
  probeUserAgent,
} from '@app/specs/visibility-probes.spec';
import { ProbeDiffSchema, ProbePageAnswerSchema, ProbeRobotsAnswerSchema, ProbeRowSchema, type ProbePageAnswer, type ProbeRow } from '@app/specs/visibility-probes.schema';
import { agentDirectives, canonicalsOf, diffRow, diffsOf, directivesOf, pendingRow, robotsVerdict, textSimilarity, xRobotsTags } from '../probe-compare';
import { runProbeJob, textSignature } from '../probe-parse';

const PAGE = 'https://www.example.com/guide/shoes?size=9';
const ROBOTS_URL = 'https://www.example.com/robots.txt';
const enc = (text: string) => new TextEncoder().encode(text);
const robotsFetch = (text: string | null, outcome: RobotsFetch['outcome'] = 'ok', url = ROBOTS_URL): RobotsFetch => ({
  url,
  outcome,
  status: outcome === 'ok' ? 200 : outcome === 'unavailable' ? 404 : null,
  finalUrl: outcome === 'ok' ? url : null,
  redirects: 0,
  body: text === null ? new Uint8Array() : enc(text),
  truncated: false,
});
const answerOf = (result: ReturnType<typeof runProbeJob>): ProbePageAnswer => {
  expect(result.ok).toBe(true);
  return (result as { answer: ProbePageAnswer }).answer;
};

describe('probe agents and reading', () => {
  test('probes-agent-table', () => {
    expect(PROBE_AGENTS.map((agent) => agent.id)).toEqual([...PROBE_AGENT_IDS]);
    expect(PROBE_AGENT_IDS).toEqual(['browser', 'googlebot', 'bingbot', 'gptbot', 'claudebot', 'perplexitybot']);
    expect(PROBE_BASELINE).toBe('browser');
    expect(PROBE_AGENTS.length).toBeLessThanOrEqual(PROBE_LIMITS.maxFetches);
    expect(PROBE_LIMITS).toMatchObject({ maxFetches: 6, maxRedirects: 3, maxRequests: 6 * (1 + 3), maxConcurrent: 2, maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000, maxRunsPerTab: 1 });
    const browser = probeAgent('browser');
    expect(browser).toMatchObject({ kind: 'browser', userAgent: null, robotsToken: '*', metaNames: ['robots'], directives: 'documented' });
    expect(probeUserAgent(browser, '140.0.7339.80')).toBeNull();
    // The render profiles' crawler strings, with the app's Chromium version.
    expect(probeAgent('googlebot').userAgent).toBe(USER_AGENT_TEMPLATES['googlebot-smartphone']);
    expect(probeAgent('bingbot').userAgent).toBe(USER_AGENT_TEMPLATES.bingbot);
    expect(probeUserAgent(probeAgent('googlebot'), '140.0.7339.80')).toBe(
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    );
    expect(probeUserAgent(probeAgent('bingbot'), 'garbage')).toContain('Chrome/0.0.0.0');
    // The AI crawlers' strings, verbatim.
    expect(probeUserAgent(probeAgent('gptbot'), '1.2.3.4')).toContain('GPTBot/1.1; +https://openai.com/gptbot');
    expect(probeUserAgent(probeAgent('claudebot'), '1.2.3.4')).toContain('ClaudeBot/1.0; +claudebot@anthropic.com');
    expect(probeUserAgent(probeAgent('perplexitybot'), '1.2.3.4')).toContain('PerplexityBot/1.0; +https://perplexity.ai/perplexitybot');
    for (const agent of PROBE_AGENTS) {
      if (agent.id !== 'browser') {
        expect(agent.userAgent, agent.id).toMatch(/^[\x20-\x7e]+$/);
        expect(agent.metaNames, agent.id).toEqual(['robots', agent.id]);
        expect(agent.robotsToken.toLowerCase(), agent.id).toBe(agent.id);
      }
      // Only the search crawlers' meta / header handling is documented; the AI crawlers' is frost's model.
      expect(agent.directives, agent.id).toBe(agent.kind === 'ai' ? 'frost-model' : 'documented');
      expect(agent.label.length, agent.id).toBeGreaterThan(0);
    }
    expect(PROBE_AGENTS.filter((agent) => agent.kind === 'ai').map((agent) => agent.robotsToken)).toEqual(['GPTBot', 'ClaudeBot', 'PerplexityBot']);
    expect(PROBE_AGENTS.filter((agent) => agent.kind === 'search').map((agent) => agent.robotsToken)).toEqual(['Googlebot', 'bingbot']);
    expect(PROBE_MODELLED_DIRECTIVES_NOTE).toMatch(/robots\.txt/);
    expect(PROBE_MODELLED_DIRECTIVES_NOTE).toMatch(/model/);
    // One disclosure: the user agent alone, the request count, robots.txt reported not obeyed, the firewall risk, the fetch disclosure.
    expect(PROBE_DISCLOSURE).toMatch(/user-agent/i);
    expect(PROBE_DISCLOSURE).toMatch(/network/);
    expect(PROBE_DISCLOSURE).toMatch(/render/);
    expect(PROBE_DISCLOSURE).toMatch(/verify/);
    expect(PROBE_DISCLOSURE).toContain(`at most ${PROBE_LIMITS.maxFetches} requests`);
    expect(PROBE_DISCLOSURE).toContain(`up to ${PROBE_LIMITS.maxRedirects} redirects`);
    expect(PROBE_DISCLOSURE).toMatch(/reported, not obeyed/);
    expect(PROBE_DISCLOSURE).toMatch(/bot protection/);
    expect(PROBE_DISCLOSURE).toContain(FETCH_DISCLOSURE);
  });

  test('probes-per-agent-robots', () => {
    const file = ['User-agent: *', 'Disallow: /private', '', 'User-agent: GPTBot', 'Disallow: /guide/', '', 'User-agent: Googlebot', 'Allow: /'].join('\n');
    const fetched = robotsFetch(file);
    const gpt = robotsVerdict(fetched, 'gptbot', PAGE);
    expect(ProbeRobotsAnswerSchema.safeParse(gpt).success).toBe(true);
    expect(gpt).toEqual({ kind: 'robots', outcome: 'ok', robots: { url: ROBOTS_URL, verdict: 'disallowed', rule: { allow: false, raw: '/guide/', line: 5 }, groupAgents: ['GPTBot'], groupLine: 4, fallback: false } });
    expect(robotsVerdict(fetched, 'googlebot', PAGE).robots).toMatchObject({ verdict: 'allowed', rule: { allow: true, raw: '/' }, groupAgents: ['Googlebot'], fallback: false });
    // The browser by `*`; the other crawlers fall back to `*`.
    expect(robotsVerdict(fetched, 'browser', PAGE).robots).toMatchObject({ verdict: 'allowed', rule: null, groupAgents: ['*'], groupLine: 1, fallback: false });
    for (const id of ['bingbot', 'claudebot', 'perplexitybot'] as const) expect(robotsVerdict(fetched, id, PAGE).robots, id).toMatchObject({ verdict: 'allowed', rule: null, groupAgents: ['*'], fallback: true });
    // Each agent is judged on the URL it ended on.
    expect(robotsVerdict(fetched, 'browser', 'https://www.example.com/private/x').robots.verdict).toBe('disallowed');
    expect(robotsVerdict(fetched, 'gptbot', 'https://www.example.com/about').robots.verdict).toBe('allowed');
    // Another origin's file never judges this URL.
    expect(robotsVerdict(fetched, 'gptbot', 'https://m.example.com/guide/shoes')).toMatchObject({ outcome: null, robots: { url: null, verdict: 'unknown' } });
    // No file to obey: allowed; unreadable: unknown (crawlers assume disallowed); none asked: unknown.
    for (const id of PROBE_AGENT_IDS) expect(robotsVerdict(robotsFetch(null, 'unavailable'), id, PAGE).robots.verdict, id).toBe('allowed');
    for (const id of PROBE_AGENT_IDS) expect(robotsVerdict(robotsFetch(null, 'server-error'), id, PAGE).robots.verdict, id).toBe('unknown');
    expect(robotsVerdict(null, 'gptbot', PAGE)).toMatchObject({ outcome: null, robots: { verdict: 'unknown', url: null } });
    // Through the worker job (validated there).
    expect(runProbeJob({ kind: 'robots', agent: 'gptbot', url: PAGE, robots: fetched })).toEqual({ ok: true, answer: gpt });
    expect(runProbeJob({ kind: 'robots', agent: 'gptbot', url: PAGE, robots: { outcome: 'ok', body: 'not bytes' } })).toMatchObject({ ok: true, answer: { outcome: null, robots: { verdict: 'unknown' } } });
    expect(runProbeJob({ kind: 'robots', agent: 'gptbot', url: 'file:///etc/passwd', robots: null })).toEqual({ ok: false, reason: 'invalid-job' });
    expect(runProbeJob({ kind: 'robots', url: PAGE, robots: null })).toEqual({ ok: false, reason: 'invalid-job' });
  });

  test('probes-agent-scoped-x-robots-tag', () => {
    expect(xRobotsTags('googlebot: noindex').map((tag) => [tag.agent, tag.directives])).toEqual([['googlebot', ['noindex']]]);
    expect(xRobotsTags('noindex, gptbot: nofollow, noarchive').map((tag) => [tag.agent, tag.directives])).toEqual([
      [null, ['noindex']],
      ['gptbot', ['nofollow', 'noarchive']],
    ]);
    expect(xRobotsTags('max-snippet: 20, noindex').map((tag) => [tag.agent, tag.directives])).toEqual([[null, ['max-snippet', 'noindex']]]);
    expect(xRobotsTags(null)).toEqual([]);
    // Repeated headers, kept apart by the fetcher: a scoped value never swallows the next one.
    expect(xRobotsTags('googlebot: nofollow\nnoindex').map((tag) => [tag.agent, tag.directives])).toEqual([
      ['googlebot', ['nofollow']],
      [null, ['noindex']],
    ]);
    const repeated = xRobotsTags('googlebot: nofollow\nnoindex');
    expect(agentDirectives(probeAgent('googlebot'), null, repeated)).toMatchObject({ xRobotsTag: { general: ['noindex'], agent: ['nofollow'] }, noindex: true, nofollow: true });
    for (const id of ['browser', 'bingbot', 'gptbot', 'claudebot', 'perplexitybot'] as const) expect(agentDirectives(probeAgent(id), null, repeated), id).toMatchObject({ xRobotsTag: { general: ['noindex'], agent: [] }, noindex: true, nofollow: false });
    const tags = xRobotsTags('GoogleBot: noindex');
    const google = agentDirectives(probeAgent('googlebot'), null, tags);
    expect(google).toEqual({ metaRobots: null, xRobotsTag: { general: [], agent: ['noindex'] }, noindex: true, nofollow: false });
    for (const id of ['browser', 'bingbot', 'gptbot', 'claudebot', 'perplexitybot'] as const) expect(agentDirectives(probeAgent(id), null, tags), id).toMatchObject({ xRobotsTag: { general: [], agent: [] }, noindex: false });
    const joined = xRobotsTags('noindex, gptbot: nofollow');
    expect(agentDirectives(probeAgent('gptbot'), null, joined)).toMatchObject({ xRobotsTag: { general: ['noindex'], agent: ['nofollow'] }, noindex: true, nofollow: true });
    expect(agentDirectives(probeAgent('browser'), null, joined)).toMatchObject({ noindex: true, nofollow: false });
    expect(agentDirectives(probeAgent('claudebot'), null, xRobotsTags('claudebot: none'))).toMatchObject({ noindex: true, nofollow: true });
    // Through the worker's page job.
    const job = { kind: 'page', agent: 'bingbot', url: PAGE, contentType: 'application/pdf', xRobotsTag: 'googlebot: nofollow\nnoindex', link: null, html: false, body: new Uint8Array() };
    expect(answerOf(runProbeJob(job))).toMatchObject({ noindex: true, nofollow: false, xRobotsTag: { general: ['noindex'], agent: [] } });
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
    const answer = answerOf(runProbeJob(job(html('<h1>Best  running shoes</h1><p hidden>secret words</p><script>var x = 1</script><style>p{}</style><p>for\n wet   trails</p>'))));
    expect(ProbePageAnswerSchema.safeParse(answer).success).toBe(true);
    expect(answer).toMatchObject({
      kind: 'page',
      title: 'Running shoes',
      canonical: 'https://www.example.com/guide/shoes',
      canonicals: { html: ['https://www.example.com/guide/shoes'], header: null, conflicts: [] },
      wordCount: 6,
      metaRobots: { general: ['max-image-preview'], agent: ['noindex'] },
      noindex: true,
      partial: false,
      textTruncated: false,
    });
    // The visible text, as the word count reads it, whitespace collapsed: its hash and its signature.
    expect(answer.textHash).toBe(createHash('sha256').update('Best running shoes for wet trails', 'utf8').digest('hex'));
    expect(answer.textSignature).toEqual(textSignature('Best running shoes for wet trails'));
    expect(answer.textSignature).toHaveLength(PROBE_TEXT_SIMILARITY.signatureSize);
    const same = answerOf(runProbeJob(job(html('<h1>Best running shoes</h1>\n\n<p>for wet trails</p>', '<meta name="x" content="y">'))));
    expect(same.textHash).toBe(answer.textHash);
    expect(same.textSignature).toEqual(answer.textSignature);
    const other = answerOf(runProbeJob(job(html('<h1>Best running shoes</h1><p>for dry roads</p>'))));
    expect(other.textHash).not.toBe(answer.textHash);
    // Canonical conflicts are reported: several HTML ones, and HTML against the Link header.
    const several = answerOf(runProbeJob(job(html('<p>x</p>', '<link rel="canonical" href="https://www.example.com/other">'), { link: '<https://www.example.com/from-header>; rel="canonical"' })));
    expect(several).toMatchObject({ canonical: 'https://www.example.com/guide/shoes', canonicals: { html: ['https://www.example.com/guide/shoes', 'https://www.example.com/other'], header: 'https://www.example.com/from-header', conflicts: ['several-html', 'html-vs-header'] } });
    expect(canonicalsOf(['https://a.example/', 'https://a.example/'], 'https://a.example/')).toEqual({ canonical: 'https://a.example/', canonicals: { html: ['https://a.example/'], header: 'https://a.example/', conflicts: [] } });
    // No canonical in the HTML: the Link header's.
    const linked = answerOf(runProbeJob(job(enc('<html><body>hi</body></html>'), { link: '<https://www.example.com/canonical>; rel="canonical"' })));
    expect(linked.canonical).toBe('https://www.example.com/canonical');
    // A non-HTML answer: its headers only, its Link canonical kept.
    const headersOnly = runProbeJob(job(new Uint8Array(), { contentType: 'application/pdf', xRobotsTag: 'claudebot: noindex', link: '</guide/shoes.pdf>; rel="canonical"', html: false }));
    expect(headersOnly).toEqual({
      ok: true,
      answer: {
        kind: 'page',
        metaRobots: null,
        xRobotsTag: { general: [], agent: ['noindex'] },
        noindex: true,
        nofollow: false,
        canonical: 'https://www.example.com/guide/shoes.pdf',
        canonicals: { html: [], header: 'https://www.example.com/guide/shoes.pdf', conflicts: [] },
        title: null,
        wordCount: null,
        textHash: null,
        textSignature: null,
        textTruncated: false,
        partial: false,
      },
    });
    // An invalid job is refused.
    for (const bad of [null, 'x', { kind: 'page' }, job(enc('x'), { agent: 'evilbot' }), job(enc('x'), { url: 'javascript:alert(1)' }), job('not bytes' as never), job(enc('x'), { html: 'yes' }), { kind: 'eval', code: '1' }]) expect(runProbeJob(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: 'invalid-job' });
  });

  test('probes-text-similarity', () => {
    const base = 'the quick brown fox jumps over the lazy dog near the quiet river bank on a sunny morning in late spring while birds sing';
    expect(textSimilarity(textSignature(base), textSignature(base))).toBe(1);
    expect(textSimilarity(textSignature(base), textSignature(base.toUpperCase()))).toBe(1);
    // A small edit stays similar; another text is not.
    const edited = base.replace('sunny', 'cloudy');
    expect(textSimilarity(textSignature(base), textSignature(edited))).toBeGreaterThan(0.5);
    expect(textSimilarity(textSignature(base), textSignature('completely different words about trail running shoes and their soles'))).toBeLessThan(0.2);
    // Short and empty texts.
    expect(textSignature('')).toBeNull();
    expect(textSignature('one two')).toHaveLength(PROBE_TEXT_SIMILARITY.signatureSize);
    expect(textSimilarity(null, null)).toBe(1);
    expect(textSimilarity(textSignature('one'), null)).toBe(0);
    // Fixed seeds: the same text signs the same in every run.
    expect(textSignature('fixed seeds')).toEqual(textSignature('fixed seeds'));
  });

  test('probes-diff-against-browser', () => {
    const signature = textSignature('best running shoes for wet trails and muddy hills in winter');
    const settled = (agent: ProbeRow['agent'], extra: Partial<ProbeRow> = {}): ProbeRow => ({
      ...pendingRow(agent),
      outcome: 'ok',
      status: 200,
      finalUrl: PAGE,
      robots: { url: ROBOTS_URL, verdict: 'allowed', rule: null, groupAgents: [], groupLine: null, fallback: false },
      metaRobots: { general: [], agent: [] },
      xRobotsTag: { general: [], agent: [] },
      noindex: false,
      nofollow: false,
      canonical: PAGE,
      canonicals: { html: [PAGE], header: null, conflicts: [] },
      contentType: 'text/html',
      bytes: 10_000,
      wordCount: 1_000,
      textHash: 'a'.repeat(64),
      textSignature: signature,
      title: 'Shoes',
      durationMs: 5,
      ...extra,
    });
    const base = settled('browser');
    expect(ProbeRowSchema.safeParse(base).success).toBe(true);
    expect(ProbeRowSchema.safeParse(pendingRow('gptbot')).success).toBe(true);
    expect(diffRow(base, settled('bingbot'))).toEqual({ agent: 'bingbot', facts: [], textSimilarity: 1, contentTruncated: false });
    // A redirect for one agent only.
    expect(diffRow(base, settled('googlebot', { hops: [{ url: PAGE, status: 301 }], finalUrl: 'https://m.example.com/guide/shoes' }))?.facts).toEqual(['finalUrl', 'redirects']);
    // The same number of hops, but another status or URL, is a redirect difference.
    const hopped = settled('browser', { hops: [{ url: PAGE, status: 301 }] });
    expect(diffRow(hopped, settled('bingbot', { hops: [{ url: PAGE, status: 302 }] }))?.facts).toEqual(['redirects']);
    expect(diffRow(hopped, settled('bingbot', { hops: [{ url: `${PAGE}&x=1`, status: 301 }] }))?.facts).toEqual(['redirects']);
    expect(diffRow(hopped, settled('bingbot', { hops: [{ url: PAGE, status: 301 }] }))?.facts).toEqual([]);
    // robots.txt disallows GPTBot only.
    expect(diffRow(base, settled('gptbot', { robots: { url: ROBOTS_URL, verdict: 'disallowed', rule: { allow: false, raw: '/', line: 2 }, groupAgents: ['GPTBot'], groupLine: 1, fallback: false } }))?.facts).toEqual(['robots']);
    expect(diffRow(base, settled('googlebot', { noindex: true }))?.facts).toEqual(['noindex']);
    expect(diffRow(base, settled('claudebot', { canonical: 'https://www.example.com/other' }))?.facts).toEqual(['canonical']);
    // Smaller content: beyond the tolerance, word count, size and text; within it, and a near-identical text, nothing.
    const otherText = textSignature('a short teaser page asking crawlers to enable javascript first');
    const small = diffRow(base, settled('perplexitybot', { wordCount: 200, bytes: 3_000, textHash: 'b'.repeat(64), textSignature: otherText }));
    expect(small?.facts).toEqual(['wordCount', 'bytes', 'text']);
    expect(small?.textSimilarity).toBeLessThan(PROBE_TEXT_SIMILARITY.minSimilarity);
    const within = 1 - PROBE_DIFF_TOLERANCE.wordShare / 2;
    const near = diffRow(base, settled('perplexitybot', { wordCount: Math.round(1_000 * within), bytes: 9_500, textHash: 'b'.repeat(64), textSignature: signature!.map((value, i) => (i === 0 ? value ^ 1 : value)) }));
    expect(near?.facts).toEqual([]);
    expect(near?.textSimilarity).toBeCloseTo(63 / 64);
    // Cut text: still compared, and the diff says so.
    expect(diffRow(base, settled('gptbot', { textTruncated: true }))).toMatchObject({ facts: [], contentTruncated: true });
    expect(diffRow(settled('browser', { truncated: true }), settled('gptbot'))?.contentTruncated).toBe(true);
    expect(diffRow(base, settled('gptbot', { partial: true }))?.contentTruncated).toBe(true);
    // A failed request: its status differs; no final URL to compare; content facts need both bodies.
    const failed = { ...pendingRow('gptbot'), outcome: 'http-status' as const, status: 403, finalUrl: PAGE, robots: base.robots, xRobotsTag: { general: [], agent: [] }, noindex: false, nofollow: false };
    expect(diffRow(base, failed)).toEqual({ agent: 'gptbot', facts: ['status'], textSimilarity: null, contentTruncated: false });
    const unreachable = { ...pendingRow('gptbot'), outcome: 'unreachable' as const, robots: base.robots };
    expect(diffRow(base, unreachable)?.facts).toEqual(['status']);
    // A non-HTML answer's header canonical is compared with the baseline's.
    const pdf = { ...failed, status: 200, outcome: 'not-html' as const, canonical: 'https://www.example.com/guide.pdf' };
    expect(diffRow(base, pdf)?.facts).toEqual(['canonical']);
    expect(diffRow(base, { ...pdf, canonical: PAGE })?.facts).toEqual([]);
    // Unsettled rows (or an unsettled baseline): no diff.
    expect(diffRow(base, pendingRow('gptbot'))).toBeNull();
    expect(diffRow(base, { ...pendingRow('gptbot'), outcome: 'stopped' })).toBeNull();
    expect(diffRow(pendingRow('browser'), settled('gptbot'))).toBeNull();
    // Every fact at once, in `PROBE_DIFF_FACTS` order; `diffsOf` skips the baseline.
    const all = settled('gptbot', {
      status: 203,
      finalUrl: `${PAGE}#x`,
      hops: [{ url: PAGE, status: 302 }],
      robots: { url: ROBOTS_URL, verdict: 'unknown', rule: null, groupAgents: [], groupLine: null, fallback: false },
      noindex: true,
      canonical: null,
      wordCount: 0,
      bytes: 0,
      textHash: 'c'.repeat(64),
      textSignature: null,
    });
    expect(diffRow(base, all)?.facts).toEqual([...PROBE_DIFF_FACTS]);
    const diffs = diffsOf([base, settled('googlebot'), all, pendingRow('claudebot')]);
    expect(diffs.map((diff) => [diff.agent, diff.facts])).toEqual([
      ['googlebot', []],
      ['gptbot', [...PROBE_DIFF_FACTS]],
    ]);
    for (const diff of diffs) expect(ProbeDiffSchema.safeParse(diff).success).toBe(true);
    expect(diffsOf([settled('googlebot')])).toEqual([]);
  });
});
