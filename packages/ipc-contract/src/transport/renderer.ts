import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import type { AnyTRPCRouter } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { IPC_BRIDGE_KEY, IPC_PROCEDURE_TYPES, type IpcRequestEnvelope } from '@app/specs/ipc-transport.spec';
import type { IpcBridge } from './bridge';

export type { IpcBridge };

// Renderer end of the IPC transport (spec `specs/ipc-transport.spec.ts`): a tRPC link that sends
// each operation as one envelope through the preload bridge. Renderer code imports `AppRouter`
// with `import type` only (tRPC's server init must not run in the page).

export interface IpcLinkOptions {
  /** Defaults to the preload bridge at `globalThis[IPC_BRIDGE_KEY]`. */
  readonly bridge?: IpcBridge;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function defaultBridge(): IpcBridge {
  const bridge = (globalThis as Record<string, unknown>)[IPC_BRIDGE_KEY];
  if (!isRecord(bridge) || typeof bridge['invoke'] !== 'function') {
    throw new Error(`IPC bridge window.${IPC_BRIDGE_KEY} is not available`);
  }
  return bridge as unknown as IpcBridge;
}

function isProcedureType(type: string): type is IpcRequestEnvelope['type'] {
  return (IPC_PROCEDURE_TYPES as readonly string[]).includes(type);
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function ipcLink<TRouter extends AnyTRPCRouter>(opts: IpcLinkOptions = {}): TRPCLink<TRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        let active = true;
        const run = async (): Promise<void> => {
          if (!isProcedureType(op.type)) throw new Error(`${op.type} is not supported over IPC`);
          const envelope: IpcRequestEnvelope = {
            id: op.id,
            type: op.type,
            path: op.path,
            ...(op.input === undefined ? {} : { input: op.input }),
          };
          const response = await (opts.bridge ?? defaultBridge()).invoke(envelope);
          if (!active) return;
          if (isRecord(response) && isRecord(response['error'])) {
            // `from` keeps the server's shape only if it is a well-formed tRPC error shape.
            observer.error(TRPCClientError.from({ error: response['error'] }));
          } else if (isRecord(response) && isRecord(response['result']) && 'data' in response['result']) {
            observer.next({ result: { type: 'data', data: response['result']['data'] } });
            observer.complete();
          } else {
            throw new Error('malformed IPC response');
          }
        };
        run().catch((cause: unknown) => {
          if (active) observer.error(TRPCClientError.from(toError(cause)));
        });
        return () => {
          active = false;
        };
      });
}

/** A typed tRPC client over the preload bridge: `createIpcClient<AppRouter>()`. */
export function createIpcClient<TRouter extends AnyTRPCRouter>(opts: IpcLinkOptions = {}) {
  return createTRPCClient<TRouter>({ links: [ipcLink<TRouter>(opts)] });
}
