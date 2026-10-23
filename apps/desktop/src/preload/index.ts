// Minimal sandboxed preload: exposes only the typed IPC bridge (`window.frostIpc.invoke`, fixed
// channel). No raw ipcRenderer and nothing else (specs/ipc-transport.spec.ts).
import { exposeIpcBridge } from '@app/ipc-contract/preload';

exposeIpcBridge();
