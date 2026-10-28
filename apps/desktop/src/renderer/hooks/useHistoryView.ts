import { useCallback, useEffect, useRef, useState } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
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
