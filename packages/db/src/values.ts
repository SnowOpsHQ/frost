import { MAX_STORED_TITLE_LENGTH, MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { PERSISTED_DECISIONS, SITE_PERMISSIONS, type PersistedDecision, type SitePermission } from '@app/specs/permissions.spec';
import { isDefaultRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import { RenderProfileSchema } from '@app/specs/render-profile.schema.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

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
  // Too long before parsing is too long after (removing userinfo aside): never parse a huge value.
  if (typeof url !== 'string' || url === '' || url.length > MAX_STORED_URL_LENGTH) return null;
  const parsed = parseWebUrl(url);
  if (!parsed) return null;
  parsed.username = '';
  parsed.password = '';
  return parsed.href.length <= MAX_STORED_URL_LENGTH ? parsed.href : null;
}

/** `title` cut to `MAX_STORED_TITLE_LENGTH` characters (code points); a non-string is `''`. */
export function storableTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  // At most as many code points as UTF-16 units: a short string needs no splitting, and a long
  // one is split only as far as the cap can reach (two units per code point at most).
  if (title.length <= MAX_STORED_TITLE_LENGTH) return title;
  return [...title.slice(0, MAX_STORED_TITLE_LENGTH * 2)].slice(0, MAX_STORED_TITLE_LENGTH).join('');
}

/** `origin` if it is a serialized `http(s)` origin (`https://example.com`, `http://127.0.0.1:8080`). */
export function storableOrigin(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;
  const url = storableUrl(origin);
  if (url === null) return null;
  return new URL(url).origin === origin ? origin : null;
}

/** Longest stored render profile (its JSON); a longer value is not a profile. */
export const MAX_STORED_PROFILE_LENGTH = 2_048;

/**
 * A render profile as stored and loaded (`render-profile.feature.md`): the value itself, or its JSON
 * text (at most `MAX_STORED_PROFILE_LENGTH`), if it is a valid, non-default profile
 * (`RenderProfileSchema`); else `null`.
 */
export function storableProfile(value: RenderProfile | string): RenderProfile | null {
  let candidate: unknown = value;
  if (typeof value === 'string') {
    if (value.length > MAX_STORED_PROFILE_LENGTH) return null;
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = RenderProfileSchema.safeParse(candidate);
  return parsed.success && !isDefaultRenderProfile(parsed.data) ? parsed.data : null;
}

export const isSitePermission = (value: unknown): value is SitePermission => includes(SITE_PERMISSIONS, value);
/** Only a Block is stored or loaded (`PERSISTED_DECISIONS`); an Allow is for the app session. */
export const isPersistedDecision = (value: unknown): value is PersistedDecision => includes(PERSISTED_DECISIONS, value);
