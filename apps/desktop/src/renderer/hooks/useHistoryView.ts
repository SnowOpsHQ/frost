import { useCallback, useEffect, useRef, useState } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import { useSeqChange } from './useSeqChange';

/**
 * Whether the History sheet is open (spec `browser-polish.feature.md`, History view; per window):
 * main's requests (`BrowserState.historyViewSeq`: the menu, Mod+Y, the palette) open it; it closes
 * when asked, or when another tab is shown or a new document commits in this one (its page is what
 * the user wants to see; an in-page URL change does not count).
 */
export function useHistoryView(seq: number | undefined, tab: Pick<TabState, 'id' | 'documentSeq'> | undefined): readonly [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useSeqChange(seq, () => setOpen(true));
  const close = useCallback(() => setOpen(false), []);
  const key = tab ? `${tab.id} ${tab.documentSeq}` : '';
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    setOpen(false);
  }, [key]);
  return [open, close];
}
