// @vitest-environment jsdom
// Spec: specs/gsc-panel.spec.ts (GSC_CALENDAR), specs/gsc.spec.ts (gscRetentionStart, gscDateRange)
// Acceptance: specs/gsc-panel.feature.md (Calendar)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GSC_CALENDAR } from '@app/specs/gsc-panel.spec';
import { gscDateRange, gscRetentionStart, type GscDateRange } from '@app/specs/gsc.spec';
import { GscCalendar } from '../components/seo/GscCalendar';

const NOW = Date.parse('2026-10-28T15:00:00Z');
// Oct 26, 2026 (the lag day, a Monday) back to Jun 28, 2025.
const BOUNDS = { min: gscRetentionStart(NOW), max: gscDateRange(1, NOW).end };

let host: HTMLDivElement;
let root: Root;
let opener: HTMLButtonElement;
let onPick: ReturnType<typeof vi.fn<(range: GscDateRange) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

function open(weekStart = 1, value: GscDateRange | null = null) {
  opener.focus();
  act(() => root.render(createElement(GscCalendar, { bounds: BOUNDS, value, weekStart, onPick, onClose })));
}
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]');
const grid = () => host.querySelector<HTMLElement>('[role="grid"]')!;
const day = (iso: string) => host.querySelector<HTMLElement>(`[data-date="${iso}"]`);
const focusedDate = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-date') ?? null;
const tabbable = () => [...grid().querySelectorAll<HTMLElement>('[tabindex="0"]')].map((cell) => cell.getAttribute('data-date'));
const heading = () => host.querySelector('[data-testid="gsc-calendar-month"]')!.textContent;
const button = (testId: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
function key(name: string, options: KeyboardEventInit = {}) {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options }));
  });
}
const press = (name: string, times: number, options: KeyboardEventInit = {}) => {
  for (let i = 0; i < times; i++) key(name, options);
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  opener = document.createElement('button');
  opener.textContent = 'Custom range';
  document.body.append(opener, host);
  root = createRoot(host);
  onPick = vi.fn<(range: GscDateRange) => void>();
  // The panel unmounts the calendar when it closes.
  onClose = vi.fn<() => void>(() => act(() => root.render(null)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  opener.remove();
});

describe('GscCalendar', () => {
  test('calendar-keyboard', () => {
    open();
    // A modal dialog with a grid of the month, labelled by its heading.
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute('aria-modal')).toBe('true');
    expect(dialog()!.getAttribute('aria-label')).toBe(GSC_CALENDAR.text.dialogLabel);
    expect(heading()).toBe('October 2026');
    expect(grid().getAttribute('aria-labelledby')).toBe(host.querySelector('[data-testid="gsc-calendar-month"]')!.id);
    // The locale's week start (here Monday) heads the first column.
    const columns = [...grid().querySelectorAll('th')];
    expect(columns.map((th) => th.getAttribute('abbr'))).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    // Focus starts on the last day there is, the only tabbable day (roving tabindex).
    expect(focusedDate()).toBe('2026-10-26');
    expect(tabbable()).toEqual(['2026-10-26']);
    expect(day('2026-10-26')!.getAttribute('aria-selected')).toBe('false');

    // Arrows: a day, a week.
    key('ArrowLeft');
    expect(focusedDate()).toBe('2026-10-25');
    key('ArrowUp');
    expect(focusedDate()).toBe('2026-10-18');
    key('ArrowRight');
    expect(focusedDate()).toBe('2026-10-19');
    key('ArrowDown');
    expect(focusedDate()).toBe('2026-10-26');
    expect(tabbable()).toEqual(['2026-10-26']);
    // Home / End: the week's first and last day.
    press('ArrowLeft', 5);
    expect(focusedDate()).toBe('2026-10-21');
    key('Home');
    expect(focusedDate()).toBe('2026-10-19');
    key('End');
    expect(focusedDate()).toBe('2026-10-25');
    // PageUp / PageDown: a month; with Shift, a year.
    key('PageUp');
    expect(focusedDate()).toBe('2026-09-25');
    expect(heading()).toBe('September 2026');
    key('PageDown');
    expect(focusedDate()).toBe('2026-10-25');
    key('PageUp', { shiftKey: true });
    expect(focusedDate()).toBe('2025-10-25');
    expect(heading()).toBe('October 2025');
    key('PageDown', { shiftKey: true });
    expect(focusedDate()).toBe('2026-10-25');
    // The month buttons move the month too (focus stays on the button) …
    button('gsc-calendar-previous').focus();
    act(() => button('gsc-calendar-previous').click());
    expect(heading()).toBe('September 2026');
    expect(tabbable()).toEqual(['2026-09-25']);
    expect(document.activeElement).toBe(button('gsc-calendar-previous'));
    // … unless it disables (the last month): then focus goes to the day, never to the page.
    button('gsc-calendar-next').focus();
    act(() => button('gsc-calendar-next').click());
    expect(heading()).toBe('October 2026');
    expect(button('gsc-calendar-next').disabled).toBe(true);
    expect(focusedDate()).toBe('2026-10-25');

    // Enter picks the start.
    expect(host.querySelector('[data-testid="gsc-calendar-status"]')!.textContent).toBe(GSC_CALENDAR.text.pickStart);
    key('Enter');
    expect(day('2026-10-25')!.getAttribute('aria-selected')).toBe('true');
    expect(day('2026-10-24')!.getAttribute('aria-selected')).toBe('false');
    expect(host.querySelector('[data-testid="gsc-calendar-status"]')!.textContent).toBe(GSC_CALENDAR.text.pickEnd);
    expect(onPick).not.toHaveBeenCalled();
    // Space picks the end (before the start: they swap), applies and closes, focus back on the opener.
    press('ArrowLeft', 5);
    key(' ');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith({ start: '2026-10-20', end: '2026-10-25' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);

    // Opened on a range: it shows selected, focus on its end.
    open(7, { start: '2026-09-01', end: '2026-09-03' });
    expect(focusedDate()).toBe('2026-09-03');
    expect(['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'].map((iso) => day(iso)?.getAttribute('aria-selected') ?? null)).toEqual([null, 'true', 'true', 'true', 'false']);
    // Week start Sunday: Home from Thursday Sep 3 is Sunday Aug 30, End is Saturday Sep 5.
    expect(grid().querySelector('th')!.getAttribute('abbr')).toBe('Sunday');
    key('Home');
    expect(focusedDate()).toBe('2026-08-30');
    key('End');
    expect(focusedDate()).toBe('2026-09-05');
    // Tab stays inside the dialog.
    const focusables = [...dialog()!.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')];
    focusables.at(-1)!.focus();
    key('Tab');
    expect(document.activeElement).toBe(focusables[0]);
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(focusables.at(-1));
    // Escape closes without a change and returns focus.
    day('2026-09-05')!.focus();
    key('Enter');
    key('Escape');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('calendar-disables-unavailable-days', () => {
    open();
    // After the lag day: disabled, never tabbable, not picked by a click.
    for (const iso of ['2026-10-27', '2026-10-28', '2026-10-31']) {
      expect(day(iso)!.getAttribute('aria-disabled'), iso).toBe('true');
      expect(day(iso)!.hasAttribute('tabindex'), iso).toBe(false);
      expect(day(iso)!.hasAttribute('aria-selected'), iso).toBe(false);
    }
    expect(day('2026-10-26')!.hasAttribute('aria-disabled')).toBe(false);
    act(() => day('2026-10-28')!.click());
    expect(host.querySelector('[aria-selected="true"]')).toBeNull();
    // Keys stop at the last day; the next month cannot be shown.
    key('ArrowRight');
    key('ArrowDown');
    key('PageDown');
    key('PageDown', { shiftKey: true });
    expect(focusedDate()).toBe('2026-10-26');
    expect(button('gsc-calendar-next').disabled).toBe(true);
    expect(button('gsc-calendar-previous').disabled).toBe(false);

    // Back to the first month Search Console still holds: June 2025, from the 28th.
    key('PageUp', { shiftKey: true });
    press('PageUp', 4);
    expect(heading()).toBe('June 2025');
    // Jul 26 back a month is Jun 26, before the first day: focus stops at Jun 28.
    expect(focusedDate()).toBe('2025-06-28');
    for (const iso of ['2025-06-01', '2025-06-20', '2025-06-27']) {
      expect(day(iso)!.getAttribute('aria-disabled'), iso).toBe('true');
      expect(day(iso)!.hasAttribute('tabindex'), iso).toBe(false);
    }
    expect(day('2025-06-28')!.hasAttribute('aria-disabled')).toBe(false);
    act(() => day('2025-06-20')!.click());
    expect(host.querySelector('[aria-selected="true"]')).toBeNull();
    key('ArrowLeft');
    key('ArrowUp');
    key('Home');
    key('PageUp');
    expect(focusedDate()).toBe('2025-06-28');
    expect(button('gsc-calendar-previous').disabled).toBe(true);
    // A click on an available day picks it.
    act(() => day('2025-06-30')!.click());
    expect(day('2025-06-30')!.getAttribute('aria-selected')).toBe('true');
    expect(onPick).not.toHaveBeenCalled();
    act(() => day('2025-06-29')!.click());
    expect(onPick).toHaveBeenCalledWith({ start: '2025-06-29', end: '2025-06-30' });
  });
});
