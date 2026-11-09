import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryCursorAnswer, HistoryPageAnswer, HistoryVisitAnswer } from '@app/ipc-contract';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import { appendPage } from '../history-view';
import { useSeqChange } from './useSeqChange';

/**
 * Whether the History sheet is open (spec `browser-polish.feature.md`, History view; per window):
 * main's requests (`BrowserState.historyViewSeq`: the menu, Mod+Y, the palette) open it; it closes
 * when asked, or when another tab is shown or a new document commits in this one (its page is what
 * the user wants to see; an in-page URL change does not count). A request in the same state as that
 * change came after it, so it opens the sheet.
 */
export function useHistoryView(seq: number | undefined, tab: Pick<TabState, 'id' | 'documentSeq'> | undefined): readonly [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useSeqChange(seq, () => setOpen(true));
  const close = useCallback(() => setOpen(false), []);
  const key = tab ? `${tab.id} ${tab.documentSeq}` : '';
  const seen = useRef({ key, seq });
  useEffect(() => {
    const before = seen.current;
    seen.current = { key, seq };
    // A request that arrives with the new document came after it: the request wins.
    if (before.key !== key && before.seq === seq) setOpen(false);
  }, [key, seq]);
  return [open, close];
}

/** Where the History view reads its pages (`actions.historyList`; a fake in tests). */
export interface HistorySource {
  list(query: string, after: HistoryCursorAnswer | null, projectId?: string): Promise<HistoryPageAnswer>;
}

export interface HistoryListing {
  /** The search and project filter the visits were listed for. */
  readonly query: string;
  readonly projectId: string | null;
  /** Newest first, each with its `changeCount` (Phase 11 Task 10). */
  readonly visits: readonly HistoryVisitAnswer[];
  readonly next: HistoryCursorAnswer | null;
  readonly loading: boolean;
}

/**
 * The History view's listing (spec `browser-polish.spec.ts`; acceptance `browser-polish.feature.md`,
 * History view and Phase 11's project filter): lists for `query` within `projectId` (`null`: every
 * visit) whenever either changes, a page at a time (`more`); a slow answer for an old search or filter
 * never lands. `reload` lists again from the top (after a clear); `drop` forgets one listed URL.
 */
export function useHistoryListing(source: HistorySource, query: string, projectId: string | null) {
  const [listing, setListing] = useState<HistoryListing>({ query, projectId, visits: [], next: null, loading: true });
  /** Bumped by each new listing, so a slow answer for an old query never lands. */
  const generation = useRef(0);
  const latest = useRef({ source, query, projectId });
  latest.current = { source, query, projectId };

  const reload = useCallback(() => {
    const { source: from, query: text, projectId: project } = latest.current;
    const mine = ++generation.current;
    setListing((current) => ({ ...current, loading: true }));
    void from.list(text, null, project ?? undefined).then((page) => {
      if (generation.current === mine) setListing({ query: text, projectId: project, visits: page.visits, next: page.next, loading: false });
    });
  }, []);

  useEffect(() => reload(), [query, projectId, reload]);

  const shown = useRef(listing);
  shown.current = listing;
  const more = useCallback(() => {
    const { next, query: text, projectId: project, loading } = shown.current;
    if (!next || loading) return;
    const mine = generation.current;
    setListing((current) => ({ ...current, loading: true }));
    void latest.current.source.list(text, next, project ?? undefined).then((page) => {
      if (generation.current === mine) setListing((now) => ({ ...now, visits: appendPage(now.visits, page.visits), next: page.next, loading: false }));
    });
  }, []);

  const drop = useCallback((url: string) => setListing((current) => ({ ...current, visits: current.visits.filter((v) => v.url !== url) })), []);
  return { listing, more, reload, drop } as const;
}
