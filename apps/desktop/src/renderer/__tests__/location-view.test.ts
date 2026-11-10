// @vitest-environment jsdom
// Spec: specs/location-profiles.spec.ts (LOCATION_BADGE, LOCATION_PALETTE, LOCATIONS_SETTINGS_TEXT, LOCATION_SCHEME_LABELS,
// LOCATION_NOT_PROXIED_NOTE), specs/location-profiles.schema.ts (LocationProfilesView, LocationProfileInput),
// specs/browser.spec.ts (TabState.location), specs/account-settings.spec.ts (SETTINGS_SECTIONS: `locations`)
// Acceptance: specs/location-profiles.feature.md (location-badge-always-visible; Behaviour: Settings, New tab in location)
// · plan docs/plans/phase-12-big-bets.md, Decision 11, Task 10b
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SETTINGS_SECTIONS } from '@app/specs/account-settings.spec';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { LOCATION_BADGE, LOCATION_PALETTE, LOCATIONS_SETTINGS_TEXT as TEXT } from '@app/specs/location-profiles.spec';
import type { LocationProfilesView } from '@app/specs/location-profiles.schema';
import { locationBadge } from '../location-view';
import { locationPaletteSources } from '../location-palette';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';
import { locationInput, locationRows, locationWriteMessage } from '../settings-locations-view';

vi.mock('../ipc', () => ({ actions: { activateTab: vi.fn(), closeTab: vi.fn(), newTab: vi.fn() }, ipc: {} }));
const calls = vi.hoisted(() => ({ list: [] as unknown[], create: [] as unknown[] }));
vi.mock('../settings-locations-actions', () => ({
  locationActions: {
    list: vi.fn(async () => ({ protection: 'os', profiles: [] })),
    create: vi.fn(async (input: unknown) => {
      calls.create.push(input);
      return 'saved';
    }),
    update: vi.fn(async () => 'saved'),
    remove: vi.fn(async () => 'removed'),
    newTab: vi.fn(async () => 'opened'),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: the strip scrolls its active tab into view.
Element.prototype.scrollIntoView = vi.fn();

const ID = '01920000-0000-7000-8000-0000000000c1';
const ID_2 = '01920000-0000-7000-8000-0000000000c2';
const BERLIN = { profileId: ID, label: 'Berlin' };

function tab(id: number, changes: Partial<TabState> = {}): TabState {
  return { id, url: 'https://site.example/', title: 'A very long page title that is cut in the strip', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 0, documentSeq: 1, highlight: 'off', highlightPhrase: null, renderProfile: null, tabOverrides: { cssDisabled: false, cookiesDisabled: false, geolocation: null }, loadedUnderOverrides: false, overridesRevision: 0, overridesStatus: 'active', ...changes };
}

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

describe('location badge', () => {
  test('location-badge-always-visible', async () => {
    expect(locationBadge(tab(1))).toBeNull();
    expect(locationBadge(tab(1, { location: null }))).toBeNull();
    expect(locationBadge(tab(1, { location: BERLIN }))).toEqual({ text: LOCATION_BADGE.text('Berlin'), title: LOCATION_BADGE.title('Berlin') });
    const { TabStrip } = await import('../components/TabStrip');
    const state = { version: 1, tabs: [tab(1), tab(2, { location: BERLIN }), tab(3, { location: { profileId: ID_2, label: 'Paris' } })], activeTabId: 2 } as unknown as BrowserState;
    act(() => root.render(createElement(TabStrip, { state })));
    const items = [...host.querySelectorAll('[data-testid="tab"]')];
    const badges = items.map((item) => item.querySelector('[data-testid="tab-location"]'));
    // Every location tab, active (2) or not (3); never a home tab (1).
    expect(badges.map((badge) => badge?.textContent ?? null)).toEqual([null, 'Berlin', 'Paris']);
    expect(badges[2]!.getAttribute('title')).toBe(LOCATION_BADGE.title('Paris'));
    // Outside the label that is cut with an ellipsis, so a long title never hides it.
    for (const badge of badges.slice(1)) expect(badge!.closest('[data-testid="tab-label"]')).toBeNull();
    // Its style never lets it shrink away.
    const css = readFileSync(path.resolve(__dirname, '../location.css'), 'utf8');
    expect(css).toMatch(/\.tab-location\s*\{[^}]*flex:\s*none/);
    const rule = /\.tab-location\s*\{([^}]*)\}/.exec(css)![1]!;
    // Never cut: no width cap, no ellipsis, nothing hidden; the label gives way first.
    expect(rule).not.toMatch(/max-width|text-overflow|overflow|min-width|flex-shrink:\s*[1-9]/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('settings › locations', () => {
  const VIEW: LocationProfilesView = {
    protection: 'os',
    profiles: [
      { id: ID, label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: 3128, hasCredentials: true },
      { id: ID_2, label: 'Tunnel', scheme: 'socks5', host: '127.0.0.1', port: 9050, hasCredentials: false },
    ],
  };

  test('settings-locations-rows', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain('locations');
    const rows = locationRows(VIEW);
    expect(rows.map((r) => [r.label, r.proxy, r.signIn])).toEqual([
      ['Berlin', 'HTTP proxy.example.net:3128', TEXT.credentialsSet],
      ['Tunnel', 'SOCKS5 127.0.0.1:9050', null],
    ]);
  });

  test('settings-locations-input', () => {
    // A SOCKS5 profile never sends a sign-in; blank fields keep (edit) or skip (new) it.
    expect(locationInput({ label: 'Tunnel', scheme: 'socks5', host: '127.0.0.1', port: '9050', username: 'u', password: 'p' })).toEqual({ label: 'Tunnel', scheme: 'socks5', host: '127.0.0.1', port: 9050 });
    expect(locationInput({ label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: '3128', username: '', password: '' })).toEqual({ label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: 3128 });
    expect(locationInput({ label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: '3128', username: 'me', password: 'pw' })).toEqual({ label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: 3128, username: 'me', password: 'pw' });
    // Not a port: invalid before anything is sent.
    expect(locationInput({ label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: '80a', username: '', password: '' })).toBeNull();
    expect(locationInput({ label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: '3128', username: 'me', password: '' })).toBeNull();
    expect(locationWriteMessage('saved')).toBe(TEXT.results.saved);
    expect(locationWriteMessage('nope' as never)).toBe(TEXT.results.failed);
  });

  test('location-palette-new-tab', () => {
    let profiles: LocationProfilesView['profiles'] | null = null;
    const newTab = vi.fn(async () => 'opened' as const);
    const openSettings = vi.fn();
    const refresh = vi.fn();
    const registry = createPaletteRegistry();
    registry.register(...locationPaletteSources({ profiles: () => profiles, refresh, newTab, openSettings }));
    const ctx = {} as PaletteContext;
    // Before main answered: only the settings entry.
    expect(registry.resolve(ctx).map((a) => a.id)).toEqual(['location.settings']);
    expect(refresh).toHaveBeenCalled();
    profiles = [...(VIEW.profiles as LocationProfilesView['profiles'])];
    const actions = registry.resolve(ctx);
    expect(actions.map((a) => a.label)).toEqual([LOCATION_PALETTE.label('Berlin'), LOCATION_PALETTE.label('Tunnel'), LOCATION_PALETTE.manage]);
    void actions[0]!.run(ctx);
    expect(newTab).toHaveBeenCalledWith(ID);
    void actions[2]!.run(ctx);
    expect(openSettings).toHaveBeenCalled();
  });

  test('settings-locations-sign-in-never-rendered', async () => {
    const { LocationsSettings } = await import('../settings-locations');
    await act(async () => root.render(createElement(LocationsSettings)));
    expect(host.querySelector('[data-testid="location-not-proxied"]')!.textContent).toBe(TEXT.notProxied);
    expect(host.querySelector('[data-testid="location-permissions"]')!.textContent).toBe(TEXT.permissions);
    await act(async () => (host.querySelector('[data-testid="location-add"]') as HTMLButtonElement).click());
    const set = (testId: string, value: string) => {
      const input = host.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input;
    };
    set('location-label', 'Berlin');
    set('location-host', 'proxy.example.net');
    set('location-port', '3128');
    // An HTTP proxy (the default): the form says a sign-in travels unencrypted.
    expect(host.querySelector('[data-testid="location-http-sign-in"]')!.textContent).toBe(TEXT.httpSignIn);
    const user = set('location-username', 'me');
    const pass = set('location-password', 'pw-SECRET-1');
    expect(user.type).toBe('password');
    expect(pass.type).toBe('password');
    await act(async () => (host.querySelector('[data-testid="location-save"]') as HTMLButtonElement).click());
    // Sent once to main, the fields emptied, and the sign-in never on the page.
    expect(calls.create).toEqual([{ label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: 3128, username: 'me', password: 'pw-SECRET-1' }]);
    expect(host.innerHTML).not.toContain('pw-SECRET-1');
  });
});
