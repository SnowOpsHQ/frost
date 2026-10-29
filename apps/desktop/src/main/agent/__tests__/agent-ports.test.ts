// Spec: specs/agent-search-tools.spec.ts (PORT_NOT_CONNECTED_REASONS, SEARCH_TOOL_SOURCES) ·
// packages/ai-skills/src/ports.ts (PortAnswer, unavailablePort, fakes) · specs/agent-protocol.schema.ts (tool.result)
// Acceptance: specs/agent-search-tools.feature.md (Wiring)
//
// Phase 3 is merged: its fixtures below are typed with its own types (`SerpReadApi` from
// `@app/ipc-contract`, `SerpState`, `IntentAnswer`, `ProbesState`), and its real intent classifier
// (`main/intent/classifier.ts`) is used for the no-download check. The Phase 4 types are local
// copies of the parts of its read API the adapters see, taken from `phase-4/accounts-telemetry`
// at bc692be (`packages/ipc-contract/src/gsc-service.ts` `GscService`; `specs/gsc.schema.ts`;
// `specs/entitlements-snapshot.spec.ts` `FEATURE_FLAGS`; `EntitlementsReader.requireFeature(flag): void`,
// which throws). Field names and kinds as there; nested objects copied as far as they matter.
import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { createFakeGscPort, createFakeSerpPort } from '@app/ai-skills/fakes';
import type { SerpReadApi } from '@app/ipc-contract';
import { INTENT_MODEL, type IntentAnswer, type IntentEnableOutcome } from '@app/specs/intent-classifier.spec';
import { SERP_RESULT_TYPES, type SerpResultType } from '@app/specs/serp-selector-pack.spec';
import type { SerpState } from '@app/specs/serp-service.schema';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import { createIntentClassifier } from '../../intent/classifier';
import { GSC_NOT_PUBLIC_REASON, PORT_NOT_CONNECTED_REASONS, SEARCH_TOOL_SOURCES } from '@app/specs/agent-search-tools.spec';
import type { AgentFeature } from '../entitlements';
import {
  GSC_ADAPTER_REASONS,
  gscAdapter,
  INTENT_ADAPTER_REASONS,
  intentAdapter,
  nearestGscRange,
  probesAdapter,
  resolveAgentPorts,
  SERP_ADAPTER_REASONS,
  serpAdapter,
  type GscServiceLike,
  type IntentReadApiLike,
  type ProbesReadApiLike,
  type SerpReadApiLike,
} from '../ports';
import type { createAgentService } from '../wire';
import { createPageToolRunner } from '../tools';
import { flush, setupBroker } from './approval-fakes';

describe('agent ports', () => {
  test('agent-ports-default-to-not-connected', async () => {
    const ports = resolveAgentPorts();
    expect(await ports.serp.results({ query: 'tea' })).toEqual({ status: 'unavailable', reason: PORT_NOT_CONNECTED_REASONS.serp });
    expect(await ports.serp.aiSearch({ query: 'tea' })).toEqual({ status: 'unavailable', reason: PORT_NOT_CONNECTED_REASONS.serp });
    expect(await ports.intent.classify({ query: 'tea' })).toEqual({ status: 'unavailable', reason: PORT_NOT_CONNECTED_REASONS.intent });
    expect(await ports.gsc.performance({ url: 'https://example.com/', days: 28 })).toEqual({ status: 'unavailable', reason: PORT_NOT_CONNECTED_REASONS.gsc });
    expect(resolveAgentPorts({ serp: null, intent: undefined }).serp).not.toBeNull();
    const serp = createFakeSerpPort();
    expect(resolveAgentPorts({ serp }).serp).toBe(serp);
    // Honest, plain reasons: no claim the data exists.
    for (const reason of Object.values(PORT_NOT_CONNECTED_REASONS)) expect(reason).toMatch(/(isn't|aren't) connected in this build\.$/);
  });

  test('agent-port-adapters-are-thin', async () => {
    expect(serpAdapter(null)).toBeNull();
    expect(intentAdapter(undefined)).toBeNull();
    expect(gscAdapter(null)).toBeNull();

    // SERP: the chat tab's reading, for the same query only.
    let state: SerpState = READY_STATE;
    const snapshot = vi.fn((_tabId: number): SerpState => state);
    const serp = serpAdapter(phase3ReadApi(snapshot))!;
    const ready = await serp.results({ query: '  Running   SHOES ' }, { tabId: 4 });
    expect(snapshot).toHaveBeenCalledWith(4);
    expect(ready).toEqual({
      status: 'ok',
      data: {
        query: 'running shoes',
        locale: 'en-US',
        device: 'mobile',
        fetchedAt: new Date(1_700_000_000_000).toISOString(),
        results: [
          { position: 1, url: 'https://shoes.example/running', title: 'Running shoes', snippet: '' },
          { position: 2, url: 'https://reviews.example/best', title: 'Best shoes', snippet: '' },
        ],
        features: ['people-also-ask'],
      },
    });
    expect(await serp.results({ query: 'trail shoes' }, { tabId: 4 })).toEqual({ status: 'unavailable', reason: SERP_ADAPTER_REASONS.otherQuery });
    expect(await serp.results({ query: 'running shoes' })).toEqual({ status: 'unavailable', reason: SERP_ADAPTER_REASONS.noTab });
    for (const status of ['not-serp', 'pending', 'unreadable', 'disabled'] as const) {
      state = { ...NOT_READY[status] } as SerpState;
      expect(await serp.results({ query: 'running shoes' }, { tabId: 4 })).toEqual({ status: 'unavailable', reason: SERP_ADAPTER_REASONS[status] });
    }
    snapshot.mockImplementationOnce(() => {
      throw new Error('token=SECRET');
    });
    expect(await serp.results({ query: 'x' }, { tabId: 4 })).toEqual({ status: 'unavailable', reason: SERP_ADAPTER_REASONS.failed });
    // No AI answer read in Phase 3: the tool says so.
    expect(await serp.aiSearch({ query: 'x' }, { tabId: 4 })).toEqual({ status: 'unavailable', reason: SERP_ADAPTER_REASONS.aiSearch });

    // Intent: classifyIntent's labels and scores, most likely first; its states explained.
    let answer: IntentAnswer = { state: 'ready', result: { label: 'commercial', confidence: 0.6, scores: { informational: 0.1, navigational: 0.05, commercial: 0.6, transactional: 0.25 }, model: INTENT_MODEL.id } };
    const intent = intentAdapter(phase3ReadApi(snapshot, async () => answer))!;
    expect(await intent.classify({ query: 'best shoes' })).toEqual({
      status: 'ok',
      data: { query: 'best shoes', primary: 'commercial', intents: [{ intent: 'commercial', confidence: 0.6 }, { intent: 'transactional', confidence: 0.25 }, { intent: 'informational', confidence: 0.1 }, { intent: 'navigational', confidence: 0.05 }] },
    });
    // Its states are passed on unchanged, with a sentence.
    for (const st of ['model-missing', 'downloading', 'unavailable', 'no-query'] as const) {
      answer = { state: st };
      expect(await intent.classify({ query: 'x' })).toEqual({ status: 'unavailable', reason: INTENT_ADAPTER_REASONS[st], state: st });
    }

    // GSC: page scope, the nearest range, totals merged with the top queries, reason codes in words.
    const reads: Phase4GscQuery[] = [];
    let perf: Phase4PerformanceAnswer = PERFORMANCE_OK;
    let top: Phase4QueriesAnswer = QUERIES_OK;
    const gsc = gscAdapter(phase4Service(async (q) => (reads.push(q), perf), async (q) => (reads.push(q), top)))!;
    expect(await gsc.performance({ url: 'https://example.com/a', days: 30 })).toEqual({
      status: 'ok',
      data: { url: 'https://example.com/a', days: 28, clicks: 12, impressions: 400, ctr: 0.03, position: 7.5, queries: [{ query: 'shoes', clicks: 10, impressions: 200, ctr: 0.05, position: 3 }] },
    });
    expect(reads).toEqual([
      { url: 'https://example.com/a', scope: 'page', days: 28 },
      { url: 'https://example.com/a', scope: 'page', days: 28 },
    ]);
    expect([1, 7, 17, 18, 28, 59, 60, 90, 480].map(nearestGscRange)).toEqual([7, 7, 7, 28, 28, 90, 90, 90, 90]);
    top = { status: 'unavailable', reason: 'quota' };
    expect(await gsc.performance({ url: 'https://example.com/a', days: 7 })).toMatchObject({ status: 'ok', data: { days: 7, queries: [] } });
    for (const reason of ['unconfigured', 'not-entitled', 'not-connected', 'no-property', 'auth-expired', 'quota', 'network', 'invalid', 'not-a-web-page'] as const) {
      perf = { status: 'unavailable', reason };
      expect(await gsc.performance({ url: 'https://example.com/a', days: 7 })).toEqual({ status: 'unavailable', reason: GSC_ADAPTER_REASONS[reason] });
    }
    perf = { status: 'unavailable', reason: 'brand-new-code' as never };
    expect(await gsc.performance({ url: 'https://example.com/a', days: 7 })).toEqual({ status: 'unavailable', reason: 'The search performance data could not be read.' });
    // A thrown error is a fixed reason, never the error's text.
    const broken = gscAdapter(phase4Service(async () => Promise.reject(new Error('token=SECRET')), async () => QUERIES_OK))!;
    expect(JSON.stringify(await broken.performance({ url: 'https://example.com/', days: 7 }))).not.toContain('SECRET');

    // A stopped chat: the abort goes on, not an `unavailable` answer.
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(intent.classify({ query: 'x' }, { signal: stop.signal })).rejects.toThrow('stopped');
    await expect(gsc.performance({ url: 'https://example.com/', days: 7 }, { signal: stop.signal })).rejects.toThrow('stopped');
  });

  test('agent-port-adapters-accept-the-real-shapes', () => {
    // Type-level: the merged `SerpReadApi` and Phase 4's `GscService` (a local copy below) are what
    // the adapters take; this file fails to compile if the adapters' structural types drift from them.
    const readApi: SerpReadApi = phase3ReadApi(() => READY_STATE);
    const service: Phase4GscService = phase4Service(async () => PERFORMANCE_OK, async () => QUERIES_OK);
    const serpLike: SerpReadApiLike = readApi;
    const intentLike: IntentReadApiLike = readApi;
    const probesLike: ProbesReadApiLike = readApi;
    const gscLike: GscServiceLike = service;
    expect([serpAdapter(serpLike), intentAdapter(intentLike), probesAdapter(probesLike), gscAdapter(gscLike)].every((port) => port !== null)).toBe(true);
    // And the lead's wiring block compiles against `createAgentService`'s options as written in the plan.
    const requireFeature = (flag: Phase4FeatureFlag): void => {
      if (flag !== 'ai-agent') throw new Error('not entitled');
    };
    const AGENT_FEATURE_FLAGS: Readonly<Record<AgentFeature, Phase4FeatureFlag>> = { agent: 'ai-agent', 'agent.skills': 'ai-agent', 'agent.mcp': 'ai-agent' };
    const serp = { readApi };
    const gsc = { service };
    const options = {
      ports: { serp: serpAdapter(serp.readApi), intent: intentAdapter(serp.readApi), probes: probesAdapter(serp.readApi), gsc: gscAdapter(gsc.service) },
      entitlements: {
        allowed: (feature: AgentFeature) => {
          try {
            requireFeature(AGENT_FEATURE_FLAGS[feature]);
            return true;
          } catch {
            return false;
          }
        },
      },
    } satisfies Pick<Parameters<typeof createAgentService>[0], 'ports' | 'entitlements'>;
    expect(options.entitlements.allowed('agent')).toBe(true);
  });

  test('agent-search-tools-through-the-broker', async () => {
    const serp = createFakeSerpPort();
    const runner = createPageToolRunner({ contentsOf: () => null, audit: () => ({ status: 'pending', url: '' }), navigate: async () => ({ status: 'no-tab' }), ports: resolveAgentPorts({ serp }) });
    const { fake } = await setupBroker({ overrides: { runner } });
    fake.invoke('call-1', 'serp_results', { query: 'running shoes' });
    fake.invoke('call-2', 'search_intent', { query: 'running shoes' });
    await vi.waitFor(async () => {
      await flush();
      expect(fake.results('call-1')).toHaveLength(1);
      expect(fake.results('call-2')).toHaveLength(1);
    });
    // Wrapped as untrusted data from the search results, mapped and bounded.
    expect(fake.results('call-1')[0]).toMatchObject({ ok: true, output: { untrusted: true, source: SEARCH_TOOL_SOURCES.serp_results, data: { query: 'running shoes', resultsTotal: 2 } } });
    // Not connected: the reason reaches the model as data.
    expect(fake.results('call-2')[0]).toEqual({ ok: true, output: { untrusted: true, source: SEARCH_TOOL_SOURCES.search_intent, data: { unavailable: PORT_NOT_CONNECTED_REASONS.intent } } });
    expect(serp.calls).toHaveLength(1);
  });

  test('gsc-default-url-is-in-the-approved-input', async () => {
    const gsc = createFakeGscPort();
    const runner = createPageToolRunner({ contentsOf: () => null, audit: () => ({ status: 'pending', url: '' }), navigate: async () => ({ status: 'no-tab' }), ports: resolveAgentPorts({ gsc }) });
    // Read tools ask (the user turned them off): the card shows the page that will be read.
    const { fake, broker, tab } = await setupBroker({ readToolsAllowed: false, tabUrl: 'https://user:pw@example.com/products?x=1#reviews', overrides: { runner } });
    fake.invoke('call-1', 'gsc_performance', {});
    await flush();
    const [request] = broker.pending();
    expect(JSON.parse(request!.input)).toEqual({ url: 'https://example.com/products?x=1', days: 28 });
    expect(request!.inputSha256).toBe(createHash('sha256').update(request!.input).digest('hex'));
    // The tab moves before the user answers: the approved page is read, not the new one.
    tab.url = 'https://example.com/elsewhere';
    await broker.answer(request!.id, 'allow-once');
    await vi.waitFor(async () => {
      await flush();
      expect(fake.results('call-1')).toHaveLength(1);
    });
    expect(gsc.calls).toEqual([{ url: 'https://example.com/products?x=1', days: 28 }]);
    // A private page is refused as data, without asking the port.
    const local = await setupBroker({ tabUrl: 'http://localhost:8080/admin', overrides: { runner } });
    local.fake.invoke('call-2', 'gsc_performance', {});
    await vi.waitFor(async () => {
      await flush();
      expect(local.fake.results('call-2')).toHaveLength(1);
    });
    expect(local.fake.results('call-2')[0]).toMatchObject({ ok: true, output: { data: { unavailable: GSC_NOT_PUBLIC_REASON } } });
    expect(gsc.calls).toHaveLength(1);
  });

  test('intent-adapter-never-downloads', async () => {
    // Phase 3's real classifier over a store that records any download, wired as main's
    // `serp/service.ts` wires `classifyIntent`.
    const harness = (present: boolean) => {
      const download = vi.fn(async (): Promise<IntentEnableOutcome> => 'ready');
      const hostClassify = vi.fn(async () => ({ ok: true as const, result: { label: 'transactional' as const, confidence: 0.7, scores: { informational: 0.1, navigational: 0.1, commercial: 0.1, transactional: 0.7 }, model: INTENT_MODEL.id } }));
      const classifier = createIntentClassifier({ store: { present: async () => present, download }, host: { classify: hostClassify, dispose: () => undefined } });
      const readApi = { classifyIntent: (query: string) => classifier.classify(query) } satisfies Pick<SerpReadApi, 'classifyIntent'>;
      return { port: intentAdapter(readApi)!, download, hostClassify };
    };
    // No model on disk: `model-missing` handed on unchanged; nothing downloaded or loaded.
    const missing = harness(false);
    for (let i = 0; i < 3; i += 1) expect(await missing.port.classify({ query: 'buy tea' })).toEqual({ status: 'unavailable', reason: INTENT_ADAPTER_REASONS['model-missing'], state: 'model-missing' });
    expect(missing.download).not.toHaveBeenCalled();
    expect(missing.hostClassify).not.toHaveBeenCalled();
    // The model present: classified on this computer, still no download.
    const ready = harness(true);
    expect(await ready.port.classify({ query: 'buy tea' })).toMatchObject({ status: 'ok', data: { primary: 'transactional' } });
    expect(ready.download).not.toHaveBeenCalled();
    // The adapter's type has no way to reach the enabling path at all.
    const readApi = phase3ReadApi(() => READY_STATE);
    const enableIntent = vi.fn();
    const port = intentAdapter(Object.assign(readApi, { enableIntent, ensureModel: enableIntent }))!;
    await port.classify({ query: 'x' });
    expect(enableIntent).not.toHaveBeenCalled();
  });

  test('probes-adapter-maps-the-run', async () => {
    let probes: ProbesState = PROBES_DONE;
    const runProbes = vi.fn((_tabId: number) => true);
    const port = probesAdapter({ ...phase3ReadApi(() => READY_STATE), probes: () => probes, runProbes })!;
    expect(await port.latest(4)).toEqual({
      status: 'ok',
      data: {
        url: 'https://example.com/a',
        status: 'done',
        startedAt: new Date(1000).toISOString(),
        finishedAt: new Date(2000).toISOString(),
        agents: [
          { agent: 'browser', kind: 'browser', outcome: 'ok', status: 200, redirects: 0, finalUrl: 'https://example.com/a', robots: 'allowed', noindex: false, nofollow: false, canonical: 'https://example.com/a', wordCount: 300, title: 'A', differsIn: [], textSimilarity: null },
          { agent: 'gptbot', kind: 'ai', outcome: 'ok', status: 403, redirects: 1, finalUrl: 'https://example.com/blocked', robots: 'disallowed', noindex: null, nofollow: null, canonical: null, wordCount: null, title: null, differsIn: ['status', 'robots'], textSimilarity: null },
        ],
      },
    });
    // Idle: said, with the state.
    probes = { ...PROBES_DONE, status: 'idle', rows: [], diffs: [], startedAt: null, finishedAt: null };
    expect(await port.latest(4)).toMatchObject({ status: 'unavailable', state: 'idle' });
    // Running starts a run; a refused start (not the active tab) is `started: false`.
    expect(await port.run(4)).toEqual({ status: 'ok', data: { started: true } });
    expect(runProbes).toHaveBeenCalledWith(4);
    runProbes.mockReturnValueOnce(false);
    expect(await port.run(4)).toEqual({ status: 'ok', data: { started: false } });
  });
});

// ---- Local copies of the Phase 3 and Phase 4 shapes ----

type Phase4GscQuery = { url: string; scope: 'page' | 'property'; days: 7 | 28 | 90 };
type Phase4Unavailable = { status: 'unavailable'; reason: 'unconfigured' | 'not-entitled' | 'not-connected' | 'no-property' | 'auth-expired' | 'quota' | 'network' | 'invalid' | 'not-a-web-page' };
type Phase4Property = { siteUrl: string; kind: 'url-prefix' | 'domain'; permissionLevel: 'siteOwner' };
type Phase4PerformanceAnswer =
  | { status: 'ok'; property: Phase4Property; scope: 'page' | 'property'; range: { start: string; end: string }; rows: { date: string; clicks: number; impressions: number; ctr: number; position: number }[]; totals: { clicks: number; impressions: number; ctr: number; position: number | null } }
  | Phase4Unavailable;
type Phase4QueriesAnswer =
  | { status: 'ok'; property: Phase4Property; scope: 'page' | 'property'; range: { start: string; end: string }; rows: { query: string; clicks: number; impressions: number; ctr: number; position: number }[] }
  | Phase4Unavailable;
interface Phase4GscService {
  status(): { connected: boolean };
  properties(): Promise<{ status: 'ok'; properties: Phase4Property[] } | Phase4Unavailable>;
  propertyFor(url: string): Promise<{ status: 'ok'; property: Phase4Property } | Phase4Unavailable>;
  performance(query: Phase4GscQuery): Promise<Phase4PerformanceAnswer>;
  topQueries(query: Phase4GscQuery): Promise<Phase4QueriesAnswer>;
}
type Phase4FeatureFlag = 'ai-agent' | 'search-console' | 'sync';

type SearchParams = Extract<SerpState, { status: 'pending' }>['params'];
const COUNTS = { ...(Object.fromEntries(SERP_RESULT_TYPES.map((type) => [type, 0])) as Record<SerpResultType, number>), organic: 2, ad: 1, 'people-also-ask': 1 };
const PARAMS: SearchParams = { engine: 'engine', engineLabel: 'The search engine', query: 'running shoes', gl: 'us', hl: 'en', device: 'mobile', page: 1, offset: null, url: 'https://search.example/?q=running+shoes' };
const READY_STATE: SerpState = {
  status: 'ready',
  tabId: 4,
  documentSeq: 1,
  url: PARAMS.url,
  readAt: 1_700_000_000_000,
  snapshot: {
    status: 'ready',
    params: PARAMS,
    packVersion: 1,
    results: [
      { rank: 1, type: 'ad', position: 1, featureSlot: null, title: 'Ad', url: 'https://ads.example/', redirected: true, domain: 'ads.example' },
      { rank: 2, type: 'organic', position: 1, featureSlot: null, title: 'Running shoes', url: 'https://shoes.example/running', redirected: false, domain: 'shoes.example' },
      { rank: 3, type: 'people-also-ask', position: null, featureSlot: 1, title: 'Which shoes?', url: null, redirected: false, domain: null },
      { rank: 4, type: 'organic', position: 2, featureSlot: null, title: 'Best shoes', url: 'https://reviews.example/best', redirected: false, domain: 'reviews.example' },
    ],
    composition: { counts: COUNTS, features: [{ slot: 1, type: 'people-also-ask', results: 1 }] },
    ownership: { page: 1, organic: 2, complete: true, domains: [] },
    truncated: false,
  },
};
const NOT_READY: Record<'not-serp' | 'pending' | 'unreadable' | 'disabled', SerpState> = {
  'not-serp': { status: 'not-serp', tabId: 4, url: 'https://example.com/' },
  pending: { status: 'pending', tabId: 4, documentSeq: 1, url: PARAMS.url, params: PARAMS },
  unreadable: { status: 'unreadable', tabId: 4, documentSeq: 1, url: PARAMS.url, readAt: 1, reason: 'no-container', params: PARAMS, packVersion: 1 },
  disabled: { status: 'disabled', tabId: 4, reason: 'pack-invalid' },
};
const PROBE_ROW = { hops: [] as { url: string; status: number }[], robots: null, metaRobots: null, xRobotsTag: null, canonicals: null, contentType: 'text/html', bytes: 1000, truncated: false, textTruncated: false, partial: false, textHash: null, textSignature: null, durationMs: 10 };
const PROBES_DONE: ProbesState = {
  tabId: 4,
  url: 'https://example.com/a',
  status: 'done',
  rows: [
    { ...PROBE_ROW, agent: 'browser', outcome: 'ok', status: 200, finalUrl: 'https://example.com/a', robots: { url: 'https://example.com/robots.txt', verdict: 'allowed', rule: null, groupAgents: [], groupLine: null, fallback: false }, noindex: false, nofollow: false, canonical: 'https://example.com/a', wordCount: 300, title: 'A' },
    { ...PROBE_ROW, agent: 'gptbot', outcome: 'ok', status: 403, hops: [{ url: 'https://example.com/a', status: 301 }], finalUrl: 'https://example.com/blocked', robots: { url: 'https://example.com/robots.txt', verdict: 'disallowed', rule: null, groupAgents: [], groupLine: null, fallback: false }, noindex: null, nofollow: null, canonical: null, wordCount: null, title: null },
  ],
  diffs: [{ agent: 'gptbot', facts: ['status', 'robots'], textSimilarity: null, contentTruncated: false }],
  robotsTxt: [],
  startedAt: 1000,
  finishedAt: 2000,
  version: 3,
};
function phase3ReadApi(snapshot: (tabId: number) => SerpState, classifyIntent: (query: string) => Promise<IntentAnswer> = async () => ({ state: 'model-missing' })): SerpReadApi {
  return { snapshot, classifyIntent, probes: () => ({ ...PROBES_DONE, status: 'idle', rows: [], diffs: [], startedAt: null, finishedAt: null }), runProbes: () => false };
}

const PROPERTY: Phase4Property = { siteUrl: 'https://example.com/', kind: 'url-prefix', permissionLevel: 'siteOwner' };
const PERFORMANCE_OK: Phase4PerformanceAnswer = { status: 'ok', property: PROPERTY, scope: 'page', range: { start: '2026-09-01', end: '2026-09-28' }, rows: [], totals: { clicks: 12, impressions: 400, ctr: 0.03, position: 7.5 } };
const QUERIES_OK: Phase4QueriesAnswer = { status: 'ok', property: PROPERTY, scope: 'page', range: { start: '2026-09-01', end: '2026-09-28' }, rows: [{ query: 'shoes', clicks: 10, impressions: 200, ctr: 0.05, position: 3 }] };
function phase4Service(performance: Phase4GscService['performance'], topQueries: Phase4GscService['topQueries']): Phase4GscService {
  return { status: () => ({ connected: true }), properties: async () => ({ status: 'ok', properties: [PROPERTY] }), propertyFor: async () => ({ status: 'ok', property: PROPERTY }), performance, topQueries };
}
