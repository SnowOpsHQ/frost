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

The root entry and `/main` import no `electron` code at runtime (types only; `ipcMain` and
`fromWebContents` are injected), so they run under plain Node/Vitest. Only `/preload` imports `electron`.
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

The in-repo transport (spec `specs/ipc-transport.spec.ts`, acceptance `specs/ipc-transport.feature.md`)
lives under `src/transport/` and is consumed through subpath exports, so the root entry stays free
of runtime `electron` imports:
- **`@app/ipc-contract/main`** — `attachIpcHandler({ router, policy, ipcMain, fromWebContents })`
  registers one `ipcMain.handle` on `IPC_CHANNEL` (`app:trpc`). Per message it captures the context
  synchronously (`createContext` from `event.sender`, `event.senderFrame`, `fromWebContents(sender)`),
  rejects a bad sender with `FORBIDDEN` before looking at the envelope (so a foreign sender learns
  nothing about paths), validates the envelope with Zod (`{ id?, type: 'query'|'mutation', path,
  input? }`, strict → `BAD_REQUEST`), then runs `callTRPCProcedure` (unknown path → `NOT_FOUND`).
  Errors come back as the router's formatted shape (no stack; unexpected errors masked to
  `INTERNAL_SERVER_ERROR`). The handler always resolves an envelope; it never throws or rejects.
- **`@app/ipc-contract/preload`** — `exposeIpcBridge()` exposes `window.frostIpc = { invoke }` (frozen)
  via `contextBridge`; `invoke(envelope)` is `ipcRenderer.invoke(IPC_CHANNEL, envelope)`. Nothing else.
  It imports only `electron` and spec constants, so it bundles into the sandboxed CJS preload.
- **`@app/ipc-contract/renderer`** — `ipcLink()` (a tRPC v11 `TRPCLink`) and `createIpcClient<AppRouter>()`.
  Error envelopes and bridge failures surface as `TRPCClientError`. `@trpc/client` is pinned to the
  exact `@trpc/server` version.
