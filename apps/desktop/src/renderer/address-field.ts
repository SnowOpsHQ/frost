// The address bar's text as a pure reducer (spec `browser-chrome.feature.md`, Address field): what
// the user is typing, else the text just submitted (until its navigation commits, its load ends or
// `navigate` fails), else the tab's URL.

export interface AddressField {
  /** What the user is typing; `null` when not editing. */
  readonly draft: string | null;
  /** Text the user submitted, shown while its navigation is pending. */
  readonly submitted: string | null;
}

export type AddressFieldEvent =
  | { readonly type: 'edit'; readonly text: string }
  | { readonly type: 'submit'; readonly text: string }
  /** Escape or blur: drop the draft. */
  | { readonly type: 'cancel' }
  | { readonly type: 'url-changed' }
  | { readonly type: 'load-ended' }
  /** `browser.navigate` rejected or answered `false` (a no-op). */
  | { readonly type: 'navigate-failed' }
  /** Another tab became active: nothing typed or pending carries over (spec `tabs.feature.md`). */
  | { readonly type: 'tab-switched' };

export const initialAddressField: AddressField = { draft: null, submitted: null };

export function addressFieldReducer(state: AddressField, event: AddressFieldEvent): AddressField {
  switch (event.type) {
    case 'edit':
      return { ...state, draft: event.text };
    case 'submit':
      return { draft: null, submitted: event.text };
    case 'tab-switched':
      return initialAddressField;
    case 'cancel':
      return state.draft === null ? state : { ...state, draft: null };
    case 'url-changed':
    case 'load-ended':
    case 'navigate-failed':
      return state.submitted === null ? state : { ...state, submitted: null };
  }
}

/** The text the field shows for the tab's `url`. */
export function addressFieldText(state: AddressField, url: string): string {
  return state.draft ?? state.submitted ?? url;
}
