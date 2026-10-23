# @app/ipc-contract

The typed tRPC contract for all main ↔ renderer IPC (design doc §2–3). Spec:
`specs/ipc-sender.spec.ts`; acceptance: `specs/ipc-sender.feature.md`.

- `appRouter` / `type AppRouter`: every procedure is `publicProcedure.use(enforceSender)…`. The
  unguarded `publicProcedure` is not exported, so procedures can only be added here.
- `enforceSender`: rejects with tRPC `FORBIDDEN` unless the sender is the main frame of a known app
  window on an accepted origin (`app://app`, plus the Vite dev-server origin only when explicitly
  allowed). It fails closed when the context is missing or malformed.
- `createSenderPolicy({ knownWindowIds, devServerUrl? })`: built once at startup.
- `createContext({ sender, senderFrame, window, policy })`: called per message with the real
  Electron objects (`event.sender`, `event.senderFrame`, `BrowserWindow.fromWebContents(event.sender)`).

The package imports no `electron` code at runtime (types only), so it runs under plain Node/Vitest.
Consumers bundle the TypeScript source (`exports` → `src/index.ts`); `build` only type-checks.
Renderer code must import `AppRouter` with `import type`, because tRPC's server init throws in a
browser context.

## Electron transport (Task 4)
**Decision:** Task 4 builds a small in-repo transport inside this package instead of using a
third-party Electron/tRPC bridge.

- `electron-trpc` (last release 0.7.1, Dec 2024) bundles tRPC v10's `callProcedure`, which looks
  procedures up by `_def[type]`; tRPC v11 procedures carry `_def.type`, so **every** v11 procedure
  fails with `NOT_FOUND`, not only those with input.
- `trpc-electron` (the v11 fork) is rejected: it throws an uncaught `TypeError` in main when
  `event.senderFrame` is `null`, calls `createContext` outside its `try` (unhandled rejections), does
  not validate the message envelope, bundles its own drifting copy of tRPC, and has one maintainer.

The in-repo transport (Task 4; not built yet):
- **main:** one `ipcMain.handle` channel; the envelope is validated with Zod (hence the `zod`
  dependency here); the context is captured synchronously from the event (`createContext`) before
  any `await`; `callTRPCProcedure` runs inside a `try`, and failures are returned as tRPC error
  shapes (no stack or other internals: `error-shape-hides-internals`).
- **preload:** `contextBridge` exposes only `invoke(envelope)`; no raw `ipcRenderer`.
- **renderer:** a `TRPCLink` that sends envelopes through `invoke`.
