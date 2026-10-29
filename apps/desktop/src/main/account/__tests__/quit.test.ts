// Spec: specs/account-state.schema.ts (QUIT_REVOKE_TIMEOUT_MS)
// Acceptance: specs/account-signin.feature.md (Quitting)
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { QUIT_REVOKE_TIMEOUT_MS } from '@app/specs/account-state.schema';
import { holdQuitFor, type QuitApp } from '../quit';

/** An app whose `quit()` emits `will-quit` and quits for real only if no listener prevented it (once). */
function fakeApp() {
  const emitter = new EventEmitter();
  let quits = 0;
  const attempt = (): void => {
    if (quits > 0) return;
    let prevented = false;
    emitter.emit('will-quit', { preventDefault: () => (prevented = true) });
    if (!prevented) quits++;
  };
  const app = Object.assign(emitter, { quit: vi.fn(attempt) }) as unknown as QuitApp & { quit: ReturnType<typeof vi.fn> };
  return { app, attempt, quits: () => quits };
}

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('quit hold for revocations', () => {
  test('quit-held-only-for-revocations', async () => {
    // Nothing to revoke: the first will-quit passes, nothing is re-quit.
    const idle = fakeApp();
    const none = vi.fn(() => null);
    holdQuitFor(idle.app, none);
    idle.attempt();
    expect(idle.quits()).toBe(1);
    expect(none).toHaveBeenCalledOnce();
    expect(idle.app.quit).not.toHaveBeenCalled();

    // A revocation running: held until it settles, then one quit.
    const held = fakeApp();
    let release!: () => void;
    const revoking = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    holdQuitFor(held.app, revoking, 1_000);
    held.attempt();
    held.attempt();
    expect(held.quits()).toBe(0);
    expect(revoking).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(held.quits()).toBe(1));
    expect(held.app.quit).toHaveBeenCalledOnce();

    // One that never settles: the cap ends the hold.
    const stuck = fakeApp();
    holdQuitFor(stuck.app, () => new Promise<void>(() => undefined), 50);
    stuck.attempt();
    expect(stuck.quits()).toBe(0);
    await later(80);
    await vi.waitFor(() => expect(stuck.quits()).toBe(1));
    expect(QUIT_REVOKE_TIMEOUT_MS).toBeLessThanOrEqual(2_000);

    // Beside another holder of the same quit (telemetry's flush, held the same way): whichever ends
    // first re-quits once and is passed by the other's hold; the app quits once, after both.
    for (const [accountMs, otherMs] of [
      [20, 60],
      [60, 20],
    ]) {
      const both = fakeApp();
      holdQuitFor(both.app, () => later(accountMs!), 1_000);
      holdQuitFor(both.app, () => later(otherMs!), 1_000);
      both.attempt();
      expect(both.quits()).toBe(0);
      await later(Math.min(accountMs!, otherMs!) + 15);
      expect(both.quits()).toBe(0);
      await vi.waitFor(() => expect(both.quits()).toBe(1));
      expect(both.app.quit).toHaveBeenCalledTimes(2);
    }
  });
});
