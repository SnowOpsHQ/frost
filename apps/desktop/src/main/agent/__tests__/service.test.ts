// Spec: specs/agent-session.spec.ts (AGENT_E2E_SCRIPT_SWITCH, AGENT_E2E_SCRIPT_ENV),
// specs/agent-search-tools.spec.ts (PORT_NOT_CONNECTED_REASONS)
// Acceptance: specs/agent-session.feature.md (Wiring), specs/agent-search-tools.feature.md (Wiring)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createScriptedModelFactory, scriptedModelFactoryFromEnv, startRuntime, type RuntimePort } from '@app/agent-runtime';
import { createFakeSerpPort } from '@app/ai-skills/fakes';
import { PORT_NOT_CONNECTED_REASONS } from '@app/specs/agent-search-tools.spec';
import { AgentE2eScriptSchema } from '@app/specs/agent-e2e-script.schema';
import { AGENT_E2E_SCRIPT_ENV, AGENT_E2E_SCRIPT_SWITCH } from '@app/specs/agent-session.spec';
import type { AgentElectron } from '../index';
import { createAgentServiceFrom, type AgentServiceApp, type AgentServiceDeps } from '../service';
import { createFakeChannel, createFakeFork, createFakeSafeStorage, type FakePort } from './fakes';
import { createMemoryGrantsStore } from '../grants';
import { createMemoryChatsStore } from '../chat-history';
import { encodeChat } from '../chat-record';
import { createMemorySkillsStore } from '../user-skills';
import { CHAT_PRUNE_INTERVAL_MS } from '@app/specs/agent-data.spec';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { packaged?: boolean; script?: unknown } & Pick<AgentServiceDeps, 'ports' | 'entitlements' | 'now' | 'setInterval' | 'clearInterval'> & { sessionStore?: AgentServiceDeps['sessionStore'] } = {}) {
  const userData = mkdtempSync(path.join(tmpdir(), 'frost-agent-service-'));
  dirs.push(userData);
  let switchValue = '';
  if (options.script !== undefined) {
    switchValue = path.join(userData, 'script.json');
    writeFileSync(switchValue, JSON.stringify(options.script));
  }
  const quit: (() => void)[] = [];
  const app: AgentServiceApp = {
    isPackaged: options.packaged === true,
    getPath: () => userData,
    commandLine: { getSwitchValue: (name) => (name === AGENT_E2E_SCRIPT_SWITCH ? switchValue : '') },
    once: (_event, listener) => quit.push(listener),
  };
  const forks = createFakeFork((child) => {
    child.onPort = (port: FakePort) => {
      const call = forks.calls.at(-1)!;
      const runtimePort: RuntimePort = { post: (message) => port.postMessage(message), onMessage: (listener) => port.on('message', (event: { data: unknown }) => listener(event.data)) };
      // As the real runtime does: the script from its environment, else (here) a fixed reply.
      const modelFactory = scriptedModelFactoryFromEnv(call.options.env) ?? createScriptedModelFactory(AgentE2eScriptSchema.parse({ steps: [{ text: ['from a provider'] }] }));
      startRuntime(runtimePort, { modelFactory, lockdown: { removed: ['fetch'], failed: [], permissionModel: false } });
    };
  });
  const electron: AgentElectron = {
    utilityProcess: { fork: forks.fork },
    MessageChannelMain: class {
      readonly port1: FakePort;
      readonly port2: FakePort;
      constructor() {
        const channel = createFakeChannel();
        this.port1 = channel.port1;
        this.port2 = channel.port2;
      }
    },
    safeStorage: createFakeSafeStorage().storage,
    session: { fromPartition: () => ({ fetch: async () => Promise.reject(new Error('no network')) }) },
  };
  const browser = {
    tabIdOf: () => null,
    getState: () => ({ activeTabId: 2, tabs: [{ id: 2, url: 'https://example.com/', title: 'Example' }] }),
    navigate: () => false,
    seo: { getAudit: () => ({ status: 'unavailable' as const, url: '', reason: 'no-tab' as const }) },
  };
  const service = createAgentServiceFrom({
    app,
    electron,
    browser,
    webContents: { getAllWebContents: () => [] },
    sessionStore: options.sessionStore ?? { agentGrants: createMemoryGrantsStore() },
    buildDir: '/app/.vite/build',
    ...(options.now ? { now: options.now } : {}),
    ...(options.setInterval ? { setInterval: options.setInterval } : {}),
    ...(options.clearInterval ? { clearInterval: options.clearInterval } : {}),
    ...(options.ports ? { ports: options.ports } : {}),
    ...(options.entitlements ? { entitlements: options.entitlements } : {}),
  });
  return { service, forks, quit };
}

describe('agent service wiring', () => {
  test('service-starts-lazily-and-disposes-on-quit', async () => {
    const { service, forks, quit } = setup({ script: { steps: [{ text: ['Scripted hello.'] }] } });
    await vi.waitFor(() => expect(service.getState().version).toBeGreaterThan(1));
    // Nothing forked before the first message.
    expect(forks.calls.length).toBe(0);
    expect(service.getState().setup.ready).toBe(true);
    expect(await service.send(null, 'Hi')).toBe('started');
    expect(forks.calls.length).toBe(1);
    expect(forks.calls[0]!.options.env[AGENT_E2E_SCRIPT_ENV]).toBe(JSON.stringify({ steps: [{ text: ['Scripted hello.'] }] }));
    await vi.waitFor(() => expect(service.getState().running).toBe(false));
    expect(service.getState().active).toMatchObject({ tabId: 2, messages: [{ kind: 'user' }, { kind: 'assistant', text: 'Scripted hello.' }] });
    expect(quit.length).toBe(1);
    quit[0]!();
    expect(forks.calls[0]!.child.killed).toBe(true);
    expect(await service.send(null, 'Again')).toBe('unavailable');
  });

  test('service-packaged-ignores-the-e2e-script', async () => {
    const { service, forks } = setup({ packaged: true, script: { steps: [{ text: ['Scripted hello.'] }] } });
    await vi.waitFor(() => expect(service.getState().version).toBeGreaterThan(1));
    // No seam: a key is needed, and none is stored.
    expect(service.getState().setup.ready).toBe(false);
    expect(await service.send(null, 'Hi')).toBe('setup-needed');
    expect(forks.calls.length).toBe(0);
  });

  test('service-wires-ports-and-entitlements', async () => {
    const script = { steps: [{ toolCalls: [{ toolName: 'serp_results', input: { query: 'running shoes' } }] }, { text: ['Read them.'] }] };
    const toolOutput = async (service: ReturnType<typeof setup>['service']) => {
      await vi.waitFor(() => expect(service.getState().version).toBeGreaterThan(1));
      expect(await service.send(null, 'Who ranks?')).toBe('started');
      await vi.waitFor(() => expect(service.getState().running).toBe(false));
      const assistant = service.getState().active!.messages.find((message) => message.kind === 'assistant' && message.tools.length > 0);
      return assistant?.kind === 'assistant' ? assistant.tools[0]! : null;
    };
    // No ports given: the tool tells the model the data isn't connected.
    const plain = setup({ script });
    expect(await toolOutput(plain.service)).toMatchObject({ toolName: 'serp_results', status: 'done', outputPreview: JSON.stringify({ unavailable: PORT_NOT_CONNECTED_REASONS.serp }) });
    plain.quit[0]!();
    // A port given: its answer, mapped.
    const serp = createFakeSerpPort();
    const wired = setup({ script, ports: { serp } });
    const card = await toolOutput(wired.service);
    expect(card).toMatchObject({ toolName: 'serp_results', status: 'done' });
    expect(card!.outputPreview).toContain('"resultsTotal":2');
    expect(serp.calls).toEqual([{ method: 'results', query: { query: 'running shoes' } }]);
    wired.quit[0]!();
    // The entitlements port is the one given.
    const gated = setup({ script, entitlements: { allowed: (feature) => feature !== 'agent' } });
    await vi.waitFor(() => expect(gated.service.getState().version).toBeGreaterThan(1));
    expect(await gated.service.send(null, 'Hi')).toBe('not-entitled');
    gated.quit[0]!();
  });

  test('service-restores-prunes-and-composes-skills', async () => {
    const DAY = 86_400_000;
    const now = 1000 * DAY;
    const chat = (id: string, updatedAt: number) =>
      encodeChat({ id, title: `Chat ${id.slice(-1)}`, createdAt: updatedAt, updatedAt, modelId: null, usage: null, contextTokens: null, truncated: false, history: [{ role: 'user', content: 'hi' }], entries: [{ kind: 'user', text: 'hi', tools: [] }] });
    const agentChats = createMemoryChatsStore({ chats: [chat('00000000-0000-4000-8000-000000000001', now - 40 * DAY), chat('00000000-0000-4000-8000-000000000002', now - DAY)] });
    const agentSkills = createMemorySkillsStore();
    await agentSkills.saveSkill('my-skill', JSON.stringify({ id: 'my-skill', name: 'Mine', description: 'Mine.', allowedTools: ['page_data'], instructions: 'Check {{pageUrl}}.', version: 1 }), 1);
    const timers: { callback: () => void; ms: number }[] = [];
    const cleared: unknown[] = [];
    const { service, quit } = setup({
      script: { steps: [{ text: ['unused'] }] },
      sessionStore: { agentGrants: createMemoryGrantsStore(), agentChats, agentSkills },
      now: () => now,
      setInterval: (callback, ms) => (timers.push({ callback, ms }), 'timer-1'),
      clearInterval: (handle) => cleared.push(handle),
    });
    // Startup: the 30-day default dropped the old chat on disk; the recent one is listed (no tab yet).
    await vi.waitFor(() => expect(service.getState().chats.map((item) => item.title)).toEqual(['Chat 2']));
    expect(agentChats.rows.size).toBe(1);
    expect(service.getState().chats[0]!.tabId).toBeNull();
    // The user's skill comes after the built-ins, labelled theirs.
    expect(service.getState().skills.map((skill) => [skill.id, skill.builtin])).toEqual([['audit-this-page', true], ['rewrite-title-meta', true], ['internal-link-suggestions', true], ['my-skill', false]]);
    // A daily prune, cleared on quit.
    expect(timers.map((timer) => timer.ms)).toEqual([CHAT_PRUNE_INTERVAL_MS]);
    quit[0]!();
    expect(cleared).toEqual(['timer-1']);
  });
});
