import { QUIT_REVOKE_TIMEOUT_MS } from '@app/specs/account-state.schema';

// Holding the quit for the account's revocations (acceptance `account-signin.feature.md`, Quitting):
// a token exchanged but never confirmed (or a sign-out still revoking) is revoked before frost exits,
// waiting at most `QUIT_REVOKE_TIMEOUT_MS`. Held the way telemetry holds it for its flush
// (`../telemetry/install.ts`): only when there is something to wait for; while held, every `will-quit`
// is prevented; once done, one `app.quit()` from a task of its own, and every later `will-quit`
// passes. Two such holders never fight: each re-quits once and the app quits after the last.

export interface QuitApp {
  on(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/** On the first `will-quit`, calls `work` (once); holds the quit while what it answers runs (capped). */
export function holdQuitFor(app: QuitApp, work: () => Promise<unknown> | null, timeoutMs: number = QUIT_REVOKE_TIMEOUT_MS): void {
  let phase: 'running' | 'holding' | 'done' = 'running';
  app.on('will-quit', (event) => {
    if (phase === 'done') return;
    if (phase === 'holding') {
      event.preventDefault();
      return;
    }
    let pending: Promise<unknown> | null;
    try {
      pending = work();
    } catch {
      pending = null;
    }
    if (pending === null) {
      phase = 'done';
      return;
    }
    event.preventDefault();
    phase = 'holding';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    void Promise.race([pending.then(undefined, () => undefined), cap]).then(() => {
      clearTimeout(timer);
      phase = 'done';
      // From a task of its own: a quit from a microtask still runs inside the `will-quit` dispatch.
      setImmediate(() => app.quit());
    });
  });
}
