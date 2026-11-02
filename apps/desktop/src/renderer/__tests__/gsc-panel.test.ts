// @vitest-environment jsdom
// Spec: specs/gsc-panel.spec.ts (GSC_PANEL_COPY, GSC_READ_DEBOUNCE_MS, GSC_FILTER_TEXT, GSC_CALENDAR), specs/gsc.spec.ts (GscStatus),
// specs/entitlements-snapshot.spec.ts (UNGATED_FEATURES: the panel needs no frost account, 2026-10-29)
// Acceptance: specs/gsc-panel.feature.md (Panel)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TabState } from '@app/specs/browser.spec';
import { GSC_FILTER_TEXT, GSC_READ_DEBOUNCE_MS } from '@app/specs/gsc-panel.spec';
import type { GscStatus } from '@app/specs/gsc.spec';

/** What the faked `gsc.watch` answers first (later polls wait forever), and the calls made. */
const fake = vi.hoisted(() => ({
  /** Each mount's fresh stores answer once per generation. */
  generation: 0,
  gsc: null as unknown,
  accountWatches: 0,
  performance: [] as unknown[],
  topQueries: [] as unknown[],
  countries: [] as unknown[],
}));
vi.mock('../ipc', () => {
  const never = () => new Promise<never>(() => undefined);
  const once = (value: () => unknown) => {
    let answered = -1;
    return () => {
      if (answered === fake.generation) return never();
      answered = fake.generation;
      return Promise.resolve(value());
    };
  };
  return {
    actions: {},
    ipc: {
      account: { watch: { query: () => (fake.accountWatches++, never()) }, settingsWatch: { query: never } },
      gsc: {
        watch: { query: once(() => fake.gsc) },
        performance: { query: (input: unknown) => (fake.performance.push(input), never()) },
        topQueries: { query: (input: unknown) => (fake.topQueries.push(input), never()) },
        countries: { query: (input: unknown) => (fake.countries.push(input), never()) },
      },
    },
  };
});

const URL_A = 'https://www.example.com/a';
const TAB = { id: 1, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null } as TabState;

const gsc = (changes: Partial<GscStatus>): GscStatus => ({ configured: true, entitled: true, connected: true, connecting: false, keychain: 'persistent', error: null, version: 1, ...changes });

let root: Root;
let host: HTMLDivElement;

/** Mounts the panel with fresh stores (a fresh module graph) and lets the watches and the debounce pass. */
async function mount(status: GscStatus): Promise<string | null> {
  fake.gsc = status;
  fake.generation += 1;
  vi.resetModules();
  const { GscPanel } = await import('../components/seo/GscPanel');
  await act(async () => {
    root.render(createElement(GscPanel, { tab: TAB }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(GSC_READ_DEBOUNCE_MS * 4);
  });
  return host.querySelector('[data-testid="gsc-panel"]')?.getAttribute('data-state') ?? null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  fake.performance.length = 0;
  fake.topQueries.length = 0;
  fake.countries.length = 0;
  fake.accountWatches = 0;
  host = document.createElement('div');
  // In the document, so focus moves can be checked.
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('GscPanel', () => {
  test('gsc-panel-reads-only-when-connected', async () => {
    expect(await mount(gsc({ connected: false }))).toBe('not-connected');
    expect(fake.performance).toEqual([]);
    expect(fake.topQueries).toEqual([]);
    expect(fake.countries).toEqual([]);
    act(() => root.unmount());
    root = createRoot(host);

    // Connected, and nobody signed in to frost (the account is never asked): one read of each.
    expect(await mount(gsc({}))).toBe('loading');
    expect(fake.performance).toEqual([{ url: URL_A, scope: 'page', days: 28 }]);
    expect(fake.topQueries).toEqual([{ url: URL_A, scope: 'page', days: 28 }]);
    // The country list of the same page and range (no filter by default).
    expect(fake.countries).toEqual([{ url: URL_A, scope: 'page', days: 28 }]);
    expect(fake.accountWatches).toBe(0);
    // Two fresh module graphs: give a loaded CI runner room beyond the 5 s default.
  }, 30_000);

  test('custom-range-only-from-its-button', async () => {
    expect(await mount(gsc({}))).toBe('loading');
    const dialog = () => host.querySelector('[role="dialog"]');
    const select = host.querySelector<HTMLSelectElement>('[data-testid="gsc-range-select"]')!;
    // The select holds the month presets only; a `change` to any option (as arrowing through a closed
    // select fires on Windows and Linux) applies it and never opens the calendar.
    const values = [...select.options].map((option) => option.value);
    expect(values).toEqual(['', '3m', '6m', '12m', '16m']);
    for (const value of [...values.slice(1), ...values.slice(1).reverse()]) {
      act(() => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(dialog(), value).toBeNull();
      expect(select.value).toBe(value);
    }
    // The Custom range button opens it (a dialog popup) …
    const button = host.querySelector<HTMLButtonElement>('[data-testid="gsc-custom-range"]')!;
    expect(button.textContent).toBe(GSC_FILTER_TEXT.customOption);
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.focus();
    act(() => button.click());
    expect(dialog()).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    // … and Escape closes it, focus back on the button.
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  }, 30_000);
});
