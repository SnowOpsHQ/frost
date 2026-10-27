// Spec: specs/seo-speed.spec.ts (SPEED_POLL_MS, SPEED_LIVE_MAX_POLLS)
// Acceptance: specs/seo-speed.feature.md (Live updates)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SpeedResponse } from '@app/seo-core';
import { SPEED_LIVE_MAX_POLLS, SPEED_POLL_MS } from '@app/specs/seo-speed.spec';
import { createSpeedPoller, IDLE_SPEED_STATE, type SpeedPollState } from '../speed-poller';

const A = 'https://example.com/a';
const B = 'https://example.com/b';

/** A measure call the test settles. */
interface Call {
  readonly tabId: number;
  resolve(response: SpeedResponse | null): void;
  reject(error: unknown): void;
}

let calls: Call[];
let states: SpeedPollState[];
const measure = (tabId: number) =>
  new Promise<SpeedResponse | null>((resolve, reject) => {
    calls.push({ tabId, resolve, reject });
  });
const pending = (url: string): SpeedResponse => ({ status: 'pending', url });
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  states = [];
});
afterEach(() => vi.useRealTimers());

const make = (maxPolls?: number) => createSpeedPoller({ measure, onChange: (s) => states.push(s), maxPolls });

describe('speed poller', () => {
  test('speed-poller-polls-one-at-a-time', async () => {
    const poller = make();
    poller.start(1, A);
    // At once, then never a second request before the first answered.
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SPEED_POLL_MS * 5);
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(pending(A));
    await flush();
    expect(poller.state()).toMatchObject({ session: { tabId: 1, url: A }, response: pending(A), polls: 1, paused: false });
    // The next one `SPEED_POLL_MS` after the answer.
    await vi.advanceTimersByTimeAsync(SPEED_POLL_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.tabId).toBe(1);
    // A failed call (null, or a rejection) keeps the last answer and polls on.
    calls[1]!.reject(new Error('ipc'));
    await flush();
    expect(poller.state()).toMatchObject({ response: pending(A), polls: 2 });
    await vi.advanceTimersByTimeAsync(SPEED_POLL_MS);
    expect(calls).toHaveLength(3);
    // Starting the same session again is a no-op.
    poller.start(1, A);
    expect(calls).toHaveLength(3);
    poller.stop();
  });

  test('speed-poller-stops-on-navigation-and-close', async () => {
    const poller = make();
    poller.start(1, A);
    // The tab navigates to B: A's session ends at once; its late answer is dropped.
    poller.start(1, B);
    expect(calls).toHaveLength(2);
    calls[0]!.resolve(pending(A));
    await flush();
    expect(poller.state()).toMatchObject({ session: { url: B }, response: null, polls: 0 });
    calls[1]!.resolve(pending(B));
    await flush();
    expect(poller.state()).toMatchObject({ session: { url: B }, response: pending(B), polls: 1 });
    // An answer for another URL (the tab moved on before the chrome heard) is not shown.
    await vi.advanceTimersByTimeAsync(SPEED_POLL_MS);
    calls[2]!.resolve(pending(`${B}/next`));
    await flush();
    expect(poller.state().response).toEqual(pending(B));
    // Another tab: a new session.
    await vi.advanceTimersByTimeAsync(SPEED_POLL_MS);
    poller.start(2, A);
    expect(calls.at(-1)!.tabId).toBe(2);
    // The panel closes: no more polls, late answers dropped, state idle.
    const before = calls.length;
    poller.stop();
    expect(poller.state()).toBe(IDLE_SPEED_STATE);
    calls.at(-1)!.resolve(pending(A));
    await vi.advanceTimersByTimeAsync(SPEED_POLL_MS * 10);
    expect(calls).toHaveLength(before);
    expect(poller.state()).toBe(IDLE_SPEED_STATE);
  });

  test('speed-poller-pauses-after-max-polls', async () => {
    const poller = make(3);
    poller.start(1, A);
    for (let i = 0; i < 3; i++) {
      calls.at(-1)!.resolve(pending(A));
      await vi.advanceTimersByTimeAsync(SPEED_POLL_MS);
    }
    expect(calls).toHaveLength(3);
    expect(poller.state()).toMatchObject({ polls: 3, paused: true });
    await vi.advanceTimersByTimeAsync(SPEED_POLL_MS * 10);
    expect(calls).toHaveLength(3);
    // Resume: another run of polls.
    poller.resume();
    expect(calls).toHaveLength(4);
    expect(poller.state()).toMatchObject({ polls: 0, paused: false });
    // Restart (Re-measure): the same session afresh.
    poller.restart();
    expect(calls).toHaveLength(5);
    expect(poller.state()).toMatchObject({ session: { tabId: 1, url: A }, response: null, polls: 0 });
    calls[3]!.resolve(pending(A));
    await flush();
    expect(poller.state().polls).toBe(0);
    poller.stop();
    expect(SPEED_LIVE_MAX_POLLS).toBe(120);
  });

  test('speed-poller-survives-a-throwing-measure', async () => {
    const poller = createSpeedPoller({
      measure: () => {
        throw new Error('no');
      },
      onChange: (s) => states.push(s),
    });
    poller.start(1, A);
    await flush();
    expect(poller.state()).toMatchObject({ polls: 1, response: null });
    poller.stop();
  });
});
