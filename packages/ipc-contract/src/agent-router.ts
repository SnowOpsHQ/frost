import { TRPCError } from '@trpc/server';
import {
  AgentAnswerApprovalInputSchema,
  AgentChatInputSchema,
  AgentClearKeyInputSchema,
  AgentSendInputSchema,
  AgentSetKeyInputSchema,
  AgentSetModelInputSchema,
  AgentWatchInputSchema,
  AgentExportChatInputSchema,
  AgentRevokeGrantInputSchema,
  AgentSaveSkillInputSchema,
  AgentSetChatRetentionInputSchema,
  AgentSetReadToolsAllowedInputSchema,
  AgentSkillIdInputSchema,
} from '@app/specs/agent-ipc.schema';
import {
  AGENT_DELETE_ALL_CHATS_RESULTS,
  AGENT_SAVE_SKILL_RESULTS,
  AGENT_SET_RETENTION_RESULTS,
  CHAT_EXPORT_RESULTS,
  MAX_SKILL_ERRORS,
  SKILL_EDITOR_FIELDS,
  type AgentDeleteAllChatsResult,
  type AgentGrantView,
  type AgentSaveSkillResult,
  type AgentSetRetentionResult,
  type AgentSkillDetail,
  type ChatExportResult,
} from '@app/specs/agent-data.spec';
import { AGENT_ANSWER_RESULTS, AGENT_SEND_RESULTS, AGENT_SET_KEY_RESULTS, AGENT_WATCH_TIMEOUT_MS, type AgentAnswerResult, type AgentSendResult, type AgentSetKeyResult, type AgentSkillRequest, type AgentState } from '@app/specs/agent-session.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
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
 * `stop`, `selectChat`, `deleteChat`, `setModel`, `clearKey` whether they did it; `newChat` `null`;
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
});
