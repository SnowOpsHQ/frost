import type { WebContents } from 'electron';
import { CDP_PROTOCOL_VERSION, isAllowedCdpMethod } from '@app/specs/render-profile.spec';
import type { CdpCommand } from './render-profile-cdp';

// The one module that touches a tab's `webContents.debugger` (Global Constraints: debugger use is
// main-only and per tab; Semgrep `debugger-outside-allowlisted-modules` flags it anywhere else but the
// devtools drawer's recorder). It attaches to a browse-session tab's own WebContents (CDP in-process,
// no remote-debugging port), sends only `RENDER_PROFILE_CDP_METHODS` (anything else is refused here,
// before it reaches the debugger), never listens to the protocol's events, and detaches on request
// (which clears every override) or when the tab goes. Spec `render-profile.feature.md`.

/** The parts of a tab's WebContents this module uses. */
export type DebuggerHost = Pick<WebContents, 'debugger' | 'isDestroyed'>;

export interface ProfileDebugger {
  /**
   * Attaches if needed and dispatches every command of `commands` at once, in order (CDP handles a
   * session's commands in order). Dispatching is synchronous: when `send` returns, the browser-side
   * overrides (user agent, network conditions, cache) are in place, so a load started right after
   * already carries them; renderer-side ones (viewport, touch, the JavaScript switch) are answered
   * once the tab has a renderer, which a fresh tab gets only from its first load. Throws (sending
   * nothing) if any method is not on the allowlist, or the attach fails or the tab is gone; the
   * promise answers once every command has, and rejects if one fails.
   */
  send(commands: readonly CdpCommand[]): Promise<void>;
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

/**
 * A render-profile debugger for `contents` (a tab's WebContents). `detached(reason)` is called when
 * the debugger detaches without frost asking (Chromium closed the session); never for `detach()`.
 */
export function createProfileDebugger(contents: DebuggerHost, detached: (reason: string) => void): ProfileDebugger {
  let disposed = false;
  /** Set while frost detaches, so its own detach is not reported as unexpected. */
  let detaching = false;
  const onDetach = (_event: unknown, reason: string): void => {
    if (!detaching && !disposed) detached(String(reason));
  };
  const target = (): DebuggerHost['debugger'] | null => (disposed || contents.isDestroyed() ? null : contents.debugger);
  target()?.on('detach', onDetach);

  const attached = (): boolean => {
    try {
      return target()?.isAttached() === true;
    } catch {
      return false;
    }
  };

  const detach = (): void => {
    const dbg = target();
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

  return {
    send(commands) {
      for (const command of commands) if (!isAllowedCdpMethod(command.method)) throw new CdpMethodRefused(command.method);
      const dbg = target();
      if (!dbg) throw new Error('tab is gone');
      if (!dbg.isAttached()) dbg.attach(CDP_PROTOCOL_VERSION);
      const answers = commands.map((command) => dbg.sendCommand(command.method, { ...command.params }));
      return Promise.all(answers).then(() => undefined);
    },
    detach,
    isAttached: attached,
    dispose() {
      if (disposed) return;
      detach();
      try {
        target()?.off('detach', onDetach);
      } catch {
        // The WebContents is gone.
      }
      disposed = true;
    },
  };
}
