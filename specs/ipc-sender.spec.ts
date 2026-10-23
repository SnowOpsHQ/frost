/**
 * IPC sender contract (design doc §2 "IPC" and §3 "Security model"; Phase 0 Task 3).
 *
 * Every tRPC procedure in `packages/ipc-contract` passes `enforceSender`, which accepts a call only
 * when it was sent by the **main frame** of a **known app window** whose frame origin is an accepted
 * origin; anything else fails with `IPC_SENDER_ERROR_CODE`. Implemented by
 * `packages/ipc-contract/src/{sender,trpc}.ts`; acceptance list: `ipc-sender.feature.md`.
 */
import { APP_ORIGIN } from './security-policy.spec';

/**
 * Origins a sender frame may have in every build. Compared **exactly** against Chromium's serialized
 * `WebFrameMain.origin` (lowercased scheme/host for the registered standard `app:` scheme, no
 * trailing slash, `"null"` for opaque origins). Never derived with Node's `new URL(x).origin`, which
 * returns `"null"` for the non-special `app:` scheme.
 */
export const IPC_ACCEPTED_ORIGINS = [APP_ORIGIN] as const;

/**
 * The Vite dev-server origin is accepted **only** when the sender policy is created with it
 * explicitly (Task 4: unpackaged `electron-forge start` with `MAIN_WINDOW_VITE_DEV_SERVER_URL`), and
 * only if that URL is plain `http:` on one of these loopback hosts (WHATWG `hostname` form). Any
 * other dev-server URL is a configuration error and throws at startup rather than trusting it.
 */
export const IPC_DEV_SERVER_PROTOCOL = 'http:';
export const IPC_DEV_SERVER_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

/** tRPC error code (and message) for every rejected sender; the reason is never sent to the caller. */
export const IPC_SENDER_ERROR_CODE = 'FORBIDDEN' as const;

/**
 * Why a sender was rejected (main-process diagnostics only), in the order they are checked.
 * - `no-context`: the procedure ran without a well-formed context (fail closed).
 * - `no-sender-frame`: `event.senderFrame` is `null` (the frame navigated or was destroyed).
 * - `sender-destroyed`: the frame, its `webContents` or its window is destroyed, or the frame is detached.
 * - `unknown-window`: no owning window, or a window the app did not register as an app window.
 * - `not-window-contents`: the sender `webContents` is not the window's own (e.g. an embedded view/tab).
 * - `not-main-frame`: a subframe, or a top frame that is not the window `webContents`' main frame.
 * - `origin-not-allowed`: the frame origin is not exactly an accepted origin.
 */
export const IPC_SENDER_REJECTIONS = [
  'no-context',
  'no-sender-frame',
  'sender-destroyed',
  'unknown-window',
  'not-window-contents',
  'not-main-frame',
  'origin-not-allowed',
] as const;
export type IpcSenderRejection = (typeof IPC_SENDER_REJECTIONS)[number];
