import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { ContentNotesInputSchema, CopySnippetHtmlInputSchema, DeleteVariantInputSchema, SaveVariantInputSchema, SetTargetQueryInputSchema } from '@app/specs/seo-content.schema';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The Content panel ↔ main (Phase 2.5 Task 3; spec `seo-content.schema.ts`; acceptance
// `seo-content.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`.

/** Hands the procedure main's `ContentService` (after `enforceSender`; fails closed without it). */
const requireContent = middleware(({ ctx, next }) => {
  const content = ctx.services?.content;
  if (!content) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'content service unavailable' });
  return next({ ctx: { ...ctx, content } });
});

/**
 * `getNotes` answers the page's target query and drafts (`ContentNotes`); `setTarget`, `saveVariant`
 * and `deleteVariant` whether they were stored; `copySnippetHtml` whether main wrote the HTML to its
 * clipboard (only from the ready audit the panel shows, or a stored draft of its URL);
 * `clearAllNotes` whether every note was deleted (after main's confirmation).
 */
export const contentRouter = router({
  getNotes: publicProcedure
    .use(enforceSender)
    .use(requireContent)
    .input(ContentNotesInputSchema)
    .query(({ ctx, input }) => ctx.content.notes(input.url)),
  setTarget: publicProcedure
    .use(enforceSender)
    .use(requireContent)
    .input(SetTargetQueryInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.content.setTargetQuery(input.url, input.query)) === true),
  saveVariant: publicProcedure
    .use(enforceSender)
    .use(requireContent)
    .input(SaveVariantInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.content.saveVariant(input.url, { slot: input.slot, title: input.title, description: input.description })) === true),
  deleteVariant: publicProcedure
    .use(enforceSender)
    .use(requireContent)
    .input(DeleteVariantInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.content.deleteVariant(input.url, input.slot)) === true),
  copySnippetHtml: publicProcedure
    .use(enforceSender)
    .use(requireContent)
    .input(CopySnippetHtmlInputSchema)
    .mutation(async ({ ctx, input }) => (await ctx.content.copySnippetHtml(input.tabId, input.audit, input.source === 'variant' ? { slot: input.slot! } : 'page')) === true),
  // Phase 2.5 Task 3 review: "Delete all notes" (the panel's button and the palette); main confirms.
  clearAllNotes: publicProcedure
    .use(enforceSender)
    .use(requireContent)
    .mutation(async ({ ctx }) => (await ctx.content.clearAllNotes()) === true),
});
