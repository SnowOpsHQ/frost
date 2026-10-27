import { contextBridge, ipcRenderer } from 'electron';
import { IPC_BRIDGE_KEY, IPC_CHANNEL } from '@app/specs/ipc-transport.spec';
import type { IpcBridge } from './bridge';

// Preload end of the IPC transport (spec `specs/ipc-transport.spec.ts`). Bundled into the sandboxed
// CJS preload, so it imports nothing but `electron` and spec constants.

export type { IpcBridge };

/** Builds the bridge over `ipcRenderer`. The channel is fixed here; the renderer cannot pick one. */
export function createIpcBridge(renderer: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }): IpcBridge {
  return Object.freeze({ invoke: (envelope: unknown) => renderer.invoke(IPC_CHANNEL, envelope) });
}

/** Exposes the bridge (and nothing else) to the page's main world. */
export function exposeIpcBridge(): void {
  contextBridge.exposeInMainWorld(IPC_BRIDGE_KEY, createIpcBridge(ipcRenderer));
}
