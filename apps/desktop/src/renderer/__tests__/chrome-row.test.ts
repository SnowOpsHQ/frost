// @vitest-environment jsdom
// Spec: specs/tabs.spec.ts (CHROME_ROW, NEW_TAB_LABEL)
// Acceptance: specs/tabs.feature.md (Renderer: chrome-row-dom-order)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { CHROME_ROW } from '@app/specs/tabs.spec';

// Every call to main waits for ever: these tests look at the DOM only.
vi.mock('../ipc', () => {
  const never = () => new Promise<never>(() => undefined);
  const procedure: unknown = new Proxy(() => undefined, { get: (_target, key) => (key === 'then' ? undefined : key === 'query' || key === 'mutate' ? never : procedure) });
  return { ipc: procedure, actions: new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : never) }) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out (the active tab scrolls itself into view). The strip draws `state`'s tabs; the
// row's tools need no active tab.
Element.prototype.scrollIntoView = () => undefined;

const { ChromeRow } = await import('../components/ChromeRow');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tab = (id: number): TabState =>
  ({ id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1 }) as TabState;

function render(tabs: number): HTMLElement {
  const list = Array.from({ length: tabs }, (_, i) => tab(i + 1));
  const state = { tabs: list, activeTabId: 1, focusAddressBarSeq: 0 } as unknown as BrowserState;
  const agent = { state: null, open: false, setOpen: () => undefined, show: () => undefined, focusAfter: { current: null }, toggleRef: { current: null } };
  act(() =>
    root.render(
      createElement(ChromeRow, { state, tab: undefined, sidebarOpen: false, onToggleSidebar: () => undefined, profileOpen: false, onToggleProfile: () => undefined, agent }),
    ),
  );
  return host.querySelector<HTMLElement>('[data-testid="chrome-row"]')!;
}

test('chrome-row-dom-order', () => {
  for (const tabs of [1, 3]) {
    const row = render(tabs);
    // Each CHROME_ROW control, in that DOM order (the address bar's input sits in its .address box).
    const controls = CHROME_ROW.map((id) => row.querySelector(`[data-testid="${id}"]`));
    expect(controls.every((el) => el !== null)).toBe(true);
    for (let i = 1; i < controls.length; i++)
      expect(controls[i - 1]!.compareDocumentPosition(controls[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, CHROME_ROW[i]).not.toBe(0);
    // New tab is the tablist's next sibling, a child of the row (so it is `no-drag` as the tools are), and
    // the address bar's box comes right after it.
    const list = row.querySelector('[role="tablist"]')!;
    const plus = row.querySelector<HTMLButtonElement>('[data-testid="new-tab"]')!;
    expect(list.nextElementSibling).toBe(plus);
    expect(plus.parentElement).toBe(row);
    expect(list.contains(plus)).toBe(false);
    expect(plus.nextElementSibling?.classList.contains('address')).toBe(true);
    // The tablist holds tabs only, one per open tab.
    expect(list.querySelectorAll('[role="tab"]').length).toBe(tabs);
    expect(list.querySelectorAll('button:not([aria-hidden="true"]), input').length).toBe(0);
    // Its name and tooltip are unchanged; it is a plain button in the Tab order.
    expect([plus.type, plus.getAttribute('aria-label'), plus.title, plus.tabIndex]).toEqual(['button', 'New tab', 'New tab', 0]);
    expect(plus.classList.contains('new-tab')).toBe(true);
  }
});
