# Feature: IPC transport (renderer link ↔ preload bridge ↔ main handler)

Spec: `specs/ipc-transport.spec.ts`. Design doc §2 (IPC) and §3 (Security model). Builds on
`ipc-sender.feature.md` (`enforceSender`). Each line maps to one named test in
`packages/ipc-contract/src/transport/__tests__/transport.test.ts` (Node, Electron objects faked).
The real-Electron round trip is `ipc-e2e.feature.md`.

## Main handler — `attachIpcHandler({ router, policy, ipcMain, fromWebContents })`
- **Scenario: registers-one-fixed-channel** — exactly one `ipcMain.handle` registration, on
  `IPC_CHANNEL`; no `ipcMain.on` listeners.
- **Scenario: ping-returns-pong** — a `query` envelope for `ping` from the main frame of a known app
  window on `app://app` resolves `{ result: { data: 'pong' } }`, echoing `id`.
- **Scenario: captures-sender-before-await** — the context is built synchronously in the handler's
  first tick from `event.sender`, `event.senderFrame` and `fromWebContents(event.sender)`: a frame
  that becomes destroyed / navigates away after the handler returned its promise does not change
  the verdict for that message.
- **Scenario: null-sender-frame-is-forbidden** — `event.senderFrame === null` resolves a `FORBIDDEN`
  error envelope; the handler does not throw.
- **Scenario: foreign-origin-is-forbidden** — a sender on `https://evil.com` resolves `FORBIDDEN`.
- **Scenario: foreign-sender-learns-nothing** — a rejected sender gets the same `FORBIDDEN` envelope
  for an existing path, an unknown path and a garbage envelope (the sender gate runs before
  envelope validation and routing).
- **Scenario: rejects-malformed-envelope** — from a valid sender, envelopes that are not
  `{ id?, type: 'query'|'mutation', path, input? }` resolve `BAD_REQUEST`: `undefined`, `null`, a
  string, an array, missing/`'subscription'`/unknown `type`, non-string / empty / too long /
  non-identifier `path` (`'a..b'`, `'../x'`, `'a b'`), an object `id`, and extra keys.
- **Scenario: unknown-path-is-not-found** — a well-formed envelope for a path with no procedure, a
  prototype key (`constructor`, `__proto__`, `toString`) or the wrong type (`mutation` for `ping`)
  resolves `NOT_FOUND`.
- **Scenario: error-envelope-has-no-internals** — every error envelope is exactly the router's
  formatted shape (`{ message, code, data: { code, httpStatus, path? } }`): no `stack`, no `cause`.
- **Scenario: internal-errors-are-masked** — a procedure throwing a plain `Error('secret /etc/x')`
  resolves `INTERNAL_SERVER_ERROR` with message `INTERNAL_SERVER_ERROR`.
- **Scenario: input-errors-are-masked** — (Phase 5 Task 6a review) a refused input resolves
  `BAD_REQUEST` with message `BAD_REQUEST`, never the validator's text, which can quote what was
  sent (an unrecognized key's name; `agent.setKey`'s input holds a key). Also
  `agent-set-key-answer-has-no-key` (`agent-router.test.ts`).
- **Scenario: uncloneable-output-is-internal-error** — a procedure whose output cannot be
  structured-cloned (a function, or an object holding one) resolves `INTERNAL_SERVER_ERROR` (with
  the request `id`) instead of a result Electron would fail to send back.
- **Scenario: handler-never-rejects** — for every input above, and when `fromWebContents`, the
  context or the router's error formatter throws, the handler resolves an envelope; it never throws
  synchronously or rejects. A throwing formatter yields the fixed last-resort
  `INTERNAL_SERVER_ERROR` envelope.

## Preload bridge — `createIpcBridge(ipcRenderer)` / `exposeIpcBridge()`
- **Scenario: bridge-exposes-only-invoke** — the bridge object has exactly `IPC_BRIDGE_METHODS`
  (`['invoke']`) and is frozen.
- **Scenario: bridge-uses-fixed-channel** — `invoke(envelope)` calls `ipcRenderer.invoke(IPC_CHANNEL,
  envelope)` with exactly those two arguments, and resolves the main handler's value only (no
  Electron event object).
- **Scenario: exposes-bridge-under-fixed-key** — `exposeIpcBridge()` calls
  `contextBridge.exposeInMainWorld(IPC_BRIDGE_KEY, bridge)` once.

## Renderer link — `ipcLink({ bridge })`
- **Scenario: client-round-trip** — a tRPC v11 client using `ipcLink` over a bridge wired to the main
  handler resolves `ping` to `'pong'`.
- **Scenario: maps-error-envelope-to-trpc-client-error** — a `FORBIDDEN` error envelope rejects the
  client call with a `TRPCClientError` whose `data.code` is `FORBIDDEN`.
- **Scenario: maps-bridge-failure-to-trpc-client-error** — a missing bridge, a rejecting `invoke`
  or a malformed response rejects with a `TRPCClientError` (never hangs).

## Main wiring — `createWindowRegistry()` (`apps/desktop/src/main/__tests__/app-windows.test.ts`)
The sender policy's `knownWindowIds` is a live set owned by the main process; the policy is built
once at startup with `createSenderPolicy({ knownWindowIds, devServerUrl })`, `devServerUrl` being
the same gated value given to `registerSecurity`.
- **Scenario: tracks-app-window-ids** — `track(win)` adds `win.id` to `knownWindowIds`; the id is
  removed when the window emits `'closed'` (using the id captured at `track` time, since a destroyed
  window's properties may throw). Windows that were never tracked are never known.
