import { BROWSABLE_SCHEMES } from '@app/specs/browser.spec';
import { MAX_STORED_TITLE_LENGTH, MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { REMEMBERED_DECISIONS, SITE_PERMISSIONS, type RememberedDecision, type SitePermission } from '@app/specs/permissions.spec';

// What may be stored, and what a stored value must look like to be loaded (spec
// `browser-session-db.feature.md`). Every value is checked both ways: the database is a file in
// the profile, so a row may have been edited by something other than frost.

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

/**
 * `url` as stored: an `http(s)` URL (`BROWSABLE_SCHEMES`) with any userinfo removed, serialized, at
 * most `MAX_STORED_URL_LENGTH` long; anything else is `null`.
 */
export function storableUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!includes(BROWSABLE_SCHEMES, parsed.protocol) || parsed.host === '') return null;
  parsed.username = '';
  parsed.password = '';
  return parsed.href.length <= MAX_STORED_URL_LENGTH ? parsed.href : null;
}

/** `title` cut to `MAX_STORED_TITLE_LENGTH` characters (code points); a non-string is `''`. */
export function storableTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  const chars = [...title];
  return chars.length <= MAX_STORED_TITLE_LENGTH ? title : chars.slice(0, MAX_STORED_TITLE_LENGTH).join('');
}

/** `origin` if it is a serialized `http(s)` origin (`https://example.com`, `http://127.0.0.1:8080`). */
export function storableOrigin(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;
  const url = storableUrl(origin);
  if (url === null) return null;
  return new URL(url).origin === origin ? origin : null;
}

export const isSitePermission = (value: unknown): value is SitePermission => includes(SITE_PERMISSIONS, value);
export const isRememberedDecision = (value: unknown): value is RememberedDecision => includes(REMEMBERED_DECISIONS, value);
