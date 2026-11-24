// @vitest-environment jsdom
// Spec: specs/browser-polish.spec.ts (ADDRESS_PROMPT)
// Acceptance: specs/browser-polish.feature.md (New-tab page: start-search-is-the-address-bar-path)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TabState } from '@app/specs/browser.spec';
import { ADDRESS_PROMPT } from '@app/specs/browser-polish.spec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What `browser.navigate` answers next (`false`: a no-op, so the field reverts). */
let navigateAnswer = true;
const navigate = vi.fn(async (_input: string) => navigateAnswer);
const never = () => new Promise<never>(() => undefined);
vi.mock('../ipc', () => ({
  ipc: {
    agent: { watch: { query: async () => ({ version: 1, setup: { ready: false } }) } },
    gsc: { watch: { query: never } },
    account: { watch: { query: never }, settingsWatch: { query: never } },
    help: { watch: { query: never } },
  },
  actions: {
    navigate: (input: string) => navigate(input),
    jumpBackIn: async () => ({ mostVisited: [], recent: [] }),
    listProjects: async () => [],
    focusPage: async () => true,
  },
}));
vi.mock('../components/changes/projects-sheet', () => ({ openProjects: () => undefined, closeProjects: () => undefined, onProjectsOpened: () => () => undefined }));

const { AddressBar } = await import('../components/AddressBar');
const { StartView } = await import('../components/StartView');

/** An empty tab, as main reports it. */
const emptyTab = { id: 1, url: '', loading: false } as unknown as TabState;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  navigate.mockClear();
  navigateAnswer = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** The chrome on an empty tab: the address bar in its row, the start view in the page area. */
async function showEmptyTab(): Promise<void> {
  await act(async () => root.render(createElement('div', null, createElement(AddressBar, { tab: emptyTab, focusSeq: undefined }), createElement(StartView, { tabId: emptyTab.id }))));
  await act(async () => undefined);
}

const addressInput = () => host.querySelector<HTMLInputElement>('[data-testid="address"]')!;
const searchInput = () => host.querySelector<HTMLInputElement>('[data-testid="start-search-input"]')!;

function typeInto(input: HTMLInputElement, text: string): void {
  // React tracks the value it set: go through the native setter so its input event sees a change.
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    input.focus();
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  // navigate's answer arrives.
  await act(async () => undefined);
}

/** One script of keystrokes in `field`, and what each step leaves: the field's text and what reached `browser.navigate`. */
async function run(field: () => HTMLInputElement): Promise<{ step: string; value: string; sent: string[] }[]> {
  const trace: { step: string; value: string; sent: string[] }[] = [];
  const note = (step: string) => {
    trace.push({ step, value: field().value, sent: navigate.mock.calls.map(([input]) => input) });
    navigate.mockClear();
  };
  navigateAnswer = false;
  typeInto(field(), '  two words ');
  await press(field(), 'Enter');
  note('Enter, navigate answers false');
  typeInto(field(), '   ');
  await press(field(), 'Enter');
  note('blank Enter');
  await press(field(), 'Escape');
  note('Escape');
  typeInto(field(), 'abc');
  act(() => field().blur());
  note('blur');
  navigateAnswer = true;
  typeInto(field(), 'example.com');
  await press(field(), 'Enter');
  note('Enter, navigate answers true');
  return trace;
}

test('start-search-is-the-address-bar-path', async () => {
  await showEmptyTab();
  // One focus target: the empty tab puts the caret in the address bar, not in the start view's field.
  expect(document.activeElement).toBe(addressInput());
  const field = searchInput();
  expect(field).not.toBeNull();
  expect(field.getAttribute('aria-label')).toBe(ADDRESS_PROMPT);
  expect(field.placeholder).toBe(ADDRESS_PROMPT);
  expect(addressInput().placeholder).toBe(ADDRESS_PROMPT);
  // No tagline repeats it: the field (an attribute, not text) is where the start view says it.
  expect(host.querySelector('[data-testid="start-view"]')!.textContent).not.toContain(ADDRESS_PROMPT);

  const viaAddressBar = await run(addressInput);
  await showEmptyTab();
  const viaStartView = await run(searchInput);
  expect(viaStartView).toEqual(viaAddressBar);
  expect(viaStartView).toEqual([
    { step: 'Enter, navigate answers false', value: '', sent: ['  two words '] },
    { step: 'blank Enter', value: '   ', sent: [] },
    { step: 'Escape', value: '', sent: [] },
    { step: 'blur', value: '', sent: [] },
    { step: 'Enter, navigate answers true', value: 'example.com', sent: ['example.com'] },
  ]);
  // Enter hands focus on to the page (main focuses the tab's WebContents), from either field.
  expect(document.activeElement).not.toBe(searchInput());
});
