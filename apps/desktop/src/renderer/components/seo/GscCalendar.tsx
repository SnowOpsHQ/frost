import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { GSC_CALENDAR } from '@app/specs/gsc-panel.spec';
import type { GscDateRange } from '@app/specs/gsc.spec';
import { formatDay, orderedRange } from '../../gsc-view';
import { ChevronIcon } from '../../icons';

// The Search Console panel's custom range calendar (Phase 9 Task 3; spec `GSC_CALENDAR`; acceptance
// `gsc-panel.feature.md`, Calendar). A modal dialog popover following the WAI-ARIA date picker
// dialog: one month's `grid` with a roving tabindex (one day tabbable), arrows (a day, a week),
// Home/End (the week's ends, from the locale's week start), PageUp/PageDown (a month; with Shift, a
// year), Enter/Space picks; Escape closes and returns focus to what opened it; Tab stays inside. The
// first pick is the start, the second the end (they swap when picked backwards), which applies the
// range and closes. Days outside `bounds` (Search Console's retention to the lag day) are
// `aria-disabled`, never focused or picked. Classes only, no `style=` (strict CSP). Dates are UTC days
// (`YYYY-MM-DD`), as Search Console's.

const DAY_MS = 86_400_000;
const msOf = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, days: number): string => isoOf(msOf(iso) + days * DAY_MS);

/** `iso` moved by `months` calendar months (the day clamped to the month's last). */
function addMonths(iso: string, months: number): string {
  const at = new Date(msOf(iso));
  const total = at.getUTCFullYear() * 12 + at.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return isoOf(Date.UTC(year, month, Math.min(at.getUTCDate(), lastDay)));
}

/** ISO weekday: `1` Monday … `7` Sunday. */
const weekdayOf = (iso: string): number => new Date(msOf(iso)).getUTCDay() || 7;
/** The first day of `iso`'s week when weeks start on `weekStart`. */
const weekStartOf = (iso: string, weekStart: number): string => addDays(iso, -((weekdayOf(iso) - weekStart + 7) % 7));
const clampDay = (iso: string, bounds: CalendarBounds): string => (iso < bounds.min ? bounds.min : iso > bounds.max ? bounds.max : iso);
const monthOf = (iso: string): string => iso.slice(0, 7);

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** "October 2026". */
const monthTitle = (iso: string): string => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** The weeks of `iso`'s month, each seven days from `weekStart` (`null`: a day of another month). */
function monthWeeks(iso: string, weekStart: number): (string | null)[][] {
  const first = `${monthOf(iso)}-01`;
  const month = monthOf(iso);
  const weeks: (string | null)[][] = [];
  for (let day = weekStartOf(first, weekStart); weeks.length < GSC_CALENDAR.maxWeeks; ) {
    const week: (string | null)[] = [];
    for (let i = 0; i < 7; i++, day = addDays(day, 1)) week.push(monthOf(day) === month ? day : null);
    if (week.every((d) => d === null)) break;
    weeks.push(week);
  }
  return weeks;
}

/**
 * The locale's first day of the week (`1` Monday … `7` Sunday) from `Intl.Locale`'s week info, else
 * `GSC_CALENDAR.fallbackWeekStart`.
 */
export function localeWeekStart(locale: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.language): number {
  try {
    const info = new Intl.Locale(locale ?? 'en-US') as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
    return Number.isInteger(firstDay) && firstDay! >= 1 && firstDay! <= 7 ? firstDay! : GSC_CALENDAR.fallbackWeekStart;
  } catch {
    return GSC_CALENDAR.fallbackWeekStart;
  }
}

export interface CalendarBounds {
  /** The first day that can be picked (`gscRetentionStart`). */
  readonly min: string;
  /** The last day that can be picked (the lag day). */
  readonly max: string;
}

export interface GscCalendarProps {
  readonly bounds: CalendarBounds;
  /** The current custom range (shown selected until the first pick), or `null`. */
  readonly value: GscDateRange | null;
  /** `1` Monday … `7` Sunday (`localeWeekStart`). */
  readonly weekStart: number;
  /** Both days picked, in order. The calendar then closes (`onClose`). */
  readonly onPick: (range: GscDateRange) => void;
  /** The calendar is done (picked, cancelled, Escape, a click outside); the parent unmounts it. */
  readonly onClose: () => void;
  /** What gets focus back on close (default: what had focus when it opened). */
  readonly returnFocus?: HTMLElement | null;
}

export function GscCalendar({ bounds, value, weekStart, onPick, onClose, returnFocus }: GscCalendarProps) {
  // What opened it (the select or the dates button) gets focus back on close.
  const [opener] = useState(() => returnFocus ?? (typeof document === 'undefined' ? null : document.activeElement));
  const [focused, setFocused] = useState(() => clampDay(value?.end ?? bounds.max, bounds));
  const [start, setStart] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLTableElement>(null);
  // Whether a change of the focused day moves DOM focus to it (on open and from the grid's keys; not
  // from the month buttons, which keep focus).
  const focusDay = useRef(true);
  const headingId = useId();
  const statusId = useId();
  const { text } = GSC_CALENDAR;

  const close = (restore: boolean) => {
    if (restore && opener instanceof HTMLElement) opener.focus();
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (focusDay.current) grid.current?.querySelector<HTMLElement>(`[data-date="${focused}"]`)?.focus();
  }, [focused]);

  // A press outside the dialog (but not on its opener, which toggles it) closes it, leaving focus there.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && dialog.current && !dialog.current.contains(target) && !(opener instanceof Node && opener.contains(target))) closeRef.current(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [opener]);

  const available = (day: string) => day >= bounds.min && day <= bounds.max;
  const selected = (day: string) => (start !== null ? day === start : value !== null && day >= value.start && day <= value.end);
  const canPrevious = monthOf(focused) > monthOf(bounds.min);
  const canNext = monthOf(focused) < monthOf(bounds.max);

  const pick = (day: string) => {
    if (!available(day)) return;
    setFocused(day);
    if (start === null) {
      setStart(day);
      return;
    }
    onPick(orderedRange(start, day));
    close(true);
  };

  const showMonth = (months: number) => {
    const next = clampDay(addMonths(focused, months), bounds);
    // The button is about to be disabled (an end reached): focus goes to the day instead of the body.
    focusDay.current = months < 0 ? monthOf(next) <= monthOf(bounds.min) : monthOf(next) >= monthOf(bounds.max);
    setFocused(next);
  };

  const onGridKey = (event: KeyboardEvent<HTMLTableElement>) => {
    let next: string;
    switch (event.key) {
      case 'ArrowLeft':
        next = addDays(focused, -1);
        break;
      case 'ArrowRight':
        next = addDays(focused, 1);
        break;
      case 'ArrowUp':
        next = addDays(focused, -7);
        break;
      case 'ArrowDown':
        next = addDays(focused, 7);
        break;
      case 'Home':
        next = weekStartOf(focused, weekStart);
        break;
      case 'End':
        next = addDays(weekStartOf(focused, weekStart), 6);
        break;
      case 'PageUp':
        next = addMonths(focused, event.shiftKey ? -12 : -1);
        break;
      case 'PageDown':
        next = addMonths(focused, event.shiftKey ? 12 : 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        pick(focused);
        return;
      default:
        return;
    }
    event.preventDefault();
    focusDay.current = true;
    const clamped = clampDay(next, bounds);
    if (clamped === focused) grid.current?.querySelector<HTMLElement>(`[data-date="${focused}"]`)?.focus();
    else setFocused(clamped);
  };

  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    // Modal: Tab and Shift+Tab wrap inside the dialog.
    const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const order = Array.from({ length: 7 }, (_, i) => ((weekStart - 1 + i) % 7) + 1);
  return (
    <div ref={dialog} className="gsc-cal" role="dialog" aria-modal="true" aria-label={text.dialogLabel} data-testid="gsc-calendar" onKeyDown={onDialogKey}>
      <div className="gsc-cal-head">
        <button
          type="button"
          className="gsc-cal-nav gsc-cal-previous"
          data-testid="gsc-calendar-previous"
          aria-label={text.previousMonth}
          disabled={!canPrevious}
          onClick={() => {
            focusDay.current = false;
            showMonth(-1);
          }}
        >
          <ChevronIcon />
        </button>
        <h2 id={headingId} className="gsc-cal-month" data-testid="gsc-calendar-month" aria-live="polite">
          {monthTitle(focused)}
        </h2>
        <button
          type="button"
          className="gsc-cal-nav gsc-cal-next"
          data-testid="gsc-calendar-next"
          aria-label={text.nextMonth}
          disabled={!canNext}
          onClick={() => {
            focusDay.current = false;
            showMonth(1);
          }}
        >
          <ChevronIcon />
        </button>
      </div>
      <table ref={grid} className="gsc-cal-grid" role="grid" aria-labelledby={headingId} aria-describedby={statusId} aria-multiselectable="true" onKeyDown={onGridKey}>
        <thead>
          <tr>
            {order.map((weekday) => (
              <th key={weekday} scope="col" abbr={WEEKDAYS[weekday - 1]} className="gsc-cal-weekday">
                {WEEKDAYS[weekday - 1]!.slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthWeeks(focused, weekStart).map((week) => (
            <tr key={week.find((d) => d !== null)}>
              {week.map((day, i) => {
                if (day === null) return <td key={`blank-${i}`} className="gsc-cal-blank" />;
                const open = available(day);
                const chosen = open && selected(day);
                return (
                  <td
                    key={day}
                    className="gsc-cal-day"
                    data-date={day}
                    data-edge={chosen && (day === start || day === value?.start || day === value?.end) ? 'true' : undefined}
                    tabIndex={open ? (day === focused ? 0 : -1) : undefined}
                    aria-disabled={open ? undefined : 'true'}
                    aria-selected={open ? chosen : undefined}
                    aria-label={formatDay(day)}
                    onFocus={open ? () => setFocused(day) : undefined}
                    onClick={() => pick(day)}
                  >
                    {Number(day.slice(8))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="gsc-cal-foot">
        <p id={statusId} className="gsc-cal-status" data-testid="gsc-calendar-status" aria-live="polite">
          {start === null ? text.pickStart : text.pickEnd}
        </p>
        <button type="button" className="panel-button" data-testid="gsc-calendar-cancel" onClick={() => close(true)}>
          {text.cancel}
        </button>
      </div>
    </div>
  );
}
