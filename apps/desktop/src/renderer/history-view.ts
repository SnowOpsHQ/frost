import type { HistoryVisitAnswer } from '@app/ipc-contract';
import { parseWebUrl } from '@app/specs/web-url.spec';

// Pure helpers of the History view and the new-tab page's "Jump back in" (spec
// `browser-polish.spec.ts`; acceptance `browser-polish.feature.md`). No React, no IPC.

export interface HistoryDay {
  /** `YYYY-MM-DD` in local time. */
  readonly key: string;
  readonly label: string;
  readonly visits: readonly HistoryVisitAnswer[];
}

const pad = (n: number) => String(n).padStart(2, '0');
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The heading of the local day `at` falls in: Today, Yesterday, else a long date (`locale`). */
export function dayLabel(at: number, now: number, locale?: string): string {
  const day = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(day) === dayKey(today)) return 'Today';
  if (dayKey(day) === dayKey(yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(day);
}

/** Visits (newest first, as listed) grouped by local day, in order. */
export function groupByDay(visits: readonly HistoryVisitAnswer[], now: number, locale?: string): HistoryDay[] {
  const days: { key: string; label: string; visits: HistoryVisitAnswer[] }[] = [];
  for (const visit of visits) {
    const key = dayKey(new Date(visit.lastVisitAt));
    const last = days[days.length - 1];
    if (last && last.key === key) last.visits.push(visit);
    else days.push({ key, label: dayLabel(visit.lastVisitAt, now, locale), visits: [visit] });
  }
  return days;
}

/** A visit's time of day (`locale`, hours and minutes). */
export function visitTime(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(at));
}

/** The host (with port) of a visit's URL, or the URL itself. */
export function visitHost(url: string): string {
  return parseWebUrl(url)?.host ?? url;
}

/** What a row or tile is called: its title, else its host. */
export function visitLabel(visit: Pick<HistoryVisitAnswer, 'title' | 'url'>): string {
  const title = visit.title.trim();
  return title !== '' ? title : visitHost(visit.url);
}

/** A tile's monogram: the first letter or digit of its host (without `www.`), upper-case; `?` without one. */
export function monogram(url: string): string {
  const host = (parseWebUrl(url)?.hostname ?? '').replace(/^www\./, '');
  const first = [...host].find((c) => /[\p{L}\p{N}]/u.test(c));
  return first ? first.toLocaleUpperCase() : '?';
}

/** Appends a page to what is listed, never listing a URL twice (a visit moved by a newer one). */
export function appendPage(listed: readonly HistoryVisitAnswer[], page: readonly HistoryVisitAnswer[]): HistoryVisitAnswer[] {
  const seen = new Set(listed.map((v) => v.url));
  return [...listed, ...page.filter((v) => !seen.has(v.url))];
}
