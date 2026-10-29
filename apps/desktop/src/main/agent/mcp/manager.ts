import {
  cutText,
  isAllowedMcpReadFolder,
  isMcpServerId,
  mcpCommandLine,
  mcpServerIdFor,
  mcpServerIdOf,
  mcpToolDescription,
  mcpToolLabel,
  mcpToolNames,
  mcpSandboxSentence,
  MCP_ERRORS,
  MCP_LIMITS,
  normalizeMcpServerName,
  normalizeMcpToken,
  parseMcpServerUrl,
  sanitizeMcpInputSchema,
  validateMcpInput,
  type AgentMcpServerView,
  type AgentMcpView,
  type McpErrorCode,
  type McpInputSchema,
  type McpReadFolderContext,
  type McpSandboxMode,
  type McpSaveResult,
  type McpServerStatus,
  type McpStartResult,
  type McpTokenResult,
} from '@app/specs/agent-mcp.spec';
import { McpServerConfigSchema, McpToolDefinitionSchema, type AgentSaveMcpServerInput, type McpServerConfig, type McpToolDefinition } from '@app/specs/agent-mcp.schema';
import type { JsonValue } from '@app/specs/agent-protocol.schema';
import { TOOL_RESULT_MAX_CHARS, UNSAFE_CODE_CHARS } from '@app/specs/agent-tools.spec';
import type { ToolRunContext, ToolRunner, ToolRunOutcome } from '../approvals';
import type { AgentEntitlements } from '../entitlements';
import { createMcpClient, McpFailure, McpRpcError, type McpClient, type McpTransport } from './client';
import { createHttpTransport, type HttpTransportDeps } from './http';
import { launchPlan, resolveCommand, type DetectedSandbox } from './sandbox';
import type { McpSecrets } from './secrets';
import { createStdioTransport, type SpawnLike, type StdioTransport } from './stdio';

// The MCP servers (Phase 5 Task 10; spec `specs/agent-mcp.spec.ts`; acceptance
// `specs/agent-mcp.feature.md`): main's registry of the user's servers, their connections, and the
// broker's `ToolRunner` for their tools.
//
// - **Never automatic.** A server connects only when the user presses Start (`start`), never at
//   launch or when a chat runs. A command server's start shows main's native dialog every time,
//   with the exact command line, the sandbox in effect and the "untrusted" label; only its confirm
//   button starts it.
// - **Tools.** After `tools/list`, each tool gets a model-facing name (`mcp__<id>__<tool>`), a
//   description prefixed "Untrusted tool from {server}: " and a sanitised input schema; tools are
//   offered to a chat (`toolsForChat`) only while their server is enabled and ready and the
//   `agent.mcp` entitlement holds, never through a skill.
// - **Calls.** The broker asks the user every time (`external`, never grantable); this runner then
//   checks the call came `via: 'approval'`, validates the input against the sanitised schema, sends
//   `tools/call` with a timeout and the turn's abort signal, at most
//   `maxConcurrentCallsPerServer` at once, and answers the text parts only (other parts are left out
//   with a note; `isError` and JSON-RPC errors become `isError: true` data). The broker wraps it
//   untrusted and caps it.

/** The servers' table (`SessionStore.agentMcp`; a memory fake in tests). */
export interface McpServersStore {
  servers(): Promise<readonly { readonly id: string; readonly name: string; readonly transport: string; readonly url: string | null; readonly command: string | null; readonly args: string; readonly envNames: string; readonly readPaths: string; readonly allowNetwork: boolean; readonly enabled: boolean }[]>;
  saveServer(server: { readonly id: string; readonly name: string; readonly transport: string; readonly url: string | null; readonly command: string | null; readonly args: string; readonly envNames: string; readonly readPaths: string; readonly allowNetwork: boolean; readonly enabled: boolean }, at: number): Promise<boolean>;
  setEnabled(id: string, enabled: boolean, at: number): Promise<boolean>;
  deleteServer(id: string): Promise<boolean>;
}

/** What the start dialog shows (main's native confirm, `dialogs.ts`). */
export interface McpStartPrompt {
  readonly name: string;
  readonly commandLine: string;
  readonly sandbox: McpSandboxMode;
  readonly allowNetwork: boolean;
  /** The folders it may read, as real paths (what the sandbox binds), and its variables' names (never values). */
  readonly readPaths: readonly string[];
  readonly envNames: readonly string[];
}

export interface McpManagerDeps {
  readonly store: McpServersStore;
  readonly secrets: McpSecrets;
  readonly entitlements: AgentEntitlements;
  /** main's native confirm before a command server starts: `true` only for its confirm button. */
  readonly confirmStart: (prompt: McpStartPrompt) => Promise<boolean>;
  readonly spawn: SpawnLike;
  readonly fetch: HttpTransportDeps['fetch'];
  readonly resolveHost: HttpTransportDeps['resolveHost'];
  /** The sandbox here, detected once (`sandbox.ts` `detectSandbox`). */
  readonly detectSandbox: () => Promise<DetectedSandbox>;
  readonly isExecutable: (file: string) => boolean;
  readonly isDirectory: (file: string) => Promise<boolean>;
  readonly realpath: (file: string) => Promise<string>;
  /** A new, empty, owner-only folder for one start. */
  readonly makeTempDir: () => Promise<string>;
  readonly removeDir: (dir: string) => Promise<void>;
  /** main's `PATH`. */
  readonly pathEnv: string;
  /**
   * What a sandbox hides and a readable folder is checked against (each resolved to its real path at
   * every start): the user's home folders, `$XDG_RUNTIME_DIR`, the system's temporary folder and
   * frost's `userData`.
   */
  readonly homes: readonly string[];
  readonly runtimeDir: string | null;
  readonly tmpDir: string;
  readonly userData: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Signals a process group (tests). */
  readonly killGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface McpManager {
  /** Reads the stored servers (and starts detecting the sandbox). */
  load(): Promise<void>;
  view(): AgentMcpView;
  save(input: AgentSaveMcpServerInput): Promise<{ readonly result: McpSaveResult; readonly id?: string }>;
  remove(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  start(id: string): Promise<McpStartResult>;
  stop(id: string): Promise<boolean>;
  setToken(id: string, token: string | null): Promise<McpTokenResult>;
  /** The tools a chat may be offered now (enabled, ready, entitled), at most `maxToolsPerChat`. */
  toolsForChat(): McpToolDefinition[];
  /** The name of the server behind an MCP tool name, or `null`. */
  serverNameOf(toolName: string): string | null;
  /** The label of an MCP tool's cards and approvals ("Untrusted tool from {server}"). */
  labelOf(toolName: string): string;
  /** `false` only for a known tool whose sanitised schema refuses `input` (the broker refuses before asking). */
  inputAllowed(toolName: string, input: JsonValue): boolean;
  /** The broker's runner for MCP tools. */
  readonly runner: ToolRunner;
  onChange(listener: () => void): () => void;
  /** App quit: `SIGKILL` to every command server's process group, synchronously. */
  killAll(): void;
  /** Stops every server (app quit). */
  dispose(): Promise<void>;
}

interface ServerTool {
  readonly original: string;
  readonly definition: McpToolDefinition;
  readonly schema: McpInputSchema;
}

interface Run {
  readonly controller: AbortController;
  client: McpClient | null;
  /** A command server's transport (for `killAll`). */
  stdio: StdioTransport | null;
  tempDir: string | null;
  sandbox: McpSandboxMode;
  tools: Map<string, ServerTool>;
  inFlight: number;
}

interface Server {
  config: McpServerConfig;
  status: McpServerStatus;
  error: { readonly code: McpErrorCode; readonly status: number | null } | null;
  hasToken: boolean;
  run: Run | null;
}

/** Text a server returned, as the model reads it: line breaks and tabs kept, other controls and invisible characters removed. */
const UNSAFE_TEXT = new RegExp(UNSAFE_CODE_CHARS.source, 'gu');
const cleanResultText = (text: string) => text.replace(UNSAFE_TEXT, '');

/** The result's text budget, below the broker's cap so the text arrives as text, not cut JSON. */
const RESULT_TEXT_BUDGET = TOOL_RESULT_MAX_CHARS - 4_000;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A `tools/call` result as data for the model: text parts only, with a note for what was left out. */
export function mcpResultData(serverName: string, tool: string, result: Record<string, unknown>): Record<string, JsonValue> {
  const content = Array.isArray(result['content']) ? result['content'] : [];
  const texts: string[] = [];
  let omitted = 0;
  let used = 0;
  let cut = false;
  for (const part of content.slice(0, 1024)) {
    if (isObject(part) && part['type'] === 'text' && typeof part['text'] === 'string' && texts.length < MCP_LIMITS.maxTextParts) {
      const text = cleanResultText(part['text'].slice(0, RESULT_TEXT_BUDGET + 1));
      if (used + text.length > RESULT_TEXT_BUDGET) {
        texts.push(cutText(text, Math.max(0, RESULT_TEXT_BUDGET - used)));
        cut = true;
        break;
      }
      texts.push(text);
      used += text.length;
    } else omitted += 1;
  }
  const data: Record<string, JsonValue> = { server: serverName, tool: cutText(tool, 256), isError: result['isError'] === true, text: texts.join('\n\n') };
  if (cut) data['truncated'] = true;
  // `structuredContent` is never passed on (Task 10 review): its strings would reach the model uncleaned.
  if (omitted > 0) data['note'] = `frost passes on text only: ${omitted} other part${omitted === 1 ? ' was' : 's were'} left out.`;
  return data;
}

/** A stored row as a validated config, or `null` (a tampered row never becomes a server). */
function configOf(row: Awaited<ReturnType<McpServersStore['servers']>>[number]): McpServerConfig | null {
  try {
    const value =
      row.transport === 'http'
        ? { id: row.id, name: row.name, transport: 'http', url: row.url, enabled: row.enabled }
        : { id: row.id, name: row.name, transport: row.transport, command: row.command, args: JSON.parse(row.args), envNames: JSON.parse(row.envNames), readPaths: JSON.parse(row.readPaths), allowNetwork: row.allowNetwork, enabled: row.enabled };
    const parsed = McpServerConfigSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function rowOf(config: McpServerConfig) {
  return config.transport === 'http'
    ? { id: config.id, name: config.name, transport: 'http', url: config.url, command: null, args: '[]', envNames: '[]', readPaths: '[]', allowNetwork: false, enabled: config.enabled }
    : {
        id: config.id,
        name: config.name,
        transport: 'stdio',
        url: null,
        command: config.command,
        args: JSON.stringify(config.args),
        envNames: JSON.stringify(config.envNames),
        readPaths: JSON.stringify(config.readPaths),
        allowNetwork: config.allowNetwork,
        enabled: config.enabled,
      };
}

const sameConnection = (a: McpServerConfig, b: McpServerConfig) => JSON.stringify(rowOf({ ...a, enabled: true })) === JSON.stringify(rowOf({ ...b, enabled: true }));

export function createMcpManager(deps: McpManagerDeps): McpManager {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const platform = deps.platform ?? process.platform;
  const servers = new Map<string, Server>();
  const listeners = new Set<() => void>();
  let detected: DetectedSandbox | null = null;
  let detecting: Promise<DetectedSandbox> | null = null;
  let disposed = false;

  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        log('agent mcp: a change listener failed');
      }
    }
  };

  const entitled = (): boolean => {
    try {
      return deps.entitlements.allowed('agent') === true && deps.entitlements.allowed('agent.mcp') === true;
    } catch {
      return false;
    }
  };

  const sandboxHere = () => {
    detecting ??= deps
      .detectSandbox()
      .catch(() => ({ mode: 'none' as const, launcher: null }))
      .then((found) => {
        detected = found;
        changed();
        return found;
      });
    return detecting;
  };

  /** Ends a run: closes its client, removes its folder. The server's status is the caller's. */
  const endRun = async (run: Run) => {
    run.controller.abort();
    const client = run.client;
    run.client = null;
    run.tools = new Map();
    if (client !== null) await client.close().catch(() => undefined);
    const dir = run.tempDir;
    run.tempDir = null;
    if (dir !== null) await deps.removeDir(dir).catch(() => log('agent mcp: a temporary folder could not be removed'));
  };

  const failRun = (server: Server, run: Run, code: McpErrorCode, status: number | null = null) => {
    if (server.run !== run) return;
    server.run = null;
    server.status = 'failed';
    server.error = { code, status };
    void endRun(run);
    changed();
  };

  const stopServer = async (server: Server): Promise<void> => {
    const run = server.run;
    server.run = null;
    if (run !== null) await endRun(run);
    if (server.status !== 'stopped' || server.error !== null) {
      server.status = 'stopped';
      server.error = null;
      changed();
    }
  };

  const errorText = (server: Server): string | null => {
    if (server.error === null) return null;
    const base = MCP_ERRORS[server.error.code] ?? MCP_ERRORS.protocol;
    return server.error.status !== null ? `${base} (HTTP ${server.error.status})` : base;
  };

  const viewOf = (server: Server): AgentMcpServerView => {
    const config = server.config;
    const sandbox: McpSandboxMode = config.transport === 'http' ? 'n/a' : (server.run?.sandbox ?? detected?.mode ?? 'none');
    const allowNetwork = config.transport === 'stdio' ? config.allowNetwork : true;
    return {
      id: config.id,
      name: config.name,
      transport: config.transport,
      target: cutText(config.transport === 'http' ? config.url : mcpCommandLine(config.command, config.args), 2000),
      enabled: config.enabled,
      status: server.status,
      sandbox,
      sandboxNote: mcpSandboxSentence(sandbox, allowNetwork),
      allowNetwork: config.transport === 'stdio' ? config.allowNetwork : false,
      readPaths: config.transport === 'stdio' ? [...config.readPaths] : [],
      envNames: config.transport === 'stdio' ? [...config.envNames] : [],
      hasToken: server.hasToken,
      toolCount: server.status === 'ready' ? (server.run?.tools.size ?? 0) : 0,
      lastError: errorText(server),
    };
  };

  /** Connects a server's transport and lists its tools; the server is `starting` and `run` is its current run. */
  const connect = async (server: Server, run: Run): Promise<McpStartResult> => {
    const config = server.config;
    const current = () => server.run === run && !run.controller.signal.aborted;
    let transport: McpTransport;
    let stdio: StdioTransport | null = null;
    if (config.transport === 'http') {
      const url = parseMcpServerUrl(config.url);
      if (url === null) {
        failRun(server, run, 'refused-url');
        return 'failed';
      }
      run.sandbox = 'n/a';
      transport = createHttpTransport({ url, fetch: deps.fetch, resolveHost: deps.resolveHost, token: () => deps.secrets.withToken(config.id, async (token) => token) });
    } else {
      const sandbox = await sandboxHere();
      if (!current()) return 'failed';
      // The real path: what runs, what the dialog shows, what a sandbox profile names (macOS refuses
      // to exec a symlink whose own path the profile allows, checked on macOS 27).
      const found = resolveCommand(config.command, deps.pathEnv, platform, deps.isExecutable);
      const command = found === null ? null : await deps.realpath(found).catch(() => null);
      if (!current()) return 'failed';
      if (command === null) {
        failRun(server, run, 'not-found');
        return 'failed';
      }
      run.sandbox = sandbox.mode;
      // The readable folders, on their real paths now (a symlink or a renamed folder can't slip
      // something else in since saving), checked against home, its secret folders, the runtime and
      // temporary folders and frost's data; any missing or refused one stops the start.
      const context = await readContext(null);
      const readPaths = context === null ? null : await vetReadPaths(config.readPaths, context);
      if (!current()) return 'failed';
      if (context === null || readPaths === null) {
        failRun(server, run, 'read-path');
        return 'failed';
      }
      // Every start asks, showing exactly what will run, what it may read and get, and how it is contained.
      let allowed = false;
      try {
        allowed =
          (await deps.confirmStart({ name: config.name, commandLine: mcpCommandLine(command, config.args), sandbox: sandbox.mode, allowNetwork: config.allowNetwork, readPaths, envNames: [...config.envNames] })) === true;
      } catch {
        allowed = false;
      }
      if (!current()) return 'failed';
      if (!allowed) {
        server.run = null;
        server.status = 'stopped';
        server.error = { code: 'declined', status: null };
        changed();
        return 'declined';
      }
      let env: Record<string, string> = {};
      if (config.envNames.length > 0) {
        const values = await deps.secrets.envValues(config.id).catch(() => null);
        if (values === null || !config.envNames.every((name) => Object.hasOwn(values, name))) {
          failRun(server, run, 'secrets-failed');
          return 'failed';
        }
        env = Object.fromEntries(config.envNames.map((name) => [name, values[name]!]));
      }
      if (!current()) return 'failed';
      try {
        run.tempDir = await deps.makeTempDir();
        run.tempDir = await deps.realpath(run.tempDir);
      } catch {
        failRun(server, run, 'spawn-failed');
        return 'failed';
      }
      if (!current()) return 'failed';
      // Checked again with the server's own folder known: nothing listed may be it, hold it or sit in it.
      const tempDir = run.tempDir;
      if ((await vetReadPaths(readPaths, { ...context, tempDir })) === null) {
        failRun(server, run, 'read-path');
        return 'failed';
      }
      const plan = launchPlan(
        sandbox.mode,
        {
          command,
          args: config.args,
          tempDir,
          hidden: [...context.realHomes, context.userData],
          allowNetwork: config.allowNetwork,
          readPaths,
          pathEnv: deps.pathEnv,
          env,
          disableUserns: sandbox.disableUserns === true,
        },
        undefined,
        sandbox.mode === 'bubblewrap' && sandbox.launcher !== null ? sandbox.launcher : undefined,
      );
      try {
        stdio = createStdioTransport({ spawn: deps.spawn, command: plan.command, args: plan.args, env: plan.env, cwd: plan.cwd, statusFd: plan.statusFd, platform, ...(deps.killGroup ? { killGroup: deps.killGroup } : {}) });
      } catch {
        failRun(server, run, 'spawn-failed');
        return 'failed';
      }
      transport = stdio;
      run.stdio = stdio;
    }
    const launched = stdio;
    /** Why the connection ended: a sandbox that never came up is the sandbox's failure, not the server's. */
    const classify = (code: McpErrorCode): McpErrorCode => {
      if (launched === null || code !== 'exited') return code;
      if (run.sandbox === 'bubblewrap' && !launched.sandboxReady()) return 'sandbox-failed';
      if (run.sandbox === 'macos-sandbox' && launched.stderrHead().startsWith('sandbox-exec')) return 'sandbox-failed';
      return code;
    };
    transport.onClose((code) => {
      if (server.run === run && !run.controller.signal.aborted) failRun(server, run, classify(code));
    });
    const client = createMcpClient(transport);
    run.client = client;
    const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(MCP_LIMITS.startTimeoutMs)]);
    try {
      const init = await client.initialize(signal);
      const listed = init.tools ? await client.listTools(signal) : [];
      if (!current()) return 'failed';
      const tools = new Map<string, ServerTool>();
      const byName = new Map(listed.filter((tool) => typeof tool.name === 'string').map((tool) => [tool.name as string, tool] as const));
      for (const { name, original } of mcpToolNames(config.id, listed.map((tool) => tool.name))) {
        const tool = byName.get(original);
        if (tool === undefined) continue;
        const schema = sanitizeMcpInputSchema(tool.inputSchema);
        const parsed = McpToolDefinitionSchema.safeParse({ name, description: mcpToolDescription(config.name, tool.description), inputSchema: schema });
        if (parsed.success) tools.set(name, { original, definition: parsed.data, schema: parsed.data.inputSchema });
      }
      run.tools = tools;
      server.status = 'ready';
      server.error = null;
      changed();
      return 'ready';
    } catch (error) {
      if (!current()) return 'failed';
      const code = error instanceof McpFailure ? classify(error.code) : 'protocol';
      failRun(server, run, code, error instanceof McpFailure ? error.status : null);
      return 'failed';
    }
  };

  /** The real paths a readable folder is checked against; `null` if they can't be resolved. */
  const readContext = async (tempDir: string | null): Promise<(McpReadFolderContext & { readonly realHomes: readonly string[] }) | null> => {
    const real = async (file: string) => deps.realpath(file).catch(() => null);
    const homes = (await Promise.all(deps.homes.map((home) => real(home)))).filter((home): home is string => home !== null);
    const userData = (await real(deps.userData)) ?? deps.userData;
    const tmpDir = (await real(deps.tmpDir)) ?? deps.tmpDir;
    const runtimeDir = deps.runtimeDir === null ? null : ((await real(deps.runtimeDir)) ?? deps.runtimeDir);
    // Without a home to hide, nothing is hidden: refuse rather than run a sandbox that claims it.
    if (homes.length === 0 && deps.homes.length > 0) return null;
    // Checked against both a home as given and its real path; the sandbox hides the real ones.
    return { homes: [...new Set([...homes, ...deps.homes.filter((home) => home.startsWith('/'))])], realHomes: [...new Set(homes)], runtimeDir, userData, tmpDir, tempDir };
  };

  /** Each folder's real path, if it is a directory and allowed (`isAllowedMcpReadFolder`); `null` if any isn't. */
  const vetReadPaths = async (folders: readonly string[], context: McpReadFolderContext): Promise<string[] | null> => {
    const out: string[] = [];
    for (const folder of folders) {
      if (!isAllowedMcpReadFolder(folder, context)) return null;
      const real = await deps.realpath(folder).catch(() => null);
      if (real === null || !isAllowedMcpReadFolder(real, context) || !(await deps.isDirectory(real).catch(() => false))) return null;
      if (!out.includes(real)) out.push(real);
    }
    return out;
  };

  const findTool = (toolName: string): { server: Server; run: Run; tool: ServerTool } | null => {
    const id = mcpServerIdOf(toolName);
    const server = id === null ? undefined : servers.get(id);
    const run = server?.run ?? null;
    if (server === undefined || run === null || server.status !== 'ready' || !server.config.enabled) return null;
    const tool = run.tools.get(toolName);
    return tool === undefined ? null : { server, run, tool };
  };

  const runner: ToolRunner = {
    async run(toolName: string, input: JsonValue, context: ToolRunContext): Promise<ToolRunOutcome> {
      // An MCP tool runs only on the user's approval of this exact call (never a grant or the read setting).
      if (context.via !== 'approval' || !entitled()) return { ok: false, code: 'not-allowed' };
      if (context.signal.aborted) return { ok: false, code: 'failed' };
      const found = findTool(toolName);
      if (found === null || found.run.client === null) return { ok: false, code: 'unavailable' };
      const { server, run, tool } = found;
      if (!isObject(input) || !validateMcpInput(tool.schema, input)) return { ok: false, code: 'invalid-input' };
      if (run.inFlight >= MCP_LIMITS.maxConcurrentCallsPerServer) return { ok: false, code: 'failed' };
      run.inFlight += 1;
      const signal = AbortSignal.any([context.signal, run.controller.signal]);
      const source = `MCP server "${server.config.name}" (untrusted)`;
      try {
        const result = await run.client!.callTool(tool.original, input as Record<string, unknown>, signal);
        return { ok: true, data: mcpResultData(server.config.name, tool.original, result), source };
      } catch (error) {
        if (error instanceof McpRpcError) {
          const message = cleanResultText(error.rpcMessage).slice(0, 1000);
          return { ok: true, data: { server: server.config.name, tool: cutText(tool.original, 256), isError: true, error: { code: error.rpcCode, message } }, source };
        }
        // The client's own deadline: `timeout`; Stop or the server stopping: `failed`.
        if (error instanceof McpFailure && error.code === 'timeout' && !signal.aborted) return { ok: false, code: 'timeout' };
        return { ok: false, code: 'failed' };
      } finally {
        run.inFlight -= 1;
      }
    },
  };

  return {
    async load() {
      void sandboxHere();
      let rows: Awaited<ReturnType<McpServersStore['servers']>> = [];
      try {
        rows = await deps.store.servers();
      } catch {
        log('agent mcp: the servers could not be read');
      }
      for (const row of rows) {
        const config = configOf(row);
        if (config === null) {
          log('agent mcp: a stored server was not valid and was skipped');
          continue;
        }
        if (!servers.has(config.id)) servers.set(config.id, { config, status: 'stopped', error: null, hasToken: false, run: null });
      }
      await Promise.all(
        [...servers.values()]
          .filter((server) => server.config.transport === 'http')
          .map(async (server) => {
            server.hasToken = await deps.secrets.hasToken(server.config.id).catch(() => false);
          }),
      );
      changed();
    },

    view: () => ({ available: entitled(), servers: [...servers.values()].map(viewOf) }),

    async save(input) {
      if (disposed) return { result: 'failed' };
      if (!entitled()) return { result: 'not-entitled' };
      const name = normalizeMcpServerName(input.name);
      if (name === null) return { result: 'invalid' };
      const existing = input.id === undefined ? undefined : servers.get(input.id);
      if (input.id !== undefined && existing === undefined) return { result: 'unknown' };
      if (existing === undefined && servers.size >= MCP_LIMITS.maxServers) return { result: 'too-many' };
      const id = existing?.config.id ?? mcpServerIdFor(name, new Set(servers.keys()));
      if (id === null || !isMcpServerId(id)) return { result: 'too-many' };
      const enabled = existing?.config.enabled ?? false;
      const candidate =
        input.transport === 'http'
          ? { id, name, transport: 'http' as const, url: parseMcpServerUrl(input.url), enabled }
          : { id, name, transport: 'stdio' as const, command: input.command, args: [...input.args], envNames: input.env.map((item) => item.name), readPaths: [...input.readPaths], allowNetwork: input.allowNetwork, enabled };
      const parsed = McpServerConfigSchema.safeParse(candidate);
      if (!parsed.success) return { result: 'invalid' };
      const config = parsed.data;
      // Readable folders are checked here too (as typed and as they resolve now), so a refused one
      // is said at once; every start checks them again.
      if (config.transport === 'stdio' && config.readPaths.length > 0) {
        const context = await readContext(null);
        if (context === null || !config.readPaths.every((folder) => isAllowedMcpReadFolder(folder, context))) return { result: 'invalid' };
        for (const folder of config.readPaths) {
          const real = await deps.realpath(folder).catch(() => null);
          if (real !== null && !isAllowedMcpReadFolder(real, context)) return { result: 'invalid' };
        }
      }
      // Environment values: the ones typed now, else the stored ones for names still listed.
      if (input.transport === 'stdio') {
        const typed = input.env.filter((item) => item.value !== undefined);
        const keptNames = new Set(input.env.map((item) => item.name));
        const previous = existing?.config.transport === 'stdio' ? existing.config.envNames : [];
        if (typed.length > 0 || previous.some((item) => !keptNames.has(item))) {
          const stored = previous.length > 0 ? await deps.secrets.envValues(id).catch(() => null) : {};
          if (stored === null) return { result: 'failed' };
          const next: Record<string, string> = {};
          for (const item of input.env) {
            const value = item.value ?? stored[item.name];
            if (value !== undefined) next[item.name] = value;
          }
          const written = await deps.secrets.setEnvValues(id, next).catch(() => 'failed' as const);
          if (written === 'no-keychain') return { result: 'no-keychain' };
          if (written !== 'stored') return { result: written === 'invalid' ? 'invalid' : 'failed' };
        }
      } else if (existing?.config.transport === 'stdio' && existing.config.envNames.length > 0) {
        await deps.secrets.setEnvValues(id, {}).catch(() => undefined);
      }
      let saved = false;
      try {
        saved = await deps.store.saveServer(rowOf(config), now());
      } catch {
        saved = false;
      }
      if (!saved) return { result: 'failed' };
      if (existing !== undefined) {
        // A changed connection ends the running one: the next start shows the new command.
        const reconnect = !sameConnection(existing.config, config);
        existing.config = config;
        if (reconnect) await stopServer(existing);
        if (config.transport === 'http') existing.hasToken = await deps.secrets.hasToken(id).catch(() => false);
      } else {
        servers.set(id, { config, status: 'stopped', error: null, hasToken: false, run: null });
      }
      changed();
      return { result: 'saved', id };
    },

    async remove(id) {
      const server = servers.get(id);
      if (server === undefined) return false;
      let deleted = false;
      try {
        deleted = await deps.store.deleteServer(id);
      } catch {
        deleted = false;
      }
      if (!deleted) return false;
      servers.delete(id);
      await stopServer(server);
      await deps.secrets.forget(id).catch(() => log('agent mcp: a server secret could not be removed'));
      changed();
      return true;
    },

    async setEnabled(id, enabled) {
      const server = servers.get(id);
      if (server === undefined || typeof enabled !== 'boolean') return false;
      if (enabled && !entitled()) return false;
      let stored = false;
      try {
        stored = await deps.store.setEnabled(id, enabled, now());
      } catch {
        stored = false;
      }
      if (!stored) return false;
      server.config = { ...server.config, enabled };
      // Turned off: its connection ends, and its tools leave every chat from the next turn on.
      if (!enabled) await stopServer(server);
      changed();
      return true;
    },

    async start(id) {
      const server = servers.get(id);
      if (server === undefined || disposed) return 'unknown';
      if (!entitled()) return 'not-entitled';
      if (!server.config.enabled) return 'disabled';
      if (server.status === 'starting' || server.status === 'ready') return 'busy';
      const run: Run = { controller: new AbortController(), client: null, stdio: null, tempDir: null, sandbox: server.config.transport === 'http' ? 'n/a' : (detected?.mode ?? 'none'), tools: new Map(), inFlight: 0 };
      server.run = run;
      server.status = 'starting';
      server.error = null;
      changed();
      try {
        return await connect(server, run);
      } catch {
        failRun(server, run, 'protocol');
        return 'failed';
      }
    },

    async stop(id) {
      const server = servers.get(id);
      if (server === undefined) return false;
      await stopServer(server);
      return true;
    },

    async setToken(id, token) {
      const server = servers.get(id);
      if (server === undefined) return 'unknown';
      let result: McpTokenResult;
      if (token === null) {
        result = (await deps.secrets.clearToken(id).catch(() => false)) ? 'cleared' : 'failed';
      } else if (normalizeMcpToken(token) === null) {
        result = 'invalid';
      } else {
        const stored = await deps.secrets.setToken(id, token).catch(() => 'failed' as const);
        result = stored === 'stored' ? 'stored' : stored === 'invalid' ? 'invalid' : stored === 'no-keychain' ? 'no-keychain' : 'failed';
      }
      server.hasToken = await deps.secrets.hasToken(id).catch(() => false);
      changed();
      return result;
    },

    toolsForChat() {
      if (!entitled()) return [];
      const out: McpToolDefinition[] = [];
      for (const server of servers.values()) {
        if (!server.config.enabled || server.status !== 'ready' || server.run === null) continue;
        for (const tool of server.run.tools.values()) {
          if (out.length >= MCP_LIMITS.maxToolsPerChat) return out;
          out.push(tool.definition);
        }
      }
      return out;
    },

    serverNameOf(toolName) {
      const id = mcpServerIdOf(toolName);
      return id === null ? null : (servers.get(id)?.config.name ?? null);
    },

    labelOf(toolName) {
      const id = mcpServerIdOf(toolName);
      return mcpToolLabel(id === null ? null : (servers.get(id)?.config.name ?? null));
    },

    inputAllowed(toolName, input) {
      const found = findTool(toolName);
      return found === null || (isObject(input) && validateMcpInput(found.tool.schema, input));
    },

    runner,

    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    killAll() {
      disposed = true;
      for (const server of servers.values()) {
        try {
          server.run?.stdio?.killNow();
        } catch {
          // Already gone.
        }
      }
    },

    async dispose() {
      disposed = true;
      await Promise.all([...servers.values()].map((server) => stopServer(server)));
    },
  };
}

/** Servers in memory (no database: nothing persists). */
export function createMemoryMcpStore(): McpServersStore {
  type Row = Awaited<ReturnType<McpServersStore['servers']>>[number];
  const rows = new Map<string, Row>();
  return {
    servers: async () => [...rows.values()].map((row) => ({ ...row })),
    async saveServer(server) {
      if (!rows.has(server.id) && rows.size >= MCP_LIMITS.maxServers) return false;
      rows.set(server.id, { ...server });
      return true;
    },
    async setEnabled(id, enabled) {
      const row = rows.get(id);
      if (row === undefined) return false;
      rows.set(id, { ...row, enabled });
      return true;
    },
    deleteServer: async (id) => rows.delete(id) || true,
  };
}
