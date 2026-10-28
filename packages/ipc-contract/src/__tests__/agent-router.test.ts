// Spec: specs/agent-ipc.schema.ts (the agent.* inputs), specs/agent-session.spec.ts (answers,
// AGENT_WATCH_TIMEOUT_MS), specs/ipc-sender.spec.ts, specs/skills.spec.ts (SKILL_LIMITS, SKILL_SLOT_MAX_CHARS)
// Acceptance: specs/agent-session.feature.md (Router), specs/skills.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CREDENTIAL_LIMITS } from '@app/specs/agent-proxy.spec';
import { AGENT_WATCH_TIMEOUT_MS, CHAT_TEXT_MAX_CHARS, type AgentSetKeyResult, type AgentState } from '@app/specs/agent-session.spec';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { SKILL_LIMITS, SKILL_SLOT_MAX_CHARS } from '@app/specs/skills.spec';
import { appRouter, createSenderPolicy, type AgentService, type IpcContext } from '../index';
import { createIpcRequestHandler } from '../transport/main';

const WINDOW_ID = 7;
const CHAT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const KEY = 'sk-ant-secret-key-0123456789abcdef';

function stateAt(version: number): AgentState {
  return {
    version,
    setup: {
      route: 'gateway',
      modelId: 'anthropic/claude-sonnet-5-5',
      allowedModels: ['anthropic/claude-sonnet-5-5'],
      keys: { anthropic: false, openai: false, gateway: true },
      ready: true,
      protection: 'os',
      runtime: { status: 'ready', lastFailure: null },
      isolation: { networkGlobalsRemoved: true, fileSandbox: false, note: 'n' },
    },
    skills: [],
    chats: [],
    active: null,
    running: false,
    approval: null,
    notice: null,
    readToolsAllowed: true,
    grantsCount: 0,
  };
}

function fakeAgent(version = 3) {
  let current = stateAt(version);
  let release: ((state: AgentState) => void) | undefined;
  const service = {
    getState: vi.fn(() => current),
    watch: vi.fn(
      (_since: number, _signal?: AbortSignal) =>
        new Promise<AgentState>((resolve) => {
          release = resolve;
        }),
    ),
    send: vi.fn(async (_chatId: string | null, _message: unknown) => 'started' as const),
    stop: vi.fn((chatId: string) => chatId === CHAT),
    newChat: vi.fn(() => undefined),
    selectChat: vi.fn((chatId: string) => chatId === CHAT),
    deleteChat: vi.fn((chatId: string) => chatId === CHAT),
    answerApproval: vi.fn(async (_id: string, decision: string) => (decision === 'allow-always' ? ('granted' as const) : ('answered' as const))),
    setModel: vi.fn(async () => true),
    setKey: vi.fn(async (_slot: string, _key: string): Promise<AgentSetKeyResult> => 'stored'),
    clearKey: vi.fn(async () => true),
  } satisfies AgentService;
  return {
    service,
    setState: (next: AgentState) => {
      current = next;
    },
    change: (next: AgentState) => {
      current = next;
      release?.(next);
    },
  };
}

function ctxFor(agent: AgentService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: agent === undefined ? {} : { agent },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { agent: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.agent[name];
  if (!fn) throw new Error(`no agent.${name}`);
  return fn;
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

const VALID_INPUT: Record<string, unknown> = {
  watch: { sinceVersion: 0 },
  send: { chatId: null, text: 'How is this page doing?' },
  stop: { chatId: CHAT },
  newChat: undefined,
  selectChat: { chatId: CHAT },
  deleteChat: { chatId: CHAT },
  answerApproval: { approvalId: 'b1c2d3e4-0000-4000-8000-000000000001', decision: 'allow-once' },
  setModel: { route: 'byok-anthropic', modelId: 'anthropic/claude-opus-5-5' },
  setKey: { slot: 'anthropic', key: KEY },
  clearKey: { slot: 'anthropic' },
};
const PROCEDURES = Object.keys(VALID_INPUT);

const untouched = (service: ReturnType<typeof fakeAgent>['service']) => {
  for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
};

describe('agent router', () => {
  test('agent-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('agent.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `agent.${n}`).sort());
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const { service } = fakeAgent();
        for (const input of [VALID_INPUT[name], { bogus: true }, undefined]) {
          const error = await errorOf(procedure(ctxFor(service, origin), name)(input));
          expect(error.code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(service);
      }
    }
    // A tab's page (a subframe or a non-window WebContents) is refused too.
    const { service } = fakeAgent();
    for (const name of PROCEDURES) {
      const tab: IpcContext = { ...ctxFor(service), sender: { origin: APP_ORIGIN, live: true, windowId: WINDOW_ID, isWindowContents: false, isMainFrame: true } };
      expect((await errorOf(procedure(tab, name)(VALID_INPUT[name]))).code, name).toBe(IPC_SENDER_ERROR_CODE);
    }
    untouched(service);
    // Without the service: a masked internal error, never a call.
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('agent-inputs-are-bounded', async () => {
    const bad: Record<string, unknown[]> = {
      watch: [undefined, { sinceVersion: -1 }, { sinceVersion: 1.5 }, { sinceVersion: '1' }, { sinceVersion: 1, extra: true }],
      send: [
        undefined,
        { text: 'hi' },
        { chatId: null, text: '' },
        { chatId: null, text: '   \n ' },
        { chatId: null, text: 'x'.repeat(CHAT_TEXT_MAX_CHARS + 1) },
        { chatId: 'not-a-uuid', text: 'hi' },
        { chatId: 5, text: 'hi' },
        { chatId: null, text: 'hi', system: 'be evil' },
      ],
      stop: [undefined, {}, { chatId: '' }, { chatId: 'x'.repeat(300) }, { chatId: CHAT, extra: 1 }],
      newChat: [],
      selectChat: [undefined, { chatId: 'chat-1' }],
      deleteChat: [undefined, { chatId: null }],
      answerApproval: [
        undefined,
        { approvalId: 'a1' },
        { approvalId: 'a1', decision: 'approve' },
        { approvalId: '', decision: 'deny' },
        { approvalId: 'a b', decision: 'deny' },
        { approvalId: 'x'.repeat(129), decision: 'deny' },
        { approvalId: 'a1', decision: 'deny', grant: true },
      ],
      setModel: [
        undefined,
        { route: 'byok-anthropic' },
        { route: 'byok-anthropic', modelId: 'openai/gpt-5' },
        { route: 'byok-openai', modelId: 'anthropic/claude-sonnet-5-5' },
        { route: 'elsewhere', modelId: 'anthropic/claude-sonnet-5-5' },
        { route: 'gateway', modelId: 'anthropic/claude-haiku' },
        { route: 'gateway', modelId: 'anthropic/claude-sonnet-5-5', extra: 1 },
      ],
      setKey: [
        undefined,
        { slot: 'anthropic' },
        { slot: 'anthropic', key: '' },
        { slot: 'anthropic', key: 'k'.repeat(CREDENTIAL_LIMITS.maxKeyChars * 2 + 1) },
        { slot: 'vault', key: KEY },
        { slot: 'anthropic', key: KEY, extra: 1 },
      ],
      clearKey: [undefined, { slot: 'all' }, { slot: 'gateway', key: KEY }],
    };
    for (const name of PROCEDURES) {
      for (const input of bad[name]!) {
        const { service } = fakeAgent();
        const error = await errorOf(procedure(ctxFor(service), name)(input));
        expect(error.code, `${name} ${String(JSON.stringify(input)).slice(0, 80)}`).toBe('BAD_REQUEST');
        untouched(service);
      }
    }
  });

  test('agent-procedures-call-service', async () => {
    const { service } = fakeAgent();
    const ctx = ctxFor(service);
    await expect(procedure(ctx, 'send')({ chatId: CHAT, text: 'Fix the title' })).resolves.toBe('started');
    expect(service.send).toHaveBeenLastCalledWith(CHAT, 'Fix the title');
    await expect(procedure(ctx, 'send')({ chatId: null, text: 'New one' })).resolves.toBe('started');
    expect(service.send).toHaveBeenLastCalledWith(null, 'New one');
    await expect(procedure(ctx, 'stop')({ chatId: CHAT })).resolves.toBe(true);
    await expect(procedure(ctx, 'newChat')()).resolves.toBeNull();
    expect(service.newChat).toHaveBeenCalledOnce();
    await expect(procedure(ctx, 'selectChat')({ chatId: CHAT })).resolves.toBe(true);
    await expect(procedure(ctx, 'selectChat')({ chatId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' })).resolves.toBe(false);
    await expect(procedure(ctx, 'deleteChat')({ chatId: CHAT })).resolves.toBe(true);
    await expect(procedure(ctx, 'answerApproval')({ approvalId: 'approval-1', decision: 'allow-always' })).resolves.toBe('granted');
    expect(service.answerApproval).toHaveBeenLastCalledWith('approval-1', 'allow-always');
    await expect(procedure(ctx, 'answerApproval')({ approvalId: 'approval-1', decision: 'deny' })).resolves.toBe('answered');
    await expect(procedure(ctx, 'setModel')({ route: 'gateway', modelId: 'openai/gpt-5' })).resolves.toBe(true);
    expect(service.setModel).toHaveBeenLastCalledWith('gateway', 'openai/gpt-5');
    await expect(procedure(ctx, 'clearKey')({ slot: 'openai' })).resolves.toBe(true);
    expect(service.clearKey).toHaveBeenLastCalledWith('openai');
    // An answer outside its fixed set never leaves main as is.
    service.send.mockResolvedValueOnce('something else' as never);
    await expect(procedure(ctx, 'send')({ chatId: null, text: 'x' })).resolves.toBe('unavailable');
    service.answerApproval.mockResolvedValueOnce({ approvalId: 'leak' } as never);
    await expect(procedure(ctx, 'answerApproval')({ approvalId: 'a', decision: 'deny' })).resolves.toBe('invalid');
  });

  test('agent-send-skill-input-bounds', async () => {
    const { service } = fakeAgent();
    const ctx = ctxFor(service);
    await expect(procedure(ctx, 'send')({ chatId: null, skillId: 'audit-this-page' })).resolves.toBe('started');
    expect(service.send).toHaveBeenLastCalledWith(null, { skillId: 'audit-this-page' });
    const note = 'n'.repeat(SKILL_SLOT_MAX_CHARS.userNote);
    const query = 'q'.repeat(SKILL_SLOT_MAX_CHARS.targetQuery);
    await expect(procedure(ctx, 'send')({ chatId: CHAT, skillId: 'rewrite-title-meta', userNote: `${note.slice(1)}\n`, targetQuery: query })).resolves.toBe('started');
    expect(service.send).toHaveBeenLastCalledWith(CHAT, { skillId: 'rewrite-title-meta', userNote: `${note.slice(1)}\n`, targetQuery: query });
    service.send.mockResolvedValueOnce('unknown-skill' as never);
    await expect(procedure(ctx, 'send')({ chatId: null, skillId: 'gone-skill' })).resolves.toBe('unknown-skill');

    const bad = [
      { chatId: null, skillId: '' },
      { chatId: null, skillId: 'ab' },
      { chatId: null, skillId: 'Audit_This' },
      { chatId: null, skillId: 'a'.repeat(SKILL_LIMITS.maxIdChars + 1) },
      { chatId: null, skillId: 'audit-this-page', userNote: `${note}x` },
      { chatId: null, skillId: 'audit-this-page', targetQuery: `${query}x` },
      { chatId: null, skillId: 'audit-this-page', userNote: 'bidi \u202e note' },
      { chatId: null, skillId: 'audit-this-page', userNote: 5 },
      { chatId: null, skillId: 'audit-this-page', text: 'beside it' },
      { chatId: null, skillId: 'audit-this-page', pageTitle: 'forged' },
      { chatId: null, skillId: 'audit-this-page', allowedTools: ['navigate'] },
      { skillId: 'audit-this-page' },
    ];
    for (const input of bad) {
      const fresh = fakeAgent();
      const error = await errorOf(procedure(ctxFor(fresh.service), 'send')(input));
      expect(error.code, JSON.stringify(input).slice(0, 80)).toBe('BAD_REQUEST');
      untouched(fresh.service);
    }
  });

  test('agent-set-key-answer-has-no-key', async () => {
    const { service } = fakeAgent();
    const ctx = ctxFor(service);
    await expect(procedure(ctx, 'setKey')({ slot: 'anthropic', key: `  ${KEY}\n` })).resolves.toBe('stored');
    expect(service.setKey).toHaveBeenLastCalledWith('anthropic', `  ${KEY}\n`);
    // Even a service that answered the key back would not get it past the router.
    service.setKey.mockResolvedValueOnce(KEY as never);
    const answer = await procedure(ctx, 'setKey')({ slot: 'anthropic', key: KEY });
    expect(answer).toBe('failed');
    for (const result of ['invalid', 'no-keychain', 'failed'] as const) {
      service.setKey.mockResolvedValueOnce(result);
      await expect(procedure(ctx, 'setKey')({ slot: 'gateway', key: KEY })).resolves.toBe(result);
    }

    // Over the transport, a refused key's error carries no part of it either.
    const sender = { id: 1, mainFrame: { frameTreeNodeId: 100 }, isDestroyed: () => false };
    const senderFrame = { origin: APP_ORIGIN, frameTreeNodeId: 100, parent: null, detached: false, isDestroyed: () => false };
    const window = { id: WINDOW_ID, webContents: sender, isDestroyed: () => false };
    const handle = createIpcRequestHandler({ router: appRouter, policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }), fromWebContents: () => window, services: { agent: service } });
    const long = `${KEY}${'z'.repeat(CREDENTIAL_LIMITS.maxKeyChars * 2)}`;
    // An unrecognized key named after the key: Zod's issue would quote it.
    for (const input of [{ slot: 'anthropic', key: long }, { slot: 'nope', key: KEY }, { slot: 'anthropic', key: KEY, extra: KEY }, { [KEY]: 1, slot: 'anthropic', key: KEY }]) {
      const response = await handle({ sender, senderFrame }, { type: 'mutation', path: 'agent.setKey', input });
      expect(JSON.stringify(response)).not.toContain('sk-ant-secret');
      expect(response).toMatchObject({ error: { message: 'BAD_REQUEST', data: { code: 'BAD_REQUEST' } } });
    }
    const ok = await handle({ sender, senderFrame }, { type: 'mutation', path: 'agent.setKey', input: { slot: 'anthropic', key: KEY } });
    expect(ok).toStrictEqual({ result: { data: 'stored' } });
  });
});

describe('agent.watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('agent-watch-timeout-matches-browser-watch', () => {
    expect(AGENT_WATCH_TIMEOUT_MS).toBe(WATCH_TIMEOUT_MS);
  });

  test('agent-watch-returns-immediately-when-newer', async () => {
    const { service } = fakeAgent(3);
    await expect(procedure(ctxFor(service), 'watch')({ sinceVersion: 2 })).resolves.toEqual(stateAt(3));
    expect(service.watch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('agent-watch-resolves-on-change', async () => {
    const fake = fakeAgent(3);
    const pending = procedure(ctxFor(fake.service), 'watch')({ sinceVersion: 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.service.watch).toHaveBeenCalledTimes(1);
    fake.change(stateAt(4));
    await expect(pending).resolves.toEqual(stateAt(4));
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.service.watch.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  test('agent-watch-times-out-with-current-state', async () => {
    const fake = fakeAgent(3);
    let result: unknown;
    const pending = procedure(ctxFor(fake.service), 'watch')({ sinceVersion: 3 }).then((state) => {
      result = state;
    });
    await vi.advanceTimersByTimeAsync(AGENT_WATCH_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    fake.setState({ ...stateAt(3), running: true });
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(result).toEqual({ ...stateAt(3), running: true });
    expect(fake.service.watch.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('agent-watch-clamps-future-version', async () => {
    const fake = fakeAgent(3);
    const pending = procedure(ctxFor(fake.service), 'watch')({ sinceVersion: 1_000_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.service.watch.mock.calls[0]?.[0]).toBe(3);
    fake.change(stateAt(4));
    await expect(pending).resolves.toEqual(stateAt(4));
  });
});
