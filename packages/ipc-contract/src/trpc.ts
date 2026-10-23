import { initTRPC, TRPCError } from '@trpc/server';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { senderRejection, type IpcContext } from './sender';

// tRPC init for the IPC contract (spec `specs/ipc-sender.spec.ts`). Module-private to the package:
// `index.ts` does not re-export `publicProcedure`, so procedures are only defined in this package,
// each written as `publicProcedure.use(enforceSender)` first (Task 5's Semgrep rule checks that form).

// The error shape goes back to the renderer. `isDev` defaults to `NODE_ENV !== 'production'`, which
// is always true in Electron main, and would add `data.stack` (absolute main-process paths); the
// formatter also allowlists `data` so nothing else internal is ever sent (`error-shape-hides-internals`).
const t = initTRPC.context<IpcContext>().create({
  isDev: false,
  errorFormatter: ({ shape }) => ({
    message: shape.message,
    code: shape.code,
    data: { code: shape.data.code, httpStatus: shape.data.httpStatus, path: shape.data.path },
  }),
});

export const router = t.router;

/** Unguarded base procedure. Never end a chain on it without `.use(enforceSender)` first. */
export const publicProcedure = t.procedure;

/**
 * Rejects the call with `FORBIDDEN` unless the sender is the main frame of a known app window on an
 * accepted origin (`senderRejection`). Fails closed on a missing/malformed context. The reason is
 * not sent to the renderer.
 */
export const enforceSender = t.middleware(({ ctx, next }) => {
  if (senderRejection(ctx) !== null) {
    throw new TRPCError({ code: IPC_SENDER_ERROR_CODE, message: IPC_SENDER_ERROR_CODE });
  }
  return next({ ctx });
});
