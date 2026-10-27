import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FIND_PLACEHOLDER, FIND_TEXT_MAX_CHARS, findCountLabel } from '@app/specs/browser-polish.spec';
// Type-only (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { FindState } from '@app/specs/browser-polish.schema';
import { ChevronIcon, CloseIcon, SearchIcon } from '../icons';
import { actions } from '../ipc';

// The find bar (spec `browser-polish.spec.ts`; acceptance `browser-polish.feature.md`, Find in page):
// a chrome row above the workspace while the active tab's bar is open (main lays the tab's view
// out below it). Main owns the state per tab (`BrowserState.find`) and runs
// `findInPage`; the text typed here goes only to main. Styling is the bundled styles.css only.

/** The last focus request taken (one counter for every tab: a bar shown again after a switch is not one). */
let focusSeen = 0;

function OpenFindBar({ find }: { readonly find: FindState }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(find.text);
  const [matchCase, setMatchCase] = useState(find.matchCase);
  const tabId = find.tabId;

  // Main asked for the bar (Mod+F, the menu, the palette): focus it, the text selected.
  useEffect(() => {
    if (find.focusSeq <= focusSeen) return;
    focusSeen = find.focusSeq;
    input.current?.focus();
    input.current?.select();
  }, [find.focusSeq]);

  const search = (next: string, nextCase: boolean) => void actions.findSearch(tabId, next, nextCase);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void actions.findStep(tabId, !event.shiftKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void actions.closeFind(tabId);
    }
  };
  const count = findCountLabel(find);
  return (
    <div className="find-bar" data-testid="find-bar" role="search" aria-label="Find in page">
      <span className="find-icon" aria-hidden="true">
        <SearchIcon />
      </span>
      <input
        ref={input}
        className="find-input"
        data-testid="find-input"
        type="text"
        spellCheck={false}
        autoComplete="off"
        aria-label={FIND_PLACEHOLDER}
        placeholder={FIND_PLACEHOLDER}
        maxLength={FIND_TEXT_MAX_CHARS}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          search(event.target.value, matchCase);
        }}
        onKeyDown={onKeyDown}
      />
      <output className="find-count" data-testid="find-count" aria-live="polite" data-empty={find.text !== '' && find.matches === 0}>
        {count}
      </output>
      <button
        type="button"
        className="find-tool find-case"
        data-testid="find-case"
        aria-pressed={matchCase}
        aria-label="Match case"
        title="Match case"
        onClick={() => {
          setMatchCase(!matchCase);
          search(text, !matchCase);
        }}
      >
        Aa
      </button>
      <span className="find-divider" aria-hidden="true" />
      <button type="button" className="find-tool find-previous" data-testid="find-previous" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={find.matches === 0} onClick={() => void actions.findStep(tabId, false)}>
        <ChevronIcon />
      </button>
      <button type="button" className="find-tool" data-testid="find-next" aria-label="Next match" title="Next match (Enter)" disabled={find.matches === 0} onClick={() => void actions.findStep(tabId, true)}>
        <ChevronIcon />
      </button>
      <button type="button" className="find-tool" data-testid="find-close" aria-label="Close find bar" title="Close (Esc)" onClick={() => void actions.closeFind(tabId)}>
        <CloseIcon />
      </button>
    </div>
  );
}

/** The active tab's find bar while it is open; nothing otherwise. Each tab's bar is its own (keyed by tab). */
export function FindBar({ find }: { readonly find: FindState | null | undefined }) {
  return find ? <OpenFindBar key={find.tabId} find={find} /> : null;
}
