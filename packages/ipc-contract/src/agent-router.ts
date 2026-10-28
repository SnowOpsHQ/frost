import { TRPCError } from '@trpc/server';
import {
  AgentAnswerApprovalInputSchema,
  AgentChatInputSchema,
  AgentClearKeyInputSchema,
  AgentSendInputSchema,
  AgentSetKeyInputSchema,
  AgentSetModelInputSchema,
  AgentWatchInputSchema,
} from '@app/specs/agent-ipc.schema';
import { AGENT_ANSWER_RESULTS, AGENT_SEND_RESULTS, AGENT_SET_KEY_RESULTS, AGENT_WATCH_TIMEOUT_MS, type AgentAnswerResult, type AgentSendResult, type AgentSetKeyResult, type AgentState } from '@app/specs/agent-session.spec';
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
 * `watch` answers the panel's `AgentState`; `send` how the message went (`AGENT_SEND_RESULTS`);
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
    .mutation(async ({ ctx, input }): Promise<AgentSendResult> => oneOf(AGENT_SEND_RESULTS, await ctx.agent.send(input.chatId, input.text), 'unavailable')),
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
});
