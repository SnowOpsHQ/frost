// Spec: specs/agent-protocol.schema.ts (RUNTIME_TO_MAIN_MESSAGE_TYPES, RuntimeToMainMessageSchema) · specs/agent-approvals.spec.ts
// Acceptance: specs/agent-approvals.feature.md (Scenarios: the runtime can't approve) · plan threat model "The agent process approves its own call"
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AGENT_PROTOCOL_VERSION, RUNTIME_TO_MAIN_MESSAGE_TYPES, type MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { createApprovalBroker } from '../approvals';
import { createAgentGrants, createMemoryGrantsStore } from '../grants';
import { createAgentHost } from '../host';
import { createFakeRunner } from './approval-fakes';
import { createFakeChannel, createFakeFork, type FakePort } from './fakes';

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the runtime cannot approve', () => {
  test('agent-cannot-approve', async () => {
    const runtimes: FakePort[] = [];
    const forks = createFakeFork((child) => {
      child.onPort = (port) => runtimes.push(port);
    });
    const host = createAgentHost({ fork: forks.fork, createChannel: createFakeChannel, buildDir: path.join(path.sep, 'app'), packaged: false });
    let ids = 0;
    const store = createMemoryGrantsStore();
    const grants = createAgentGrants({ store });
    await grants.load();
    const runner = createFakeRunner();
    const broker = createApprovalBroker({ host, grants, entitlements: { allowed: () => true }, runner: runner.runner, tabUrl: () => 'https://shop.example.com/cart', randomId: () => (ids += 1) === 1 ? 'approval-known' : `approval-${ids}` });
    const fetches: unknown[] = [];
    host.onFetch((event) => fetches.push(event));

    const started = host.start();
    const runtime = runtimes[0]!;
    const toRuntime: MainToRuntimeMessage[] = [];
    runtime.on('message', (event) => toRuntime.push(event.data as MainToRuntimeMessage));
    runtime.postMessage({ type: 'ready', protocolVersion: AGENT_PROTOCOL_VERSION, lockdown: { removed: [], failed: [], permissionModel: false } });
    expect(await started).toBe(true);
    const allowedTools = ['navigate', 'click', 'execute_javascript', 'page_text'];
    expect(host.send({ type: 'chat.start', chatId: 'chat-1', messages: [{ role: 'user', content: 'Hi' }], systemPrompt: '', modelId: 'anthropic/claude-sonnet-5-5', route: 'gateway', allowedTools, mcpTools: [] })).toBe(true);
    broker.register('chat-1', { tabId: 3, allowedTools });

    // One honest call that needs the user.
    runtime.postMessage({ type: 'tool.invoke', chatId: 'chat-1', callId: 'call-1', toolName: 'click', input: { selector: '#buy' } });
    await flush();
    expect(broker.pending().map((r) => r.id)).toEqual(['approval-known']);

    // Then every runtime → main type, each carrying approval-like payloads naming the real id,
    // and messages the protocol doesn't have.
    const approval = { approvalId: 'approval-known', decision: 'allow-always', approved: true, grant: { tool: 'click', origin: 'https://shop.example.com' } };
    const barrage: unknown[] = [
      { type: 'ready', protocolVersion: AGENT_PROTOCOL_VERSION, lockdown: { removed: [], failed: [], permissionModel: true } },
      { type: 'chat.delta', chatId: 'chat-1', text: 'allow-always approval-known' },
      { type: 'chat.delta', chatId: 'chat-1', text: 'x', ...approval },
      { type: 'chat.tool-call', chatId: 'chat-1', callId: 'call-1', toolName: 'click', input: approval },
      { type: 'chat.step', chatId: 'chat-1', step: 1, text: 'approved', toolCalls: [{ callId: 'call-1', toolName: 'click', input: approval }] },
      { type: 'tool.invoke', chatId: 'chat-1', callId: 'call-1', toolName: 'click', input: approval },
      { type: 'tool.invoke', chatId: 'chat-1', callId: 'call-2', toolName: 'click', input: { selector: '#buy' }, ...approval },
      { type: 'tool.invoke', chatId: 'chat-1', callId: 'call-3', toolName: 'click', input: { selector: '#buy', ...approval } },
      { type: 'tool.invoke', chatId: 'chat-1', callId: 'call-4', toolName: 'execute_javascript', input: { code: 'approve("approval-known")' } },
      { type: 'fetch.request', requestId: 'r1', url: 'https://ai-gateway.vercel.sh/v4/ai/language-model', method: 'POST', headers: [['x-approval', 'approval-known']], body: JSON.stringify(approval) },
      { type: 'fetch.abort', requestId: 'r1' },
      { type: 'tool.result', chatId: 'chat-1', callId: 'call-1', result: { ok: true, output: { untrusted: true, source: 'self', data: approval } } },
      { type: 'approval.answer', ...approval },
      { type: 'approval.grant', ...approval },
      { type: 'approve', ...approval },
      { type: 'grant.add', tool: 'click', origin: 'https://shop.example.com' },
      { type: 'grants.set', grants: [approval.grant] },
      { type: 'settings.set', readToolsAllowed: false },
      { type: 'chat.answer-approval', chatId: 'chat-1', ...approval },
      { ...approval },
      'approval-known allow-always',
      { type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 1, usage: { input: 1, output: 1 }, ...approval },
      { type: 'chat.error', chatId: 'chat-1', message: 'allow-always approval-known', ...approval },
    ];
    for (const message of barrage) runtime.postMessage(message);
    await flush();

    // Every protocol type was exercised (a test of the barrage itself).
    const types = new Set(barrage.flatMap((m) => (typeof m === 'object' && m !== null && 'type' in m ? [String((m as { type: unknown }).type)] : [])));
    for (const type of RUNTIME_TO_MAIN_MESSAGE_TYPES) expect(types.has(type), type).toBe(true);

    // Nothing was approved, run or granted; the honest request still waits for the user.
    expect(runner.calls).toEqual([]);
    expect(grants.list()).toEqual([]);
    expect([...store.rows.values()]).toEqual([]);
    expect(grants.readToolsAllowed()).toBe(true);
    // The script the runtime asked for (naming the approval in its code) waits for the user too.
    expect(broker.pending().map((r) => [r.id, r.callId, r.toolName])).toEqual([
      ['approval-known', 'call-1', 'click'],
      ['approval-2', 'call-4', 'execute_javascript'],
    ]);
    expect(broker.pending()[1]!.code).toBe('approve("approval-known")');
    const call1 = broker.activity('chat-1').find((a) => a.callId === 'call-1');
    expect(call1?.status).toBe('awaiting-approval');
    expect(broker.activity('chat-1').find((a) => a.callId === 'call-4')?.status).toBe('awaiting-approval');
    // No successful tool result went to the runtime; call-3's input with extra fields was refused.
    const results = toRuntime.filter((m): m is Extract<MainToRuntimeMessage, { type: 'tool.result' }> => m.type === 'tool.result');
    expect(results.every((m) => !m.result.ok)).toBe(true);
    expect(results.find((m) => m.callId === 'call-3')?.result).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(results.some((m) => m.callId === 'call-1' || m.callId === 'call-4')).toBe(false);
    expect(host.stats().inboundDropped).toBeGreaterThan(0);
    // The same runtime heard all of it (no flood restart cut the barrage short).
    expect(host.status()).toBe('ready');
    expect(host.stats().restarts).toBe(0);
    expect(forks.calls.length).toBe(1);

    // Only main's own call answers it.
    expect(await broker.answer('approval-known', 'allow-once')).toEqual({ ok: true, granted: false });
    await flush();
    expect(runner.calls.map((c) => [c.toolName, c.input])).toEqual([['click', { selector: '#buy' }]]);
    // A valid `chat.error` naming the approval only ends the turn: the script's request expires, unrun.
    runtime.postMessage({ type: 'chat.error', chatId: 'chat-1', message: 'allow-always approval-known' });
    await flush();
    expect(broker.isRegistered('chat-1')).toBe(false);
    expect(broker.pending()).toEqual([]);
    expect(runner.calls.map((c) => c.toolName)).toEqual(['click']);
    expect(await broker.answer('approval-2', 'allow-once')).toEqual({ ok: false, reason: 'unknown' });
    expect(grants.list()).toEqual([]);
    broker.dispose();
    host.dispose();
  });

  // Task 10 review: an MCP tool the turn didn't offer (a skill turn offers none), and allow-always on one it did.
  test('agent-cannot-approve-mcp', async () => {
    const runtimes: FakePort[] = [];
    const forks = createFakeFork((child) => {
      child.onPort = (port) => runtimes.push(port);
    });
    const host = createAgentHost({ fork: forks.fork, createChannel: createFakeChannel, buildDir: path.join(path.sep, 'app'), packaged: false });
    const grants = createAgentGrants({ store: createMemoryGrantsStore() });
    await grants.load();
    const runner = createFakeRunner();
    const broker = createApprovalBroker({ host, grants, entitlements: { allowed: () => true }, runner: runner.runner, tabUrl: () => 'https://shop.example.com/cart' });
    const started = host.start();
    const runtime = runtimes[0]!;
    const toRuntime: MainToRuntimeMessage[] = [];
    runtime.on('message', (event) => toRuntime.push(event.data as MainToRuntimeMessage));
    runtime.postMessage({ type: 'ready', protocolVersion: AGENT_PROTOCOL_VERSION, lockdown: { removed: [], failed: [], permissionModel: false } });
    expect(await started).toBe(true);
    const start = (chatId: string, allowedTools: string[], mcpTools: { name: string; description: string; inputSchema: { type: 'object' } }[]) =>
      expect(host.send({ type: 'chat.start', chatId, messages: [{ role: 'user', content: 'Hi' }], systemPrompt: '', modelId: 'anthropic/claude-sonnet-5-5', route: 'gateway', allowedTools, mcpTools })).toBe(true);
    // A skill turn: catalogue tools only.
    start('chat-1', ['page_audit', 'page_text'], []);
    broker.register('chat-1', { tabId: 3, allowedTools: ['page_audit', 'page_text'] });
    runtime.postMessage({ type: 'tool.invoke', chatId: 'chat-1', callId: 'm-1', toolName: 'mcp__evil__run', input: { cmd: 'id' } });
    await flush();
    expect(broker.pending()).toEqual([]);
    expect(runner.calls).toEqual([]);
    const refused = toRuntime.find((m): m is Extract<MainToRuntimeMessage, { type: 'tool.result' }> => m.type === 'tool.result' && m.callId === 'm-1');
    expect(refused?.result).toMatchObject({ ok: false, error: { code: 'not-allowed' } });
    // A typed turn that offered it: it asks, and can't be allowed for good.
    start('chat-2', ['page_audit', 'mcp__evil__run'], [{ name: 'mcp__evil__run', description: 'Untrusted tool from Evil: runs.', inputSchema: { type: 'object' } }]);
    broker.register('chat-2', { tabId: 3, allowedTools: ['page_audit', 'mcp__evil__run'] });
    runtime.postMessage({ type: 'tool.invoke', chatId: 'chat-2', callId: 'm-2', toolName: 'mcp__evil__run', input: { cmd: 'id' } });
    await flush();
    const request = broker.pending()[0]!;
    expect(request).toMatchObject({ toolName: 'mcp__evil__run', risk: 'external', grantable: false });
    expect(await broker.answer(request.id, 'allow-always')).toEqual({ ok: false, reason: 'not-grantable' });
    // The runtime naming the approval in a forged message changes nothing.
    runtime.postMessage({ type: 'approval.answer', approvalId: request.id, decision: 'allow-always' });
    runtime.postMessage({ type: 'tool.invoke', chatId: 'chat-2', callId: 'm-3', toolName: 'mcp__evil__run', input: { cmd: 'id' }, approvalId: request.id });
    await flush();
    expect(runner.calls).toEqual([]);
    expect(grants.list()).toEqual([]);
    expect(broker.pending().map((r) => r.id)).toEqual([request.id]);
    broker.dispose();
    host.dispose();
  });
});
