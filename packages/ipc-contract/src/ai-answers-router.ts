import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { AI_SEARCH_SETTING_RESULTS, type AiSearchSettingResult } from '@app/specs/ai-answers.spec';
import {
  AiAnswerIdInputSchema,
  AiAnswerRecordSchema,
  AiAnswersListAnswerSchema,
  AiAnswersListInputSchema,
  AiAnswersRunAnswerSchema,
  AiAnswersRunInputSchema,
  AiAnswersSetDefaultEngineInputSchema,
  AiAnswersSetRetentionInputSchema,
  AiAnswersSetViaInputSchema,
  AiAnswersViewSchema,
} from '@app/specs/ai-answers.schema';
import type { AiAnswersService } from './ai-answers-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The AI answers view ↔ main (Phase 12 Task 9; spec `ai-answers.schema.ts`; acceptance `ai-answers.feature.md`,
// Router). Every procedure starts `publicProcedure.use(enforceSender)`; inputs are strict and bounded, and
// every answer is checked against a strict schema (or its fixed set) before it leaves, so no stray field
// (a key, markup) reaches the renderer.

/** Hands the procedure main's `AiAnswersService` (after `enforceSender`; fails closed without it). */
const requireAiAnswers = middleware(({ ctx, next }) => {
  const aiAnswers = ctx.services?.aiAnswers;
  if (!aiAnswers) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'ai answers service unavailable' });
  return next({ ctx: { ...ctx, aiAnswers } });
});

const settingResult = (value: unknown): AiSearchSettingResult => ((AI_SEARCH_SETTING_RESULTS as readonly unknown[]).includes(value) ? (value as AiSearchSettingResult) : 'failed');

/**
 * - `view`: `AiAnswersView` (retention, default engine; per engine `available`, `hasKey`, `via`, `usable`).
 * - `list` (`{ beforeId?, limit }`): `AiAnswersListAnswer` (summaries, newest first).
 * - `get` (`{ id }`): `AiAnswerRecord` or `null`.
 * - `run` (`{ query, engine? }`): `AiAnswersRunAnswer` (a user action: no approval card; `unavailable` while gated).
 * - `delete` (`{ id }`), `deleteAll`, `setRetention` (`{ retention }`): booleans.
 * - `setVia` (`{ engine, via }`), `setDefaultEngine` (`{ engine | null }`): `AI_SEARCH_SETTING_RESULTS`.
 */
export const aiAnswersRouter = router({
  view: publicProcedure
    .use(enforceSender)
    .use(requireAiAnswers)
    .output(AiAnswersViewSchema)
    .query(({ ctx }) => ctx.aiAnswers.view()),
  list: publicProcedure
    .use(enforceSender)
    .use(requireAiAnswers)
    .input(AiAnswersListInputSchema)
    .output(AiAnswersListAnswerSchema)
    .query(({ ctx, input }) => ctx.aiAnswers.list(input)),
  get: publicProcedure
    .use(enforceSender)
    .use(requireAiAnswers)
    .input(AiAnswerIdInputSchema)
    .output(AiAnswerRecordSchema.nullable())
    .query(async ({ ctx, input }) => (await ctx.aiAnswers.get(input.id)) ?? null),
  run: publicProcedure
    .use(enforceSender)
    .use(requireAiAnswers)
    .input(AiAnswersRunInputSchema)
    .output(AiAnswersRunAnswerSchema)
    .mutation(({ ctx, input }) => ctx.aiAnswers.run(input)),
  delete: publicProcedure
    .use(enforceSender)
    .use(requireAiAnswers)
    .input(AiAnswerIdInputSchema)
    .output(z.boolean())
    .mutation(async ({ ctx, input }) => (await ctx.aiAnswers.delete(input.id)) === true),
  deleteAll: publicProcedure
    .use(enforceSender)
    .use(requireAiAnswers)
    .output(z.boolean())
    .mutation(async ({ ctx }) => (await ctx.aiAnswers.deleteAll()) === true),
  setRetention: publicProcedure
    .use(enforceSender)
    .use(requireAiAnswers)
    .input(AiAnswersSetRetentionInputSchema)
    .output(z.boolean())
    .mutation(async ({ ctx, input }) => (await ctx.aiAnswers.setRetention(input.retention)) === true),
  setVia: publicProcedure
    .use(enforceSender)
    .use(requireAiAnswers)
    .input(AiAnswersSetViaInputSchema)
    .mutation(async ({ ctx, input }): Promise<AiSearchSettingResult> => settingResult(await ctx.aiAnswers.setVia(input.engine, input.via))),
  setDefaultEngine: publicProcedure
    .use(enforceSender)
    .use(requireAiAnswers)
    .input(AiAnswersSetDefaultEngineInputSchema)
    .mutation(async ({ ctx, input }): Promise<AiSearchSettingResult> => settingResult(await ctx.aiAnswers.setDefaultEngine(input.engine))),
});
