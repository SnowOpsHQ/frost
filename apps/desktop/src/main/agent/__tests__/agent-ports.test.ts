// Spec: specs/agent-search-tools.spec.ts (PORT_NOT_CONNECTED_REASONS, SEARCH_TOOL_SOURCES) ·
// packages/ai-skills/src/ports.ts (PortAnswer, unavailablePort, fakes) · specs/agent-protocol.schema.ts (tool.result)
// Acceptance: specs/agent-search-tools.feature.md (Wiring)
import { describe, expect, test, vi } from 'vitest';
import { createFakeSerpPort, FAKE_GSC_PERFORMANCE, FAKE_INTENT, FAKE_SERP_RESULTS } from '@app/ai-skills/fakes';
import { PORT_NOT_CONNECTED_REASONS, SEARCH_TOOL_SOURCES } from '@app/specs/agent-search-tools.spec';
import { gscAdapter, intentAdapter, resolveAgentPorts, serpAdapter } from '../ports';
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
    for (const reason of Object.values(PORT_NOT_CONNECTED_REASONS)) expect(reason).toMatch(/isn't connected in this build\.$/);
  });

  test('agent-port-adapters-are-thin', async () => {
    expect(serpAdapter(null)).toBeNull();
    expect(intentAdapter(undefined)).toBeNull();
    expect(gscAdapter(null)).toBeNull();

    const results = vi.fn(async () => FAKE_SERP_RESULTS);
    const serp = serpAdapter({ results })!;
    const signal = new AbortController().signal;
    expect(await serp.results({ query: 'running shoes' }, { signal })).toEqual({ status: 'ok', data: FAKE_SERP_RESULTS });
    expect(results).toHaveBeenCalledWith({ query: 'running shoes' }, { signal });
    // No AI answer read in the service: the tool says it isn't connected.
    expect(await serp.aiSearch({ query: 'x' })).toEqual({ status: 'unavailable', reason: "AI answers aren't connected in this build." });

    const missing = serpAdapter({ results: async () => null, aiSearch: async () => undefined })!;
    expect(await missing.results({ query: 'x' })).toEqual({ status: 'unavailable', reason: 'No search results are stored for this query yet.' });
    expect(await missing.aiSearch({ query: 'x' })).toEqual({ status: 'unavailable', reason: 'No AI answer is stored for this query yet.' });

    // A thrown error is a fixed reason, never the error's text.
    const broken = gscAdapter({ performance: async () => Promise.reject(new Error('token=SECRET at https://internal/')) })!;
    const answer = await broken.performance({ url: 'https://example.com/', days: 7 });
    expect(answer).toEqual({ status: 'unavailable', reason: 'The search performance data could not be read.' });
    expect(JSON.stringify(answer)).not.toContain('SECRET');
    expect(await gscAdapter({ performance: async () => FAKE_GSC_PERFORMANCE })!.performance({ url: 'https://example.com/', days: 28 })).toEqual({ status: 'ok', data: FAKE_GSC_PERFORMANCE });
    expect(await intentAdapter({ classify: async () => FAKE_INTENT })!.classify({ query: 'buy running shoes' })).toEqual({ status: 'ok', data: FAKE_INTENT });

    // A stopped chat: the abort goes on, not an `unavailable` answer.
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    const aborting = intentAdapter({ classify: async () => Promise.reject(stop.signal.reason) })!;
    await expect(aborting.classify({ query: 'x' }, { signal: stop.signal })).rejects.toThrow('stopped');
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
});
