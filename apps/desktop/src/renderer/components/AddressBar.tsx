import { useEffect, useReducer, useRef, type KeyboardEvent } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import { addressFieldReducer, addressFieldText, initialAddressField } from '../address-field';
import { useSeqChange } from '../hooks/useSeqChange';
import { LockIcon, NotSecureIcon, SearchIcon } from '../icons';
import { actions } from '../ipc';
import { tabSecurity } from '../security';

// The address bar of the browser chrome (`App.tsx`; spec `browser-chrome.feature.md`, Layout). Styling is the
// bundled styles.css only (strict CSP).

export function AddressBar({ tab, focusSeq }: { readonly tab: TabState | undefined; readonly focusSeq: number | undefined }) {
  const input = useRef<HTMLInputElement>(null);
  const [field, dispatch] = useReducer(addressFieldReducer, initialAddressField);
  const selectOnMouseUp = useRef(false);
  const url = tab?.url ?? '';
  const loading = tab?.loading === true;
  const empty = url === '';
  const tabId = tab?.id;

  /** Focus with everything selected (no click follows, so no mouseup to protect). */
  const focusAll = () => {
    input.current?.focus();
    input.current?.select();
    selectOnMouseUp.current = false;
  };

  useEffect(() => dispatch({ type: 'tab-switched' }), [tabId]);
  useEffect(() => dispatch({ type: 'url-changed' }), [url]);
  useEffect(() => {
    if (!loading) dispatch({ type: 'load-ended' });
  }, [loading]);

  // An empty tab puts the caret in the address bar.
  useEffect(() => {
    if (empty && tabId !== undefined) focusAll();
  }, [empty, tabId]);
  // Main asked for the address bar (new tab, Cmd/Ctrl+L, switching to an empty tab).
  useSeqChange(focusSeq, focusAll);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const typed = event.currentTarget.value;
      if (typed.trim() === '') return;
      dispatch({ type: 'submit', text: typed });
      // Focus moves to the page (main focuses the tab's WebContents).
      event.currentTarget.blur();
      void actions.navigate(typed).then((navigated) => {
        if (!navigated) dispatch({ type: 'navigate-failed' });
      });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dispatch({ type: 'cancel' });
      requestAnimationFrame(() => input.current?.select());
    }
  };

  const security = field.draft !== null || field.submitted !== null ? 'none' : tabSecurity(tab);
  return (
    <div className="address" data-security={security}>
      <span className="address-badge" title={security === 'secure' ? 'Secure connection' : security === 'insecure' ? 'Not secure' : undefined}>
        {security === 'secure' ? <LockIcon /> : security === 'insecure' ? <NotSecureIcon /> : <SearchIcon />}
      </span>
      <input
        ref={input}
        data-testid="address"
        className="address-input"
        type="text"
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-label="Address and search bar"
        placeholder="Search or enter address"
        value={addressFieldText(field, url)}
        onChange={(event) => dispatch({ type: 'edit', text: event.target.value })}
        onFocus={(event) => {
          event.currentTarget.select();
          selectOnMouseUp.current = true;
        }}
        onMouseUp={(event) => {
          // Keep the select-all from focus instead of letting the click place the caret.
          if (selectOnMouseUp.current) event.preventDefault();
          selectOnMouseUp.current = false;
        }}
        onBlur={() => {
          dispatch({ type: 'cancel' });
          selectOnMouseUp.current = false;
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
