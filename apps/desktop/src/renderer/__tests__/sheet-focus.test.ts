// @vitest-environment jsdom
// Acceptance: specs/help.feature.md (Chrome, `a-replacing-sheet-keeps-focus`), specs/account-settings.feature.md
// (Decisions, "A sheet over the page column": closed with focus inside, focus goes to the page) · issue #25 (Bugs)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const focusPage = vi.hoisted(() => vi.fn(async () => true));
// Every other call to main waits for ever: these tests look at focus only.
vi.mock('../ipc', () => {
  const never = () => new Promise<never>(() => undefined);
  const procedure: unknown = new Proxy(() => undefined, { get: (_target, key) => (key === 'then' ? undefined : key === 'query' || key === 'mutate' ? never : procedure) });
  return { ipc: procedure, actions: new Proxy({ focusPage }, { get: (target, key) => (key === 'focusPage' ? target.focusPage : key === 'then' ? undefined : never) }) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out (Settings scrolls its section's heading into view).
Element.prototype.scrollIntoView = () => undefined;

const { requestSettings } = await import('../settings-open');
const { requestHelpSheet } = await import('../help-palette');
const { SettingsSlot } = await import('../settings-view');
const { ShortcutsSheet } = await import('../components/ShortcutsView');
const { WhatsNewSheet } = await import('../components/WhatsNewView');

describe('a sheet that replaces another', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    focusPage.mockClear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const props = { tab: { id: 1, documentSeq: 1, loading: false }, historySeq: undefined, onOpen: () => undefined };
    act(() => root.render(createElement('div', null, createElement(ShortcutsSheet, props), createElement(WhatsNewSheet, props), createElement(SettingsSlot, props))));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const shown = (testId: string) => host.querySelector(`[data-testid="${testId}"]`) !== null;
  const focusedId = () => (document.activeElement as HTMLElement | null)?.id;

  test('a-replacing-sheet-keeps-focus', async () => {
    // Settings replaced by the shortcuts sheet: its title has focus, and the page is not asked to take it.
    await act(async () => void requestSettings('account'));
    expect(shown('settings-view')).toBe(true);
    expect(focusedId()).toBe('settings-section-account');
    await act(async () => void requestHelpSheet('shortcuts'));
    expect(shown('settings-view')).toBe(false);
    expect(shown('shortcuts-view')).toBe(true);
    expect(focusedId()).toBe('shortcuts-view-title');
    expect(focusPage).not.toHaveBeenCalled();
    // The shortcuts sheet replaced by Settings: the same.
    await act(async () => void requestSettings('telemetry'));
    expect(shown('shortcuts-view')).toBe(false);
    expect(focusedId()).toBe('settings-section-telemetry');
    expect(focusPage).not.toHaveBeenCalled();
  });

  test('a closed sheet still gives focus back to the page', async () => {
    await act(async () => void requestHelpSheet('shortcuts'));
    expect(focusedId()).toBe('shortcuts-view-title');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="shortcuts-view-close"]')!.click());
    expect(shown('shortcuts-view')).toBe(false);
    expect(focusPage).toHaveBeenCalledTimes(1);
    focusPage.mockClear();
    await act(async () => void requestSettings('account'));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="settings-close"]')!.click());
    expect(shown('settings-view')).toBe(false);
    expect(focusPage).toHaveBeenCalledTimes(1);
  });
});
