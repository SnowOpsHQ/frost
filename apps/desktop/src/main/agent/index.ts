import fs from 'node:fs/promises';
import path from 'node:path';
import { AGENT_MODEL_PARTITION, AGENT_SETTINGS_FILE, CREDENTIALS_FILE } from '@app/specs/agent-proxy.spec';
import { createCredentialStore, credentialSettings, type CredentialFs, type CredentialSettings, type SafeStorageLike } from './credentials';
import { createDefaultAgentEntitlements, type AgentEntitlements } from './entitlements';
import { createAgentHost, type AgentHost, type HostChild, type HostPort } from './host';
import { createModelProxy, type ModelProxy, type ProxyRequestInit } from './model-proxy';
import { createAgentSettings, type AgentSettings, type SettingsFs } from './settings';

// The agent's main-side composition (Phase 5 Task 3): the host (the runtime's utility process), the
// key store, the model proxy, the model settings and the entitlements port, returned for the later
// tasks (approvals, tools, the IPC router) to use. Main wires it with one line (Task 6). Only the
// proxy gets the key store itself; everyone else gets `credentials`, which has no way to read a key.

/** The Electron pieces the agent uses (main passes the real ones; tests pass fakes). */
export interface AgentElectron {
  readonly utilityProcess: {
    fork(modulePath: string, args: string[], options: { serviceName: string; env: Record<string, string>; execArgv: string[]; stdio: 'ignore' | 'inherit' }): HostChild;
  };
  readonly MessageChannelMain: new () => { readonly port1: HostPort; readonly port2: HostPort };
  readonly safeStorage: SafeStorageLike;
  readonly session: { fromPartition(partition: string): { fetch(url: string, init: ProxyRequestInit): Promise<Response> } };
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
  /** Loads the settings, then forks the runtime if needed and waits for `ready` (`false` if it failed). */
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
    log,
  });
  const store = createCredentialStore({ safeStorage: electron.safeStorage, file: path.join(deps.userData, CREDENTIALS_FILE), fs: files, log, ...(deps.platform ? { platform: deps.platform } : {}) });
  const settings = createAgentSettings({ file: path.join(deps.userData, AGENT_SETTINGS_FILE), fs: files, log });
  const proxy = createModelProxy({
    host,
    credentials: store,
    settings,
    // The in-memory session, looked up per request (after app ready; no `persist:`, so no cookie,
    // cache or connection state reaches the disk).
    fetch: (url, init) => electron.session.fromPartition(AGENT_MODEL_PARTITION).fetch(url, init),
    log,
  });
  return {
    host,
    credentials: credentialSettings(store),
    settings,
    proxy: { state: () => proxy.state() },
    entitlements: deps.entitlements ?? createDefaultAgentEntitlements(),
    async start() {
      // The proxy reads the route from the settings: they are loaded before the runtime can ask.
      await settings.load();
      return host.start();
    },
    dispose() {
      proxy.dispose();
      host.dispose();
    },
  };
}

export type { AgentHost, AgentHostStatus, AgentLockdown, AgentChatEvent, AgentToolInvoke } from './host';
export type { CredentialSettings, SetKeyResult } from './credentials';
export type { AgentSettings } from './settings';
export type { ModelProxyState } from './model-proxy';
export type { AgentEntitlements, AgentFeature } from './entitlements';
