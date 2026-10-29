// Spec: specs/agent-search-tools.spec.ts (PROBE_TOOL_LIMITS, PROBE_TOOL_REASONS, PROBE_TOOL_SOURCE) ·
// specs/agent-tools.spec.ts (visibility_probes, run_visibility_probes) · specs/agent-approvals.spec.ts
// (grantOriginFor, canGrant, PAGE_TOOLS) · specs/agent-session.spec.ts (RUN_PROBES_APPROVAL_NOTE)
// Acceptance: specs/agent-search-tools.feature.md (Probes)
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createFakeProbesPort, FAKE_PROBE_REPORT } from '@app/ai-skills/fakes';
import { canGrant, grantOriginFor } from '@app/specs/agent-approvals.spec';
import { PROBE_TOOL_LIMITS, PROBE_TOOL_REASONS, PROBE_TOOL_SOURCE, PROBE_RUN_MAX_REQUESTS, PROBE_RUN_USER_AGENTS } from '@app/specs/agent-search-tools.spec';
import type { ProbeReport, ProbesPort } from '@app/ai-skills';
import { resolveAgentPorts } from '../ports';
import { createPageToolRunner, type PageContents } from '../tools';
import { RUN_PROBES_APPROVAL_NOTE } from '@app/specs/agent-session.spec';
import { flush, setupBroker } from './approval-fakes';
import { setupSession } from './session-fakes';

const PAGE = 'https://example.com/products';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A runner over `port` on a tab showing `PAGE` (each one with its own run memory). */
const directRunner = (port: ProbesPort, url = PAGE) =>
  createPageToolRunner({
    contentsOf: () => ({ executeJavaScriptInIsolatedWorld: async () => null, getURL: () => url, isDestroyed: () => false }),
    audit: () => ({ status: 'pending', url: '' }),
    navigate: async () => ({ status: 'no-tab' }),
    ports: resolveAgentPorts({ probes: port }),
  });

/** A broker whose real page tool runner reads `port`, on tab 7 showing `tab.url` (its WebContents too). */
async function setup(port = createFakeProbesPort({ latest: { status: 'ok', data: { ...FAKE_PROBE_REPORT, url: PAGE } } }), options: Parameters<typeof setupBroker>[0] = {}) {
  let live = options.tabUrl === undefined ? PAGE : (options.tabUrl ?? '');
  const contents: PageContents = { executeJavaScriptInIsolatedWorld: async () => null, getURL: () => live, isDestroyed: () => false };
  const runner = createPageToolRunner({ contentsOf: (tabId) => (tabId === 7 ? contents : null), audit: () => ({ status: 'pending', url: '' }), navigate: async () => ({ status: 'no-tab' }), ports: resolveAgentPorts({ probes: port }) });
  const broker = await setupBroker({ ...options, overrides: { runner } });
  const settle = async (callId: string) => {
    await vi.waitFor(async () => {
      await flush();
      expect(broker.fake.results(callId)).toHaveLength(1);
    });
    return broker.fake.results(callId)[0]!;
  };
  return { ...broker, port, settle, moveTo: (url: string) => ((live = url), (broker.tab.url = url)) };
}

describe('visibility probe tools', () => {
  test('visibility-probes-reads-without-fetching', async () => {
    const s = await setup();
    s.fake.invoke('call-1', 'visibility_probes', {});
    const result = await s.settle('call-1');
    expect(result).toMatchObject({ ok: true, output: { untrusted: true, source: PROBE_TOOL_SOURCE, data: { url: PAGE, status: 'done', agentsTotal: 2 } } });
    expect(s.port.calls).toEqual([{ method: 'latest', tabId: 7 }]);
    expect(s.broker.pending()).toEqual([]);
    // A run for another page is not handed on; no run yet is said.
    const other = await setup(createFakeProbesPort({ latest: { status: 'ok', data: { ...FAKE_PROBE_REPORT, url: 'https://elsewhere.example/' } } }));
    other.fake.invoke('call-2', 'visibility_probes', {});
    expect(await other.settle('call-2')).toMatchObject({ ok: true, output: { data: { unavailable: PROBE_TOOL_REASONS.otherPage } } });
    const idle = await setup(createFakeProbesPort({ latest: { status: 'unavailable', reason: PROBE_TOOL_REASONS.idle, state: 'idle' } }));
    idle.fake.invoke('call-3', 'visibility_probes', {});
    expect(await idle.settle('call-3')).toMatchObject({ ok: true, output: { data: { unavailable: PROBE_TOOL_REASONS.idle, state: 'idle' } } });
    expect(idle.port.calls.some((call) => call.method === 'run')).toBe(false);
  });

  test('run-visibility-probes-asks-and-binds-the-page', async () => {
    const s = await setup();
    s.fake.invoke('call-1', 'run_visibility_probes', {});
    await flush();
    const [request] = s.broker.pending();
    expect(request).toMatchObject({ toolName: 'run_visibility_probes', risk: 'act', origin: 'https://example.com', pageUrl: PAGE, grantable: true });
    expect(s.port.calls).toEqual([]);
    expect(await s.broker.answer(request!.id, 'allow-once')).toEqual({ ok: true, granted: false });
    const result = await s.settle('call-1');
    expect(result).toMatchObject({ ok: true, output: { data: { started: true, url: PAGE, status: 'done' } } });
    expect(s.port.calls.map((call) => call.method)).toEqual(['run', 'latest']);

    // Approved, then the tab moved: nothing is fetched.
    const moved = await setup();
    moved.fake.invoke('call-2', 'run_visibility_probes', {});
    await flush();
    const [pending] = moved.broker.pending();
    moved.moveTo('https://example.com/other');
    await moved.broker.answer(pending!.id, 'allow-once');
    expect(await moved.settle('call-2')).toMatchObject({ ok: false, error: { code: 'expired' } });
    expect(moved.port.calls).toEqual([]);
  });

  test('run-visibility-probes-grants-like-click', async () => {
    // A grant is for the tab page's origin, public https only.
    expect(grantOriginFor('run_visibility_probes', {}, `${PAGE}#x`)).toBe('https://example.com');
    expect(canGrant('run_visibility_probes', 'https://example.com')).toBe(true);
    expect(canGrant('run_visibility_probes', 'http://example.com')).toBe(false);
    expect(canGrant('run_visibility_probes', 'https://localhost')).toBe(false);
    const s = await setup(undefined, { grants: [{ tool: 'run_visibility_probes', origin: 'https://example.com', createdAt: 1 }] });
    s.fake.invoke('call-1', 'run_visibility_probes', {});
    expect(await s.settle('call-1')).toMatchObject({ ok: true, output: { data: { started: true } } });
    expect(s.broker.pending()).toEqual([]);
    // The grant doesn't cover another origin.
    s.moveTo('https://shop.example.org/page');
    s.fake.invoke('call-2', 'run_visibility_probes', {});
    await flush();
    expect(s.broker.pending()).toHaveLength(1);
  });

  test('run-visibility-probes-not-active-and-read-refused', async () => {
    const s = await setup(createFakeProbesPort({ run: { status: 'ok', data: { started: false } } }), { grants: [{ tool: 'run_visibility_probes', origin: 'https://example.com', createdAt: 1 }] });
    s.fake.invoke('call-1', 'run_visibility_probes', {});
    expect(await s.settle('call-1')).toMatchObject({ ok: true, output: { data: { started: false, unavailable: PROBE_TOOL_REASONS.notActive } } });
    // The runner itself refuses a run that only the read setting would allow.
    const runner = createPageToolRunner({
      contentsOf: () => ({ executeJavaScriptInIsolatedWorld: async () => null, getURL: () => PAGE, isDestroyed: () => false }),
      audit: () => ({ status: 'pending', url: '' }),
      navigate: async () => ({ status: 'no-tab' }),
      ports: resolveAgentPorts({ probes: createFakeProbesPort() }),
    });
    expect(await runner.run('run_visibility_probes', {}, { tabId: 7, signal: new AbortController().signal, via: 'read', expectedOrigin: 'https://example.com', expectedUrl: PAGE })).toEqual({ ok: false, code: 'not-allowed' });
    // Not wired: unavailable.
    const bare = createPageToolRunner({ contentsOf: () => null, audit: () => ({ status: 'pending', url: '' }), navigate: async () => ({ status: 'no-tab' }) });
    expect(await bare.run('visibility_probes', {}, { tabId: 7, signal: new AbortController().signal, via: 'read', expectedOrigin: 'https://example.com', expectedUrl: PAGE })).toEqual({ ok: false, code: 'unavailable' });
  });

  test('run-visibility-probes-waits-for-the-run', async () => {
    vi.useFakeTimers();
    const running: ProbeReport = { ...FAKE_PROBE_REPORT, url: PAGE, status: 'running', agents: [] };
    let reads = 0;
    const port = { ...createFakeProbesPort(), latest: async () => ((reads += 1), { status: 'ok' as const, data: reads < 4 ? running : { ...FAKE_PROBE_REPORT, url: PAGE } }), run: async () => ({ status: 'ok' as const, data: { started: true } }) };
    const runner = createPageToolRunner({
      contentsOf: () => ({ executeJavaScriptInIsolatedWorld: async () => null, getURL: () => PAGE, isDestroyed: () => false }),
      audit: () => ({ status: 'pending', url: '' }),
      navigate: async () => ({ status: 'no-tab' }),
      ports: resolveAgentPorts({ probes: port }),
    });
    const context = { tabId: 7, signal: new AbortController().signal, via: 'approval' as const, expectedOrigin: 'https://example.com', expectedUrl: PAGE };
    const pending = runner.run('run_visibility_probes', {}, context);
    await vi.advanceTimersByTimeAsync(PROBE_TOOL_LIMITS.pollMs * 4);
    expect(await pending).toMatchObject({ ok: true, data: { started: true, status: 'done', agentsTotal: 2 } });
    expect(reads).toBe(4);
    // Stopped while waiting: the call fails and polling ends; the run itself was started once and is
    // not stopped (Phase 3's run has no stop: it finishes on its own).
    reads = 0;
    let runs = 0;
    const stopPort = { ...port, run: async () => ((runs += 1), { status: 'ok' as const, data: { started: true } }) };
    const stop = new AbortController();
    const stopped = directRunner(stopPort).run('run_visibility_probes', {}, { ...context, signal: stop.signal });
    await vi.advanceTimersByTimeAsync(PROBE_TOOL_LIMITS.pollMs);
    stop.abort();
    expect(await stopped).toEqual({ ok: false, code: 'failed' });
    expect(runs).toBe(1);
    const readsAtStop = reads;
    await vi.advanceTimersByTimeAsync(PROBE_TOOL_LIMITS.pollMs * 4);
    expect(reads).toBe(readsAtStop);
  });

  test('run-visibility-probes-approval-card-says-what-it-fetches', async () => {
    const s = await setupSession({ steps: [{ toolCalls: [{ toolName: 'run_visibility_probes', input: {} }] }, { text: ['Done.'] }] });
    try {
      expect(await s.session.send(null, 'How do crawlers see this page?')).toBe('started');
      const state = await s.until((next) => next.approval !== null);
      expect(state.approval!.request).toMatchObject({ toolName: 'run_visibility_probes', label: 'Fetch this page as search and AI crawlers would', note: RUN_PROBES_APPROVAL_NOTE, grantable: true });
      expect(RUN_PROBES_APPROVAL_NOTE).toMatch(/^frost will fetch this page as search and AI crawlers would/);
      await s.session.answerApproval(state.approval!.request.id, 'deny');
      await s.until((next) => !next.running);
    } finally {
      s.stop();
    }
  });

  test('run-visibility-probes-capped-per-turn-and-cooled-down', async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const s = await setup(undefined, { grants: [{ tool: 'run_visibility_probes', origin: 'https://example.com', createdAt: 1 }] });
    // A model looping on the tool under a grant: exactly one run.
    for (let i = 1; i <= 6; i += 1) {
      s.fake.invoke(`call-${i}`, 'run_visibility_probes', {});
      const result = await s.settle(`call-${i}`);
      expect(result).toMatchObject({ ok: true, output: { data: i === 1 ? { started: true, status: 'done' } : { reused: true, status: 'done', url: PAGE } } });
    }
    expect(s.port.calls.filter((call) => call.method === 'run')).toHaveLength(1);
    expect(s.broker.pending()).toEqual([]);
    // A new turn within the cooldown: still reused.
    s.broker.register('chat-1', { tabId: 7, allowedTools: ['run_visibility_probes'] });
    clock += PROBE_TOOL_LIMITS.cooldownMs - 1;
    s.fake.invoke('call-next', 'run_visibility_probes', {});
    expect(await s.settle('call-next')).toMatchObject({ ok: true, output: { data: { reused: true } } });
    expect(s.port.calls.filter((call) => call.method === 'run')).toHaveLength(1);
    // After it, a new turn may run again (once).
    s.broker.register('chat-1', { tabId: 7, allowedTools: ['run_visibility_probes'] });
    clock += 2;
    s.fake.invoke('call-later', 'run_visibility_probes', {});
    expect(await s.settle('call-later')).toMatchObject({ ok: true, output: { data: { started: true } } });
    expect(s.port.calls.filter((call) => call.method === 'run')).toHaveLength(2);
    // Reused with no report for the page: the cooldown sentence.
    const empty = directRunner(createFakeProbesPort({ latest: { status: 'unavailable', reason: PROBE_TOOL_REASONS.idle, state: 'idle' } }));
    const context = { tabId: 7, signal: new AbortController().signal, via: 'approval' as const, expectedOrigin: 'https://example.com', expectedUrl: PAGE };
    await empty.run('run_visibility_probes', {}, context);
    expect(await empty.run('run_visibility_probes', {}, context)).toEqual({ ok: true, data: { reused: true, unavailable: PROBE_TOOL_REASONS.cooldown }, source: PROBE_TOOL_SOURCE });
    // A start that didn't happen (not the active tab) doesn't count.
    const notActive = createFakeProbesPort({ run: { status: 'ok', data: { started: false } } });
    const inactive = directRunner(notActive);
    await inactive.run('run_visibility_probes', {}, context);
    await inactive.run('run_visibility_probes', {}, context);
    expect(notActive.calls.filter((call) => call.method === 'run')).toHaveLength(2);
  });

  test('run-visibility-probes-private-page-never-asks', async () => {
    for (const url of ['http://localhost:3000/admin', 'http://192.168.1.4/', 'http://intranet/wiki', 'https://printer.local/']) {
      const s = await setup(undefined, { tabUrl: url });
      s.fake.invoke('call-1', 'run_visibility_probes', {});
      expect(await s.settle('call-1'), url).toEqual({ ok: true, output: { untrusted: true, source: PROBE_TOOL_SOURCE, data: { unavailable: PROBE_TOOL_REASONS.privatePage } } });
      expect(s.broker.pending()).toEqual([]);
      expect(s.port.calls).toEqual([]);
      expect(s.broker.activity('chat-1')).toEqual([expect.objectContaining({ callId: 'call-1', status: 'done', approvalId: null })]);
    }
    // The tool refuses one too, should a call reach it.
    const port = createFakeProbesPort();
    expect(await directRunner(port, 'http://localhost:3000/admin').run('run_visibility_probes', {}, { tabId: 7, signal: new AbortController().signal, via: 'approval', expectedOrigin: 'http://localhost:3000', expectedUrl: 'http://localhost:3000/admin' })).toEqual({
      ok: true,
      data: { unavailable: PROBE_TOOL_REASONS.privatePage },
      source: PROBE_TOOL_SOURCE,
    });
    expect(port.calls).toEqual([]);
    // Reading the last run of a private page is still a read (it asks there, as every read tool does).
    expect(PROBE_RUN_MAX_REQUESTS).toBe(24);
    expect(PROBE_RUN_USER_AGENTS).toBe(6);
  });
});
