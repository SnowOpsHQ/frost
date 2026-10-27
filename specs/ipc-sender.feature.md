# Feature: IPC sender validation (`enforceSender`)

Spec: `specs/ipc-sender.spec.ts`. Design doc §2 (IPC) and §3 (Security model). Background:
the private reference analysis (handlers with no or partial sender checks).
Tests: `packages/ipc-contract/src/__tests__/sender.test.ts` (behaviour) and
`packages/ipc-contract/src/__tests__/electron-types.test.ts` (type-level). Each line maps to one
named test.

## Rule
A procedure call is accepted only when the sender frame is the **main frame** of a **known app
window** on an **accepted origin**; otherwise it throws a tRPC `FORBIDDEN` error
(`IPC_SENDER_ERROR_CODE`) whose message carries no reason.

- **Main frame:** `senderFrame.parent === null` **and** `senderFrame.frameTreeNodeId` equals the
  sender `webContents.mainFrame.frameTreeNodeId` (`WebFrameMain` objects are compared by their
  browser-global frame id, not object identity).
- **Known app window:** `BrowserWindow.fromWebContents(event.sender)` is non-null, its `id` is in
  the app's registered window set, and the sender `webContents` **is** that window's own
  `webContents` (an embedded view — e.g. a future browsing tab — hosted in an app window is not).
- **Live:** neither the frame, the sender `webContents` nor the window is destroyed, and the frame
  is not detached; a `null` `senderFrame` is rejected.
- **Accepted origin:** Chromium's serialized `senderFrame.origin`, compared exactly against
  `IPC_ACCEPTED_ORIGINS` (`app://app`), plus the dev-server origin when explicitly allowed.
- **Fail closed:** a missing or malformed context (no context, `{}`, no sender policy) is rejected.

## Scenarios (sender.test.ts)
- **Scenario: ping returns pong for a valid app-window sender** — main frame of a known app window
  on `app://app` → `ping` resolves `'pong'`.
- **Scenario: rejects-foreign-sender** (Review Focus) — main frame of a known app window on
  `https://evil.com` → `FORBIDDEN`; the error code and message are exactly `FORBIDDEN`.
- **Scenario: rejects-subframe-on-app-origin** — a subframe (`parent !== null`) on `app://app` in a
  known app window → `FORBIDDEN`, even if its `frameTreeNodeId` equals the main frame's (both halves
  of the main-frame check are required).
- **Scenario: rejects-top-frame-that-is-not-the-main-frame** — a frame with `parent === null` whose
  id differs from the sender `webContents.mainFrame` → `FORBIDDEN`.
- **Scenario: rejects-embedded-view-sender** — the main frame of a `webContents` that is hosted in a
  known app window but is not the window's own `webContents` → `FORBIDDEN`.
- **Scenario: rejects-unknown-window** — no owning window (`window === null`), or a window whose id
  is not registered → `FORBIDDEN`.
- **Scenario: rejects-destroyed-sender** — destroyed window, destroyed sender `webContents`,
  destroyed frame, or detached frame → `FORBIDDEN`; property access that throws on a destroyed
  Electron object is also treated as rejection.
- **Scenario: rejects-missing-sender-frame** — `senderFrame === null` → `FORBIDDEN`.
- **Scenario: rejects-origin-lookalikes** — exact match only: `app://app.evil`, `app://evil`,
  `app://app/`, `app://app:1`, `app://APP`, `APP://APP` (Chromium reports `app://app` for a real app
  frame, so rejecting other casings costs nothing), `app://`, `null`, `''`, `file://`,
  `https://app`, `http://localhost:5173` (dev origin not allowed) → `FORBIDDEN`.
- **Scenario: accepts-dev-server-origin-only-when-allowed** — `http://localhost:5173` is accepted
  only when the sender policy was created with `devServerUrl` on that origin; even then another
  port or host is rejected and `app://app` remains accepted.
- **Scenario: rejects-non-loopback-dev-server-url** — creating a sender policy with a dev-server URL
  that is not `http:` on `IPC_DEV_SERVER_HOSTS` (`https://evil.com`, `http://evil.com:5173`,
  `https://localhost:5173`, `http://user:pass@localhost:5173` (credentials), `file:///tmp/x`,
  `app://app`, `not a url`, `''`) throws.
- **Scenario: fails-closed-without-context** — `ctx` of `undefined`, `null`, `{}`, a sender without
  a policy, or a policy without a sender → `FORBIDDEN`.
- **Scenario: error-shape-hides-internals** — the tRPC error shape sent back for a rejected call
  (`getTRPCErrorShape` with the router's config) is exactly `{ message: 'FORBIDDEN', code, data:
  { code: 'FORBIDDEN', httpStatus: 403, path } }`: no `data.stack` or other main-process detail, in
  any `NODE_ENV` (Electron main never sets `production`).
- **Scenario: every-procedure-enforces-sender** — structural: the router has at least one
  procedure; for every procedure in `appRouter` the **first** middleware is `enforceSender` (so an
  `.input()` placed before the guard fails), and a foreign sender is rejected with `FORBIDDEN`
  before input parsing.

## Scenarios (electron-types.test.ts)
- **Scenario: context-derivable-from-electron-ipc-event** — type-level: Electron 45's
  `IpcMainEvent`/`IpcMainInvokeEvent` (`sender`, `senderFrame`) and `BrowserWindow` satisfy
  `CreateContextOptions`, so Task 4 passes the real objects with no adapter logic.
