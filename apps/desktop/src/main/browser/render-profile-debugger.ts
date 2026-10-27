import { session as electronSession, type WebContents } from 'electron';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import {
  CDP_PROTOCOL_VERSION,
  CHILD_FRAME_TYPES,
  CHILD_RESUME_TIMEOUT_MS,
  CHILD_WORKER_TYPES,
  isAllowedCdpCommand,
  isAllowedCdpMethod,
  TARGET_AUTO_ATTACH_PARAMS,
} from '@app/specs/render-profile.spec';
import { childFrameCommands, workerCommands, type CdpCommand } from './render-profile-cdp';

// The one module that touches a tab's `webContents.debugger` (Global Constraints: debugger use is
// main-only and per tab; Semgrep `debugger-outside-allowlisted-modules` flags it anywhere else but the
// devtools drawer's recorder). It refuses any WebContents that is not on the browse partition, attaches
// to a tab's own WebContents (CDP in-process, no remote-debugging port), and sends only
// `RENDER_PROFILE_CDP_METHODS`, plus the two session methods under their rules (`isAllowedCdpCommand`):
// auto-attach, so every cross-site frame and dedicated worker of the tab is announced paused and gets
// the profile before it runs anything, and the resume of such a child. Anything else is refused here,
// before it reaches the debugger. Of the protocol's events it reads only `Target.attachedToTarget` /
// `Target.detachedFromTarget`. It detaches on request (which clears every override, children's
// included) or when the tab goes. Spec `render-profile.feature.md`.

/** The parts of a tab's WebContents this module uses. */
export type DebuggerHost = Pick<WebContents, 'debugger' | 'isDestroyed' | 'session'>;

export interface ProfileDebugger {
  /**
   * Puts a whole profile into effect: attaches if needed and dispatches every command of `commands`
   * at once, in order (CDP handles a session's commands in order), to the tab, then (first time after
   * an attach) turns on auto-attach for its children; every live child gets its share
   * (`childFrameCommands` / `workerCommands`), and so does every child announced later. Dispatching
   * is synchronous: when `send` returns, the browser-side overrides (user agent, network conditions,
   * cache) are in place, so a load started right after already carries them; renderer-side ones
   * (viewport, touch, the JavaScript switch) are answered once the tab has a renderer, which a fresh
   * tab gets only from its first load. Throws (sending nothing) if any method is not on the profile
   * allowlist, or the attach fails or the tab is gone; the promise answers once every command to the
   * tab has, and rejects if one fails (a child's failure never fails it).
   */
  send(commands: readonly CdpCommand[]): Promise<void>;
  /** Dispatches `commands` to the tab alone (a refit of the viewport); same checks as `send`. */
  sendTopLevel(commands: readonly CdpCommand[]): Promise<void>;
  /** Detaches (Chromium then drops every override this session set); a no-op when not attached. */
  detach(): void;
  isAttached(): boolean;
  /** Stops listening (the tab's view is gone); detaches first if still attached. */
  dispose(): void;
}

export class CdpMethodRefused extends Error {
  constructor(method: unknown) {
    super(`CDP method not allowlisted: ${String(method)}`);
    this.name = 'CdpMethodRefused';
  }
}

/** Whether `contents` is a tab's: on the browse partition's session (fails closed). */
function isBrowseContents(contents: DebuggerHost): boolean {
  try {
    const browse = electronSession.fromPartition(BROWSE_PARTITION);
    return contents.session != null && contents.session === browse;
  } catch {
    return false;
  }
}

interface Child {
  readonly kind: 'frame' | 'worker' | 'other';
}

function kindOf(type: unknown): Child['kind'] {
  if ((CHILD_FRAME_TYPES as readonly unknown[]).includes(type)) return 'frame';
  if ((CHILD_WORKER_TYPES as readonly unknown[]).includes(type)) return 'worker';
  return 'other';
}

/**
 * A render-profile debugger for `contents` (a tab's WebContents; any other is refused, throwing).
 * `detached(reason)` is called when the debugger detaches without frost asking (Chromium closed the
 * session); never for `detach()`.
 */
export function createProfileDebugger(contents: DebuggerHost, detached: (reason: string) => void): ProfileDebugger {
  if (!isBrowseContents(contents)) throw new Error('render profiles apply to browse-session tabs only');
  let disposed = false;
  /** Set while frost detaches, so its own detach is not reported as unexpected. */
  let detaching = false;
  /** Auto-attach is on for this attach. */
  let autoAttached = false;
  /** The tab's announced children, by session id. */
  const children = new Map<string, Child>();
  /** The profile's share for a frame and for a worker (the last whole profile sent). */
  let frameShare: CdpCommand[] = [];
  let workerShare: CdpCommand[] = [];

  const target = (): DebuggerHost['debugger'] | null => (disposed || contents.isDestroyed() ? null : contents.debugger);

  const forgetSession = (): void => {
    autoAttached = false;
    children.clear();
  };

  /** Sends one command to a child session (checked against the session rules); never throws. */
  const toChild = (sessionId: string, method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
    try {
      const dbg = target();
      if (!dbg || !children.has(sessionId) || !isAllowedCdpCommand(method, params, 'child')) return Promise.resolve(undefined);
      return dbg.sendCommand(method, { ...params }, sessionId).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  };

  const shareFor = (child: Child): CdpCommand[] => (child.kind === 'frame' ? frameShare : child.kind === 'worker' ? workerShare : []);

  /**
   * A child announced itself: it gets its share of the profile (a frame also auto-attach, for the
   * frames nested in it), and if it is paused it is resumed once those commands have answered, or
   * after `CHILD_RESUME_TIMEOUT_MS` at the latest. Never earlier: resuming a child before its commands
   * answered can leave it paused for good.
   */
  const announced = (params: Record<string, unknown>): void => {
    const sessionId = params['sessionId'];
    const info = params['targetInfo'] as { type?: unknown } | undefined;
    if (typeof sessionId !== 'string' || sessionId === '' || !autoAttached) return;
    const child: Child = { kind: kindOf(info?.type) };
    children.set(sessionId, child);
    const answers = shareFor(child).map((command) => toChild(sessionId, command.method, command.params));
    if (child.kind === 'frame') answers.push(toChild(sessionId, 'Target.setAutoAttach', TARGET_AUTO_ATTACH_PARAMS));
    if (params['waitingForDebugger'] !== true) return;
    let resumed = false;
    const resume = (): void => {
      if (resumed) return;
      resumed = true;
      clearTimeout(deadline);
      void toChild(sessionId, 'Runtime.runIfWaitingForDebugger', {});
    };
    const deadline = setTimeout(resume, CHILD_RESUME_TIMEOUT_MS);
    void Promise.all(answers).then(resume);
  };

  const onMessage = (_event: unknown, method: string, params: Record<string, unknown>): void => {
    if (disposed || typeof params !== 'object' || params === null) return;
    if (method === 'Target.attachedToTarget') announced(params);
    else if (method === 'Target.detachedFromTarget' && typeof params['sessionId'] === 'string') children.delete(params['sessionId']);
  };
  const onDetach = (_event: unknown, reason: string): void => {
    forgetSession();
    if (!detaching && !disposed) detached(String(reason));
  };
  target()?.on('detach', onDetach);
  target()?.on('message', onMessage);

  const attached = (): boolean => {
    try {
      return target()?.isAttached() === true;
    } catch {
      return false;
    }
  };

  const detach = (): void => {
    const dbg = target();
    forgetSession();
    if (!dbg) return;
    detaching = true;
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      // Already detached, or the WebContents is going.
    } finally {
      detaching = false;
    }
  };

  /** Checks `commands` and dispatches them to the tab; answers when they all have. */
  const dispatch = (commands: readonly CdpCommand[], extra: readonly { readonly method: string; readonly params: Readonly<Record<string, unknown>> }[] = []): Promise<void> => {
    for (const command of commands) if (!isAllowedCdpMethod(command.method)) throw new CdpMethodRefused(command.method);
    const dbg = target();
    if (!dbg) throw new Error('tab is gone');
    if (!dbg.isAttached()) {
      forgetSession();
      dbg.attach(CDP_PROTOCOL_VERSION);
    }
    const answers = commands.map((command) => dbg.sendCommand(command.method, { ...command.params }));
    for (const command of extra) {
      if (!isAllowedCdpCommand(command.method, command.params, 'top')) throw new CdpMethodRefused(command.method);
      answers.push(dbg.sendCommand(command.method, { ...command.params }));
    }
    return Promise.all(answers).then(() => undefined);
  };

  return {
    send(commands) {
      for (const command of commands) if (!isAllowedCdpMethod(command.method)) throw new CdpMethodRefused(command.method);
      frameShare = childFrameCommands(commands);
      workerShare = workerCommands(commands);
      const turnOn = !autoAttached || !attached();
      const answered = dispatch(commands, turnOn ? [{ method: 'Target.setAutoAttach', params: TARGET_AUTO_ATTACH_PARAMS }] : []);
      autoAttached = true;
      // Every live child gets the new profile (they run already: nothing to resume).
      for (const [sessionId, child] of children) for (const command of shareFor(child)) void toChild(sessionId, command.method, command.params);
      return answered;
    },
    sendTopLevel: (commands) => dispatch(commands),
    detach,
    isAttached: attached,
    dispose() {
      if (disposed) return;
      detach();
      try {
        target()?.off('detach', onDetach);
        target()?.off('message', onMessage);
      } catch {
        // The WebContents is gone.
      }
      disposed = true;
    },
  };
}
