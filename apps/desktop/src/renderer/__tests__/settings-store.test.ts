// Spec: specs/account-settings.spec.ts (SETTINGS_RETRY, settingsRetryDelay)
// Acceptance: specs/account-settings.feature.md (Shared watches)
import { describe, expect, test, vi } from 'vitest';
import { SETTINGS_RETRY, settingsRetryDelay } from '@app/specs/account-settings.spec';
import { createWatchStore } from '../settings-store';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A poll whose answers the test hands out one at a time. */
function controlledPoll() {
  const pending: { since: number; resolve: (v: { version: number }) => void; reject: (e: Error) => void }[] = [];
  const poll = vi.fn((since: number) => new Promise<{ version: number }>((resolve, reject) => pending.push({ since, resolve, reject })));
  return { poll, pending };
}

describe('shared watch store', () => {
  test('watch-store-shares-one-poll', async () => {
    const { poll, pending } = controlledPoll();
    const store = createWatchStore(poll, (v) => v.version, { sleep: async () => {} });
    const a = vi.fn();
    const b = vi.fn();
    const offA = store.subscribe(a);
    const offB = store.subscribe(b);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenLastCalledWith(-1);
    pending.shift()!.resolve({ version: 3 });
    await flush();
    expect(store.current()).toEqual({ version: 3 });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    // The next poll waits on the version it has; still one.
    expect(poll).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenLastCalledWith(3);
    offA();
    offB();
    // Nothing listens: after the wait in flight answers, no further poll.
    pending.shift()!.resolve({ version: 4 });
    await flush();
    expect(poll).toHaveBeenCalledTimes(2);
    // Subscribing again starts over at once (the state may have moved on meanwhile).
    const offC = store.subscribe(vi.fn());
    expect(poll).toHaveBeenCalledTimes(3);
    expect(poll).toHaveBeenLastCalledWith(-1);
    offC();
  });

  test('watch-store-backs-off', async () => {
    expect([1, 2, 3, 4].map(settingsRetryDelay)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(settingsRetryDelay(50)).toBe(SETTINGS_RETRY.maxMs);
    const { poll, pending } = controlledPoll();
    const sleeps: number[] = [];
    const store = createWatchStore(poll, (v) => v.version, { sleep: async (ms) => void sleeps.push(ms) });
    const off = store.subscribe(vi.fn());
    for (let i = 0; i < 3; i++) {
      pending.shift()!.reject(new Error('ipc down'));
      await flush();
    }
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(store.failures()).toBe(3);
    pending.shift()!.resolve({ version: 1 });
    await flush();
    expect(store.failures()).toBe(0);
    pending.shift()!.reject(new Error('again'));
    await flush();
    expect(sleeps.at(-1)).toBe(1_000);
    off();
  });
});
