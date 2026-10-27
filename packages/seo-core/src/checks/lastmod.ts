import { LASTMOD_FUTURE_SLACK_MS, type LastmodIssue } from '@app/specs/seo-checks.spec';

// `lastmod` sanity (spec `seo-checks.spec.ts`, `LASTMOD_ISSUES`, `LASTMOD_FUTURE_SLACK_MS`;
// acceptance `seo-checks.feature.md`, Sitemaps). The sitemaps protocol asks for a W3C Datetime:
// `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a date with a time to the minute, second or fraction of a
// second and a time zone (`Z`, `+hh:mm`, `-hh:mm`). Anything else is `invalid`; a valid value whose
// earliest moment is more than `LASTMOD_FUTURE_SLACK_MS` after `now` is `future`.

const W3C_DATETIME = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

const daysIn = (year: number, month: number): number => (month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31);

/** The earliest moment `value` names (epoch ms), or `null` when it is not a W3C Datetime. */
export function lastmodTime(value: string): number | null {
  const match = W3C_DATETIME.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zone] = match;
  const year = Number(y);
  const month = mo === undefined ? 1 : Number(mo);
  const day = d === undefined ? 1 : Number(d);
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = s === undefined ? 0 : Number(s);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (zone !== undefined && zone !== 'Z') {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 14 || zm > 59) return null;
    offset = (zone.startsWith('-') ? -1 : 1) * (zh * 60 + zm) * 60_000;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) - offset;
}

/** What is wrong with `value` as a `lastmod` checked at `now`, or `null` when nothing is. */
export function lastmodIssue(value: string, now: number): LastmodIssue | null {
  const time = lastmodTime(value);
  if (time === null) return 'invalid';
  return time > now + LASTMOD_FUTURE_SLACK_MS ? 'future' : null;
}
