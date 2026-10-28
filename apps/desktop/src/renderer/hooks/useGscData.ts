import { useEffect, useState } from 'react';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { GscPerformanceAnswer, GscQueriesAnswer } from '@app/specs/gsc.schema';
import { requestKey, shownAnswers, withoutFragment, type GscAnswers, type GscRequest } from '../gsc-view';
import { ipc } from '../ipc';

// The Search Console panel's reads (Phase 4 Task 10; acceptance `gsc-panel.feature.md`, Reading):
// `gsc.performance` and `gsc.topQueries` together, once per request (URL without fragment, scope,
// range, connection) and again on Retry. Never on a timer. An answer for an earlier request (the URL
// changed meanwhile) is dropped. A failed call reads as `invalid` (the panel offers Retry).

const FAILED = { status: 'unavailable', reason: 'invalid' } as const;

export interface GscData {
  /** The current request's answers (`null`: none, or not answered yet). */
  readonly answers: GscAnswers | null;
  /** A request is waiting for its answers. */
  readonly loading: boolean;
  /** Reads the current request again. */
  readonly retry: () => void;
}

export function useGscData(request: GscRequest | null): GscData {
  const key = request === null ? null : requestKey(request);
  const [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<{ key: string; attempt: number; answers: GscAnswers } | null>(null);
  useEffect(() => {
    if (request === null || key === null) return;
    let live = true;
    const query = { url: withoutFragment(request.url), scope: request.scope, days: request.days };
    void Promise.all([
      ipc.gsc.performance.query(query).catch((): GscPerformanceAnswer => FAILED),
      ipc.gsc.topQueries.query(query).catch((): GscQueriesAnswer => FAILED),
    ]).then(([performance, queries]) => {
      if (live) setHeld({ key, attempt, answers: { performance, queries } });
    });
    return () => {
      live = false;
    };
    // `key` covers every member of `request` the read uses.
  }, [key, attempt]);
  const answers = shownAnswers(held, key, attempt);
  return { answers, loading: key !== null && answers === null, retry: () => setAttempt((n) => n + 1) };
}
