import { useEffect, useRef, useState } from 'react';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { GscPerformanceAnswer, GscQueriesAnswer } from '@app/specs/gsc.schema';
import { GSC_READ_DEBOUNCE_MS } from '@app/specs/gsc-panel.spec';
import { requestKey, shownAnswers, withoutFragment, type GscAnswers, type GscHeld, type GscRequest } from '../gsc-view';
import { ipc } from '../ipc';

// The Search Console panel's reads (Phase 4 Task 10; acceptance `gsc-panel.feature.md`, Reading):
// `gsc.performance` and `gsc.topQueries` together, once per request (URL without fragment, scope,
// range, connection), `GSC_READ_DEBOUNCE_MS` after it last changed, and at once on Retry. Never on a
// timer. An answer for an earlier request (the URL changed meanwhile) is dropped; while another scope
// or range of the same page reads, the last data stays (`pending`). A failed call reads as `invalid`
// (the panel offers Retry).

const FAILED = { status: 'unavailable', reason: 'invalid' } as const;

export interface GscData {
  /** The current request's answers, or (`pending`) the last data of the same page while it reads; `null`: none. */
  readonly answers: GscAnswers | null;
  /** `answers` are an earlier scope's or range's, shown while the current read runs. */
  readonly pending: boolean;
  /** A request is waiting for its answers. */
  readonly loading: boolean;
  /** Reads the current request again, at once. */
  readonly retry: () => void;
}

export function useGscData(request: GscRequest | null): GscData {
  const key = request === null ? null : requestKey(request);
  const [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<GscHeld | null>(null);
  // The attempt last read: a new attempt (Retry) reads at once, a new key after the debounce.
  const readAttempt = useRef(attempt);
  useEffect(() => {
    if (request === null || key === null) return;
    let live = true;
    const query = { url: withoutFragment(request.url), scope: request.scope, days: request.days };
    const read = () => {
      readAttempt.current = attempt;
      void Promise.all([
        ipc.gsc.performance.query(query).catch((): GscPerformanceAnswer => FAILED),
        ipc.gsc.topQueries.query(query).catch((): GscQueriesAnswer => FAILED),
      ]).then(([performance, queries]) => {
        if (live) setHeld({ request, attempt, answers: { performance, queries } });
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (attempt !== readAttempt.current) read();
    else timer = setTimeout(read, GSC_READ_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` covers every member of `request` the read uses.
  }, [key, attempt]);
  const shown = shownAnswers(held, request, attempt);
  const current = shown.answers !== null && !shown.pending;
  return { answers: shown.answers, pending: shown.pending, loading: key !== null && !current, retry: () => setAttempt((n) => n + 1) };
}
