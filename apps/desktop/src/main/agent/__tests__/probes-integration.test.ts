// Spec: specs/agent-search-tools.spec.ts (PROBE_TOOL_REASONS, PROBE_RUN_MAX_REQUESTS) · specs/visibility-probes.spec.ts
// (PROBE_AGENTS, PROBE_LIMITS) · specs/fetcher.spec.ts (BoundedFetcher)
// Acceptance: specs/agent-search-tools.feature.md (probes-integration-fetches-the-approved-page)
//
// Phase 3's real visibility probes (`main/serp/probes.ts` `createProbes`, its real parser) behind
// `probesAdapter` and the agent's page tool runner, over a fake bounded fetcher that records every
// request: what `run_visibility_probes` makes frost fetch, exactly.
import { describe, expect, test, vi } from 'vitest';
import type { BoundedFetchRequest, BoundedFetchResult, BoundedFetcher } from '@app/specs/fetcher.spec';
import { PROBE_RUN_MAX_REQUESTS, PROBE_TOOL_REASONS } from '@app/specs/agent-search-tools.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { PROBE_AGENTS } from '@app/specs/visibility-probes.spec';
import { runProbeJob } from '../../serp/probe-parse';
import { createProbes, type ProbeTab } from '../../serp/probes';
import { probesAdapter, resolveAgentPorts } from '../ports';
import { createPageToolRunner } from '../tools';

const PAGE = 'https://www.example.com/guide/shoes';
const enc = (text: string) => new TextEncoder().encode(text);

function setup(tab: ProbeTab | null) {
  const requests: BoundedFetchRequest[] = [];
  const fetcher: BoundedFetcher = {
    fetch: vi.fn(async (request: BoundedFetchRequest): Promise<BoundedFetchResult> => {
      requests.push(request);
      return {
        url: request.url,
        outcome: 'response',
        status: 200,
        finalUrl: request.url,
        redirects: 0,
        chain: [],
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: enc(`<!doctype html><title>Shoes</title><link rel="canonical" href="${PAGE}"><body><p>trail running shoes</p></body>`) as Uint8Array<ArrayBuffer>,
        truncated: false,
        durationMs: 2,
      };
    }),
    load: () => ({ running: 0, queued: 0 }),
  };
  const robots = vi.fn(async (url: string): Promise<RobotsFetch> => ({ url: `${new URL(url).origin}/robots.txt`, outcome: 'ok', status: 200, finalUrl: `${new URL(url).origin}/robots.txt`, redirects: 0, body: enc('User-agent: *\nAllow: /\n'), truncated: false }));
  const probes = createProbes({ fetcher, robots, parse: async (job) => runProbeJob(job), tab: (tabId) => (tabId === 7 ? tab : null) });
  const runner = createPageToolRunner({
    contentsOf: () => ({ executeJavaScriptInIsolatedWorld: async () => null, getURL: () => tab?.url ?? '', isDestroyed: () => false }),
    audit: () => ({ status: 'pending', url: '' }),
    navigate: async () => ({ status: 'no-tab' }),
    // Exactly the members main wires (`serp.readApi`'s probes part).
    ports: resolveAgentPorts({ probes: probesAdapter({ probes: probes.state, runProbes: probes.run }) }),
  });
  const approved = { tabId: 7, signal: new AbortController().signal, via: 'approval' as const, expectedOrigin: 'https://www.example.com', expectedUrl: PAGE };
  return { runner, requests, robots, approved, dispose: () => probes.dispose() };
}

describe('visibility probes through the agent', () => {
  test('probes-integration-fetches-the-approved-page', async () => {
    const s = setup({ contentsId: 11, url: `${PAGE}#reviews`, active: true });
    try {
      const outcome = await s.runner.run('run_visibility_probes', {}, s.approved);
      expect(outcome).toMatchObject({ ok: true, data: { started: true, url: PAGE, status: 'done', agentsTotal: PROBE_AGENTS.length } });
      // One request per agent, every one for the approved page (fragment aside), within the cap.
      expect(s.requests.map((request) => request.url)).toEqual(PROBE_AGENTS.map(() => PAGE));
      expect(s.requests.length).toBeLessThanOrEqual(PROBE_RUN_MAX_REQUESTS);
      expect(s.robots.mock.calls.every(([url]) => new URL(url).origin === 'https://www.example.com')).toBe(true);
    } finally {
      s.dispose();
    }
  });

  test('probes-integration-inactive-tab-fetches-nothing', async () => {
    const s = setup({ contentsId: 11, url: PAGE, active: false });
    try {
      expect(await s.runner.run('run_visibility_probes', {}, s.approved)).toEqual({ ok: true, data: { started: false, unavailable: PROBE_TOOL_REASONS.notActive }, source: 'frost:visibility-probes' });
      expect(s.requests).toEqual([]);
      expect(s.robots).not.toHaveBeenCalled();
      // Reading is still possible and fetches nothing either.
      expect(await s.runner.run('visibility_probes', {}, { ...s.approved, via: 'read' })).toMatchObject({ ok: true, data: { unavailable: PROBE_TOOL_REASONS.idle, state: 'idle' } });
      expect(s.requests).toEqual([]);
    } finally {
      s.dispose();
    }
  });
});
