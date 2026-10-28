// Fakes for the session manager's tests (no Electron, no network): the real host, key store,
// settings, grants and approval broker from `createAgent`, over a fake utility process that runs
// the real runtime in this process with the e2e seam's scripted model, and a scripted tool runner.
import { vi } from 'vitest';
import { createScriptedModelFactory, startRuntime, type RuntimePort } from '@app/agent-runtime';
import { AgentE2eScriptSchema } from '@app/specs/agent-e2e-script.schema';
import type { MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import type { AgentState } from '@app/specs/agent-session.spec';
import { createDefaultAgentEntitlements, type AgentEntitlements } from '../entitlements';
import { createAgent } from '../index';
import { createAgentSession } from '../session';
import { createFakeRunner } from './approval-fakes';
import { createFakeChannel, createFakeFork, createFakeSafeStorage, createMemoryFs, type FakePort } from './fakes';

export const KEY = 'gw-secret-key-0123456789abcdef-SESSIONTEST';
export const TAB = 4;

/** A run of the session over the real agent; `steps` is the e2e script the runtime's model plays. */
export async function setupSession(
  options: {
    steps?: unknown[];
    key?: boolean;
    scripted?: boolean;
    entitlements?: AgentEntitlements;
    outcomes?: Parameters<typeof createFakeRunner>[0];
    tabUrl?: string | null;
  } = {},
) {
  const memory = createMemoryFs();
  const safe = createFakeSafeStorage();
  const runner = createFakeRunner(options.outcomes);
  const tab = { url: options.tabUrl === undefined ? 'https://shop.example.com/tea' : options.tabUrl };
  const script = AgentE2eScriptSchema.parse({ steps: options.steps ?? [{ text: ['Hello.'] }] });
  const logs: string[] = [];
  const forks = createFakeFork((child) => {
    child.onPort = (port: FakePort) => {
      const runtimePort: RuntimePort = { post: (message) => port.postMessage(message), onMessage: (listener) => port.on('message', (event: { data: unknown }) => listener(event.data)) };
      startRuntime(runtimePort, { modelFactory: createScriptedModelFactory(script), lockdown: { removed: ['fetch', 'WebSocket', 'EventSource'], failed: [], permissionModel: false } });
    };
  });
  const entitlements = options.entitlements ?? createDefaultAgentEntitlements();
  const agent = createAgent({
    electron: {
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
      safeStorage: safe.storage,
      session: {
        fromPartition: () => ({
          fetch: async () => {
            throw new Error('no model request in these tests');
          },
        }),
      },
    },
    userData: '/user-data',
    buildDir: '/app/.vite/build',
    packaged: true,
    fs: memory.fs,
    platform: 'linux',
    entitlements,
    toolRunner: runner.runner,
    tabUrl: (tabId) => (tabId === TAB ? tab.url : null),
    log: (line) => logs.push(line),
  });
  if (options.key !== false) await agent.credentials.setKey('gateway', KEY);
  const sent: MainToRuntimeMessage[] = [];
  const send = agent.host.send.bind(agent.host);
  agent.host.send = (message) => {
    sent.push(structuredClone(message));
    return send(message);
  };
  let ids = 0;
  const session = createAgentSession({
    host: agent.host,
    approvals: agent.approvals,
    credentials: agent.credentials,
    settings: agent.settings,
    entitlements,
    grants: agent.grants,
    start: () => agent.start(),
    activeTabId: () => TAB,
    scripted: options.scripted === true,
    randomId: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
    log: (line) => logs.push(line),
  });
  await session.refreshSetup();
  /** Every state the session published (each `watch` answer), as JSON. */
  const seen: string[] = [];
  let watching = true;
  void (async () => {
    let version = 0;
    while (watching) {
      const next: AgentState = await session.watch(version);
      seen.push(JSON.stringify(next));
      version = next.version;
    }
  })();
  const until = (check: (state: AgentState) => boolean, timeout = 3000) =>
    vi.waitFor(
      () => {
        const state = session.getState();
        if (!check(state)) throw new Error('not yet');
        return state;
      },
      { timeout, interval: 2 },
    );
  const starts = () => sent.filter((message): message is Extract<MainToRuntimeMessage, { type: 'chat.start' }> => message.type === 'chat.start');
  return {
    agent,
    session,
    runner,
    tab,
    forks,
    logs,
    sent,
    seen,
    starts,
    until,
    stop() {
      watching = false;
      session.dispose();
      agent.dispose();
    },
  };
}
