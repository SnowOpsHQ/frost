// Spec: specs/agent-protocol.schema.ts (chat.start.mcpTools, AGENT_PROTOCOL_VERSION), specs/agent-mcp.spec.ts,
// specs/agent-approvals.spec.ts (decide: external asks every call), specs/agent-session.spec.ts (AgentState.mcp)
// Acceptance: specs/agent-mcp.feature.md (Chats, Calls)
//
// The whole path in one process: the real runtime (scripted model) offered the fake server's tools
// in `chat.start`, the real broker asking for every call, main's MCP runner calling the fake server
// (a real child process, no sandbox), the result wrapped untrusted in the chat's history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { AGENT_PROTOCOL_VERSION, type ChatMessage } from '@app/specs/agent-protocol.schema';
import { AGENT_TOOL_NAMES, TOOL_RESULT_MAX_CHARS } from '@app/specs/agent-tools.spec';
import { createMcpManager, createMemoryMcpSecrets, createMemoryMcpStore, mcpResultData, type McpManager } from '../mcp';
import { nodeSpawn, removeTempDir } from '../mcp/node';
import { wrapToolOutput } from '../tool-output';
import { setupSession } from './session-fakes';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

let current: Awaited<ReturnType<typeof setupSession>> | null = null;
const managers: McpManager[] = [];
afterEach(async () => {
  current?.stop();
  current = null;
  for (const manager of managers.splice(0)) await manager.dispose();
});

async function readyManager(flags: { mcp?: boolean } = {}) {
  const entitlement = { agent: true, 'agent.skills': true, 'agent.mcp': flags.mcp !== false };
  const manager = createMcpManager({
    store: createMemoryMcpStore(),
    secrets: createMemoryMcpSecrets(),
    entitlements: { allowed: (feature) => entitlement[feature] },
    confirmStart: async () => true,
    spawn: nodeSpawn,
    fetch: async () => {
      throw new Error('no network');
    },
    resolveHost: async () => [],
    detectSandbox: async () => ({ mode: 'none', launcher: null }),
    isExecutable: (file) => fs.existsSync(file),
    realpath: (file) => fs.promises.realpath(file),
    makeTempDir: () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'frost-mcp-session-')),
    removeDir: removeTempDir,
    pathEnv: process.env['PATH'] ?? '',
    homes: [os.homedir()],
    runtimeDir: null,
    tmpDir: os.tmpdir(),
    userData: path.join(os.homedir(), '.config', 'frost-test-unused'),
    isDirectory: async () => true,
  });
  managers.push(manager);
  entitlement['agent.mcp'] = true;
  await manager.save({ name: 'Fake Tools', transport: 'stdio', command: process.execPath, args: [FIXTURE], readPaths: [], allowNetwork: false, env: [] });
  await manager.setEnabled('faketools', true);
  expect(await manager.start('faketools')).toBe('ready');
  entitlement['agent.mcp'] = flags.mcp !== false;
  return manager;
}

describe('MCP tools in a chat', () => {
  test('mcp-tool-asks-every-call-and-result-is-untrusted', async () => {
    const mcp = await readyManager();
    const s = (current = await setupSession({
      mcp,
      steps: [{ toolCalls: [{ toolName: 'mcp__faketools__echo', input: { text: 'hi' } }] }, { toolCalls: [{ toolName: 'mcp__faketools__echo', input: { text: 'again' } }] }, { text: ['Done.'] }],
    }));
    expect(AGENT_PROTOCOL_VERSION).toBe(6);
    expect(await s.session.send(null, 'Use the echo tool.')).toBe('started');
    const start = s.starts()[0]!;
    expect(start.mcpTools.map((tool) => tool.name)).toEqual(['mcp__faketools__echo', 'mcp__faketools__probe', 'mcp__faketools__mixed', 'mcp__faketools__fails', 'mcp__faketools__hostile']);
    expect(start.allowedTools).toEqual([...AGENT_TOOL_NAMES, ...start.mcpTools.map((tool) => tool.name)]);
    for (const answer of ['first', 'second']) {
      const waiting = await s.until((state) => state.approval !== null);
      const request = waiting.approval!.request;
      expect(request, answer).toMatchObject({ toolName: 'mcp__faketools__echo', label: 'Untrusted tool from Fake Tools', risk: 'external', grantable: false, origin: null });
      // Never for the whole site: there is none, and MCP is never grantable.
      expect(await s.session.answerApproval(request.id, 'allow-always')).toBe('not-grantable');
      expect(await s.session.answerApproval(request.id, 'allow-once')).toBe('answered');
      await s.until((state) => state.approval?.request.id !== request.id);
    }
    const done = await s.until((state) => !state.running);
    const cards = done.active!.messages.flatMap((message) => (message.kind === 'assistant' ? message.tools : []));
    expect(cards.map((card) => [card.label, card.status])).toEqual([
      ['Untrusted tool from Fake Tools', 'done'],
      ['Untrusted tool from Fake Tools', 'done'],
    ]);
    // Nothing standing was created.
    expect(s.agent.grants.list()).toEqual([]);
    const results = (s.session.snapshot(done.active!.id)!.history as ChatMessage[]).filter((message) => message.role === 'tool');
    expect(results[0]).toMatchObject({ role: 'tool', toolName: 'mcp__faketools__echo', result: { ok: true, output: { untrusted: true, source: 'MCP server "Fake Tools" (untrusted)', data: { text: 'echo: hi', isError: false } } } });
  });

  test('mcp-invalid-input-refused-before-asking', async () => {
    const mcp = await readyManager();
    const s = (current = await setupSession({ mcp, steps: [{ toolCalls: [{ toolName: 'mcp__faketools__echo', input: { text: 'x', extra: true } }] }, { text: ['ok'] }] }));
    // The runtime's SDK doesn't validate MCP inputs: main does, before the user is asked.
    expect(await s.session.send(null, 'Go.')).toBe('started');
    const done = await s.until((state) => !state.running);
    expect(done.approval).toBeNull();
    const card = done.active!.messages.flatMap((message) => (message.kind === 'assistant' ? message.tools : []))[0]!;
    expect([card.status, card.code]).toEqual(['failed', 'invalid-input']);
  });

  test('mcp-tools-absent-for-skills-disabled-or-not-entitled', async () => {
    const mcp = await readyManager();
    const s = (current = await setupSession({ mcp, steps: [{ text: ['a'] }, { text: ['b'] }, { text: ['c'] }] }));
    // A skill offers only its own catalogue tools.
    expect(await s.session.send(null, { skillId: 'audit-this-page' })).toBe('started');
    await s.until((state) => !state.running);
    expect(s.starts()[0]!.mcpTools).toEqual([]);
    expect(s.starts()[0]!.allowedTools.some((name) => name.startsWith('mcp__'))).toBe(false);
    // The server turned off: its tools leave the next turn.
    await mcp.setEnabled('faketools', false);
    expect(await s.session.send(null, 'Typed.')).toBe('started');
    await s.until((state) => !state.running);
    expect(s.starts()[1]!.mcpTools).toEqual([]);
    expect(s.session.getState().mcp.servers[0]).toMatchObject({ enabled: false, status: 'stopped' });
    s.stop();
    current = null;
    // Without the `agent.mcp` entitlement: none, even with a ready server.
    const gated = await readyManager({ mcp: false });
    const t = (current = await setupSession({ mcp: gated, steps: [{ text: ['x'] }] }));
    expect(await t.session.send(null, 'Typed.')).toBe('started');
    await t.until((state) => !state.running);
    expect(t.starts()[0]!.mcpTools).toEqual([]);
    expect(t.session.getState().mcp.available).toBe(false);
  });

  test('mcp-results-wrapped-and-bounded', () => {
    const huge = { content: Array.from({ length: 200 }, (_, i) => ({ type: 'text', text: `${i}`.repeat(5_000) })), structuredContent: { big: 'x'.repeat(100_000) } };
    const data = mcpResultData('Fake', 'echo', huge);
    expect(data['truncated']).toBe(true);
    // Structured content rides only when there is no text.
    expect(data['structuredContent']).toBeUndefined();
    const wrapped = wrapToolOutput('mcp__fake__echo', 'MCP server "Fake" (untrusted)', data)!;
    expect(wrapped.ok).toBe(true);
    expect(JSON.stringify((wrapped as { output: { data: unknown } }).output.data).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(wrapped).toMatchObject({ output: { untrusted: true } });
    expect(mcpResultData('Fake', 'x', { content: 'nope' as never, isError: 'yes' as never })).toEqual({ server: 'Fake', tool: 'x', isError: false, text: '' });
  });
});
