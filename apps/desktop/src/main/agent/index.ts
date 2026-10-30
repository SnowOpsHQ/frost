import fs from 'node:fs/promises';
import path from 'node:path';
import { CHATGPT_PARTITION } from '@app/specs/agent-chatgpt.spec';
import { AGENT_MODEL_PARTITION, AGENT_SETTINGS_FILE, CREDENTIALS_FILE } from '@app/specs/agent-proxy.spec';
import type { JsonValue } from '@app/specs/agent-protocol.schema';
import type { ChatgptE2eSeam } from '@app/specs/agent-chatgpt-e2e.schema';
import { isMcpToolName } from '@app/specs/agent-tools.spec';
import { startLoopback } from '../account/loopback';
import { createApprovalBroker, unavailableToolRunner, type ApprovalBroker, type ToolRunner } from './approvals';
import { createChatgptAuthInUserData, type ChatgptAuth } from './chatgpt';
import { createChatgptRoute, type ChatgptRoute } from './chatgpt/route';
import { createMemoryChatgptStore } from './chatgpt/e2e-seam';
import { createCredentialStore, credentialSettings, type CredentialFs, type CredentialSettings, type SafeStorageLike } from './credentials';
import { createDefaultAgentEntitlements, type AgentEntitlements } from './entitlements';
import { createAgentGrants, createMemoryGrantsStore, type AgentGrants, type AgentGrantsStore } from './grants';
import { createAgentHost, type AgentHost, type HostChild, type HostPort } from './host';
import { createModelProxy, type ModelProxy } from './model-proxy';
import { createAgentSettings, type AgentSettings, type SettingsFs } from './settings';
import type { McpManager, McpSessionLike } from './mcp';

// The agent's main-side composition (Phase 5 Tasks 3 and 4): the host (the runtime's utility
// process), the key store, the model proxy, the model settings, the entitlements port, the standing
// grants and the approval broker, returned for the later tasks (tools, the IPC router) to use. Main wires it with one line (Task 6). Only the
// proxy gets the key store itself; everyone else gets `credentials`, which has no way to read a key.

/** The Electron pieces the agent uses (main passes the real ones; tests pass fakes). */
export interface AgentElectron {
  readonly utilityProcess: {
    fork(modulePath: string, args: string[], options: { serviceName: string; env: Record<string, string>; execArgv: string[]; stdio: 'ignore' | 'inherit' }): HostChild;
  };
  readonly MessageChannelMain: new () => { readonly port1: HostPort; readonly port2: HostPort };
  readonly safeStorage: SafeStorageLike;
  /**
   * `fromPartition`: the model proxy's session (`fetch`), Task 10's `agent-mcp` session (`fetch`
   * for MCP servers, `resolveHost` for their private-address check), and the ChatGPT sign-in's
   * in-memory `agent-chatgpt` session (`fetch` for the auth server and the model list).
   */
  readonly session: { fromPartition(partition: string): { fetch(url: string, init: RequestInit): Promise<Response>; resolveHost?: McpSessionLike['resolveHost'] } };
}

export interface CreateAgentDeps {
  readonly electron: AgentElectron;
  /** `app.getPath('userData')`: the key and settings files live there. */
  readonly userData: string;
  /** Main's build directory (`__dirname`): the runtime's bundle is beside main's. */
  readonly buildDir: string;
  /** `app.isPackaged`. */
  readonly packaged: boolean;
  /** File operations (default `node:fs/promises`). */
  readonly fs?: CredentialFs & SettingsFs;
  /** Default: everything allowed (`createDefaultAgentEntitlements`). */
  readonly entitlements?: AgentEntitlements;
  /** One line per event; never a key, a message's content, a URL query or a header. */
  readonly log?: (line: string) => void;
  /** `process.platform` (the key store's protection report). */
  readonly platform?: NodeJS.Platform;
  /** The standing grants' table (`SessionStore.agentGrants` from `@app/db`); default in memory (nothing persists). */
  readonly grantsStore?: AgentGrantsStore;
  /** Runs the tools the broker lets run (Task 5); default: every tool answers `unavailable`. */
  readonly toolRunner?: ToolRunner;
  /** The URL a tab shows now (main's tab controller); default: none. */
  readonly tabUrl?: (tabId: number) => string | null;
  /** The e2e seam's validated script (unpackaged only, Task 6a; `e2e-seam.ts`); default none. */
  readonly e2eAgentScript?: string | null;
  /**
   * MCP servers (Task 10, `./mcp`): their tools' runner (MCP names go to it, every other name to
   * `toolRunner`), labels and input check for the broker. Default: none (MCP calls answer `unavailable`).
   */
  readonly mcp?: Pick<McpManager, 'runner' | 'labelOf' | 'inputAllowed'>;
  /**
   * Opens the ChatGPT sign-in's authorize page in the system browser (main passes its
   * scheme-allowlisted `shell.openExternal`, for the authorize page only); `userGesture`: the
   * sign-in spent a live user gesture. Default: never opened (the sign-in answers `browser-failed`).
   */
  readonly openExternal?: (url: string, userGesture: boolean) => boolean;
  /** Brings an app window to the front when a ChatGPT sign-in started from it succeeds; default: nothing. */
  readonly focusWindow?: (windowId: number) => void;
  /** The ChatGPT sign-in (tests pass their own); default: the encrypted store in `userData`, on the `agent-chatgpt` session. */
  readonly chatgptAuth?: ChatgptAuth;
  /**
   * The ChatGPT plan's e2e seam (unpackaged only, Task 6; `chatgpt/e2e-seam.ts`): the sign-in's
   * endpoints, where plan requests are sent, and the store kind. Default none (the real endpoints).
   */
  readonly chatgptE2e?: ChatgptE2eSeam | null;
}

export interface Agent {
  /** The runtime: `start()`, `send(chat.start …)`, chat and tool events, status and lockdown report. */
  readonly host: AgentHost;
  /** Keys for the settings page: `hasKey`, `setKey`, `clearKey`, `protection`; never a key back. */
  readonly credentials: CredentialSettings;
  /** The route and model. */
  readonly settings: AgentSettings;
  /** The proxy's state (`no-key`, requests in flight, the last refusal). */
  readonly proxy: Pick<ModelProxy, 'state'>;
  readonly entitlements: AgentEntitlements;
  /** Standing grants and the read-tools setting (the grants page, Task 9). */
  readonly grants: AgentGrants;
  /** The ChatGPT plan route: the sign-in, the account's models, readiness and plan failures (`start()` it once the settings load). */
  readonly chatgpt: ChatgptRoute;
  /** Every `tool.invoke`: `register`/`unregister` per turn, `pending()`, `answer()` (main's IPC only), `activity()`. */
  readonly approvals: ApprovalBroker;
  /** Loads the settings and grants, then forks the runtime if needed and waits for `ready` (`false` if it failed). */
  start(): Promise<boolean>;
  /** App quit: stops the runtime and aborts every model request. */
  dispose(): void;
}

export function createAgent(deps: CreateAgentDeps): Agent {
  const files = deps.fs ?? fs;
  const log = deps.log ?? (() => undefined);
  const { electron } = deps;
  const host = createAgentHost({
    fork: (modulePath, args, options) => electron.utilityProcess.fork(modulePath, args, { ...options, env: { ...options.env }, execArgv: [...options.execArgv] }),
    createChannel: () => new electron.MessageChannelMain(),
    buildDir: deps.buildDir,
    packaged: deps.packaged,
    ...(deps.e2eAgentScript != null ? { e2eAgentScript: deps.e2eAgentScript } : {}),
    log,
  });
  const store = createCredentialStore({ safeStorage: electron.safeStorage, file: path.join(deps.userData, CREDENTIALS_FILE), fs: files, log, ...(deps.platform ? { platform: deps.platform } : {}) });
  const settings = createAgentSettings({ file: path.join(deps.userData, AGENT_SETTINGS_FILE), fs: files, log });
  // The ChatGPT sign-in: its own encrypted record and host id in `userData`, its requests on the
  // in-memory `agent-chatgpt` session (looked up per request, after app ready).
  const chatgptAuth =
    deps.chatgptAuth ??
    createChatgptAuthInUserData({
      userData: deps.userData,
      fs: files,
      safeStorage: electron.safeStorage,
      ...(deps.platform ? { platform: deps.platform } : {}),
      fetch: (url, init) => electron.session.fromPartition(CHATGPT_PARTITION).fetch(url, init),
      now: () => Date.now(),
      startLoopback,
      openExternal: deps.openExternal ?? (() => false),
      ...(deps.focusWindow ? { focusWindow: deps.focusWindow } : {}),
      ...(deps.chatgptE2e ? { endpoints: deps.chatgptE2e.endpoints } : {}),
      ...(deps.chatgptE2e?.store === 'memory' ? { store: createMemoryChatgptStore() } : {}),
      log,
    });
  const chatgpt = createChatgptRoute({ auth: chatgptAuth, settings, log });
  const proxy = createModelProxy({
    host,
    credentials: store,
    settings,
    // The in-memory session, looked up per request (after app ready; no `persist:`, so no cookie,
    // cache or connection state reaches the disk).
    fetch: (url, init) => electron.session.fromPartition(AGENT_MODEL_PARTITION).fetch(url, init),
    // The plan's credential is the sign-in's access token; its failures go to the session through the route.
    chatgpt: { withAccessToken: (fn, options) => chatgptAuth.withAccessToken(fn, options), report: (failure) => chatgpt.report(failure), onAccountChange: (listener) => chatgpt.onAccountChange(listener) },
    ...(deps.chatgptE2e ? { chatgptResponsesUrl: deps.chatgptE2e.endpoints.responses } : {}),
    log,
  });
  const entitlements = deps.entitlements ?? createDefaultAgentEntitlements();
  const grants = createAgentGrants({ store: deps.grantsStore ?? createMemoryGrantsStore(), log });
  const mcp = deps.mcp;
  const pageRunner = deps.toolRunner;
  // MCP names run on the MCP manager's runner, the catalogue's on the page tools'.
  const runner: ToolRunner | undefined =
    mcp === undefined
      ? pageRunner
      : { run: (toolName, input, context) => (isMcpToolName(toolName) ? mcp.runner.run(toolName, input, context) : (pageRunner ?? unavailableToolRunner).run(toolName, input, context)) };
  const approvals = createApprovalBroker({
    host,
    grants,
    entitlements,
    ...(runner ? { runner } : {}),
    tabUrl: deps.tabUrl ?? (() => null),
    log,
    ...(mcp ? { mcpLabel: (toolName: string) => mcp.labelOf(toolName), mcpInputAllowed: (toolName: string, input: JsonValue) => mcp.inputAllowed(toolName, input) } : {}),
  });
  return {
    host,
    credentials: credentialSettings(store),
    settings,
    proxy: { state: () => proxy.state() },
    entitlements,
    grants,
    chatgpt,
    approvals,
    async start() {
      // The proxy reads the route from the settings, the broker the grants: both are loaded before
      // the runtime can ask.
      await Promise.all([settings.load(), grants.load()]);
      return host.start();
    },
    dispose() {
      approvals.dispose();
      proxy.dispose();
      void chatgpt.dispose();
      host.dispose();
    },
  };
}

export type { AgentHost, AgentHostStatus, AgentLockdown, AgentChatEvent, AgentToolInvoke } from './host';
export type { CredentialSettings, SetKeyResult } from './credentials';
export type { AgentSettings } from './settings';
export type { ModelProxyState } from './model-proxy';
export type { AgentEntitlements, AgentFeature } from './entitlements';
export type { ApprovalBroker, ApprovalRequestView, AnswerResult, ChatToolContext, ToolActivity, ToolRunner, ToolRunOutcome, ToolRunContext } from './approvals';
export type { AgentGrant, AgentGrants, AgentGrantsStore } from './grants';
