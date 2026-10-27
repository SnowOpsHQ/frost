import { callTRPCProcedure, getTRPCErrorFromUnknown, getTRPCErrorShape, TRPCError, type AnyTRPCRouter } from '@trpc/server';
import { z } from 'zod';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import {
  IPC_BAD_ENVELOPE_ERROR_CODE,
  IPC_CHANNEL,
  IPC_INTERNAL_ERROR_CODE,
  IPC_MAX_PATH_LENGTH,
  IPC_PATH_PATTERN,
  IPC_PROCEDURE_TYPES,
  type IpcErrorShape,
  type IpcResponseEnvelope,
} from '@app/specs/ipc-transport.spec';
import {
  createContext,
  senderRejection,
  type IpcContext,
  type SenderFrameLike,
  type SenderPolicy,
  type WebContentsLike,
  type WindowLike,
} from '../sender';
import type { IpcServices } from '../services';

// Main-process end of the IPC transport (spec `specs/ipc-transport.spec.ts`). No runtime `electron`
// import: the caller injects `ipcMain` and `BrowserWindow.fromWebContents`, so this runs under Node.

/** The parts of `IpcMainInvokeEvent` the handler reads. */
export interface IpcInvokeEventLike<S extends WebContentsLike = WebContentsLike> {
  readonly sender: S;
  readonly senderFrame: SenderFrameLike | null;
}

/** The parts of `ipcMain` the transport uses. */
export interface IpcMainLike<E> {
  handle(channel: string, listener: (event: E, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface IpcHandlerOptions<E extends IpcInvokeEventLike> {
  readonly router: AnyTRPCRouter;
  readonly policy: SenderPolicy;
  /** `BrowserWindow.fromWebContents`. */
  readonly fromWebContents: (sender: E['sender']) => WindowLike | null;
  /** Main-process services handed to procedures through the context (after the sender check). */
  readonly services?: IpcServices;
}

const envelopeSchema = z.strictObject({
  id: z.union([z.number(), z.string()]).optional(),
  type: z.enum(IPC_PROCEDURE_TYPES),
  path: z.string().max(IPC_MAX_PATH_LENGTH).regex(IPC_PATH_PATTERN),
  input: z.unknown().optional(),
});

/** Last resort if formatting itself fails; same shape as the router's formatter output. */
const INTERNAL_ERROR: IpcResponseEnvelope = {
  error: { message: IPC_INTERNAL_ERROR_CODE, code: -32603, data: { code: IPC_INTERNAL_ERROR_CODE, httpStatus: 500 } },
};

/**
 * Returns the `ipcMain.handle` listener for `IPC_CHANNEL`. The sender context is captured
 * synchronously, before anything is awaited, so the verdict reflects the frame that sent the
 * message. The returned promise always resolves to a response envelope: it never rejects, and
 * nothing about a rejected sender's request (path, id, validity) is echoed back.
 */
export function createIpcRequestHandler<E extends IpcInvokeEventLike>(
  opts: IpcHandlerOptions<E>,
): (event: E, envelope: unknown) => Promise<IpcResponseEnvelope> {
  const { router, policy, fromWebContents, services } = opts;
  return (event, envelope) => {
    let ctx: IpcContext | undefined;
    try {
      ctx = createContext({
        sender: event.sender,
        senderFrame: event.senderFrame,
        window: fromWebContents(event.sender),
        policy,
        ...(services === undefined ? {} : { services }),
      });
    } catch {
      ctx = undefined; // fails closed below (`no-context`)
    }
    return respond(router, ctx, envelope).catch(() => INTERNAL_ERROR);
  };
}

async function respond(router: AnyTRPCRouter, ctx: IpcContext | undefined, raw: unknown): Promise<IpcResponseEnvelope> {
  if (senderRejection(ctx) !== null) {
    return { error: errorShape(router, new TRPCError({ code: IPC_SENDER_ERROR_CODE, message: IPC_SENDER_ERROR_CODE }), ctx) };
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const error = new TRPCError({ code: IPC_BAD_ENVELOPE_ERROR_CODE, message: IPC_BAD_ENVELOPE_ERROR_CODE });
    return { error: errorShape(router, error, ctx) };
  }
  const { id, type, path, input } = parsed.data;
  const withId = <T extends object>(body: T) => (id === undefined ? body : { id, ...body });
  try {
    const data: unknown = await callTRPCProcedure({
      router,
      ctx,
      path,
      type,
      input,
      getRawInput: async () => input,
      signal: undefined,
      batchIndex: 0,
    });
    // Electron clones the response; a non-cloneable output must fail here, as a masked error,
    // rather than reject `invoke` in the renderer with Electron's own message.
    return withId({ result: { data: structuredClone(data) } });
  } catch (cause) {
    return withId({ error: errorShape(router, getTRPCErrorFromUnknown(cause), ctx, { type, path, input }) });
  }
}

/** The router's own formatted error shape (`trpc.ts` formatter: no stack, internal messages masked). */
function errorShape(
  router: AnyTRPCRouter,
  error: TRPCError,
  ctx: IpcContext | undefined,
  call: { type: (typeof IPC_PROCEDURE_TYPES)[number]; path: string; input: unknown } | undefined = undefined,
): IpcErrorShape {
  return getTRPCErrorShape({
    config: router._def._config,
    error,
    type: call?.type ?? 'unknown',
    path: call?.path,
    input: call?.input,
    ctx,
  }) as IpcErrorShape;
}

/**
 * Registers the transport on its one fixed channel (`IPC_CHANNEL`) and returns a function that
 * removes it. Electron allows a single handler per channel, so a second attach throws.
 */
export function attachIpcHandler<E extends IpcInvokeEventLike>(
  opts: IpcHandlerOptions<E> & { readonly ipcMain: IpcMainLike<E> },
): () => void {
  const handler = createIpcRequestHandler(opts);
  opts.ipcMain.handle(IPC_CHANNEL, (event: E, envelope: unknown) => handler(event, envelope));
  return () => opts.ipcMain.removeHandler(IPC_CHANNEL);
}
