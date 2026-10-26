// Acceptance: specs/browser-chrome.feature.md (Address field)
import { describe, expect, test } from 'vitest';
import { addressFieldReducer, addressFieldText, initialAddressField, type AddressField, type AddressFieldEvent } from '../address-field';

const URL_A = 'https://a.example/';

function run(...events: AddressFieldEvent[]): AddressField {
  return events.reduce(addressFieldReducer, initialAddressField);
}

describe('address field', () => {
  test('address-field-shows-typed-text-while-pending', () => {
    expect(addressFieldText(initialAddressField, URL_A)).toBe(URL_A);
    const typing = run({ type: 'edit', text: 'b.example' });
    expect(addressFieldText(typing, URL_A)).toBe('b.example');

    const submitted = addressFieldReducer(typing, { type: 'submit', text: 'b.example' });
    expect(submitted.draft).toBeNull();
    expect(addressFieldText(submitted, URL_A)).toBe('b.example');
    // Still pending until the URL changes …
    expect(addressFieldText(addressFieldReducer(submitted, { type: 'url-changed' }), 'https://b.example/')).toBe('https://b.example/');
    // … or the load ends (e.g. stopped, or the same URL again).
    expect(addressFieldText(addressFieldReducer(submitted, { type: 'load-ended' }), URL_A)).toBe(URL_A);

    // Escape / blur drop the draft.
    expect(addressFieldText(addressFieldReducer(typing, { type: 'cancel' }), URL_A)).toBe(URL_A);
  });

  test('address-field-reverts-when-navigate-fails', () => {
    const submitted = run({ type: 'edit', text: 'b.example' }, { type: 'submit', text: 'b.example' });
    const failed = addressFieldReducer(submitted, { type: 'navigate-failed' });
    expect(failed).toEqual(initialAddressField);
    expect(addressFieldText(failed, URL_A)).toBe(URL_A);
    // A failure report never discards what the user has typed since.
    const retyping = addressFieldReducer(submitted, { type: 'edit', text: 'c' });
    expect(addressFieldText(addressFieldReducer(retyping, { type: 'navigate-failed' }), URL_A)).toBe('c');
  });
});
