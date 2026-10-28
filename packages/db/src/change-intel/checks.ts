import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { MAX_HISTORY_PAGE, MAX_RETENTION_DAYS, MAX_RETENTION_VERSIONS, RETENTION_MODES, SHA256_HEX_PATTERN, type RetentionMode } from '@app/specs/capture-db.spec';
import { noteUrl } from '../content-notes';
import { isUuidv7 } from './ids';

// What a change-intelligence value must look like to be written, and to be read back (spec
// `capture-db.feature.md`, Behaviour). The database is a file in the profile: every value is checked
// both ways, and a row that fails is skipped, never handed to main.

export const isId = isUuidv7;
export const isHash = (value: unknown): value is string => typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
/** Unix milliseconds: a non-negative safe integer. */
export const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export const isCount = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
export const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** Non-empty text of at most `maxBytes` UTF-8 bytes (a string is never shorter in bytes than in UTF-16 units). */
export function isJson(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBytes && Buffer.byteLength(value, 'utf8') <= maxBytes;
}
export const isJsonOrNull = (value: unknown, maxBytes: number): value is string | null => value === null || isJson(value, maxBytes);

/** UTF-8 size of stored text. */
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A page URL as stored (`noteUrl`: `http(s)`, no userinfo, no fragment, capped), or `null`. */
export const pageKey = (url: unknown): string | null => noteUrl(url);
/** Whether a stored URL is in its stored form (a tampered one is not). */
export const isStoredUrl = (value: unknown): value is string => typeof value === 'string' && noteUrl(value) === value;

/** Trimmed `text` if it is a string, non-blank and at most `max` UTF-16 code units after trimming; else `null`. */
export function trimmedText(text: unknown, max: number): string | null {
  if (typeof text !== 'string' || text.length > max * 4 + 1_024) return null;
  const value = text.trim();
  return value !== '' && value.length <= max ? value : null;
}

/** A retention policy as stored: `forever` with no value, `versions`/`days` with N in range. */
export function isRetention(mode: unknown, value: unknown): mode is RetentionMode {
  if (!isOneOf(RETENTION_MODES, mode)) return false;
  if (mode === 'forever') return value === null;
  return isCount(value, 1) && value <= (mode === 'versions' ? MAX_RETENTION_VERSIONS : MAX_RETENTION_DAYS);
}

/** A page of reads: `limit` clamped to 1…`MAX_HISTORY_PAGE`. */
export const pageSize = (limit: unknown): number => Math.min(Math.max(Math.trunc(Number(limit)) || 1, 1), MAX_HISTORY_PAGE);

/** A column read no further than `max` characters plus one: a tampered huge value is never read whole, and fails its check. */
export const capped = (column: SQLiteColumn, max: number): SQL<unknown> => sql<unknown>`substr(${column}, 1, ${max + 1})`;

/** Ids per `IN (…)` list: well under SQLite's bound-parameter limit. */
export const IN_LIST_MAX = 500;
export function chunks<T>(list: readonly T[], size = IN_LIST_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
