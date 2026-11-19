// @vitest-environment jsdom
// Spec: specs/account-settings.spec.ts (SETTINGS_SECTIONS, SETTINGS_OPTIONAL_SECTIONS, settingsSectionsShown, settingsLanding,
// SETTINGS_SCROLL_SPY, settingsSectionInView, SETTINGS_BUTTON)
// Acceptance: specs/account-settings.feature.md (Decisions: "Unconfigured sections are left out", "The section list follows
// the scroll"; Sections shown and the section list)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AccountState } from '@app/specs/account-state.schema';
import type { GscStatus } from '@app/specs/gsc.spec';
import {
  SETTINGS_BUTTON,
  SETTINGS_OPTIONAL_SECTIONS,
  SETTINGS_SCROLL_SPY,
  SETTINGS_SECTIONS,
  settingsLanding,
  settingsSectionInView,
  settingsSectionsShown,
  type SettingsSectionId,
} from '@app/specs/account-settings.spec';

const ALL = SETTINGS_SECTIONS.map((entry) => entry.id);

describe('the sections shown', () => {
  test('settings-sections-left-out-when-unconfigured', () => {
    expect(SETTINGS_OPTIONAL_SECTIONS).toEqual(['account', 'search-console']);
    // Not answered yet, or configured: every section, in order.
    expect(settingsSectionsShown({})).toEqual(ALL);
    expect(settingsSectionsShown({ account: false, 'search-console': false })).toEqual(ALL);
    // Each left out on its own, the rest in order.
    expect(settingsSectionsShown({ account: true })).toEqual(ALL.filter((id) => id !== 'account'));
    expect(settingsSectionsShown({ 'search-console': true })).toEqual(ALL.filter((id) => id !== 'search-console'));
    expect(settingsSectionsShown({ account: true, 'search-console': true })).toEqual(['data-sources', 'locations', 'ai-checks', 'telemetry', 'history']);
  });

  test('settings-request-lands-on-a-shown-section', () => {
    const shown = settingsSectionsShown({ account: true, 'search-console': true });
    for (const id of shown) expect(settingsLanding(id, shown)).toBe(id);
    expect(settingsLanding('account', shown)).toBe('data-sources');
    expect(settingsLanding('search-console', shown)).toBe('data-sources');
    // Only Account left out: the top is Search Console.
    expect(settingsLanding(SETTINGS_BUTTON.section, settingsSectionsShown({ account: true }))).toBe('search-console');
    expect(settingsLanding(SETTINGS_BUTTON.section, ALL)).toBe('account');
  });

  test('settings-section-in-view', () => {
    const tops = [
      { id: 'a', top: 0 },
      { id: 'b', top: 300 },
      { id: 'c', top: 900 },
      { id: 'd', top: 1100 },
    ];
    const view = (scrollTop: number) => ({ scrollTop, clientHeight: 600, scrollHeight: 1400 });
    expect(SETTINGS_SCROLL_SPY.line).toBeCloseTo(1 / 3);
    // At the top: the first. A heading at the line (a third of 600 below the top) is current.
    expect(settingsSectionInView(tops, view(0))).toBe('a');
    expect(settingsSectionInView(tops, view(99))).toBe('a');
    expect(settingsSectionInView(tops, view(100))).toBe('b');
    expect(settingsSectionInView(tops, view(699))).toBe('b');
    expect(settingsSectionInView(tops, view(700))).toBe('c');
    // At the end of the scroll the last, though its heading is below the line.
    expect(settingsSectionInView(tops, view(799))).toBe('d');
    expect(settingsSectionInView(tops, view(800))).toBe('d');
    // Headings below the top (the first heading after a gap): still the first until one crosses the line.
    expect(settingsSectionInView([{ id: 'a', top: 400 }, ...tops.slice(1)], view(0))).toBe('a');
    // Content that does not scroll is never "at its end": the line decides (not the last section).
    expect(settingsSectionInView(tops, { scrollTop: 0, clientHeight: 1400, scrollHeight: 1400 })).toBe('b');
    // No sections, no current one.
    expect(settingsSectionInView([], view(0))).toBeNull();
  });
});

// ---- The sheet, against main's account and Search Console states (injected) -----------------------

const store = vi.hoisted(() => ({ account: null as unknown, gsc: null as unknown }));
vi.mock('../settings-hooks', () => ({
  accountStore: { current: () => store.account, subscribe: () => () => undefined },
  gscStore: { current: () => store.gsc, subscribe: () => () => undefined },
  useAccountState: () => store.account,
  useGscStatus: () => store.gsc,
  useSettingsMenuSeq: () => undefined,
  useTelemetryState: () => [{ state: null, failed: false }, async () => undefined],
  settingsActions: {},
}));
// Every call to main waits for ever: these tests look at the sheet's sections and list.
vi.mock('../ipc', () => {
  const never = () => new Promise<never>(() => undefined);
  const procedure: unknown = new Proxy(() => undefined, { get: (_target, key) => (key === 'then' ? undefined : key === 'query' || key === 'mutate' ? never : procedure) });
  return { ipc: procedure, actions: new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : never) }) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out (Settings scrolls its section's heading into view).
Element.prototype.scrollIntoView = () => undefined;

const { requestSettings } = await import('../settings-open');
const { SettingsSlot } = await import('../settings-view');

const ENTITLEMENTS = { plan: 'free', status: 'none', features: [], issuedAtMs: 0, expiresAtMs: 0, graceEndsAtMs: null } as unknown as AccountState['entitlements'];
const account = (status: AccountState['status']): AccountState => ({ status, user: null, entitlements: ENTITLEMENTS, keychain: 'persistent', requestId: null, fingerprint: null, error: null, version: 1 });
const gsc = (configured: boolean): GscStatus => ({ configured, entitled: true, connected: false, connecting: false, keychain: 'persistent', error: null, version: 1 }) as GscStatus;

describe('the sheet', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    store.account = null;
    store.gsc = null;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = () => act(() => root.render(createElement(SettingsSlot, { tab: { id: 1, documentSeq: 1 }, historySeq: undefined, onOpen: () => undefined })));
  const navIds = () => [...host.querySelectorAll<HTMLElement>('.settings-nav-item')].map((item) => item.dataset['testid']!.replace('settings-nav-', ''));
  const sectionIds = () => [...host.querySelectorAll<HTMLElement>('.settings-section')].map((section) => section.dataset['testid']!.replace('settings-', ''));
  const current = () => [...host.querySelectorAll<HTMLElement>('.settings-nav-item[aria-current]')].map((item) => [item.dataset['testid'], item.getAttribute('aria-current')]);
  const focusedId = () => (document.activeElement as HTMLElement | null)?.id;

  test('settings-sheet-leaves-out-unconfigured', async () => {
    // Before main answers: every section (each says "Loading…").
    render();
    await act(async () => void requestSettings(SETTINGS_BUTTON.section));
    expect(navIds()).toEqual(ALL);
    expect(sectionIds()).toEqual(ALL);
    expect(focusedId()).toBe('settings-section-account');
    act(() => root.unmount());
    root = createRoot(host);

    // A build with neither: both left out; the gear's request lands on the top (Data sources).
    store.account = account('unconfigured');
    store.gsc = gsc(false);
    render();
    await act(async () => void requestSettings(SETTINGS_BUTTON.section));
    const shown: SettingsSectionId[] = ['data-sources', 'locations', 'ai-checks', 'telemetry', 'history'];
    expect(navIds()).toEqual(shown);
    expect(sectionIds()).toEqual(shown);
    expect(host.querySelector('#settings-section-account, #settings-section-search-console, [data-testid="account-section"], [data-testid="gsc-section"]')).toBeNull();
    expect(current()).toEqual([['settings-nav-data-sources', 'true']]);
    expect(focusedId()).toBe('settings-section-data-sources');
    // A request for Search Console lands there too; one for a shown section lands on it.
    await act(async () => void requestSettings('telemetry'));
    expect(focusedId()).toBe('settings-section-telemetry');
    await act(async () => void requestSettings('search-console'));
    expect(focusedId()).toBe('settings-section-data-sources');
    expect(current()).toEqual([['settings-nav-data-sources', 'true']]);
  });

  test('settings-nav-follows-the-request', async () => {
    store.account = account('signed-out');
    store.gsc = gsc(true);
    render();
    await act(async () => void requestSettings('account'));
    expect(navIds()).toEqual(ALL);
    expect(current()).toEqual([['settings-nav-account', 'true']]);
    await act(async () => void requestSettings('history'));
    expect(current()).toEqual([['settings-nav-history', 'true']]);
    expect(focusedId()).toBe('settings-section-history');
    // A click in the list.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="settings-nav-locations"]')!.click());
    expect(current()).toEqual([['settings-nav-locations', 'true']]);
    expect(focusedId()).toBe('settings-section-locations');
  });
});
