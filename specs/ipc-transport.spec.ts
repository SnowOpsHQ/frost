/**
 * IPC transport contract (design doc §2 "IPC" and §3 "Security model"; Phase 0 Task 4).
 *
 * The in-repo tRPC-over-Electron transport (`packages/ipc-contract/src/transport/*`): the renderer's
 * tRPC link sends one request envelope per call through the preload bridge, the bridge forwards it
 * on the single fixed `IPC_CHANNEL`, and the main-process handler validates it, captures the sender
 * context and runs the procedure. Acceptance list: `ipc-transport.feature.md`.
 */

/** The only IPC channel the app uses. Fixed in the preload; the renderer cannot choose a channel. */
export const IPC_CHANNEL = 'app:trpc' as const;

/** Name of the preload bridge on the renderer's `window` (`contextBridge.exposeInMainWorld`). */
export const IPC_BRIDGE_KEY = 'frostIpc' as const;

/** The bridge's complete API: exactly these members, nothing else. */
export const IPC_BRIDGE_METHODS = ['invoke'] as const;

/** Procedure types the transport carries in Phase 0 (no subscriptions). */
export const IPC_PROCEDURE_TYPES = ['query', 'mutation'] as const;
export type IpcProcedureType = (typeof IPC_PROCEDURE_TYPES)[number];

/**
 * Procedure paths are dot-separated identifiers (`ping`, `audit.run`), at most this long. Anything
 * else is not a path and is answered `BAD_REQUEST` without consulting the router.
 */
export const IPC_PATH_PATTERN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
export const IPC_MAX_PATH_LENGTH = 256;

/**
 * Request envelope (renderer → main): `{ id?, type, path, input? }`, no other keys. `id` is an
 * optional caller-chosen correlation id, echoed back; the transport is request/response
 * (`ipcRenderer.invoke`), so it is not needed for routing.
 */
export interface IpcRequestEnvelope {
  readonly id?: number | string;
  readonly type: IpcProcedureType;
  readonly path: string;
  readonly input?: unknown;
}

/** The tRPC error shape the router's formatter produces (`ipc-sender.feature.md`, `error-shape-hides-internals`). */
export interface IpcErrorShape {
  readonly message: string;
  readonly code: number;
  readonly data: { readonly code: string; readonly httpStatus: number; readonly path?: string };
}

/**
 * Response envelope (main → renderer). Exactly one of `result` / `error`. The main handler always
 * resolves with one of these: it never throws or rejects, so no Electron error (with main-process
 * detail) is ever serialized to the renderer. `result.data` must survive `structuredClone` (what
 * Electron IPC uses); a procedure output that does not is answered `IPC_INTERNAL_ERROR_CODE`.
 */
export type IpcResponseEnvelope =
  | { readonly id?: number | string; readonly result: { readonly data: unknown } }
  | { readonly id?: number | string; readonly error: IpcErrorShape };

/** tRPC error code for an envelope that fails validation. */
export const IPC_BAD_ENVELOPE_ERROR_CODE = 'BAD_REQUEST' as const;
/** tRPC error code for a well-formed envelope naming no procedure of that type. */
export const IPC_UNKNOWN_PROCEDURE_ERROR_CODE = 'NOT_FOUND' as const;
/**
 * tRPC error code (and message) for anything unexpected in main. The original message is replaced:
 * it may carry main-process internals (paths, SQL, …).
 */
export const IPC_INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR' as const;
