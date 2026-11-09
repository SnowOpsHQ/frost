// @vitest-environment jsdom
// Spec: specs/browser-polish.spec.ts (HISTORY_RETENTIONS, DEFAULT_HISTORY_RETENTION, HISTORY_SETTINGS_TEXT),
// specs/account-settings.spec.ts (SETTINGS_SECTIONS: `history`)
// Acceptance: specs/browser-polish.feature.md (History retention, ranges and projects: settings-history)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SETTINGS_SECTIONS } from '@app/specs/account-settings.spec';
import { HISTORY_RETENTIONS, HISTORY_SETTINGS_TEXT } from '@app/specs/browser-polish.spec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Settings = { retention: string; keepProjectPages: boolean };
/** Main's side: what it holds, and whether the next write is stored. */
/** `answer`: what main's `setRetention` answers next (`cancelled`: the user said no in main's dialog). */
const main = { settings: { retention: 'forever', keepProjectPages: true } as Settings, answer: 'stored' as 'stored' | 'cancelled' | 'failed', readFails: 0, reads: 0 };
const writes: Settings[] = [];
let release: (() => void) | null = null;
vi.mock('../ipc', () => ({
  actions: {
    historyRetention: async () => {
      main.reads += 1;
      if (main.readFails > 0) {
        main.readFails -= 1;
        return null;
      }
      return { ...main.settings };
    },
    setHistoryRetention: (next: Settings) => {
      writes.push(next);
      return new Promise<string>((resolve) => {
        release = () => {
          if (main.answer === 'stored') main.settings = { ...next };
          resolve(main.answer);
        };
      });
    },
  },
}));

const { HistorySettings } = await import('../settings-history');

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  main.settings = { retention: 'forever', keepProjectPages: true };
  main.answer = 'stored';
  main.readFails = 0;
  main.reads = 0;
  writes.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="history-retention"]')];
const checked = () => radios().find((radio) => radio.getAttribute('aria-checked') === 'true')?.dataset['retention'];
const keep = () => host.querySelector<HTMLButtonElement>('[data-testid="history-keep-project-pages"]')!;

test('settings-history', async () => {
  expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain('history');
  await act(async () => root.render(createElement(HistorySettings)));
  // Main's settings, every retention offered, in order.
  expect(radios().map((r) => r.dataset['retention'])).toEqual(HISTORY_RETENTIONS.map((r) => r.id));
  expect(checked()).toBe('forever');
  expect(keep().getAttribute('aria-checked')).toBe('true');
  expect(host.textContent).toContain(HISTORY_SETTINGS_TEXT.keepProjectPages);
  // A click asks main; the controls wait (aria-disabled) and the checked one stays main's until it answers.
  act(() => radios()[3]!.click());
  expect(writes).toEqual([{ retention: '7d', keepProjectPages: true }]);
  expect(radios()[3]!.getAttribute('aria-disabled')).toBe('true');
  expect(checked()).toBe('forever');
  // A second click while busy sends nothing.
  act(() => keep().click());
  expect(writes).toHaveLength(1);
  await act(async () => release!());
  expect(checked()).toBe('7d');
  expect(radios()[0]!.getAttribute('aria-disabled')).toBeNull();
  // The switch.
  act(() => keep().click());
  expect(writes[1]).toEqual({ retention: '7d', keepProjectPages: false });
  await act(async () => release!());
  expect(keep().getAttribute('aria-checked')).toBe('false');
  // A write main could not store: main's settings stay checked, and the section says so.
  main.answer = 'failed';
  act(() => radios()[1]!.click());
  await act(async () => release!());
  expect(checked()).toBe('7d');
  expect(host.querySelector('[data-testid="history-settings-note"]')?.textContent).toBe(HISTORY_SETTINGS_TEXT.failed);
  // Choosing what is already checked sends nothing.
  act(() => radios()[3]!.click());
  expect(writes).toHaveLength(3);
});

test('settings-history-cancelled-and-read-failure', async () => {
  // The first read fails: an error with "Try again", never "Loading…" for ever.
  main.readFails = 1;
  await act(async () => root.render(createElement(HistorySettings)));
  expect(host.querySelector('[data-testid="history-settings-read-failed"]')?.textContent).toBe(HISTORY_SETTINGS_TEXT.readFailed);
  expect(host.textContent).not.toContain(HISTORY_SETTINGS_TEXT.loading);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="history-settings-retry"]')!.click());
  expect(checked()).toBe('forever');
  // Shortening, and the user says no in main's dialog: the stored choice is checked again, with a note.
  main.answer = 'cancelled';
  act(() => radios()[2]!.click());
  expect(writes).toEqual([{ retention: '30d', keepProjectPages: true }]);
  await act(async () => release!());
  expect(checked()).toBe('forever');
  expect(host.querySelector('[data-testid="history-settings-note"]')?.textContent).toBe(HISTORY_SETTINGS_TEXT.cancelled);
  // The switch reverts the same way.
  main.settings = { retention: '30d', keepProjectPages: true };
  act(() => keep().click());
  await act(async () => release!());
  expect(keep().getAttribute('aria-checked')).toBe('true');
});
