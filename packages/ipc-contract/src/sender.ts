import {
  IPC_ACCEPTED_ORIGINS,
  IPC_DEV_SERVER_HOSTS,
  IPC_DEV_SERVER_PROTOCOL,
  type IpcSenderRejection,
} from '@app/specs/ipc-sender.spec';
import type { IpcServices } from './services';

// Pure sender policy for `specs/ipc-sender.spec.ts`. No runtime `electron` import: the shapes below
// are structural subsets of Electron 45's `WebContents`, `WebFrameMain` and `BrowserWindow`, so the
// real IPC event objects are passed straight in (see `__tests__/electron-types.test.ts`).

/** The parts of `WebFrameMain` (`event.senderFrame`) the check reads. */
export interface SenderFrameLike {
  readonly origin: string;
  readonly frameTreeNodeId: number;
  readonly parent: object | null;
  readonly detached: boolean;
  isDestroyed(): boolean;
}

/** The parts of `WebContents` (`event.sender`, `BrowserWindow.webContents`) the check reads. */
export interface WebContentsLike {
  readonly id: number;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  isDestroyed(): boolean;
}

/** The parts of `BrowserWindow` (`BrowserWindow.fromWebContents(event.sender)`) the check reads. */
export interface WindowLike {
  readonly id: number;
  readonly webContents: WebContentsLike;
  isDestroyed(): boolean;
}

/** Which senders are trusted; built once at startup by `createSenderPolicy`. */
export interface SenderPolicy {
  /** Exact `WebFrameMain.origin` strings accepted (spec `IPC_ACCEPTED_ORIGINS` + optional dev origin). */
  readonly allowedOrigins: readonly string[];
  /** Ids of the app's own windows; may be a live set the main process updates as windows open/close. */
  readonly knownWindowIds: ReadonlySet<number>;
}

/** Facts about the sender, captured when the IPC message is received. */
export interface SenderFacts {
  /** Chromium's serialized frame origin, e.g. `app://app` (`"null"` for opaque origins). */
  readonly origin: string;
  /** Frame, sender `webContents` and window (if any) are not destroyed, and the frame is attached. */
  readonly live: boolean;
  /** Id of the owning `BrowserWindow`, or `null` when the sender has none. */
  readonly windowId: number | null;
  /** The sender `webContents` is the window's own, not a view embedded in it. */
  readonly isWindowContents: boolean;
  /** Top frame (`parent === null`) and the sender `webContents`' main frame (same `frameTreeNodeId`). */
  readonly isMainFrame: boolean;
}

/** The tRPC context for every IPC procedure. */
export interface IpcContext {
  /** `null` when the message carried no live sender frame (`event.senderFrame === null`). */
  readonly sender: SenderFacts | null;
  readonly policy: SenderPolicy;
  /**
   * Main-process services (`IpcHandlerOptions.services`). Passed through untouched; procedures
   * reach them only after `enforceSender` has accepted the sender.
   */
  readonly services?: IpcServices;
}

/** Inputs to `createContext`; Task 4 passes the real Electron objects unchanged. */
export interface CreateContextOptions {
  /** `event.sender`. */
  readonly sender: WebContentsLike;
  /** `event.senderFrame`. */
  readonly senderFrame: SenderFrameLike | null;
  /** `BrowserWindow.fromWebContents(event.sender)`. */
  readonly window: WindowLike | null;
  readonly policy: SenderPolicy;
  readonly services?: IpcServices;
}

const DESTROYED: SenderFacts = { origin: '', live: false, windowId: null, isWindowContents: false, isMainFrame: false };

/**
 * Builds the sender policy. `devServerUrl` (Task 4 passes `MAIN_WINDOW_VITE_DEV_SERVER_URL` only when
 * unpackaged) adds its origin to the accepted list; it must be `IPC_DEV_SERVER_PROTOCOL` on one of
 * `IPC_DEV_SERVER_HOSTS` without credentials, otherwise this throws instead of trusting it.
 */
export function createSenderPolicy(opts: {
  knownWindowIds: ReadonlySet<number>;
  devServerUrl?: string | undefined;
}): SenderPolicy {
  const allowedOrigins: string[] = [...IPC_ACCEPTED_ORIGINS];
  if (opts.devServerUrl !== undefined) allowedOrigins.push(devServerOrigin(opts.devServerUrl));
  return { allowedOrigins: Object.freeze(allowedOrigins), knownWindowIds: opts.knownWindowIds };
}

function devServerOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`IPC dev-server URL is not a URL: ${JSON.stringify(url)}`);
  }
  const hosts: readonly string[] = IPC_DEV_SERVER_HOSTS;
  if (
    parsed.protocol !== IPC_DEV_SERVER_PROTOCOL ||
    !hosts.includes(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(`IPC dev-server URL must be ${IPC_DEV_SERVER_PROTOCOL}//<loopback>: ${JSON.stringify(url)}`);
  }
  // `http:` is a WHATWG special scheme, so `origin` serializes exactly as Chromium reports it.
  return parsed.origin;
}

/**
 * Captures the sender facts for one IPC message. Destroyed Electron objects throw on property
 * access, so any throw is recorded as a dead sender (fail closed) rather than propagated.
 */
export function createContext(opts: CreateContextOptions): IpcContext {
  const { sender, senderFrame: frame, window, policy } = opts;
  const services = opts.services === undefined ? {} : { services: opts.services };
  if (frame === null) return { sender: null, policy, ...services };
  try {
    if (frame.isDestroyed() || frame.detached || sender.isDestroyed() || (window !== null && window.isDestroyed())) {
      return { sender: DESTROYED, policy, ...services };
    }
    return {
      sender: {
        origin: frame.origin,
        live: true,
        windowId: window === null ? null : window.id,
        isWindowContents: window !== null && window.webContents.id === sender.id,
        isMainFrame: frame.parent === null && frame.frameTreeNodeId === sender.mainFrame.frameTreeNodeId,
      },
      policy,
      ...services,
    };
  } catch {
    return { sender: DESTROYED, policy, ...services };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPolicy(value: unknown): value is SenderPolicy {
  return isRecord(value) && Array.isArray(value['allowedOrigins']) && value['knownWindowIds'] instanceof Set;
}

/**
 * Why `ctx` must be rejected (spec `IPC_SENDER_REJECTIONS`, checked in that order), or `null` when
 * the sender is the main frame of a known app window on an accepted origin. Takes `unknown` and
 * compares strictly so that a missing or malformed context fails closed.
 */
export function senderRejection(ctx: unknown): IpcSenderRejection | null {
  if (!isRecord(ctx) || !isPolicy(ctx['policy'])) return 'no-context';
  const policy = ctx['policy'];
  const sender = ctx['sender'];
  if (!isRecord(sender)) return 'no-sender-frame';
  if (sender['live'] !== true) return 'sender-destroyed';
  const windowId = sender['windowId'];
  if (typeof windowId !== 'number' || !policy.knownWindowIds.has(windowId)) return 'unknown-window';
  if (sender['isWindowContents'] !== true) return 'not-window-contents';
  if (sender['isMainFrame'] !== true) return 'not-main-frame';
  const origin = sender['origin'];
  if (typeof origin !== 'string' || !policy.allowedOrigins.includes(origin)) return 'origin-not-allowed';
  return null;
}
