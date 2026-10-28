// Spec: specs/agent-search-tools.spec.ts (SEARCH_TOOL_LIMITS, SEARCH_TOOL_SOURCES, SEARCH_TOOL_TIMEOUT_MS,
// PORT_NOT_CONNECTED_REASONS, GSC_NO_PAGE_REASON) · specs/agent-tools.spec.ts (AGENT_TOOL_INPUT_LIMITS) ·
// packages/ai-skills/src/ports.ts (the ports and their fakes)
// Acceptance: specs/agent-search-tools.feature.md (Handlers)
import { afterEach, describe, expect, test, vi } from 'vitest';
import { unavailable, type PortAnswer, type SerpResults } from '@app/ai-skills';
import { createFakeGscPort, createFakeIntentPort, createFakeSerpPort, FAKE_AI_SEARCH_ANSWER, FAKE_GSC_PERFORMANCE, FAKE_INTENT, FAKE_SERP_RESULTS } from '@app/ai-skills/fakes';
import type { ToolRunVia } from '@app/specs/agent-approvals.spec';
import type { JsonValue } from '@app/specs/agent-protocol.schema';
import { GSC_NO_PAGE_REASON, PORT_NOT_CONNECTED_REASONS, SEARCH_TOOL_LIMITS as L, SEARCH_TOOL_SOURCES, SEARCH_TOOL_TIMEOUT_MS } from '@app/specs/agent-search-tools.spec';
import { AGENT_TOOL_INPUT_LIMITS } from '@app/specs/agent-tools.spec';
import type { ToolRunContext, ToolRunOutcome } from '../approvals';
import { resolveAgentPorts } from '../ports';
import { createPageToolRunner, type PageContents, type PageToolDeps } from '../tools';

const TAB = 3;
const TAB_URL = 'https://shop.example.com/tea?x=1#reviews';

afterEach(() => {
  vi.useRealTimers();
});

function runner(ports: PageToolDeps['ports'], tabUrl: string | null = TAB_URL) {
  const contents: PageContents = { executeJavaScriptInIsolatedWorld: async () => null, getURL: () => tabUrl ?? '', isDestroyed: () => false };
  return createPageToolRunner({
    contentsOf: (tabId) => (tabId === TAB && tabUrl !== null ? contents : null),
    audit: () => ({ status: 'pending', url: '' }),
    navigate: async () => ({ status: 'no-tab' }),
    ...(ports ? { ports } : {}),
  });
}

const ctx = (via: ToolRunVia = 'read', signal: AbortSignal = new AbortController().signal): ToolRunContext => ({ tabId: TAB, signal, via, expectedOrigin: null, expectedUrl: null });
const run = (tools: ReturnType<typeof runner>, toolName: string, input: Record<string, unknown>, context: ToolRunContext = ctx(toolName === 'run_ai_search' ? 'approval' : 'read')) =>
  tools.run(toolName, input as JsonValue, context);

const dataOf = (outcome: ToolRunOutcome) => {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  return (outcome as { data: Record<string, any> }).data;
};

const CALLS = [
  ['serp_results', { query: 'green tea' }],
  ['search_intent', { query: 'buy green tea' }],
  ['run_ai_search', { query: 'best green tea' }],
  ['gsc_performance', {}],
] as const;

describe('search tools', () => {
  test('search-tools-unavailable-without-a-port', async () => {
    const none = runner(undefined);
    for (const [tool, input] of CALLS) expect(await run(none, tool, input)).toEqual({ ok: false, code: 'unavailable' });
    const nulls = runner({ serp: null, intent: null, gsc: null });
    for (const [tool, input] of CALLS) expect(await run(nulls, tool, input)).toEqual({ ok: false, code: 'unavailable' });
    // Main's defaults: each tool tells the model the data isn't connected in this build.
    const defaults = runner(resolveAgentPorts());
    const reasons = { serp_results: PORT_NOT_CONNECTED_REASONS.serp, run_ai_search: PORT_NOT_CONNECTED_REASONS.serp, search_intent: PORT_NOT_CONNECTED_REASONS.intent, gsc_performance: PORT_NOT_CONNECTED_REASONS.gsc };
    for (const [tool, input] of CALLS) expect(await run(defaults, tool, input)).toEqual({ ok: true, data: { unavailable: reasons[tool] }, source: SEARCH_TOOL_SOURCES[tool] });
  });

  test('search-tools-map-the-fakes', async () => {
    const serp = createFakeSerpPort();
    const intent = createFakeIntentPort();
    const gsc = createFakeGscPort();
    const tools = runner({ serp, intent, gsc });

    const results = await run(tools, 'serp_results', { query: 'green tea', locale: 'en-us', device: 'mobile' });
    expect(results).toMatchObject({ ok: true, source: SEARCH_TOOL_SOURCES.serp_results });
    expect(dataOf(results)).toEqual({
      query: 'green tea',
      locale: 'en-US',
      device: 'mobile',
      fetchedAt: FAKE_SERP_RESULTS.fetchedAt,
      results: FAKE_SERP_RESULTS.results,
      resultsTotal: FAKE_SERP_RESULTS.results.length,
      features: FAKE_SERP_RESULTS.features,
      featuresTotal: FAKE_SERP_RESULTS.features.length,
    });
    expect(serp.calls[0]).toEqual({ method: 'results', query: { query: 'green tea', locale: 'en-US', device: 'mobile' } });

    expect(dataOf(await run(tools, 'run_ai_search', { query: 'best green tea' }))).toEqual({
      query: 'best green tea',
      answer: FAKE_AI_SEARCH_ANSWER.answer,
      answerTruncated: false,
      citations: FAKE_AI_SEARCH_ANSWER.citations,
      citationsTotal: 1,
      fetchedAt: FAKE_AI_SEARCH_ANSWER.fetchedAt,
    });
    expect(serp.calls[1]).toEqual({ method: 'aiSearch', query: { query: 'best green tea' } });

    expect(dataOf(await run(tools, 'search_intent', { query: 'buy green tea' }))).toEqual({ query: 'buy green tea', primary: FAKE_INTENT.primary, intents: FAKE_INTENT.intents });
    expect(intent.calls).toEqual([{ query: 'buy green tea' }]);

    // No url: the tab's page without its fragment, over the default days.
    const performance = dataOf(await run(tools, 'gsc_performance', {}));
    expect(performance).toEqual({ ...FAKE_GSC_PERFORMANCE, url: 'https://shop.example.com/tea?x=1', days: AGENT_TOOL_INPUT_LIMITS.defaultGscDays, queriesTotal: 1 });
    expect(gsc.calls[0]).toEqual({ url: 'https://shop.example.com/tea?x=1', days: AGENT_TOOL_INPUT_LIMITS.defaultGscDays });
    await run(tools, 'gsc_performance', { url: 'https://shop.example.com/other#frag', days: 90 });
    expect(gsc.calls[1]).toEqual({ url: 'https://shop.example.com/other', days: 90 });
    // Input is re-parsed: a bad query never reaches the port.
    expect(await run(tools, 'serp_results', { query: '' })).toEqual({ ok: false, code: 'invalid-input' });
    expect(serp.calls).toHaveLength(2);
  });

  test('search-tools-explain-unavailable', async () => {
    const reason = `Quota used up‮ for today.\n${'x'.repeat(1000)}`;
    const tools = runner({ serp: createFakeSerpPort({ results: unavailable(reason) }), gsc: createFakeGscPort({ answer: { status: 'unavailable', reason: '' } }) });
    const data = dataOf(await run(tools, 'serp_results', { query: 'tea' }));
    expect(data.unavailable.startsWith('Quota used up for today. xxx')).toBe(true);
    expect(data.unavailable).toHaveLength(L.maxReasonChars);
    expect(Object.keys(data)).toEqual(['unavailable']);
    expect(dataOf(await run(tools, 'gsc_performance', {}))).toEqual({ unavailable: 'This data source gave no reason.' });
  });

  test('search-tools-cap-results', async () => {
    const many: SerpResults = {
      ...FAKE_SERP_RESULTS,
      results: Array.from({ length: 50 }, (_, i) => ({ position: i === 3 ? -1 : i + 1, url: `https://r${i}.example/`, title: 't'.repeat(1000), snippet: `line\nbreak ${'s'.repeat(2000)}` })),
      features: [...Array.from({ length: 40 }, (_, i) => `feature-${i}`), 'f'.repeat(500)],
    };
    const tools = runner({
      serp: createFakeSerpPort({
        results: { status: 'ok', data: many },
        aiSearch: { status: 'ok', data: { ...FAKE_AI_SEARCH_ANSWER, answer: 'a'.repeat(L.maxAnswerChars + 10), citations: Array.from({ length: 30 }, (_, i) => ({ url: `https://c${i}.example/`, title: `C${i}` })) } },
      }),
      intent: createFakeIntentPort({
        answer: { status: 'ok', data: { query: 'q', primary: 'commercial', intents: [{ intent: 'commercial', confidence: 7 }, { intent: 'bogus' as never, confidence: 0.5 }, { intent: 'commercial', confidence: 0.1 }, { intent: 'informational', confidence: Number.NaN }] } },
      }),
      gsc: createFakeGscPort({ answer: { status: 'ok', data: { ...FAKE_GSC_PERFORMANCE, ctr: Number.POSITIVE_INFINITY, position: null, queries: Array.from({ length: 60 }, (_, i) => ({ query: `q${i}`, clicks: i, impressions: 10, ctr: 0.1, position: 2 })) } } }),
    });
    const serp = dataOf(await run(tools, 'serp_results', { query: 'tea' }));
    expect(serp.results).toHaveLength(L.maxSerpResults);
    expect(serp.resultsTotal).toBe(50);
    expect(serp.results[0].title).toHaveLength(L.maxTitleChars);
    expect(serp.results[0].snippet).toHaveLength(L.maxSnippetChars);
    expect(serp.results[0].snippet.startsWith('line break ')).toBe(true);
    // A position that isn't 1-based is replaced by the result's place.
    expect(serp.results[3].position).toBe(4);
    expect(serp.features).toHaveLength(L.maxSerpFeatures);
    expect(serp.featuresTotal).toBe(41);

    const ai = dataOf(await run(tools, 'run_ai_search', { query: 'tea' }));
    expect(ai.answer).toHaveLength(L.maxAnswerChars);
    expect(ai.answerTruncated).toBe(true);
    expect(ai.citations).toHaveLength(L.maxCitations);
    expect(ai.citationsTotal).toBe(30);

    expect(dataOf(await run(tools, 'search_intent', { query: 'tea' })).intents).toEqual([{ intent: 'commercial', confidence: 1 }, { intent: 'informational', confidence: null }]);

    const performance = dataOf(await run(tools, 'gsc_performance', {}));
    expect(performance.queries).toHaveLength(L.maxGscQueries);
    expect(performance.queriesTotal).toBe(60);
    expect(performance).toMatchObject({ ctr: null, position: null });

    // Not the port's shape: the call fails.
    const malformed: [string, PortAnswer<never> | unknown][] = [
      ['serp_results', { status: 'ok', data: { results: 'no' } }],
      ['serp_results', { status: 'maybe' }],
      ['serp_results', null],
      ['search_intent', { status: 'ok', data: { primary: 'bogus', intents: [] } }],
      ['run_ai_search', { status: 'ok', data: { answer: 5, citations: [] } }],
      ['gsc_performance', { status: 'ok', data: { queries: {} } }],
    ];
    for (const [tool, answer] of malformed) {
      const port = { results: async () => answer, aiSearch: async () => answer, classify: async () => answer, performance: async () => answer } as never;
      expect(await run(runner({ serp: port, intent: port, gsc: port }), tool, { query: 'tea' }), `${tool} ${JSON.stringify(answer)}`).toEqual(
        tool === 'gsc_performance' ? { ok: false, code: 'invalid-input' } : { ok: false, code: 'failed' },
      );
    }
    const gscPort = { performance: async () => ({ status: 'ok', data: { queries: {} } }) } as never;
    expect(await run(runner({ gsc: gscPort }), 'gsc_performance', {})).toEqual({ ok: false, code: 'failed' });
    // A port that throws fails the call.
    const throwing = { results: () => { throw new Error('boom https://secret.example/?token=1'); }, aiSearch: async () => Promise.reject(new Error('x')) } as never;
    expect(await run(runner({ serp: throwing }), 'serp_results', { query: 'tea' })).toEqual({ ok: false, code: 'failed' });
    expect(await run(runner({ serp: throwing }), 'run_ai_search', { query: 'tea' })).toEqual({ ok: false, code: 'failed' });
  });

  test('search-tools-abort-propagates', async () => {
    // Stop: the port's signal aborts, and the call fails.
    const seen: AbortSignal[] = [];
    const hanging = {
      results: (_query: unknown, options?: { signal?: AbortSignal }) => {
        seen.push(options!.signal!);
        return new Promise<never>(() => undefined);
      },
    } as never;
    const stop = new AbortController();
    const pending = run(runner({ serp: hanging }), 'serp_results', { query: 'tea' }, ctx('read', stop.signal));
    await Promise.resolve();
    expect(seen[0]!.aborted).toBe(false);
    stop.abort();
    expect(await pending).toEqual({ ok: false, code: 'failed' });
    expect(seen[0]!.aborted).toBe(true);
    // The fake rejects with the signal's reason when it is aborted: still `failed`.
    const fake = createFakeIntentPort();
    const stopFake = new AbortController();
    const fakePending = run(runner({ intent: fake }), 'search_intent', { query: 'tea' }, ctx('read', stopFake.signal));
    stopFake.abort();
    expect(await fakePending).toEqual({ ok: false, code: 'failed' });
    // Already stopped: the port isn't asked.
    const asked = createFakeGscPort();
    const stopped = new AbortController();
    stopped.abort();
    expect(await run(runner({ gsc: asked }), 'gsc_performance', {}, ctx('read', stopped.signal))).toEqual({ ok: false, code: 'failed' });
    expect(asked.calls).toEqual([]);
    // A port that never answers times out, and its signal is aborted then.
    vi.useFakeTimers();
    const slow = run(runner({ serp: hanging }), 'serp_results', { query: 'tea' });
    await vi.advanceTimersByTimeAsync(SEARCH_TOOL_TIMEOUT_MS - 1);
    expect(seen[1]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await slow).toEqual({ ok: false, code: 'timeout' });
    expect(seen[1]!.aborted).toBe(true);
  });

  test('search-tools-gsc-needs-a-page', async () => {
    const gsc = createFakeGscPort();
    for (const tabUrl of [null, '', 'about:blank', 'app://app/newtab']) {
      expect(await run(runner({ gsc }, tabUrl), 'gsc_performance', {})).toEqual({ ok: true, data: { unavailable: GSC_NO_PAGE_REASON }, source: SEARCH_TOOL_SOURCES.gsc_performance });
    }
    expect(gsc.calls).toEqual([]);
    // With a url the tab doesn't matter.
    expect(dataOf(await run(runner({ gsc }, null), 'gsc_performance', { url: 'https://example.com/' })).url).toBe('https://example.com/');
  });

  test('run-ai-search-needs-approval', async () => {
    const serp = createFakeSerpPort();
    const tools = runner({ serp });
    for (const via of ['read', 'grant'] as const) expect(await run(tools, 'run_ai_search', { query: 'tea' }, ctx(via))).toEqual({ ok: false, code: 'not-allowed' });
    expect(serp.calls).toEqual([]);
    expect((await run(tools, 'run_ai_search', { query: 'tea' }, ctx('approval'))).ok).toBe(true);
  });
});
