import { TRPCError } from '@trpc/server';
import {
  InspectorAckSchema,
  InspectorChildrenAnswerSchema,
  InspectorChildrenInputSchema,
  InspectorHighlightInputSchema,
  InspectorNodeAnswerSchema,
  InspectorNodeInputSchema,
  InspectorPickAnswerSchema,
  InspectorPickInputSchema,
  InspectorTabInputSchema,
  type InspectorAck,
  type InspectorChildrenAnswer,
  type InspectorNodeAnswer,
  type InspectorPickAnswer,
  type NodePath,
} from '@app/specs/inspector.schema';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { z } from 'zod';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// The DOM inspector ↔ main (Phase 6 Task 8; spec `inspector.schema.ts`; acceptance
// `inspector.feature.md`, Router). Every procedure starts `publicProcedure.use(enforceSender)`, then
// `requireInspector` (which fails closed without the service), and takes a strict input: a tab id, a
// node path of at most `maxPathDepth` indices with its expected tag, the document's token (`null` only
// for the first read of `<html>` and a pick), an offset. No input carries a selector, a script or page
// text. Answers are checked against their schemas on the way out.

/**
 * What the `inspector.*` procedures call (main's `apps/desktop/src/main/inspector/service.ts`).
 * Every method answers; none rejects. A refusal names why (`INSPECTOR_REFUSALS`).
 */
export interface InspectorService {
  /** The node at `path` (tag `tag`; `null`: the first read of `<html>`) and up to `maxChildren` of its element children from `offset` (`more` past them). */
  children(tabId: number, path: NodePath, tag: string | null, docToken: string | null, offset: number): Promise<InspectorChildrenAnswer>;
  /** The node's details: tag, attributes, box, computed styles, region, SEO facts. */
  node(tabId: number, path: NodePath, tag: string, docToken: string): Promise<InspectorNodeAnswer>;
  /** Picks an element on the page with the mouse (trusted input only); resolves once picked or ended. */
  pick(tabId: number, docToken: string | null): Promise<InspectorPickAnswer>;
  /** Ends the tab's pick under way; whether there was one. */
  cancelPick(tabId: number): Promise<boolean>;
  /** Outlines the node `{ path, tag }` on the page (`null`: that outline goes). */
  highlight(tabId: number, node: { path: NodePath; tag: string } | null, docToken: string): Promise<InspectorAck>;
  /** Ends any pick and removes every outline (the overlay's host leaves the page). */
  clear(tabId: number): Promise<InspectorAck>;
}

/** Hands the procedure main's `InspectorService` (after `enforceSender`; fails closed without it). */
const requireInspector = middleware(({ ctx, next }) => {
  const inspector = ctx.services?.inspector;
  if (!inspector) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'inspector service unavailable' });
  return next({ ctx: { ...ctx, inspector } });
});

export const inspectorRouter = router({
  children: publicProcedure
    .use(enforceSender)
    .use(requireInspector)
    .input(InspectorChildrenInputSchema)
    .output(InspectorChildrenAnswerSchema)
    .query(({ ctx, input }) => ctx.inspector.children(input.tabId, input.path, input.tag, input.docToken, input.offset)),
  node: publicProcedure
    .use(enforceSender)
    .use(requireInspector)
    .input(InspectorNodeInputSchema)
    .output(InspectorNodeAnswerSchema)
    .query(({ ctx, input }) => ctx.inspector.node(input.tabId, input.path, input.tag, input.docToken)),
  pick: publicProcedure
    .use(enforceSender)
    .use(requireInspector)
    .input(InspectorPickInputSchema)
    .output(InspectorPickAnswerSchema)
    .mutation(({ ctx, input }) => ctx.inspector.pick(input.tabId, input.docToken)),
  cancelPick: publicProcedure
    .use(enforceSender)
    .use(requireInspector)
    .input(InspectorTabInputSchema)
    .output(z.boolean())
    .mutation(({ ctx, input }) => ctx.inspector.cancelPick(input.tabId)),
  highlight: publicProcedure
    .use(enforceSender)
    .use(requireInspector)
    .input(InspectorHighlightInputSchema)
    .output(InspectorAckSchema)
    .mutation(({ ctx, input }) => ctx.inspector.highlight(input.tabId, input.node, input.docToken)),
  clear: publicProcedure
    .use(enforceSender)
    .use(requireInspector)
    .input(InspectorTabInputSchema)
    .output(InspectorAckSchema)
    .mutation(({ ctx, input }) => ctx.inspector.clear(input.tabId)),
});
