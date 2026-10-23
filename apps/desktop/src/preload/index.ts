// Minimal sandboxed preload. Intentionally exposes nothing to the renderer:
// no ipcRenderer, no contextBridge APIs. The typed IPC bridge arrives in Phase 0, Task 4.
export {};
