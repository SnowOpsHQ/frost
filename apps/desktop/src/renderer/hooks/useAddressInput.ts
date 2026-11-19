import { useEffect, useReducer, useRef, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { addressFieldReducer, addressFieldText, initialAddressField } from '../address-field';
import { actions } from '../ipc';

// What typing in an address field does: the address bar's, and the new tab's search field's, one path
// (spec `browser-polish.feature.md`, New-tab page; `browser-chrome.feature.md`, Address field). Enter hands
// the text, exactly as typed, to `browser.navigate` (main decides URL or search, `main/browser/address.ts`)
// and moves focus on to the page; a blank Enter does nothing; Escape drops what was typed and selects the
// field; a blur drops it; focus selects everything, and the click that focused keeps that selection. The
// field's text is the address field's reducer over the tab's URL.

/** The tab the field addresses: its text reverts to `url`. */
export interface AddressTarget {
  readonly id: number | undefined;
  readonly url: string;
  readonly loading: boolean;
}

export function useAddressInput(tab: AddressTarget) {
  const input = useRef<HTMLInputElement>(null);
  const [field, dispatch] = useReducer(addressFieldReducer, initialAddressField);
  const selectOnMouseUp = useRef(false);

  useEffect(() => dispatch({ type: 'tab-switched' }), [tab.id]);
  useEffect(() => dispatch({ type: 'url-changed' }), [tab.url]);
  useEffect(() => {
    if (!tab.loading) dispatch({ type: 'load-ended' });
  }, [tab.loading]);

  /** Focus with everything selected (no click follows, so no mouseup to protect). */
  const focusAll = () => {
    input.current?.focus();
    input.current?.select();
    selectOnMouseUp.current = false;
  };

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

  /** The `<input>`'s props: spread them, then add its own name, placeholder, class and test id. */
  const inputProps = {
    ref: input,
    type: 'text',
    inputMode: 'url',
    spellCheck: false,
    autoComplete: 'off',
    autoCapitalize: 'off',
    value: addressFieldText(field, tab.url),
    onChange: (event: { readonly target: HTMLInputElement }) => dispatch({ type: 'edit', text: event.target.value }),
    onFocus: (event: FocusEvent<HTMLInputElement>) => {
      event.currentTarget.select();
      selectOnMouseUp.current = true;
    },
    onMouseUp: (event: MouseEvent<HTMLInputElement>) => {
      // Keep the select-all from focus instead of letting the click place the caret.
      if (selectOnMouseUp.current) event.preventDefault();
      selectOnMouseUp.current = false;
    },
    onBlur: () => {
      dispatch({ type: 'cancel' });
      selectOnMouseUp.current = false;
    },
    onKeyDown,
  } as const;

  return { field, focusAll, inputProps };
}
