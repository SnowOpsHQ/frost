// @vitest-environment jsdom
// Spec: specs/command-palette.spec.ts (Registration API), specs/account-settings.spec.ts (SETTINGS_PALETTE_ACTIONS, settingsSectionsShown)
// Acceptance: specs/account-settings.feature.md (Palette: settings-palette-follows-main-while-open)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { BrowserState } from '@app/specs/browser.spec';

/** The faked `gsc.watch`: its first answer is held until the test gives main's answer. */
const fake = vi.hoisted(() => ({ answerGsc: null as ((value: unknown) => void) | null }));
vi.mock('../ipc', () => {
  const never = () => new Promise<never>(() => undefined);
  let first = true;
  return {
    actions: { focusPage: async () => true },
    ipc: {
      account: { watch: { query: never }, settingsWatch: { query: never } },
      gsc: {
        watch: {
          query: () => {
            if (!first) return never();
            first = false;
            return new Promise((resolve) => (fake.answerGsc = resolve));
          },
        },
      },
    },
  };
});
// Importing the palette registers the built-ins; the settings view registers the Settings actions and what they read.
const { CommandPalette } = await import('../components/CommandPalette');
await import('../settings-view');
const { gscStore } = await import('../settings-hooks');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let unsubscribeGsc: () => void;
const state = (seq: number) => ({ commandPalette: { seq, returnFocus: 'chrome' } }) as unknown as BrowserState;
const render = (seq: number) =>
  act(() => root.render(createElement(CommandPalette, { state: state(seq), tab: undefined, audit: null, sidebarOpen: false, onSidebarOpenChange: () => undefined, onPanelJump: () => undefined })));
const offered = (id: string) => host.querySelector(`[data-action="${id}"]`) !== null;

beforeEach(() => {
  // jsdom lays nothing out: the page column must look tall enough for the sheet.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ height: 2000, width: 1000, top: 0, left: 0, right: 1000, bottom: 2000, x: 0, y: 0, toJSON: () => ({}) });
  // jsdom has no scrollIntoView (nothing to spy on): define it here, and `afterEach` removes it.
  Element.prototype.scrollIntoView = () => undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // As the real app's SettingsSlot does: the store polls whether or not the palette is open.
  unsubscribeGsc = gscStore.subscribe(() => undefined);
});
afterEach(() => {
  act(() => root.unmount());
  unsubscribeGsc();
  host.remove();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

test('settings-palette-follows-main-while-open (component)', async () => {
  render(0);
  render(1); // main opens the palette
  // Main has not answered yet: the section counts as shown (the UI never guesses).
  expect(offered('settings.search-console')).toBe(true);
  // Main answers that Search Console is not configured: nothing typed, nothing else changed.
  await act(async () => fake.answerGsc!({ version: 1, configured: false }));
  expect(offered('settings.open')).toBe(true);
  expect(offered('settings.search-console')).toBe(false);
});
