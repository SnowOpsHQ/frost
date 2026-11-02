import { useEffect, useState, useSyncExternalStore } from 'react';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { GscQueriesAnswer, GscTargetPagesAnswer } from '@app/specs/gsc.schema';
import { GSC_READ_DEBOUNCE_MS } from '@app/specs/gsc-panel.spec';
import { GSC_TARGET_CHECK_DELAY_MS } from '@app/specs/gsc-targets.spec';
import { contentGscShown, readKey, suggestionsQuery, targetPagesQuery } from '../content-gsc-view';
import { gscPeriod, gscPrefs, rangePhrase } from '../gsc-view';
import { ipc } from '../ipc';
import { useGscStatus } from '../settings-hooks';

// The Content panel's Search Console reads (Phase 9 Task 5; acceptance `seo-content.feature.md`, "Search
// Console targets"): only while configured, connected and on an `http(s)` page, with the Search Console
// panel's range (its shared `gscPrefs` store). The suggestions are `gsc.topQueries` for the page,
// `GSC_READ_DEBOUNCE_MS` after the page or range last changed; the query→page check is `gsc.targetPages`
// for the target query, `GSC_TARGET_CHECK_DELAY_MS` after it last changed (typing reads once). Never on a
// timer; an answer for an earlier read is not shown. A failed call reads as `invalid`. Main caches both.

const FAILED = { status: 'unavailable', reason: 'invalid' } as const;

interface Held<T> {
  readonly key: string;
  readonly answer: T;
}

/** Reads `run()` `delay` ms after `key` last changed (`null`: nothing to read); answers only the current key's. */
function useRead<T>(key: string | null, delay: number, run: () => Promise<T>): T | null {
  const [held, setHeld] = useState<Held<T> | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void run().then((answer) => {
        if (live) setHeld({ key, answer });
      });
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` covers everything `run` reads.
  }, [key]);
  return held !== null && held.key === key ? held.answer : null;
}

export interface ContentGscReads {
  /** Search Console is configured and connected and the page is `http(s)`: the section shows. */
  readonly shown: boolean;
  /** The panel's range as a phrase ("in the last 28 days"). */
  readonly rangePhrase: string;
  /** The page's top queries (`null`: not answered yet, or not shown). */
  readonly suggestions: GscQueriesAnswer | null;
  /** There is a target query to check. */
  readonly checking: boolean;
  /** The target query's pages (`null`: not answered yet, or nothing to check). */
  readonly pages: GscTargetPagesAnswer | null;
}

/** `url`: the page the notes are for; `target`: its target query (the notes' own value). */
export function useContentGscTargets(url: string, target: string): ContentGscReads {
  const status = useGscStatus();
  const prefs = useSyncExternalStore(gscPrefs.subscribe, gscPrefs.get);
  const now = Date.now();
  const shown = contentGscShown(status, url);
  const connection = status?.version ?? -1;
  const period = gscPeriod(prefs, now);
  const queries = shown ? suggestionsQuery(url, period) : null;
  const pagesInput = shown ? targetPagesQuery(url, target, period) : null;
  const suggestions = useRead(queries === null ? null : readKey(queries, connection), GSC_READ_DEBOUNCE_MS, () =>
    ipc.gsc.topQueries.query(queries!).catch((): GscQueriesAnswer => FAILED),
  );
  const pages = useRead(pagesInput === null ? null : readKey(pagesInput, connection), GSC_TARGET_CHECK_DELAY_MS, () =>
    ipc.gsc.targetPages.query(pagesInput!).catch((): GscTargetPagesAnswer => FAILED),
  );
  return { shown, rangePhrase: rangePhrase(prefs, now), suggestions, checking: pagesInput !== null, pages };
}
