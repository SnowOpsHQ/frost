// Fakes for the approval broker's tests (no Electron): a host that hands the broker `tool.invoke`s
// parsed as the real host parses them and records what it sends back, a scripted tool runner, and a
// tab whose URL the test moves.
import { vi } from 'vitest';
import { RuntimeToMainMessageSchema, type JsonValue, type MainToRuntimeMessage, type ToolResult } from '@app/specs/agent-protocol.schema';
import { createApprovalBroker, type ApprovalBrokerDeps, type ToolRunContext, type ToolRunner, type ToolRunOutcome } from '../approvals';
import { createDefaultAgentEntitlements, type AgentEntitlements } from '../entitlements';
import { createAgentGrants, createMemoryGrantsStore, type AgentGrant } from '../grants';
import type { AgentChatEvent, AgentToolInvoke } from '../host';

export function createFakeToolHost() {
  let listener: ((invoke: AgentToolInvoke) => void) | null = null;
  let chatListener: ((event: AgentChatEvent) => void) | null = null;
  const sent: MainToRuntimeMessage[] = [];
  const strike = vi.fn();
  return {
    host: {
      onToolInvoke(next: (invoke: AgentToolInvoke) => void) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      onChat(next: (event: AgentChatEvent) => void) {
        chatListener = next;
        return () => {
          chatListener = null;
        };
      },
      send(message: MainToRuntimeMessage) {
        sent.push(message);
        return true;
      },
      strike,
    },
    sent,
    strike,
    get listening() {
      return listener !== null || chatListener !== null;
    },
    /** The runtime asks for a call (parsed with the protocol, as the host does; throws if it wouldn't pass). */
    invoke(callId: string, toolName: string, input: unknown, chatId = 'chat-1') {
      const parsed = RuntimeToMainMessageSchema.parse({ type: 'tool.invoke', chatId, callId, toolName, input });
      listener?.(parsed as AgentToolInvoke);
    },
    /** The runtime's turn for `chatId` ends. */
    finish(chatId = 'chat-1', type: 'chat.finish' | 'chat.error' = 'chat.finish') {
      chatListener?.(type === 'chat.finish' ? { type, chatId, finishReason: 'stop', steps: 1, usage: { input: null, output: null } } : { type, chatId, message: 'failed' });
    },
    /** The `tool.result`s sent for `callId`. */
    results(callId: string): ToolResult[] {
      return sent.flatMap((message) => (message.type === 'tool.result' && message.callId === callId ? [message.result] : []));
    },
  };
}

interface RunnerCall {
  readonly toolName: string;
  readonly input: JsonValue;
  readonly context: ToolRunContext;
}

/** A runner answering `outcomes[toolName]` (default: `{ ok, data: { ran: toolName }, source }`); `hold` makes a tool wait until released. */
export function createFakeRunner(outcomes: Record<string, ToolRunOutcome | (() => ToolRunOutcome | Promise<ToolRunOutcome>)> = {}) {
  const calls: RunnerCall[] = [];
  const held = new Map<string, (outcome: ToolRunOutcome) => void>();
  const holding = new Set<string>();
  const runner: ToolRunner = {
    run(toolName, input, context) {
      calls.push({ toolName, input, context });
      if (holding.has(toolName)) return new Promise((resolve) => held.set(toolName, resolve));
      const scripted = outcomes[toolName];
      if (typeof scripted === 'function') return Promise.resolve(scripted());
      return Promise.resolve(scripted ?? { ok: true, data: { ran: toolName }, source: `${toolName} test` });
    },
  };
  return {
    runner,
    calls,
    hold: (toolName: string) => void holding.add(toolName),
    release: (toolName: string, outcome: ToolRunOutcome) => held.get(toolName)?.(outcome),
  };
}

export const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

export const ALL_TOOLS = ['page_audit', 'page_data', 'page_text', 'navigate', 'click', 'execute_javascript', 'serp_results', 'search_intent', 'run_ai_search', 'gsc_performance', 'visibility_probes', 'run_visibility_probes', 'mcp__files__read'];

/** A broker over the fakes, its chat `chat-1` registered on tab 7 (showing `tabUrl`) with `ALL_TOOLS`. */
export async function setupBroker(
  options: {
    grants?: readonly AgentGrant[];
    readToolsAllowed?: boolean;
    entitlements?: AgentEntitlements;
    outcomes?: Parameters<typeof createFakeRunner>[0];
    tabUrl?: string | null;
    register?: boolean;
    overrides?: Partial<ApprovalBrokerDeps>;
  } = {},
) {
  const fake = createFakeToolHost();
  const store = createMemoryGrantsStore({ grants: options.grants ?? [], readToolsAllowed: options.readToolsAllowed ?? true });
  const grants = createAgentGrants({ store, now: () => 1000 });
  await grants.load();
  const runner = createFakeRunner(options.outcomes);
  const tab = { url: options.tabUrl === undefined ? 'https://example.com/products' : options.tabUrl };
  let ids = 0;
  const broker = createApprovalBroker({
    host: fake.host,
    grants,
    entitlements: options.entitlements ?? createDefaultAgentEntitlements(),
    runner: runner.runner,
    tabUrl: (tabId) => (tabId === 7 ? tab.url : null),
    randomId: () => `approval-${(ids += 1)}`,
    ...options.overrides,
  });
  if (options.register !== false) broker.register('chat-1', { tabId: 7, allowedTools: ALL_TOOLS });
  return { fake, store, grants, runner, tab, broker };
}
