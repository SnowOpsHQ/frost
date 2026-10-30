// Spec: specs/agent-ipc.schema.ts (the agent.* inputs; AgentSetReasoningEffortInputSchema, Phase 8 Task 8b),
// specs/agent-session.spec.ts (answers, AGENT_WATCH_TIMEOUT_MS, AgentSetupView.reasoning), specs/agent-reasoning.spec.ts
// (REASONING_EFFORTS), specs/ipc-sender.spec.ts, specs/skills.spec.ts (SKILL_LIMITS, SKILL_SLOT_MAX_CHARS)
// Acceptance: specs/agent-session.feature.md (Router), specs/skills.feature.md (Router), specs/agent-data.feature.md (Skills library)
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_USER_SKILLS,
  SKILL_FILE_MAX_BYTES,
  type AgentDeleteAllChatsResult,
  type AgentGrantView,
  type AgentSaveSkillResult,
  type AgentSetRetentionResult,
  type AgentSkillDetail,
  type AgentSkillImportPreviewResult,
  type AgentSkillImportResult,
  type ChatExportResult,
  type SkillExportResult,
} from '@app/specs/agent-data.spec';
import { CREDENTIAL_LIMITS } from '@app/specs/agent-proxy.spec';
import { REASONING_EFFORTS } from '@app/specs/agent-reasoning.spec';
import { AGENT_WATCH_TIMEOUT_MS, CHAT_TEXT_MAX_CHARS, type AgentSetKeyResult, type AgentState } from '@app/specs/agent-session.spec';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { SKILL_LIMITS, SKILL_SLOT_MAX_CHARS } from '@app/specs/skills.spec';
import { MCP_LIMITS, type McpSaveResult, type McpStartResult, type McpTokenResult } from '@app/specs/agent-mcp.spec';
import type { ChatgptSignInResult, ChatgptSignOutResult } from '@app/specs/agent-chatgpt.spec';
import { appRouter, createSenderPolicy, type AgentService, type IpcContext } from '../index';
import { createIpcRequestHandler } from '../transport/main';

const WINDOW_ID = 7;
const CHAT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const KEY = 'sk-ant-secret-key-0123456789abcdef';
const TOKEN = 'mcp-bearer-token-0123456789abcdef';
const IMPORT_TOKEN = '3b241101-e2bb-4255-8caf-4136c566a962';
const IMPORT_PREVIEW: AgentSkillImportPreviewResult = {
  result: 'ready',
  preview: {
    token: IMPORT_TOKEN,
    room: 49,
    items: [
      {
        index: 0,
        valid: true,
        id: 'heading-check',
        name: 'Heading check',
        description: 'Check the headings.',
        tools: ['page_data', 'click'],
        actingTools: true,
        conflict: 'none',
        instructions: 'Check {{pageUrl}}. Note: {{userNote}}',
        inputs: [{ slot: 'userNote', label: 'Focus on', placeholder: null }],
        error: null,
      },
      { index: 1, valid: false, id: null, name: null, error: 'This entry is not a skill frost can read.' },
    ],
  },
};

function stateAt(version: number): AgentState {
  return {
    version,
    setup: {
      route: 'gateway',
      modelId: 'anthropic/claude-sonnet-5-5',
      allowedModels: ['anthropic/claude-sonnet-5-5'],
      keys: { anthropic: false, openai: false, gateway: true },
      chatgpt: { account: { state: 'signed-out', acknowledged: false }, models: [] },
      reasoning: { effort: 'auto', levels: ['auto', 'low', 'medium', 'high'] },
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
    grantsVersion: 1,
    chatRetention: '30d',
    mcp: { available: true, servers: [] },
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
    setReasoningEffort: vi.fn(async (_effort: string) => true),
    setKey: vi.fn(async (_slot: string, _key: string): Promise<AgentSetKeyResult> => 'stored'),
    clearKey: vi.fn(async () => true),
    listGrants: vi.fn((): AgentGrantView[] => [{ tool: 'navigate', label: 'Open a web address in this tab', origin: 'https://example.com', createdAt: 5 }]),
    revokeGrant: vi.fn(async (_tool: string, _origin: string) => true),
    revokeAllGrants: vi.fn(async () => true),
    setReadToolsAllowed: vi.fn(async (_allowed: boolean) => true),
    setChatRetention: vi.fn(async (_retention: string): Promise<AgentSetRetentionResult> => 'saved'),
    deleteAllChats: vi.fn(async (): Promise<AgentDeleteAllChatsResult> => 'deleted'),
    exportChat: vi.fn(async (_chatId: string, _format: string): Promise<ChatExportResult> => 'saved'),
    skillDetail: vi.fn((_id: string): AgentSkillDetail | null => null),
    saveSkill: vi.fn(async (_draft: unknown, _mode: string): Promise<AgentSaveSkillResult> => ({ result: 'saved', id: 'my-skill' })),
    deleteSkill: vi.fn(async (_id: string) => true),
    duplicateSkill: vi.fn(async (_id: string): Promise<AgentSaveSkillResult> => ({ result: 'saved', id: 'audit-this-page-copy' })),
    setSkillEnabled: vi.fn(async (_id: string, _enabled: boolean) => true),
    exportSkills: vi.fn(async (_ids: readonly string[] | 'all-mine'): Promise<SkillExportResult> => 'saved'),
    previewSkillImport: vi.fn(async (): Promise<AgentSkillImportPreviewResult> => IMPORT_PREVIEW),
    importSkills: vi.fn(async (_token: string, _indices: readonly number[]): Promise<AgentSkillImportResult> => ({ result: 'imported', count: 1 })),
    cancelSkillImport: vi.fn((_token: string) => true),
    saveMcpServer: vi.fn(async (_input: unknown): Promise<{ result: McpSaveResult; id?: string }> => ({ result: 'saved', id: 'docs' })),
    deleteMcpServer: vi.fn(async (_id: string) => true),
    setMcpServerEnabled: vi.fn(async (_id: string, _enabled: boolean) => true),
    startMcpServer: vi.fn(async (_id: string): Promise<McpStartResult> => 'ready'),
    stopMcpServer: vi.fn(async (_id: string) => true),
    setMcpToken: vi.fn(async (_id: string, _token: string | null): Promise<McpTokenResult> => 'stored'),
    chatgptSignIn: vi.fn(async (_windowId: number, _options: { reconsent?: boolean; differentAccount?: boolean }): Promise<ChatgptSignInResult> => 'started'),
    chatgptCancel: vi.fn(() => true),
    chatgptSignOut: vi.fn(async (): Promise<ChatgptSignOutResult> => 'signed-out'),
    chatgptAcknowledge: vi.fn(async () => true),
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
  setReasoningEffort: { effort: 'high' },
  setKey: { slot: 'anthropic', key: KEY },
  clearKey: { slot: 'anthropic' },
  listGrants: undefined,
  revokeGrant: { tool: 'navigate', origin: 'https://example.com' },
  revokeAllGrants: undefined,
  setReadToolsAllowed: { allowed: false },
  setChatRetention: { retention: '7d' },
  deleteAllChats: undefined,
  exportChat: { chatId: CHAT, format: 'markdown' },
  skillDetail: { id: 'audit-this-page' },
  saveSkill: { skill: { id: 'my-skill', name: 'Mine', description: 'D', allowedTools: ['page_text'], instructions: 'Read {{pageUrl}}', inputs: [] }, mode: 'create' },
  deleteSkill: { id: 'my-skill' },
  duplicateSkill: { id: 'audit-this-page' },
  setSkillEnabled: { id: 'audit-this-page', enabled: false },
  exportSkills: { ids: 'all-mine' },
  previewSkillImport: undefined,
  importSkills: { token: IMPORT_TOKEN, indices: [0] },
  cancelSkillImport: { token: IMPORT_TOKEN },
  saveMcpServer: { name: 'Docs', transport: 'http', url: 'https://mcp.example.com/mcp' },
  deleteMcpServer: { id: 'docs' },
  setMcpServerEnabled: { id: 'docs', enabled: true },
  startMcpServer: { id: 'docs' },
  stopMcpServer: { id: 'docs' },
  setMcpToken: { id: 'docs', token: TOKEN },
  chatgptSignIn: { reconsent: true },
  chatgptCancel: undefined,
  chatgptSignOut: undefined,
  chatgptAcknowledge: undefined,
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
      setReasoningEffort: [undefined, {}, { effort: 'minimal' }, { effort: 'high', modelId: 'openai/gpt-5' }],
      setKey: [
        undefined,
        { slot: 'anthropic' },
        { slot: 'anthropic', key: '' },
        { slot: 'anthropic', key: 'k'.repeat(CREDENTIAL_LIMITS.maxKeyChars * 2 + 1) },
        { slot: 'vault', key: KEY },
        { slot: 'anthropic', key: KEY, extra: 1 },
      ],
      clearKey: [undefined, { slot: 'all' }, { slot: 'gateway', key: KEY }],
      listGrants: [],
      revokeGrant: [undefined, { tool: 'navigate' }, { tool: '', origin: 'https://a.example' }, { tool: 'nav igate', origin: 'https://a.example' }, { tool: 'navigate', origin: 'o'.repeat(2049) }, { tool: 'navigate', origin: 'https://a.example', all: true }],
      revokeAllGrants: [],
      setReadToolsAllowed: [undefined, { allowed: 'yes' }, { allowed: true, extra: 1 }],
      setChatRetention: [undefined, { retention: '1y' }, { retention: 30 }, { retention: '7d', extra: 1 }],
      deleteAllChats: [],
      exportChat: [undefined, { chatId: CHAT }, { chatId: CHAT, format: 'html' }, { chatId: 'chat-1', format: 'json' }, { chatId: CHAT, format: 'json', path: '/tmp/x' }],
      skillDetail: [undefined, { id: 'No' }, { id: 'a'.repeat(SKILL_LIMITS.maxIdChars + 1) }],
      saveSkill: [
        undefined,
        { skill: VALID_INPUT['saveSkill'] },
        { ...(VALID_INPUT['saveSkill'] as object), mode: 'upsert' },
        { skill: { id: 'my-skill', name: 'Mine', description: 'D', allowedTools: ['page_text'], instructions: 'x'.repeat(SKILL_LIMITS.maxInstructionChars * 2 + 1), inputs: [] }, mode: 'create' },
        { skill: { id: 'my-skill', name: 'Mine', description: 'D', allowedTools: ['page_text'], instructions: 'x', inputs: [], version: 9 }, mode: 'create' },
        { skill: { id: 'my-skill', name: 'Mine', description: 'D', allowedTools: Array.from({ length: 33 }, () => 'page_text'), instructions: 'x', inputs: [] }, mode: 'create' },
      ],
      deleteSkill: [undefined, { id: 'Bad Id' }],
      duplicateSkill: [undefined, { id: 5 }],
      setSkillEnabled: [undefined, { id: 'audit-this-page' }, { enabled: true }, { id: 'No', enabled: true }, { id: 'audit-this-page', enabled: 'off' }, { id: 'audit-this-page', enabled: 0 }, { id: 'audit-this-page', enabled: true, extra: 1 }],
      exportSkills: [undefined, {}, { ids: 'all' }, { ids: [] }, { ids: ['Bad Id'] }, { ids: 'all-mine', path: '/tmp/x.json' }],
      previewSkillImport: [],
      importSkills: [undefined, { token: IMPORT_TOKEN }, { token: 'nope', indices: [0] }, { token: IMPORT_TOKEN, indices: [] }],
      cancelSkillImport: [undefined, {}, { token: 'x' }],
      saveMcpServer: [undefined, { name: '', transport: 'http', url: 'https://mcp.example.com/' }, { name: 'Docs', transport: 'ftp', url: 'https://mcp.example.com/' }],
      deleteMcpServer: [undefined, { id: '' }],
      setMcpServerEnabled: [undefined, { id: 'docs' }, { id: 'docs', enabled: 'yes' }],
      startMcpServer: [undefined, { id: 'docs', force: true }],
      stopMcpServer: [undefined, {}],
      setMcpToken: [undefined, { id: 'docs' }, { id: 'docs', token: '' }, { id: 'docs', token: TOKEN, extra: 1 }],
      chatgptSignIn: [{ reconsent: 'yes' }, { differentAccount: 1 }, { reconsent: true, clientId: 'oaiapp_x' }, { windowId: 3 }],
      chatgptCancel: [],
      chatgptSignOut: [],
      chatgptAcknowledge: [],
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
    // Invisible characters (an emoji's joiners, a soft hyphen, a bidi mark) are not refused here: main cleans them.
    const emoji = 'Fam\u00adily \u{1F468}\u200d\u{1F469}\u200d\u{1F467} \u202e note';
    await expect(procedure(ctx, 'send')({ chatId: null, skillId: 'audit-this-page', userNote: emoji })).resolves.toBe('started');
    expect(service.send).toHaveBeenLastCalledWith(null, { skillId: 'audit-this-page', userNote: emoji });
    service.send.mockResolvedValueOnce('unknown-skill' as never);
    await expect(procedure(ctx, 'send')({ chatId: null, skillId: 'gone-skill' })).resolves.toBe('unknown-skill');

    const bad = [
      { chatId: null, skillId: '' },
      { chatId: null, skillId: 'ab' },
      { chatId: null, skillId: 'Audit_This' },
      { chatId: null, skillId: 'a'.repeat(SKILL_LIMITS.maxIdChars + 1) },
      { chatId: null, skillId: 'audit-this-page', userNote: `${note}x` },
      { chatId: null, skillId: 'audit-this-page', targetQuery: `${query}x` },
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

  test('agent-data-procedures-call-service', async () => {
    const { service } = fakeAgent();
    const ctx = ctxFor(service);
    await expect(procedure(ctx, 'listGrants')()).resolves.toEqual([{ tool: 'navigate', label: 'Open a web address in this tab', origin: 'https://example.com', createdAt: 5 }]);
    await expect(procedure(ctx, 'revokeGrant')({ tool: 'click', origin: 'https://shop.example.com' })).resolves.toBe(true);
    expect(service.revokeGrant).toHaveBeenLastCalledWith('click', 'https://shop.example.com');
    await expect(procedure(ctx, 'revokeAllGrants')()).resolves.toBe(true);
    await expect(procedure(ctx, 'setReadToolsAllowed')({ allowed: false })).resolves.toBe(true);
    expect(service.setReadToolsAllowed).toHaveBeenLastCalledWith(false);
    await expect(procedure(ctx, 'setChatRetention')({ retention: 'off' })).resolves.toBe('saved');
    service.setChatRetention.mockResolvedValueOnce('cancelled');
    await expect(procedure(ctx, 'setChatRetention')({ retention: 'off' })).resolves.toBe('cancelled');
    service.setChatRetention.mockResolvedValueOnce(true as never);
    await expect(procedure(ctx, 'setChatRetention')({ retention: '7d' })).resolves.toBe('failed');
    expect(service.setChatRetention).toHaveBeenLastCalledWith('7d');
    await expect(procedure(ctx, 'deleteAllChats')()).resolves.toBe('deleted');
    await expect(procedure(ctx, 'exportChat')({ chatId: CHAT, format: 'json' })).resolves.toBe('saved');
    expect(service.exportChat).toHaveBeenLastCalledWith(CHAT, 'json');
    await expect(procedure(ctx, 'skillDetail')({ id: 'audit-this-page' })).resolves.toBeNull();
    await expect(procedure(ctx, 'saveSkill')(VALID_INPUT['saveSkill'])).resolves.toEqual({ result: 'saved', id: 'my-skill' });
    expect(service.saveSkill).toHaveBeenLastCalledWith({ id: 'my-skill', name: 'Mine', description: 'D', allowedTools: ['page_text'], instructions: 'Read {{pageUrl}}', inputs: [] }, 'create');
    await expect(procedure(ctx, 'deleteSkill')({ id: 'my-skill' })).resolves.toBe(true);
    await expect(procedure(ctx, 'duplicateSkill')({ id: 'audit-this-page' })).resolves.toEqual({ result: 'saved', id: 'audit-this-page-copy' });
    // Answers outside their fixed shapes never leave main as they are.
    service.exportChat.mockResolvedValueOnce('/home/me/secret.md' as never);
    await expect(procedure(ctx, 'exportChat')({ chatId: CHAT, format: 'json' })).resolves.toBe('failed');
    service.deleteAllChats.mockResolvedValueOnce('maybe' as never);
    await expect(procedure(ctx, 'deleteAllChats')()).resolves.toBe('failed');
    service.saveSkill.mockResolvedValueOnce({ result: 'invalid', errors: [{ field: 'name', message: 'Too long.' }, { field: 'secret', message: 'x' }, { field: 'id' }], extra: KEY } as never);
    await expect(procedure(ctx, 'saveSkill')(VALID_INPUT['saveSkill'])).resolves.toStrictEqual({ result: 'invalid', errors: [{ field: 'name', message: 'Too long.' }] });
    service.saveSkill.mockResolvedValueOnce({ result: 'exists', id: KEY } as never);
    await expect(procedure(ctx, 'saveSkill')(VALID_INPUT['saveSkill'])).resolves.toStrictEqual({ result: 'exists' });
    service.duplicateSkill.mockResolvedValueOnce({ result: 'saved', id: 5 } as never);
    await expect(procedure(ctx, 'duplicateSkill')({ id: 'audit-this-page' })).resolves.toStrictEqual({ result: 'failed' });
    service.listGrants.mockReturnValueOnce([{ tool: 'navigate', label: 'l', origin: 'https://example.com', createdAt: 1, approvalId: 'leak' } as never]);
    await expect(procedure(ctx, 'listGrants')()).resolves.toStrictEqual([{ tool: 'navigate', label: 'l', origin: 'https://example.com', createdAt: 1 }]);
  });

  test('agent-set-skill-enabled-bounds', async () => {
    const { service } = fakeAgent();
    const ctx = ctxFor(service);
    await expect(procedure(ctx, 'setSkillEnabled')({ id: 'audit-this-page', enabled: false })).resolves.toBe(true);
    expect(service.setSkillEnabled).toHaveBeenLastCalledWith('audit-this-page', false);
    await expect(procedure(ctx, 'setSkillEnabled')({ id: 'my-skill', enabled: true })).resolves.toBe(true);
    expect(service.setSkillEnabled).toHaveBeenLastCalledWith('my-skill', true);
    // The answer is a boolean, whatever the service says.
    service.setSkillEnabled.mockResolvedValueOnce('maybe' as never);
    await expect(procedure(ctx, 'setSkillEnabled')({ id: 'my-skill', enabled: true })).resolves.toBe(false);
    service.setSkillEnabled.mockClear();
    // A malformed or over-long id, a non-boolean, a missing or extra field never reach the service.
    for (const input of [
      undefined,
      {},
      { id: 'audit-this-page' },
      { enabled: true },
      { id: '', enabled: true },
      { id: 'Audit_This', enabled: true },
      { id: 'a'.repeat(SKILL_LIMITS.maxIdChars + 1), enabled: true },
      { id: 'audit-this-page', enabled: 'true' },
      { id: 'audit-this-page', enabled: 1 },
      { id: 'audit-this-page', enabled: null },
      { id: 'audit-this-page', enabled: true, builtin: true },
    ]) {
      expect((await errorOf(procedure(ctx, 'setSkillEnabled')(input))).code, JSON.stringify(input)).toBe('BAD_REQUEST');
    }
    // A foreign sender is refused before the input is read.
    const foreign = ctxFor(service, 'https://evil.example');
    expect((await errorOf(procedure(foreign, 'setSkillEnabled')({ id: 'audit-this-page', enabled: false }))).code).toBe('FORBIDDEN');
    expect(service.setSkillEnabled).not.toHaveBeenCalled();
  });

  // Acceptance: specs/agent-session.feature.md (Router: agent-set-reasoning-effort-bounds)
  test('agent-set-reasoning-effort-bounds', async () => {
    const { service } = fakeAgent();
    const ctx = ctxFor(service);
    // Every level the user may choose reaches the service as is.
    for (const effort of REASONING_EFFORTS) {
      await expect(procedure(ctx, 'setReasoningEffort')({ effort })).resolves.toBe(true);
      expect(service.setReasoningEffort).toHaveBeenLastCalledWith(effort);
    }
    // The answer is a boolean, whatever the service says.
    service.setReasoningEffort.mockResolvedValueOnce(false);
    await expect(procedure(ctx, 'setReasoningEffort')({ effort: 'low' })).resolves.toBe(false);
    service.setReasoningEffort.mockResolvedValueOnce('stored' as never);
    await expect(procedure(ctx, 'setReasoningEffort')({ effort: 'low' })).resolves.toBe(false);
    service.setReasoningEffort.mockClear();
    // Only the catalogue's names, in a strict object: a provider's wire value, another case, a
    // missing or extra field (a model, a route) never reach the service.
    for (const input of [
      undefined,
      null,
      'high',
      {},
      { effort: '' },
      { effort: 'minimal' },
      { effort: 'none' },
      { effort: 'xhigh' },
      { effort: 'High' },
      { effort: 'x'.repeat(10_000) },
      { effort: 3 },
      { effort: null },
      { effort: ['high'] },
      { effort: 'high', route: 'gateway' },
      { reasoningEffort: 'high' },
    ]) {
      expect((await errorOf(procedure(ctx, 'setReasoningEffort')(input))).code, JSON.stringify(input)).toBe('BAD_REQUEST');
    }
    expect(service.setReasoningEffort).not.toHaveBeenCalled();
    // A foreign sender, or a tab's page, is refused before the input is read.
    expect((await errorOf(procedure(ctxFor(service, 'https://evil.example'), 'setReasoningEffort')({ effort: 'high' }))).code).toBe(IPC_SENDER_ERROR_CODE);
    const tab: IpcContext = { ...ctx, sender: { origin: APP_ORIGIN, live: true, windowId: WINDOW_ID, isWindowContents: false, isMainFrame: true } };
    expect((await errorOf(procedure(tab, 'setReasoningEffort')({ effort: 'high' }))).code).toBe(IPC_SENDER_ERROR_CODE);
    expect(service.setReasoningEffort).not.toHaveBeenCalled();
  });

  test('agent-skill-file-procedures-enforce-sender-and-bounds', async () => {
    const { service } = fakeAgent();
    const ctx = ctxFor(service);
    // Each reaches the service with its input copied one by one (never a path: main asks in its dialogs).
    await expect(procedure(ctx, 'exportSkills')({ ids: 'all-mine' })).resolves.toBe('saved');
    expect(service.exportSkills).toHaveBeenLastCalledWith('all-mine');
    await expect(procedure(ctx, 'exportSkills')({ ids: ['heading-check', 'link-check'] })).resolves.toBe('saved');
    expect(service.exportSkills).toHaveBeenLastCalledWith(['heading-check', 'link-check']);
    await expect(procedure(ctx, 'previewSkillImport')()).resolves.toStrictEqual(IMPORT_PREVIEW);
    expect(service.previewSkillImport).toHaveBeenCalledWith();
    await expect(procedure(ctx, 'importSkills')({ token: IMPORT_TOKEN, indices: [2, 0] })).resolves.toStrictEqual({ result: 'imported', count: 1 });
    expect(service.importSkills).toHaveBeenLastCalledWith(IMPORT_TOKEN, [2, 0]);
    await expect(procedure(ctx, 'cancelSkillImport')({ token: IMPORT_TOKEN })).resolves.toBe(true);
    expect(service.cancelSkillImport).toHaveBeenLastCalledWith(IMPORT_TOKEN);

    // The review is rebuilt field by field: extra fields dropped, the acting-tools flag recomputed
    // from the tools, an invalid entry's instructions never carried, unknown tools left out.
    const item = (IMPORT_PREVIEW as Extract<AgentSkillImportPreviewResult, { result: 'ready' }>).preview.items[0]!;
    const noisy = {
      result: 'ready',
      path: '/home/me/skills.json',
      preview: {
        token: IMPORT_TOKEN,
        room: 49,
        file: '/home/me/skills.json',
        items: [
          { ...item, actingTools: false, tools: ['page_data', 'click', 'shell'], secret: KEY },
          { index: 1, valid: false, id: 'link-check', name: 'Link check', error: 'This entry is not a skill frost can read.', instructions: 'leak' },
        ],
      },
    };
    service.previewSkillImport.mockResolvedValueOnce(noisy as never);
    await expect(procedure(ctx, 'previewSkillImport')()).resolves.toStrictEqual({
      result: 'ready',
      preview: {
        token: IMPORT_TOKEN,
        room: 49,
        items: [
          { ...item, tools: ['page_data', 'click'], actingTools: true },
          { index: 1, valid: false, id: 'link-check', name: 'Link check', error: 'This entry is not a skill frost can read.' },
        ],
      },
    });
    // A malformed entry, token, room or over-long text fails the whole answer.
    const over = (patch: Record<string, unknown>, preview: Record<string, unknown> = {}) => ({ result: 'ready', preview: { token: IMPORT_TOKEN, room: 49, items: [{ ...item, ...patch }], ...preview } });
    for (const bad of [
      over({ instructions: 'x'.repeat(SKILL_LIMITS.maxInstructionChars + 1) }),
      over({ instructions: 5 }),
      over({ name: 'n'.repeat(SKILL_LIMITS.maxNameChars + 1) }),
      over({ description: 'd'.repeat(SKILL_LIMITS.maxDescriptionChars + 1) }),
      over({ id: 'Bad Id' }),
      over({ tools: ['shell'] }),
      over({ tools: 'page_data' }),
      over({ conflict: 'replace' }),
      over({ inputs: [{ slot: 'pageUrl', label: 'x', placeholder: null }] }),
      over({ inputs: [{ slot: 'userNote', label: 'l'.repeat(SKILL_LIMITS.maxInputLabelChars + 1), placeholder: null }] }),
      over({ index: -1 }),
      over({ index: MAX_USER_SKILLS }),
      over({ valid: 'yes' }),
      over({}, { token: 'not-a-uuid' }),
      over({}, { room: MAX_USER_SKILLS + 1 }),
      over({}, { room: 1.5 }),
      over({}, { items: Array.from({ length: MAX_USER_SKILLS + 1 }, () => item) }),
      over({}, { items: 'none' }),
      { result: 'ready' },
      { result: 'imported', count: 1 },
      { result: 'installed' },
      null,
    ]) {
      service.previewSkillImport.mockResolvedValueOnce(bad as never);
      await expect(procedure(ctx, 'previewSkillImport')(), JSON.stringify(bad)?.slice(0, 120)).resolves.toStrictEqual({ result: 'failed' });
    }
    // The whole review stays within SKILL_FILE_MAX_BYTES.
    const huge = { ...item, instructions: '\u{1F600}'.repeat(SKILL_LIMITS.maxInstructionChars / 2) };
    service.previewSkillImport.mockResolvedValueOnce({ result: 'ready', preview: { token: IMPORT_TOKEN, room: 49, items: Array.from({ length: MAX_USER_SKILLS }, (_, index) => ({ ...huge, index })) } } as never);
    const answer = await procedure(ctx, 'previewSkillImport')();
    expect(Buffer.byteLength(JSON.stringify(answer), 'utf8')).toBeLessThanOrEqual(SKILL_FILE_MAX_BYTES);
    // A plain refusal passes as it is, without anything beside it.
    service.previewSkillImport.mockResolvedValueOnce({ result: 'too-large', size: 9 } as never);
    await expect(procedure(ctx, 'previewSkillImport')()).resolves.toStrictEqual({ result: 'too-large' });
    // Import and export answers: fixed values only.
    service.importSkills.mockResolvedValueOnce({ result: 'imported', count: 1.5 } as never);
    await expect(procedure(ctx, 'importSkills')({ token: IMPORT_TOKEN, indices: [0] })).resolves.toStrictEqual({ result: 'failed' });
    service.importSkills.mockResolvedValueOnce({ result: 'limit', ids: ['x'] } as never);
    await expect(procedure(ctx, 'importSkills')({ token: IMPORT_TOKEN, indices: [0] })).resolves.toStrictEqual({ result: 'limit' });
    service.importSkills.mockResolvedValueOnce({ result: 'ready', preview: {} } as never);
    await expect(procedure(ctx, 'importSkills')({ token: IMPORT_TOKEN, indices: [0] })).resolves.toStrictEqual({ result: 'failed' });
    service.exportSkills.mockResolvedValueOnce('/home/me/skills.json' as never);
    await expect(procedure(ctx, 'exportSkills')({ ids: 'all-mine' })).resolves.toBe('failed');
    service.cancelSkillImport.mockReturnValueOnce('yes' as never);
    await expect(procedure(ctx, 'cancelSkillImport')({ token: IMPORT_TOKEN })).resolves.toBe(false);

    // Strict, bounded inputs never reach the service.
    service.exportSkills.mockClear();
    service.importSkills.mockClear();
    service.cancelSkillImport.mockClear();
    for (const input of [
      { ids: Array.from({ length: MAX_USER_SKILLS + 1 }, (_, n) => `skill-${n}`) },
      { ids: ['heading-check', 'heading-check'] },
      { ids: ['a'.repeat(SKILL_LIMITS.maxIdChars + 1)] },
      { ids: 'all-mine', file: '/etc/passwd' },
    ]) {
      expect((await errorOf(procedure(ctx, 'exportSkills')(input))).code, JSON.stringify(input).slice(0, 80)).toBe('BAD_REQUEST');
    }
    for (const input of [
      { token: IMPORT_TOKEN, indices: [0, 0] },
      { token: IMPORT_TOKEN, indices: [-1] },
      { token: IMPORT_TOKEN, indices: [MAX_USER_SKILLS] },
      { token: IMPORT_TOKEN, indices: [0.5] },
      { token: IMPORT_TOKEN, indices: Array.from({ length: MAX_USER_SKILLS + 1 }, (_, n) => n) },
      { token: IMPORT_TOKEN, indices: [0], skills: [] },
    ]) {
      expect((await errorOf(procedure(ctx, 'importSkills')(input))).code, JSON.stringify(input).slice(0, 80)).toBe('BAD_REQUEST');
    }
    expect((await errorOf(procedure(ctx, 'cancelSkillImport')({ token: IMPORT_TOKEN, extra: 1 }))).code).toBe('BAD_REQUEST');
    expect(service.exportSkills).not.toHaveBeenCalled();
    expect(service.importSkills).not.toHaveBeenCalled();
    expect(service.cancelSkillImport).not.toHaveBeenCalled();
    // A foreign sender is refused before anything is read or asked.
    service.previewSkillImport.mockClear();
    const foreign = ctxFor(service, 'https://evil.example');
    for (const name of ['exportSkills', 'previewSkillImport', 'importSkills', 'cancelSkillImport']) {
      expect((await errorOf(procedure(foreign, name)(VALID_INPUT[name]))).code, name).toBe('FORBIDDEN');
    }
    expect(service.previewSkillImport).not.toHaveBeenCalled();
    expect(service.exportSkills).not.toHaveBeenCalled();
  });

  test('agent-chatgpt-procedures (the sender\'s window for the gesture; fixed answers only)', async () => {
    const { service } = fakeAgent();
    const ctx = ctxFor(service);
    await expect(procedure(ctx, 'chatgptSignIn')({})).resolves.toBe('started');
    // The sender's own window (for its live gesture), never one the renderer names.
    expect(service.chatgptSignIn).toHaveBeenLastCalledWith(WINDOW_ID, {});
    await expect(procedure(ctx, 'chatgptSignIn')({ reconsent: true, differentAccount: false })).resolves.toBe('started');
    expect(service.chatgptSignIn).toHaveBeenLastCalledWith(WINDOW_ID, { reconsent: true });
    await expect(procedure(ctx, 'chatgptSignIn')({ differentAccount: true })).resolves.toBe('started');
    expect(service.chatgptSignIn).toHaveBeenLastCalledWith(WINDOW_ID, { differentAccount: true });
    for (const result of ['needs-gesture', 'no-keychain', 'browser-failed', 'failed'] as const) {
      service.chatgptSignIn.mockResolvedValueOnce(result);
      await expect(procedure(ctx, 'chatgptSignIn')({})).resolves.toBe(result);
    }
    await expect(procedure(ctx, 'chatgptCancel')()).resolves.toBe(true);
    await expect(procedure(ctx, 'chatgptSignOut')()).resolves.toBe('signed-out');
    await expect(procedure(ctx, 'chatgptAcknowledge')()).resolves.toBe(true);
    // Anything else a service answered (a token, a URL) never leaves main.
    service.chatgptSignIn.mockResolvedValueOnce('https://auth.openai.com/api/accounts/authorize?code=x' as never);
    await expect(procedure(ctx, 'chatgptSignIn')({})).resolves.toBe('failed');
    service.chatgptSignOut.mockResolvedValueOnce({ refreshToken: 'refresh-token-1' } as never);
    await expect(procedure(ctx, 'chatgptSignOut')()).resolves.toBe('not-revoked');
    service.chatgptCancel.mockReturnValueOnce('access-token-1' as never);
    await expect(procedure(ctx, 'chatgptCancel')()).resolves.toBe(false);
    service.chatgptAcknowledge.mockResolvedValueOnce('yes' as never);
    await expect(procedure(ctx, 'chatgptAcknowledge')()).resolves.toBe(false);
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

// Spec: specs/agent-mcp.schema.ts (the MCP procedures' inputs), specs/agent-mcp.spec.ts (answers)
// Acceptance: specs/agent-mcp.feature.md (Router)
describe('agent router: MCP servers', () => {
  test('mcp-procedures-bounded-inputs', async () => {
    const refused: [string, unknown][] = [
      // HTTP: https on a public host only.
      ['saveMcpServer', { name: 'Docs', transport: 'http', url: 'http://mcp.example.com/' }],
      ['saveMcpServer', { name: 'Docs', transport: 'http', url: 'https://localhost/mcp' }],
      ['saveMcpServer', { name: 'Docs', transport: 'http', url: 'https://10.0.0.5/mcp' }],
      ['saveMcpServer', { name: 'Docs', transport: 'http', url: 'https://user:pw@mcp.example.com/' }],
      // Command servers: one program, no shell string, no relative path, bounded arguments.
      ['saveMcpServer', { name: 'Local', transport: 'stdio', command: './server', args: [], readPaths: [], allowNetwork: false, env: [] }],
      ['saveMcpServer', { name: 'Local', transport: 'stdio', command: 'node', args: ['a\nb'], readPaths: [], allowNetwork: false, env: [] }],
      ['saveMcpServer', { name: 'Local', transport: 'stdio', command: 'node', args: Array(MCP_LIMITS.maxArgs + 1).fill('x'), readPaths: [], allowNetwork: false, env: [] }],
      ['saveMcpServer', { name: 'Local', transport: 'stdio', command: 'node', args: [], readPaths: ['relative/dir'], allowNetwork: false, env: [] }],
      ['saveMcpServer', { name: 'Local', transport: 'stdio', command: 'node', args: [], readPaths: [], allowNetwork: false, env: [{ name: 'LD_PRELOAD', value: '/x.so' }] }],
      ['saveMcpServer', { name: 'Local', transport: 'stdio', command: 'node', args: [], readPaths: [], allowNetwork: false, env: [{ name: 'PATH', value: '/x' }] }],
      ['saveMcpServer', { name: 'Docs', transport: 'http', url: 'https://mcp.example.com/', extra: true }],
      ['deleteMcpServer', { id: 'Has Caps' }],
      ['startMcpServer', { id: 'x'.repeat(17) }],
      ['setMcpToken', { id: 'docs', token: 'x'.repeat(MCP_LIMITS.maxTokenChars * 2 + 1) }],
    ];
    for (const [name, input] of refused) {
      const { service } = fakeAgent();
      const error = await errorOf(procedure(ctxFor(service), name)(input));
      expect(error.code, JSON.stringify(input)).toBe('BAD_REQUEST');
      untouched(service);
    }
  });

  test('mcp-procedures-answers-are-fixed-values', async () => {
    const { service } = fakeAgent();
    const ctx = ctxFor(service);
    await expect(procedure(ctx, 'saveMcpServer')(VALID_INPUT['saveMcpServer'])).resolves.toEqual({ result: 'saved', id: 'docs' });
    service.saveMcpServer.mockResolvedValueOnce({ result: 'saved', id: 'NOT AN ID' });
    await expect(procedure(ctx, 'saveMcpServer')(VALID_INPUT['saveMcpServer'])).resolves.toEqual({ result: 'failed' });
    service.startMcpServer.mockResolvedValueOnce('whatever' as McpStartResult);
    await expect(procedure(ctx, 'startMcpServer')({ id: 'docs' })).resolves.toBe('failed');
    // The token goes in once and never comes back.
    service.setMcpToken.mockResolvedValueOnce(TOKEN as McpTokenResult);
    const answer = await procedure(ctx, 'setMcpToken')({ id: 'docs', token: TOKEN });
    expect(answer).toBe('failed');
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(service.setMcpToken).toHaveBeenLastCalledWith('docs', TOKEN);
    await expect(procedure(ctx, 'setMcpToken')({ id: 'docs', token: null })).resolves.toBe('stored');
    // A command server's fields, copied one by one.
    await procedure(ctx, 'saveMcpServer')({ name: 'Local', transport: 'stdio', command: 'node', args: ['server.js'], readPaths: ['/opt/tools'], allowNetwork: false, env: [{ name: 'API_MODE', value: 'test' }, { name: 'KEEP' }] });
    expect(service.saveMcpServer).toHaveBeenLastCalledWith({ name: 'Local', transport: 'stdio', command: 'node', args: ['server.js'], readPaths: ['/opt/tools'], allowNetwork: false, env: [{ name: 'API_MODE', value: 'test' }, { name: 'KEEP' }] });
  });
});
