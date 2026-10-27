import type { SpeedResponse } from '@app/seo-core';
import { SPEED_LIVE_MAX_POLLS, SPEED_POLL_MS } from '@app/specs/seo-speed.spec';

// The Speed panel's live updates (spec `seo-speed.spec.ts`, `SPEED_POLL_MS`, `SPEED_LIVE_MAX_POLLS`;
// acceptance `seo-speed.feature.md`, Live updates). Pure (timers and the IPC call are injected):
// while the panel is open the chrome asks main for the active tab's measurement, waits for the
// answer, then asks again `intervalMs` later; never two requests at once. A session is one tab and
// one URL: `start` with another one ends the old session (its late answers are dropped) and starts
// afresh; `stop` ends it (the panel closed). After `maxPolls` polls it pauses until `resume`.

export interface SpeedSession {
  readonly tabId: number;
  readonly url: string;
}

export interface SpeedPollState {
  readonly session: SpeedSession | null;
  /** The latest answer for this session (`null` before the first). */
  readonly response: SpeedResponse | null;
  readonly polls: number;
  /** `maxPolls` reached: no more polls until `resume`. */
  readonly paused: boolean;
}

export interface SpeedPollerOptions {
  /** `seo.measureSpeed`; resolves `null` when the call failed (asked again on the next poll). */
  readonly measure: (tabId: number) => Promise<SpeedResponse | null>;
  readonly onChange: (state: SpeedPollState) => void;
  readonly intervalMs?: number;
  readonly maxPolls?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface SpeedPoller {
  /** Polls `tabId` at `url` (a no-op if that is the session already running or paused). */
  start(tabId: number, url: string): void;
  /** Ends the session: no more polls, late answers dropped. */
  stop(): void;
  /** Starts another run of `maxPolls` polls of a paused session. */
  resume(): void;
  /** Ends the session and starts it afresh (Re-measure), even if it is the same tab and URL. */
  restart(): void;
  state(): SpeedPollState;
}

export const IDLE_SPEED_STATE: SpeedPollState = { session: null, response: null, polls: 0, paused: false };

export function createSpeedPoller(options: SpeedPollerOptions): SpeedPoller {
  const intervalMs = options.intervalMs ?? SPEED_POLL_MS;
  const maxPolls = options.maxPolls ?? SPEED_LIVE_MAX_POLLS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let state: SpeedPollState = IDLE_SPEED_STATE;
  /** The running session's token: a tick or answer of another token is dropped. */
  let token: object | null = null;
  let timer: unknown = null;

  const set = (next: SpeedPollState): void => {
    state = next;
    options.onChange(state);
  };

  const clear = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const tick = (own: object): void => {
    timer = null;
    if (token !== own || !state.session) return;
    const session = state.session;
    let answer: Promise<SpeedResponse | null>;
    try {
      answer = options.measure(session.tabId);
    } catch {
      answer = Promise.resolve(null);
    }
    void answer
      .catch(() => null)
      .then((response) => {
        if (token !== own) return;
        const polls = state.polls + 1;
        // An answer for another URL (the tab moved on before the chrome heard of it) is not this session's.
        const shown = response !== null && response.url === session.url ? response : state.response;
        const paused = polls >= maxPolls;
        set({ session, response: shown, polls, paused });
        if (!paused) timer = setTimer(() => tick(own), intervalMs);
      });
  };

  const begin = (session: SpeedSession): void => {
    clear();
    const own = {};
    token = own;
    set({ session, response: null, polls: 0, paused: false });
    tick(own);
  };

  return {
    start(tabId, url) {
      if (state.session && token !== null && state.session.tabId === tabId && state.session.url === url) return;
      begin({ tabId, url });
    },
    stop() {
      clear();
      token = null;
      if (state !== IDLE_SPEED_STATE) set(IDLE_SPEED_STATE);
    },
    resume() {
      if (!state.paused || !state.session || token === null) return;
      const own = {};
      token = own;
      set({ ...state, polls: 0, paused: false });
      tick(own);
    },
    restart() {
      if (state.session) begin(state.session);
    },
    state: () => state,
  };
}
