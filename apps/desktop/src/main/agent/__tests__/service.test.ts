// Spec: specs/agent-session.spec.ts (AGENT_E2E_SCRIPT_SWITCH, AGENT_E2E_SCRIPT_ENV)
// Acceptance: specs/agent-session.feature.md (Wiring)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createScriptedModelFactory, scriptedModelFactoryFromEnv, startRuntime, type RuntimePort } from '@app/agent-runtime';
import { AgentE2eScriptSchema } from '@app/specs/agent-e2e-script.schema';
import { AGENT_E2E_SCRIPT_ENV, AGENT_E2E_SCRIPT_SWITCH } from '@app/specs/agent-session.spec';
import type { AgentElectron } from '../index';
import { createAgentServiceFrom, type AgentServiceApp } from '../service';
import { createFakeChannel, createFakeFork, createFakeSafeStorage, type FakePort } from './fakes';
import { createMemoryGrantsStore } from '../grants';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { packaged?: boolean; script?: unknown } = {}) {
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
  const service = createAgentServiceFrom({ app, electron, browser, webContents: { getAllWebContents: () => [] }, sessionStore: { agentGrants: createMemoryGrantsStore() }, buildDir: '/app/.vite/build' });
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
});
