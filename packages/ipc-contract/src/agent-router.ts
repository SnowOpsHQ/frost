import { TRPCError } from '@trpc/server';
import {
  AgentAnswerApprovalInputSchema,
  AgentChatInputSchema,
  AgentClearKeyInputSchema,
  AgentSendInputSchema,
  AgentSetKeyInputSchema,
  AgentSetModelInputSchema,
  AgentSetReasoningEffortInputSchema,
  AgentWatchInputSchema,
  AgentExportChatInputSchema,
  AgentRevokeGrantInputSchema,
  AgentSaveSkillInputSchema,
  AgentSetChatRetentionInputSchema,
  AgentSetReadToolsAllowedInputSchema,
  AgentSetSkillEnabledInputSchema,
  AgentSkillIdInputSchema,
  AgentChatgptSignInInputSchema,
  AgentCancelSkillImportInputSchema,
  AgentExportSkillsInputSchema,
  AgentImportSkillsInputSchema,
} from '@app/specs/agent-ipc.schema';
import { CHATGPT_SIGN_IN_RESULTS, CHATGPT_SIGN_OUT_RESULTS, type ChatgptSignInResult, type ChatgptSignOutResult } from '@app/specs/agent-chatgpt.spec';
import {
  AGENT_DELETE_ALL_CHATS_RESULTS,
  AGENT_SAVE_SKILL_RESULTS,
  AGENT_SET_RETENTION_RESULTS,
  CHAT_EXPORT_RESULTS,
  MAX_SKILL_ERRORS,
  MAX_USER_SKILLS,
  SKILL_EDITOR_FIELDS,
  SKILL_EXPORT_RESULTS,
  SKILL_FILE_MAX_BYTES,
  SKILL_IMPORT_CONFLICTS,
  SKILL_IMPORT_RESULTS,
  type AgentDeleteAllChatsResult,
  type AgentGrantView,
  type AgentSaveSkillResult,
  type AgentSetRetentionResult,
  type AgentSkillDetail,
  type AgentSkillImportItem,
  type AgentSkillImportPreviewResult,
  type AgentSkillImportResult,
  type ChatExportResult,
  type SkillExportResult,
} from '@app/specs/agent-data.spec';
import { AGENT_TOOL_NAMES, isSafeInputText, type AgentToolName } from '@app/specs/agent-tools.spec';
import { isSkillId, SKILL_ACTING_TOOLS, SKILL_INPUT_SLOTS, SKILL_LIMITS, type SkillInputSlot } from '@app/specs/skills.spec';
import { AGENT_ANSWER_RESULTS, AGENT_SEND_RESULTS, AGENT_SET_KEY_RESULTS, AGENT_WATCH_TIMEOUT_MS, type AgentAnswerResult, type AgentSendResult, type AgentSetKeyResult, type AgentSkillRequest, type AgentState } from '@app/specs/agent-session.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { isMcpServerId, MCP_SAVE_RESULTS, MCP_START_RESULTS, MCP_TOKEN_RESULTS, type McpSaveResult, type McpStartResult, type McpTokenResult } from '@app/specs/agent-mcp.spec';
import { AgentMcpServerIdInputSchema, AgentSaveMcpServerInputSchema, AgentSetMcpServerEnabledInputSchema, AgentSetMcpTokenInputSchema } from '@app/specs/agent-mcp.schema';
import type { AgentService } from './agent-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The agent panel ↔ main (Phase 5 Task 6a; inputs `specs/agent-ipc.schema.ts`, answers
// `specs/agent-session.spec.ts`; acceptance `agent-session.feature.md`, Router). Every procedure
// starts `publicProcedure.use(enforceSender)`: only the app's own window reaches the agent, so no
// page or tab renderer can send a message, answer an approval or touch a key. `setKey`'s input is
// the only place a key crosses IPC (renderer → main); no answer here carries one: each answer is
// checked against its fixed set of values before it leaves.

/** Hands the procedure main's `AgentService` (after `enforceSender`; fails closed without it). */
const requireAgent = middleware(({ ctx, next }) => {
  const agent = ctx.services?.agent;
  if (!agent) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'agent service unavailable' });
  return next({ ctx: { ...ctx, agent } });
});

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T => ((values as readonly unknown[]).includes(value) ? (value as T) : fallback);

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/** `saveSkill` / `duplicateSkill`'s answer, rebuilt from fixed values and bounded text only. */
function checkedSaveSkillResult(value: unknown): AgentSaveSkillResult {
  const answer = (typeof value === 'object' && value !== null ? value : {}) as { result?: unknown; id?: unknown; errors?: unknown };
  const result = oneOf(AGENT_SAVE_SKILL_RESULTS, answer.result, 'failed');
  if (result === 'saved') return typeof answer.id === 'string' && answer.id.length <= 64 ? { result, id: answer.id } : { result: 'failed' };
  if (result === 'invalid') {
    const errors = (Array.isArray(answer.errors) ? answer.errors : [])
      .slice(0, MAX_SKILL_ERRORS)
      .flatMap((error: unknown) => {
        const item = (typeof error === 'object' && error !== null ? error : {}) as { field?: unknown; message?: unknown };
        return (SKILL_EDITOR_FIELDS as readonly unknown[]).includes(item.field) && typeof item.message === 'string' ? [{ field: item.field as (typeof SKILL_EDITOR_FIELDS)[number], message: item.message.slice(0, 500) }] : [];
      });
    return { result, errors };
  }
  return { result };
}

/** A review's refusals and an import's (every kind but `ready` and `imported`). */
type SkillImportRefusal = Exclude<(typeof SKILL_IMPORT_RESULTS)[number], 'ready' | 'imported'>;
const refusalOf = (value: unknown): SkillImportRefusal => {
  const result = oneOf(SKILL_IMPORT_RESULTS, value, 'failed');
  return result === 'ready' || result === 'imported' ? 'failed' : result;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A string of at most `max` characters, else `null` (never cut: what the review shows is what is stored). */
const bounded = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length <= max ? value : null);
const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < MAX_USER_SKILLS;

/** One review entry, rebuilt field by field; `null` if a valid entry is malformed (it fails the whole answer). */
function checkedImportItem(value: unknown): AgentSkillImportItem | null {
  const item = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (!isIndex(item['index'])) return null;
  const index = item['index'];
  if (item['valid'] === false) {
    const name = bounded(item['name'], SKILL_LIMITS.maxNameChars);
    const error = bounded(item['error'], 500);
    if (error === null) return null;
    return { index, valid: false, id: isSkillId(item['id']) ? item['id'] : null, name: name !== null && isSafeInputText(name) ? name : null, error };
  }
  if (item['valid'] !== true || !isSkillId(item['id'])) return null;
  const name = bounded(item['name'], SKILL_LIMITS.maxNameChars);
  const description = bounded(item['description'], SKILL_LIMITS.maxDescriptionChars);
  const instructions = bounded(item['instructions'], SKILL_LIMITS.maxInstructionChars);
  if (name === null || description === null || instructions === null || !Array.isArray(item['tools']) || !Array.isArray(item['inputs'])) return null;
  // Catalogue tools only, each once; the acting-tools flag is recomputed here, so it can't be dropped.
  const tools = [...new Set(item['tools'].filter((tool): tool is AgentToolName => (AGENT_TOOL_NAMES as readonly unknown[]).includes(tool)))];
  if (tools.length === 0) return null;
  if (item['inputs'].length > SKILL_INPUT_SLOTS.length) return null;
  const inputs: { slot: SkillInputSlot; label: string; placeholder: string | null }[] = [];
  for (const raw of item['inputs'] as unknown[]) {
    const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const label = bounded(input['label'], SKILL_LIMITS.maxInputLabelChars);
    const placeholder = input['placeholder'] === null ? null : bounded(input['placeholder'], SKILL_LIMITS.maxInputPlaceholderChars);
    if (!(SKILL_INPUT_SLOTS as readonly unknown[]).includes(input['slot']) || label === null || (placeholder === null && input['placeholder'] !== null)) return null;
    inputs.push({ slot: input['slot'] as SkillInputSlot, label, placeholder });
  }
  if (!(SKILL_IMPORT_CONFLICTS as readonly unknown[]).includes(item['conflict'])) return null;
  return {
    index,
    valid: true,
    id: item['id'],
    name,
    description,
    tools,
    actingTools: tools.some((tool) => (SKILL_ACTING_TOOLS as readonly string[]).includes(tool)),
    conflict: item['conflict'] as (typeof SKILL_IMPORT_CONFLICTS)[number],
    instructions,
    inputs,
    error: null,
  };
}

/**
 * `previewSkillImport`'s answer, rebuilt field by field and re-bounded (as `checkedSaveSkillResult`):
 * a refusal as its fixed value alone; a review with a well-formed token, room and at most
 * `MAX_USER_SKILLS` entries, each rebuilt (`checkedImportItem`), within `SKILL_FILE_MAX_BYTES` in
 * all. Anything malformed answers `failed`: a review is never shown partly.
 */
function checkedSkillImportPreview(value: unknown): AgentSkillImportPreviewResult {
  const answer = (typeof value === 'object' && value !== null ? value : {}) as { result?: unknown; preview?: unknown };
  if (answer.result !== 'ready') return { result: refusalOf(answer.result) };
  const preview = (typeof answer.preview === 'object' && answer.preview !== null ? answer.preview : {}) as { token?: unknown; items?: unknown; room?: unknown };
  const { token, room } = preview;
  if (typeof token !== 'string' || !UUID.test(token) || !Number.isInteger(room) || (room as number) < 0 || (room as number) > MAX_USER_SKILLS) return { result: 'failed' };
  if (!Array.isArray(preview.items) || preview.items.length > MAX_USER_SKILLS) return { result: 'failed' };
  const items: AgentSkillImportItem[] = [];
  for (const raw of preview.items as unknown[]) {
    const item = checkedImportItem(raw);
    if (item === null) return { result: 'failed' };
    items.push(item);
  }
  const checked: AgentSkillImportPreviewResult = { result: 'ready', preview: { token, items, room: room as number } };
  return new TextEncoder().encode(JSON.stringify(checked)).length > SKILL_FILE_MAX_BYTES ? { result: 'failed' } : checked;
}

/** `importSkills`' answer: `imported` with a whole count within `MAX_USER_SKILLS`, or a refusal's fixed value. */
function checkedSkillImportResult(value: unknown): AgentSkillImportResult {
  const answer = (typeof value === 'object' && value !== null ? value : {}) as { result?: unknown; count?: unknown };
  if (answer.result === 'imported') {
    return Number.isInteger(answer.count) && (answer.count as number) >= 0 && (answer.count as number) <= MAX_USER_SKILLS ? { result: 'imported', count: answer.count as number } : { result: 'failed' };
  }
  return { result: refusalOf(answer.result) };
}

/** A grant as the page lists it, field by field. */
const grantView = (grant: AgentGrantView): AgentGrantView => ({ tool: text(grant.tool, 64), label: text(grant.label, 200), origin: text(grant.origin, 2048), createdAt: Number.isFinite(grant.createdAt) ? grant.createdAt : 0 });

/**
 * The long-poll behind `agent.watch` (`AGENT_WATCH_TIMEOUT_MS`, as `browser.watch`): the current
 * state at once if it is newer than `sinceVersion`, else the state from the service's next change,
 * or the current state after the timeout. Either way the timer is cleared and the waiter released.
 */
async function watchAgentState(agent: AgentService, sinceVersion: number): Promise<AgentState> {
  const current = agent.getState();
  if (current.version > sinceVersion) return current;
  // A version from the future (a stale or forged poll) waits for the next change, not forever.
  const since = Math.min(sinceVersion, current.version);
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      agent.watch(since, release.signal),
      new Promise<AgentState>((resolve) => {
        timer = setTimeout(() => resolve(agent.getState()), AGENT_WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * `watch` answers the panel's `AgentState`; `send` how the message (or skill run) went (`AGENT_SEND_RESULTS`);
 * `stop`, `selectChat`, `deleteChat`, `setModel`, `setReasoningEffort`, `clearKey` whether they did it; `newChat` `null`;
 * `answerApproval` `AGENT_ANSWER_RESULTS`; `setKey` `AGENT_SET_KEY_RESULTS` (never the key).
 */
export const agentRouter = router({
  watch: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentWatchInputSchema)
    .query(({ ctx, input }) => watchAgentState(ctx.agent, input.sinceVersion)),
  send: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSendInputSchema)
    .mutation(async ({ ctx, input }): Promise<AgentSendResult> => {
      // A skill run carries only the fields its schema allows, copied one by one.
      const message: string | AgentSkillRequest =
        'skillId' in input
          ? { skillId: input.skillId, ...(input.userNote !== undefined ? { userNote: input.userNote } : {}), ...(input.targetQuery !== undefined ? { targetQuery: input.targetQuery } : {}) }
          : input.text;
      return oneOf(AGENT_SEND_RESULTS, await ctx.agent.send(input.chatId, message), 'unavailable');
    }),
  stop: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentChatInputSchema)
    .mutation(({ ctx, input }) => ctx.agent.stop(input.chatId) === true),
  newChat: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .mutation(({ ctx }) => {
      ctx.agent.newChat();
      return null;
    }),
  selectChat: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentChatInputSchema)
    .mutation(({ ctx, input }) => ctx.agent.selectChat(input.chatId) === true),
  deleteChat: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentChatInputSchema)
    .mutation(({ ctx, input }) => ctx.agent.deleteChat(input.chatId) === true),
  answerApproval: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentAnswerApprovalInputSchema)
    .mutation(async ({ ctx, input }): Promise<AgentAnswerResult> => oneOf(AGENT_ANSWER_RESULTS, await ctx.agent.answerApproval(input.approvalId, input.decision), 'invalid')),
  setModel: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSetModelInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.setModel(input.route, input.modelId)) === true),
  setReasoningEffort: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSetReasoningEffortInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.setReasoningEffort(input.effort)) === true),
  setKey: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSetKeyInputSchema)
    .mutation(async ({ ctx, input }): Promise<AgentSetKeyResult> => oneOf(AGENT_SET_KEY_RESULTS, await ctx.agent.setKey(input.slot, input.key), 'failed')),
  clearKey: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentClearKeyInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.clearKey(input.slot)) === true),

  // ---- Task 9 (`agent-data.spec.ts`; acceptance `agent-data.feature.md`, Router) ----
  listGrants: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .query(({ ctx }): AgentGrantView[] => {
      const grants = ctx.agent.listGrants();
      return Array.isArray(grants) ? grants.map(grantView) : [];
    }),
  revokeGrant: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentRevokeGrantInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.revokeGrant(input.tool, input.origin)) === true),
  revokeAllGrants: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .mutation(async ({ ctx }) => (await ctx.agent.revokeAllGrants()) === true),
  setReadToolsAllowed: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSetReadToolsAllowedInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.setReadToolsAllowed(input.allowed)) === true),
  setChatRetention: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSetChatRetentionInputSchema)
    .mutation(async ({ ctx, input }): Promise<AgentSetRetentionResult> => oneOf(AGENT_SET_RETENTION_RESULTS, await ctx.agent.setChatRetention(input.retention), 'failed')),
  deleteAllChats: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .mutation(async ({ ctx }): Promise<AgentDeleteAllChatsResult> => oneOf(AGENT_DELETE_ALL_CHATS_RESULTS, await ctx.agent.deleteAllChats(), 'failed')),
  exportChat: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentExportChatInputSchema)
    .mutation(async ({ ctx, input }): Promise<ChatExportResult> => oneOf(CHAT_EXPORT_RESULTS, await ctx.agent.exportChat(input.chatId, input.format), 'failed')),
  skillDetail: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSkillIdInputSchema)
    .query(({ ctx, input }): AgentSkillDetail | null => ctx.agent.skillDetail(input.id) ?? null),
  saveSkill: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSaveSkillInputSchema)
    .mutation(async ({ ctx, input }): Promise<AgentSaveSkillResult> => {
      // The draft's fields, copied one by one (the schema is strict; main validates the skill itself).
      const { skill } = input;
      const draft = {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        allowedTools: [...skill.allowedTools],
        instructions: skill.instructions,
        inputs: skill.inputs.map((item) => ({ slot: item.slot, label: item.label, ...(item.placeholder !== undefined ? { placeholder: item.placeholder } : {}) })),
      };
      return checkedSaveSkillResult(await ctx.agent.saveSkill(draft, input.mode));
    }),
  deleteSkill: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSkillIdInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.deleteSkill(input.id)) === true),
  duplicateSkill: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSkillIdInputSchema)
    .mutation(async ({ ctx, input }): Promise<AgentSaveSkillResult> => checkedSaveSkillResult(await ctx.agent.duplicateSkill(input.id))),
  setSkillEnabled: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSetSkillEnabledInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.setSkillEnabled(input.id, input.enabled)) === true),

  // ---- Phase 8 Task 6 (`agent-data.spec.ts`, Skill files; acceptance `agent-data.feature.md`, Import and export) ----
  // No path crosses: main asks in its own save and open dialogs.
  exportSkills: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentExportSkillsInputSchema)
    .mutation(async ({ ctx, input }): Promise<SkillExportResult> => oneOf(SKILL_EXPORT_RESULTS, await ctx.agent.exportSkills(input.ids === 'all-mine' ? 'all-mine' : [...input.ids]), 'failed')),
  previewSkillImport: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .mutation(async ({ ctx }): Promise<AgentSkillImportPreviewResult> => checkedSkillImportPreview(await ctx.agent.previewSkillImport())),
  importSkills: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentImportSkillsInputSchema)
    .mutation(async ({ ctx, input }): Promise<AgentSkillImportResult> => checkedSkillImportResult(await ctx.agent.importSkills(input.token, [...input.indices]))),
  cancelSkillImport: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentCancelSkillImportInputSchema)
    .mutation(({ ctx, input }) => ctx.agent.cancelSkillImport(input.token) === true),

  // ---- Task 10 (`agent-mcp.spec.ts`; acceptance `agent-mcp.feature.md`, Router) ----
  saveMcpServer: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSaveMcpServerInputSchema)
    .mutation(async ({ ctx, input }): Promise<{ result: McpSaveResult; id?: string }> => {
      // The fields, copied one by one (the schema is strict; main validates the server itself).
      const server =
        input.transport === 'http'
          ? { ...(input.id !== undefined ? { id: input.id } : {}), name: input.name, transport: 'http' as const, url: input.url }
          : {
              ...(input.id !== undefined ? { id: input.id } : {}),
              name: input.name,
              transport: 'stdio' as const,
              command: input.command,
              args: [...input.args],
              readPaths: [...input.readPaths],
              allowNetwork: input.allowNetwork,
              env: input.env.map((item) => ({ name: item.name, ...(item.value !== undefined ? { value: item.value } : {}) })),
            };
      const answer = (await ctx.agent.saveMcpServer(server)) as { result?: unknown; id?: unknown } | null;
      const result = oneOf(MCP_SAVE_RESULTS, answer?.result, 'failed');
      return result === 'saved' && isMcpServerId(answer?.id) ? { result, id: answer.id } : { result: result === 'saved' ? 'failed' : result };
    }),
  deleteMcpServer: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentMcpServerIdInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.deleteMcpServer(input.id)) === true),
  setMcpServerEnabled: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSetMcpServerEnabledInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.setMcpServerEnabled(input.id, input.enabled)) === true),
  startMcpServer: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentMcpServerIdInputSchema)
    .mutation(async ({ ctx, input }): Promise<McpStartResult> => oneOf(MCP_START_RESULTS, await ctx.agent.startMcpServer(input.id), 'failed')),
  stopMcpServer: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentMcpServerIdInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.agent.stopMcpServer(input.id)) === true),
  /** Write-only: the token goes renderer → main once; the answer is one of `MCP_TOKEN_RESULTS`. */
  setMcpToken: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentSetMcpTokenInputSchema)
    .mutation(async ({ ctx, input }): Promise<McpTokenResult> => oneOf(MCP_TOKEN_RESULTS, await ctx.agent.setMcpToken(input.id, input.token), 'failed')),

  // ---- ChatGPT plan (`agent-chatgpt.spec.ts`; acceptance `agent-chatgpt.feature.md`, Router) ----
  /** For the sender's window: main spends its live user gesture before the browser opens (`needs-gesture` without one). */
  chatgptSignIn: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .input(AgentChatgptSignInInputSchema)
    .mutation(async ({ ctx, input }): Promise<ChatgptSignInResult> => {
      // `enforceSender` admitted only a known app window, so there is a window id.
      const windowId = ctx.sender?.windowId;
      if (typeof windowId !== 'number') throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'no sender window' });
      const options = { ...(input.reconsent === true ? { reconsent: true } : {}), ...(input.differentAccount === true ? { differentAccount: true } : {}) };
      return oneOf(CHATGPT_SIGN_IN_RESULTS, await ctx.agent.chatgptSignIn(windowId, options), 'failed');
    }),
  chatgptCancel: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .mutation(({ ctx }) => ctx.agent.chatgptCancel() === true),
  chatgptSignOut: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .mutation(async ({ ctx }): Promise<ChatgptSignOutResult> => oneOf(CHATGPT_SIGN_OUT_RESULTS, await ctx.agent.chatgptSignOut(), 'not-revoked')),
  chatgptAcknowledge: publicProcedure
    .use(enforceSender)
    .use(requireAgent)
    .mutation(async ({ ctx }) => (await ctx.agent.chatgptAcknowledge()) === true),
});
