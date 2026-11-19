// @vitest-environment jsdom
// Spec: specs/account-settings.spec.ts (SETTINGS_BUTTON), specs/tabs.spec.ts (CHROME_ROW)
// Acceptance: specs/account-settings.feature.md (Opening, "A visible way in"; The row's button)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SETTINGS_BUTTON } from '@app/specs/account-settings.spec';
import { CHROME_ROW } from '@app/specs/tabs.spec';

// Every call to main waits for ever: these tests look at the DOM and at what the button asks for.
vi.mock('../ipc', () => {
  const never = () => new Promise<never>(() => undefined);
  const procedure: unknown = new Proxy(() => undefined, { get: (_target, key) => (key === 'then' ? undefined : key === 'query' || key === 'mutate' ? never : procedure) });
  return { ipc: procedure, actions: new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : never) }) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out (Settings scrolls its section's heading into view).
Element.prototype.scrollIntoView = () => undefined;

const settingsOpen = await import('../settings-open');
const { SettingsSlot } = await import('../settings-view');
const { ChromeRow } = await import('../components/ChromeRow');

describe('the row’s Settings button', () => {
  let host: HTMLDivElement;
  let root: Root;
  const requested: string[] = [];
  let unsubscribe: () => void;
  beforeEach(() => {
    requested.length = 0;
    unsubscribe = settingsOpen.onSettingsRequest((section) => requested.push(section));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    unsubscribe();
    act(() => root.unmount());
    host.remove();
  });
  const agent = { state: null, open: false, setOpen: () => undefined, show: () => undefined, focusAfter: { current: null }, toggleRef: { current: null } };
  const render = (withSlot: boolean) => {
    const slot = { tab: { id: 1, documentSeq: 1, loading: false }, historySeq: undefined, onOpen: () => undefined };
    const row = createElement(ChromeRow, { state: null, tab: undefined, sidebarOpen: false, onToggleSidebar: () => undefined, profileOpen: false, onToggleProfile: () => undefined, agent });
    act(() => root.render(createElement('div', null, row, withSlot ? createElement(SettingsSlot, slot) : null)));
  };
  const button = () => host.querySelector<HTMLButtonElement>(`[data-testid="${SETTINGS_BUTTON.testId}"]`)!;
  const focusedId = () => (document.activeElement as HTMLElement | null)?.id;

  test('settings-button-requests-account', async () => {
    render(true);
    expect(host.querySelector('[data-testid="settings-view"]')).toBeNull();
    await act(async () => button().click());
    expect(requested).toEqual([SETTINGS_BUTTON.section]);
    expect(host.querySelector('[data-testid="settings-view"]')).not.toBeNull();
    expect(focusedId()).toBe('settings-section-account');
    // Open on another section: a second click asks again and focus returns to Account; the sheet stays.
    await act(async () => void settingsOpen.requestSettings('telemetry'));
    expect(focusedId()).toBe('settings-section-telemetry');
    await act(async () => button().click());
    expect(requested.at(-1)).toBe('account');
    expect(focusedId()).toBe('settings-section-account');
    expect(host.querySelector('[data-testid="settings-view"]')).not.toBeNull();
    // Once more with focus already there: still open (no toggle).
    await act(async () => button().click());
    expect(host.querySelector('[data-testid="settings-view"]')).not.toBeNull();
  });

  test('settings-button-is-a-plain-tool', () => {
    render(false);
    expect(button().tagName).toBe('BUTTON');
    expect(button().type).toBe('button');
    expect(button().classList.contains('tool')).toBe(true);
    expect(button().getAttribute('aria-label')).toBe(SETTINGS_BUTTON.label);
    expect(button().getAttribute('title')).toBe(SETTINGS_BUTTON.title);
    // Not a toggle: nothing pressed or expanded to report.
    for (const attribute of ['aria-pressed', 'aria-expanded', 'aria-current']) expect(button().hasAttribute(attribute), attribute).toBe(false);
    // The row's last control, after the AI agent's toggle, a direct child of the row (so it is `no-drag` as the other tools are).
    expect(CHROME_ROW.at(-1)).toBe(SETTINGS_BUTTON.testId);
    const row = host.querySelector('[data-testid="chrome-row"]')!;
    expect(button().parentElement).toBe(row);
    const controls = [...row.children].filter((el) => el.matches('button')).map((el) => el.getAttribute('data-testid'));
    expect(controls.slice(-2)).toEqual(['agent-toggle', SETTINGS_BUTTON.testId]);
    expect(row.querySelector(`[data-testid="${SETTINGS_BUTTON.testId}"] svg`)).not.toBeNull();
  });
});
