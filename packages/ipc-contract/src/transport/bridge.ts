/** The renderer's whole IPC surface: `window[IPC_BRIDGE_KEY]` (spec `specs/ipc-transport.spec.ts`). */
export interface IpcBridge {
  /** Sends one request envelope on the fixed `IPC_CHANNEL`; resolves the main handler's response envelope. */
  invoke(envelope: unknown): Promise<unknown>;
}
