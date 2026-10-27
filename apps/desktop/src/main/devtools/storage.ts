import { COOKIE_LIMITS, COOKIE_SAME_SITE, type ClearSiteDataResult, type CookieSameSite, type CookieView, type StorageAnswer } from '@app/specs/devtools.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { cut } from './network-log';

// The devtools drawer's Storage tab (spec `devtools.spec.ts`, `COOKIE_LIMITS`, `CLEAR_SITE_DATA`;
// acceptance `devtools.feature.md`, Storage). Cookies of the tab's URL come from the browse
// partition's cookie store; values are masked (`value: null`) unless the user revealed that cookie
// for the tab's current document. Which cookies are revealed is kept here, in memory only, and
// forgotten on the tab's next cross-document navigation, on "Clear this site's data" and when the
// tab goes. The values themselves are never kept: each answer reads the store again.

/** A cookie as Electron's `cookies.get` answers it (the fields read). */
export interface CookieLike {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly hostOnly?: boolean;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly session?: boolean;
  /** Seconds since the epoch. */
  readonly expirationDate?: number;
  readonly sameSite?: string;
}

export interface SiteStorageOptions {
  /** The browse partition's cookies for `url` (`session.fromPartition(BROWSE_PARTITION).cookies.get({ url })`). */
  readonly cookies: (url: string) => Promise<readonly CookieLike[]>;
  /** Asks in main's own dialog (`CLEAR_SITE_DATA`); `true` to clear. */
  readonly confirmClear: (origin: string) => Promise<boolean>;
  /** Clears the origin's data from the browse partition (`session.clearData`, `CLEAR_SITE_DATA.dataTypes`). */
  readonly clearOrigin: (origin: string) => Promise<void>;
  readonly changed?: (contentsId: number) => void;
  readonly log?: (message: string) => void;
}

export interface CookieRef {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
}

export interface SiteStorage {
  /** The tab's cookies, masked but for the ones revealed for its current document. Never rejects. */
  storage(contentsId: number, pageUrl: string): Promise<StorageAnswer>;
  /** Reveals one cookie of the page's URL until the tab's next navigation; `false` for an unknown cookie or a non-web page. Never rejects. */
  reveal(contentsId: number, pageUrl: string, cookie: CookieRef): Promise<boolean>;
  /** Asks, then clears the page origin's data; `refused` for a non-web page (nothing asked). One dialog at a time. Never rejects. */
  clearSiteData(contentsId: number, pageUrl: string): Promise<ClearSiteDataResult>;
  /** The tab started a cross-document navigation: its reveals are forgotten. */
  navigated(contentsId: number): void;
  forget(contentsId: number): void;
  /** Forgets every reveal (Clear Browsing Data). */
  clear(): void;
}

const SAME_SITE: ReadonlySet<string> = new Set(COOKIE_SAME_SITE);
/** A cookie's identity, from its listed (capped) name, domain and path. */
const keyOf = (cookie: CookieRef): string => JSON.stringify([cookie.name, cookie.domain, cookie.path]);

/** A cookie as the drawer lists it: `value` only if revealed (capped). */
export function cookieView(cookie: CookieLike, revealed: boolean): CookieView {
  const value = typeof cookie.value === 'string' ? cookie.value : '';
  const shown = revealed ? cut(value, COOKIE_LIMITS.maxValueChars) : null;
  const expires = cookie.session === true || typeof cookie.expirationDate !== 'number' || !Number.isFinite(cookie.expirationDate) ? null : Math.round(cookie.expirationDate * 1000);
  return {
    name: cut(typeof cookie.name === 'string' ? cookie.name : '', COOKIE_LIMITS.maxNameChars),
    domain: cut(cookie.domain ?? '', COOKIE_LIMITS.maxDomainChars),
    path: cut(cookie.path ?? '', COOKIE_LIMITS.maxPathChars),
    hostOnly: cookie.hostOnly === true,
    expires,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite: (typeof cookie.sameSite === 'string' && SAME_SITE.has(cookie.sameSite) ? cookie.sameSite : 'unspecified') as CookieSameSite,
    value: shown,
    valueTruncated: shown !== null && shown.length < value.length,
  };
}

export function createSiteStorage(options: SiteStorageOptions): SiteStorage {
  const revealed = new Map<number, Set<string>>();
  let clearing: Promise<ClearSiteDataResult> | null = null;
  const log = (message: string): void => options.log?.(`devtools: ${message}`);

  const read = async (url: string): Promise<readonly CookieLike[] | null> => {
    try {
      const cookies = await options.cookies(url);
      return Array.isArray(cookies) ? cookies : [];
    } catch (error) {
      log(`reading cookies failed (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  };

  return {
    async storage(contentsId, pageUrl) {
      const page = parseWebUrl(pageUrl);
      if (!page) return { status: 'no-page' };
      const cookies = (await read(page.href)) ?? [];
      const shown = revealed.get(contentsId);
      return {
        status: 'ready',
        origin: page.origin,
        cookies: cookies.slice(0, COOKIE_LIMITS.maxCookies).map((c) => {
          const masked = cookieView(c, false);
          return shown?.has(keyOf(masked)) === true ? cookieView(c, true) : masked;
        }),
        cookieTotal: cookies.length,
        usage: null,
      };
    },

    async reveal(contentsId, pageUrl, cookie) {
      const page = parseWebUrl(pageUrl);
      if (!page) return false;
      const cookies = (await read(page.href)) ?? [];
      const key = keyOf(cookie);
      // Only a cookie the drawer lists (within `maxCookies`), compared by its listed (capped) fields.
      const listed = cookies.slice(0, COOKIE_LIMITS.maxCookies).some((c) => keyOf(cookieView(c, false)) === key);
      if (!listed) return false;
      let set = revealed.get(contentsId);
      if (!set) revealed.set(contentsId, (set = new Set()));
      set.add(key);
      options.changed?.(contentsId);
      return true;
    },

    clearSiteData(contentsId, pageUrl) {
      const page = parseWebUrl(pageUrl);
      if (!page) return Promise.resolve('refused');
      clearing ??= (async (): Promise<ClearSiteDataResult> => {
        let confirmed = false;
        try {
          confirmed = await options.confirmClear(page.origin);
        } catch (error) {
          log(`the confirmation failed (${error instanceof Error ? error.message : String(error)})`);
        }
        if (!confirmed) return 'cancelled';
        try {
          await options.clearOrigin(page.origin);
        } catch (error) {
          log(`clearing site data failed (${error instanceof Error ? error.message : String(error)})`);
        }
        revealed.delete(contentsId);
        options.changed?.(contentsId);
        return 'cleared';
      })().finally(() => {
        clearing = null;
      });
      return clearing;
    },

    navigated(contentsId) {
      if (revealed.delete(contentsId)) options.changed?.(contentsId);
    },

    forget(contentsId) {
      revealed.delete(contentsId);
    },

    clear() {
      revealed.clear();
    },
  };
}
