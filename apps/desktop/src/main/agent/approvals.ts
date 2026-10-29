import { createHash, randomUUID } from 'node:crypto';
import { getToolDefinition } from '@app/ai-skills';
import {
  APPROVAL_DISPLAY_MAX_CHARS,
  APPROVAL_TIMEOUT_MS,
  activityStatusFor,
  approvalOriginFor,
  canGrant,
  decide,
  grantOriginFor,
  isApprovalDecision,
  isGrantOrigin,
  isPublicPage,
  isSafeInputJson,
  isTabBound,
  MAX_PENDING_APPROVALS_PER_CHAT,
  MAX_TOOL_CALLS_PER_TURN,
  pageUrlOf,
  runTargetFor,
  TOOL_ERROR_MESSAGES,
  type ApprovalDecision,
  type RunTarget,
  type ToolActivityStatus,
  type ToolRunVia,
} from '@app/specs/agent-approvals.spec';
import { ToolInputSchema, type JsonValue, type ToolResult } from '@app/specs/agent-protocol.schema';
import { completeToolInput } from '@app/specs/agent-search-tools.spec';
import { mcpServerIdOf, mcpToolLabel } from '@app/specs/agent-mcp.spec';
import { AGENT_TOOLS, isAgentToolName, isGrantable, isMcpToolName, TOOL_ERROR_CODES, toolRisk, type AgentToolRisk, type ToolErrorCode } from '@app/specs/agent-tools.spec';
import type { AgentEntitlements } from './entitlements';
import type { AgentGrants } from './grants';
import type { AgentHost, AgentToolInvoke } from './host';
import { wrapToolOutput } from './tool-output';

// The approval broker (Phase 5 Task 4, plan decision 7; spec `specs/agent-approvals.spec.ts`;
// acceptance `specs/agent-approvals.feature.md`). Main's only answer to the runtime's `tool.invoke`:
// for a chat main registered, a tool that chat allows, and input that main itself re-parses with
// the tool's schema, it runs the call (a read tool, or an act tool under a standing grant), asks
// the user, or refuses it, and answers `tool.result`. Approvals are answered only through
// `answer()`, which only main's code calls (the panel's sender-guarded IPC, Task 6): the host hands
// this module `tool.invoke` (and the turn's end) and nothing else, and no runtime message reaches
// `answer()` or the grants. An approval is bound to one call (its chat, call id, tool, exact
// canonical input and, for a page tool, the exact page), answered once, and expires after
// `APPROVAL_TIMEOUT_MS` or when its chat's turn ends. The run uses the input main stored, never
// anything sent later, and the runner is told what the page must still be (`ToolRunContext`).

/** What a tool run gets besides its input. */
export interface ToolRunContext {
  /** The chat's tab: the only tab the agent acts on. */
  readonly tabId: number;
  /** Aborted when the chat's turn ends (Stop) or the broker is disposed. */
  readonly signal: AbortSignal;
  /** Why it runs: a read tool on its own, an act tool under a grant, or the user's approval. */
  readonly via: ToolRunVia;
  /**
   * The origin the run must find before it acts (`runTargetFor`): the tab page's for a page tool
   * (checked as `location.origin` inside the isolated world, Task 5), the destination's for
   * `navigate`; `null` for tools that don't act on a site.
   */
  readonly expectedOrigin: string | null;
  /**
   * The exact URL: for a page tool, the tab's URL without its fragment when main decided the call
   * (a `via: 'approval'` page tool acts only if the page is still exactly it); for `navigate`, the
   * URL to load (`parseWebUrl(url).href`); `null` otherwise.
   */
  readonly expectedUrl: string | null;
}

/** A tool run's outcome: data and where it came from, or why there is none. */
export type ToolRunOutcome = { readonly ok: true; readonly data: unknown; readonly source: string } | { readonly ok: false; readonly code: ToolErrorCode };

/**
 * Runs tools for the broker (Task 5's page tools, Task 8's port tools, Task 10's MCP tools). It is
 * handed only calls the broker decided to run, with input re-parsed by main, and must check
 * `expectedOrigin` / `expectedUrl` itself before acting (the plan's Task 5 requirements). Its data
 * is wrapped untrusted and capped by the broker; its error codes become fixed messages
 * (`TOOL_ERROR_MESSAGES`).
 */
export interface ToolRunner {
  run(toolName: string, input: JsonValue, context: ToolRunContext): Promise<ToolRunOutcome>;
}

/** The runner until Task 5's tools are wired: every tool answers `unavailable`. */
export const unavailableToolRunner: ToolRunner = { run: async () => ({ ok: false, code: 'unavailable' }) };

/** What the session manager tells the broker about a chat's running turn. */
export interface ChatToolContext {
  /** The tab the chat acts on. */
  readonly tabId: number;
  /** The tools the chat offered the model this turn (`chat.start`'s `allowedTools`). */
  readonly allowedTools: readonly string[];
}

/** An approval request as the panel shows it. */
export interface ApprovalRequestView {
  readonly id: string;
  readonly chatId: string;
  readonly callId: string;
  readonly toolName: string;
  /** The catalogue's label, or "Untrusted tool from {server}" for an MCP tool. */
  readonly label: string;
  readonly risk: AgentToolRisk;
  /** The site the call acts on (`approvalOriginFor`), `null` for none. */
  readonly origin: string | null;
  /** For a page tool, the exact page it acts on (the tab's URL without its fragment); `null` otherwise. */
  readonly pageUrl: string | null;
  /** The exact canonical input (JSON text), in full: never longer than `APPROVAL_DISPLAY_MAX_CHARS`. */
  readonly input: string;
  /** SHA-256 (hex) of `input`, for display and logs only (main keeps the input itself). */
  readonly inputSha256: string;
  /** `execute_javascript`'s exact code (also in `input`, JSON-escaped); `null` for other tools. */
  readonly code: string | null;
  /** Whether `allow-always` is offered (`canGrant`). */
  readonly grantable: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A tool call's card state. */
export interface ToolActivity {
  readonly chatId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly status: ToolActivityStatus;
  /** The error code a call ended with (`denied`, `expired`, `failed` …), `null` otherwise. */
  readonly code: ToolErrorCode | null;
  /** The approval request it waits on (or waited on), `null` if it never asked. */
  readonly approvalId: string | null;
  readonly updatedAt: number;
}

/**
 * - `ok`: answered (`granted`: an `allow-always` grant was stored; `false` if it couldn't be, the
 *   call still ran once);
 * - `unknown`: no such pending request (never existed, already answered, expired);
 * - `not-grantable`: `allow-always` for a request that can't be granted (it stays pending);
 * - `invalid`: not an id or a decision.
 */
export type AnswerResult = { readonly ok: true; readonly granted: boolean } | { readonly ok: false; readonly reason: 'unknown' | 'not-grantable' | 'invalid' };

export interface ApprovalBrokerStats {
  /** `tool.invoke`s for a chat not registered. */
  unregistered: number;
  /** A call id seen before in the turn (dropped, unanswered). */
  duplicates: number;
  /** Refused before the policy: not allowed, not entitled, invalid input, over a cap. */
  refused: number;
  /** Ran without asking (read tools, standing grants). */
  autoRun: number;
  /** Approval requests created. */
  asked: number;
}

export interface ApprovalBrokerDeps {
  /**
   * `tool.invoke` in, `tool.result` out; `onChat` only to end a chat's turn on its `chat.finish` or
   * `chat.error` (the host also sends one when the runtime dies); `strike` for a repeated call id.
   */
  readonly host: Pick<AgentHost, 'onToolInvoke' | 'send'> & Partial<Pick<AgentHost, 'strike' | 'onChat'>>;
  readonly grants: AgentGrants;
  readonly entitlements: AgentEntitlements;
  /** Default `unavailableToolRunner`. */
  readonly runner?: ToolRunner;
  /** The URL tab `tabId` shows now (main's tab controller); `null` for none or a closed tab. */
  readonly tabUrl: (tabId: number) => string | null;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Approval ids (default `crypto.randomUUID`). */
  readonly randomId?: () => string;
  /** One line per event; never an input, an origin or tool output. */
  readonly log?: (line: string) => void;
  /** An MCP tool's label, naming its server (Task 10; default: the server id from the name). */
  readonly mcpLabel?: (toolName: string) => string;
  /**
   * Whether an MCP tool's input fits its server's sanitised schema (Task 10): `false` refuses the
   * call `invalid-input` before the user is asked. Main's runner checks it again before the call.
   */
  readonly mcpInputAllowed?: (toolName: string, input: JsonValue) => boolean;
}

export interface ApprovalBroker {
  /**
   * A chat's turn starts: its tab and its tools. Registering a chat again ends its previous turn
   * first (as `unregister`) and clears its activity.
   */
  register(chatId: string, context: ChatToolContext): void;
  /**
   * The chat's turn ended or was stopped: its pending approvals and running tools end `expired`.
   * Also done on the turn's `chat.finish` / `chat.error` from the host.
   */
  unregister(chatId: string): void;
  /** `unregister`, then drop the chat's activity (the chat was closed or deleted). */
  forget(chatId: string): void;
  isRegistered(chatId: string): boolean;
  /** Every approval request waiting for the user, oldest first. */
  pending(): readonly ApprovalRequestView[];
  /**
   * Answers an approval request once (main's IPC only). Resolves once the decision is applied (and
   * an `allow-always` grant stored); an allowed call then runs on its own. A request past its
   * `expiresAt` is `unknown` (and its call ends `expired`), whether or not its timer has fired.
   */
  answer(approvalId: string, decision: ApprovalDecision): Promise<AnswerResult>;
  /** The chat's tool calls this turn (or last turn), in call order. */
  activity(chatId: string): readonly ToolActivity[];
  /** Called after any change to `pending()` or `activity()`. */
  onChange(listener: () => void): () => void;
  /**
   * Called with each `tool.result` the broker sent the runtime (Task 6a: the session manager keeps
   * what the model was told in its history). Only results the host accepted.
   */
  onResult(listener: (chatId: string, callId: string, toolName: string, result: ToolResult) => void): () => void;
  stats(): Readonly<ApprovalBrokerStats>;
  /** Ends every turn and stops listening to the host. */
  dispose(): void;
}

interface Call {
  readonly chatId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly chat: ChatState;
  status: ToolActivityStatus;
  code: ToolErrorCode | null;
  approvalId: string | null;
  updatedAt: number;
  /** Set once a `tool.result` was sent (or the turn ended): nothing more is sent for it. */
  settled: boolean;
  controller: AbortController | null;
}

/** What main decided a call is: its exact input and what it acts on. */
interface Decided {
  readonly risk: AgentToolRisk;
  /** The exact canonical input (JSON text of the re-parsed input). */
  readonly canonical: string;
  readonly origin: string | null;
  /** The tab's page (no fragment) for a page tool, `null` otherwise. */
  readonly pageUrl: string | null;
  readonly target: RunTarget;
}

interface Pending {
  readonly view: ApprovalRequestView;
  readonly call: Call;
  readonly decided: Decided;
  readonly timer: unknown;
}

interface ChatState {
  readonly chatId: string;
  readonly tabId: number;
  readonly allowed: ReadonlySet<string>;
  readonly seen: Set<string>;
  active: boolean;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The panel's one line for `toolName` (an MCP tool: "Untrusted tool from {server}", `serverName` or its id). */
export function toolLabel(toolName: string, serverName: string | null = null): string {
  if (isAgentToolName(toolName)) return AGENT_TOOLS[toolName].label;
  return mcpToolLabel(serverName ?? mcpServerIdOf(toolName));
}

interface InputParser {
  safeParse(input: unknown): { readonly success: true; readonly data: unknown } | { readonly success: false };
}

/**
 * `input` re-parsed in main: a catalogue tool's own strict schema (`@app/ai-skills`), or, for an MCP
 * tool (its server's schema is Task 10's), bounded JSON with no unsafe character in a key or string
 * (`isSafeInputJson`). The canonical input must fit `APPROVAL_DISPLAY_MAX_CHARS`, so the user always
 * sees all of it (a catalogue input always does; a longer MCP input is refused rather than shown
 * cut). `null` when any of that fails.
 */
function reparse(toolName: string, input: unknown, mcpInputAllowed: (toolName: string, input: JsonValue) => boolean): { canonical: string; value: JsonValue } | null {
  // Each tool's schema, seen as a plain parser (their union of output types is too deep to infer).
  const definition = getToolDefinition(toolName) as { readonly inputSchema: InputParser } | undefined;
  const schema: InputParser | null = definition !== undefined ? definition.inputSchema : isMcpToolName(toolName) ? ToolInputSchema : null;
  const parsed = schema?.safeParse(input);
  if (parsed === undefined || !parsed.success) return null;
  const canonical = JSON.stringify(parsed.data ?? null);
  if (canonical.length > APPROVAL_DISPLAY_MAX_CHARS) return null;
  const checked = ToolInputSchema.safeParse(JSON.parse(canonical));
  if (!checked.success) return null;
  if (definition === undefined && (!isSafeInputJson(checked.data) || !mcpInputAllowed(toolName, checked.data))) return null;
  return { canonical, value: checked.data };
}

export function createApprovalBroker(deps: ApprovalBrokerDeps): ApprovalBroker {
  const runner = deps.runner ?? unavailableToolRunner;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const randomId = deps.randomId ?? randomUUID;
  const log = deps.log ?? (() => undefined);
  const labelOf = (toolName: string): string => {
    if (!isMcpToolName(toolName) || deps.mcpLabel === undefined) return toolLabel(toolName);
    try {
      return deps.mcpLabel(toolName);
    } catch {
      return toolLabel(toolName);
    }
  };
  const mcpInputAllowed = (toolName: string, value: JsonValue): boolean => {
    try {
      return deps.mcpInputAllowed === undefined || deps.mcpInputAllowed(toolName, value) === true;
    } catch {
      return false;
    }
  };
  const stats: ApprovalBrokerStats = { unregistered: 0, duplicates: 0, refused: 0, autoRun: 0, asked: 0 };

  const chats = new Map<string, ChatState>();
  /** Each chat's calls of its current (or last) turn, by call id, in call order. */
  const activities = new Map<string, Map<string, Call>>();
  const pendings = new Map<string, Pending>();
  const listeners = new Set<() => void>();
  const resultListeners = new Set<(chatId: string, callId: string, toolName: string, result: ToolResult) => void>();
  let disposed = false;

  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        log('agent approvals: a change listener failed');
      }
    }
  };

  const setStatus = (call: Call, status: ToolActivityStatus, code: ToolErrorCode | null = null) => {
    call.status = status;
    call.code = code;
    call.updatedAt = now();
    changed();
  };

  const send = (chatId: string, callId: string, toolName: string, result: ToolResult) => {
    let sent = false;
    try {
      sent = deps.host.send({ type: 'tool.result', chatId, callId, result }) === true;
    } catch {
      log('agent approvals: a tool result could not be sent');
    }
    if (!sent) return;
    for (const listener of [...resultListeners]) {
      try {
        listener(chatId, callId, toolName, result);
      } catch {
        log('agent approvals: a result listener failed');
      }
    }
  };

  const errorResult = (code: ToolErrorCode): ToolResult => ({ ok: false, error: { code, message: TOOL_ERROR_MESSAGES[code] } });

  /** Ends `call` with `code`: answers the runtime once and updates its card. */
  const fail = (call: Call, code: ToolErrorCode) => {
    if (call.settled) return;
    call.settled = true;
    call.controller = null;
    send(call.chatId, call.callId, call.toolName, errorResult(code));
    setStatus(call, activityStatusFor(code), code);
  };

  /** Drops a pending request (answered, expired, or its turn ended); `undefined` if it wasn't pending. */
  const takePending = (approvalId: string): Pending | undefined => {
    const entry = pendings.get(approvalId);
    if (entry === undefined) return undefined;
    pendings.delete(approvalId);
    clearTimer(entry.timer);
    return entry;
  };

  const entitled = (risk: AgentToolRisk) => deps.entitlements.allowed('agent') && (risk !== 'external' || deps.entitlements.allowed('agent.mcp'));

  /** Runs `call` with the stored input, `via` the read setting, a grant, or the user's approval. */
  const run = async (call: Call, decided: Decided, via: ToolRunVia) => {
    try {
      if (call.settled) return;
      const chat = call.chat;
      if (!chat.active || chats.get(call.chatId) !== chat) {
        fail(call, 'expired');
        return;
      }
      if (!entitled(decided.risk)) {
        fail(call, 'not-allowed');
        return;
      }
      // An approved page tool runs only on the exact page the user saw in the request.
      if (via === 'approval' && isTabBound(call.toolName) && pageUrlOf(deps.tabUrl(chat.tabId)) !== decided.pageUrl) {
        fail(call, 'expired');
        return;
      }
      const controller = new AbortController();
      call.controller = controller;
      setStatus(call, 'running');
      let outcome: ToolRunOutcome;
      try {
        outcome = await runner.run(call.toolName, JSON.parse(decided.canonical) as JsonValue, {
          tabId: chat.tabId,
          signal: controller.signal,
          via,
          expectedOrigin: decided.target.expectedOrigin,
          expectedUrl: decided.target.expectedUrl,
        });
      } catch {
        outcome = { ok: false, code: 'failed' };
      }
      if (call.settled) return;
      if ((outcome as unknown) === null || typeof outcome !== 'object') {
        fail(call, 'failed');
        return;
      }
      if (!outcome.ok) {
        fail(call, (TOOL_ERROR_CODES as readonly string[]).includes(outcome.code) ? outcome.code : 'failed');
        return;
      }
      const result = wrapToolOutput(call.toolName, outcome.source, outcome.data);
      if (result === null) {
        fail(call, 'failed');
        return;
      }
      call.settled = true;
      call.controller = null;
      send(call.chatId, call.callId, call.toolName, result);
      setStatus(call, 'done');
    } catch {
      // A dependency threw (the tab lookup, a listener): the call fails rather than stays running.
      fail(call, 'failed');
    }
  };

  const ask = (call: Call, decided: Decided) => {
    const chatPending = [...pendings.values()].filter((entry) => entry.call.chat === call.chat).length;
    if (chatPending >= MAX_PENDING_APPROVALS_PER_CHAT) {
      stats.refused += 1;
      fail(call, 'not-allowed');
      return;
    }
    const id = randomId();
    if (typeof id !== 'string' || id === '' || pendings.has(id)) {
      fail(call, 'failed');
      return;
    }
    const createdAt = now();
    const code = call.toolName === 'execute_javascript' ? (JSON.parse(decided.canonical) as { code: string }).code : null;
    const view: ApprovalRequestView = {
      id,
      chatId: call.chatId,
      callId: call.callId,
      toolName: call.toolName,
      label: labelOf(call.toolName),
      risk: decided.risk,
      origin: decided.origin,
      pageUrl: decided.pageUrl,
      input: decided.canonical,
      inputSha256: sha256(decided.canonical),
      code,
      grantable: canGrant(call.toolName, decided.origin),
      createdAt,
      expiresAt: createdAt + APPROVAL_TIMEOUT_MS,
    };
    const timer = setTimer(() => {
      const entry = takePending(id);
      if (entry !== undefined) fail(entry.call, 'expired');
    }, APPROVAL_TIMEOUT_MS);
    pendings.set(id, { view, call, decided, timer });
    stats.asked += 1;
    call.approvalId = id;
    setStatus(call, 'awaiting-approval');
  };

  const onInvoke = (invoke: AgentToolInvoke) => {
    if (disposed) return;
    const chat = chats.get(invoke.chatId);
    if (chat === undefined) {
      stats.unregistered += 1;
      send(invoke.chatId, invoke.callId, invoke.toolName, errorResult('not-allowed'));
      return;
    }
    if (chat.seen.has(invoke.callId)) {
      // The first call with this id is answered (or will be); a second answer would race it.
      stats.duplicates += 1;
      deps.host.strike?.();
      return;
    }
    if (chat.seen.size >= MAX_TOOL_CALLS_PER_TURN) {
      stats.refused += 1;
      send(invoke.chatId, invoke.callId, invoke.toolName, errorResult('not-allowed'));
      return;
    }
    chat.seen.add(invoke.callId);
    const call: Call = {
      chatId: invoke.chatId,
      callId: invoke.callId,
      toolName: invoke.toolName,
      chat,
      status: 'running',
      code: null,
      approvalId: null,
      updatedAt: now(),
      settled: false,
      controller: null,
    };
    let calls = activities.get(invoke.chatId);
    if (calls === undefined) activities.set(invoke.chatId, (calls = new Map()));
    calls.set(invoke.callId, call);

    try {
      const risk = toolRisk(invoke.toolName);
      if (risk === null || !chat.allowed.has(invoke.toolName) || !entitled(risk)) {
        stats.refused += 1;
        fail(call, 'not-allowed');
        return;
      }
      const tabUrl = deps.tabUrl(chat.tabId);
      // Defaults that depend on the tab (Task 8 review: `gsc_performance`'s page) are filled in
      // before the input is parsed, so the approval shows, hashes and runs exactly that input.
      const input = reparse(invoke.toolName, completeToolInput(invoke.toolName, invoke.input, tabUrl), mcpInputAllowed);
      if (input === null) {
        stats.refused += 1;
        fail(call, 'invalid-input');
        return;
      }
      const pageUrl = isTabBound(invoke.toolName) ? pageUrlOf(tabUrl) : null;
      if (isTabBound(invoke.toolName) && pageUrl === null) {
        // A page tool with no web page in the tab: nothing to read or act on.
        fail(call, 'unavailable');
        return;
      }
      const grantOrigin = grantOriginFor(invoke.toolName, input.value, tabUrl);
      const decided: Decided = {
        risk,
        canonical: input.canonical,
        origin: approvalOriginFor(invoke.toolName, input.value, tabUrl),
        pageUrl,
        target: runTargetFor(invoke.toolName, input.value, tabUrl),
      };
      const decision = decide(risk, {
        grantable: isGrantable(invoke.toolName),
        hasGrant: grantOrigin !== null && deps.grants.has(invoke.toolName, grantOrigin),
        readToolsAllowed: deps.grants.readToolsAllowed(),
        privateOrigin: !isGrantOrigin(grantOrigin),
        privatePage: pageUrl !== null && !isPublicPage(pageUrl),
      });
      if (decision === 'run') {
        stats.autoRun += 1;
        void run(call, decided, risk === 'read' ? 'read' : 'grant');
        return;
      }
      ask(call, decided);
    } catch {
      // A dependency threw (the tab lookup, the grants): refused, never left running.
      fail(call, 'failed');
    }
  };

  const unsubscribeTools = deps.host.onToolInvoke(onInvoke);

  const endTurn = (chatId: string) => {
    const chat = chats.get(chatId);
    if (chat === undefined) return;
    chats.delete(chatId);
    chat.active = false;
    for (const [id, entry] of [...pendings]) {
      if (entry.call.chat !== chat) continue;
      takePending(id);
      fail(entry.call, 'expired');
    }
    for (const call of activities.get(chatId)?.values() ?? []) {
      if (call.chat !== chat || call.settled) continue;
      const controller = call.controller;
      fail(call, 'expired');
      controller?.abort();
    }
  };

  // The turn ended in the runtime (or the runtime died): whatever still waits for it expires.
  const unsubscribeChat =
    deps.host.onChat?.((event) => {
      if (event.type === 'chat.finish' || event.type === 'chat.error') endTurn(event.chatId);
    }) ?? (() => undefined);

  return {
    register(chatId, context) {
      if (disposed) return;
      endTurn(chatId);
      activities.delete(chatId);
      chats.set(chatId, { chatId, tabId: context.tabId, allowed: new Set(context.allowedTools), seen: new Set(), active: true });
      changed();
    },
    unregister(chatId) {
      endTurn(chatId);
    },
    forget(chatId) {
      endTurn(chatId);
      if (activities.delete(chatId)) changed();
    },
    isRegistered: (chatId) => chats.has(chatId),
    pending: () => [...pendings.values()].map((entry) => entry.view).sort((a, b) => a.createdAt - b.createdAt),
    async answer(approvalId, decision) {
      if (typeof approvalId !== 'string' || !isApprovalDecision(decision)) return { ok: false, reason: 'invalid' };
      const entry = pendings.get(approvalId);
      if (entry === undefined) return { ok: false, reason: 'unknown' };
      if (now() >= entry.view.expiresAt) {
        // Its timer hasn't fired (the machine slept, or timers lag): expired all the same.
        takePending(approvalId);
        fail(entry.call, 'expired');
        return { ok: false, reason: 'unknown' };
      }
      if (decision === 'allow-always' && !entry.view.grantable) return { ok: false, reason: 'not-grantable' };
      // Single use: taken before anything is awaited.
      takePending(approvalId);
      const { call, decided } = entry;
      if (decision === 'deny') {
        fail(call, 'denied');
        return { ok: true, granted: false };
      }
      let granted = false;
      if (decision === 'allow-always' && decided.origin !== null) {
        try {
          granted = await deps.grants.add(call.toolName, decided.origin);
        } catch {
          granted = false;
        }
        if (!granted) log('agent approvals: a standing grant could not be stored; the call runs once');
      }
      // The tool runs on; its outcome shows in `activity()` and goes to the runtime as `tool.result`.
      void run(call, decided, 'approval');
      return { ok: true, granted };
    },
    activity: (chatId) =>
      [...(activities.get(chatId)?.values() ?? [])].map((call) => ({
        chatId: call.chatId,
        callId: call.callId,
        toolName: call.toolName,
        status: call.status,
        code: call.code,
        approvalId: call.approvalId,
        updatedAt: call.updatedAt,
      })),
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onResult(listener) {
      resultListeners.add(listener);
      return () => void resultListeners.delete(listener);
    },
    stats: () => ({ ...stats }),
    dispose() {
      if (disposed) return;
      for (const chatId of [...chats.keys()]) endTurn(chatId);
      disposed = true;
      unsubscribeTools();
      unsubscribeChat();
    },
  };
}
