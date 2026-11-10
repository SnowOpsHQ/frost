import { COOKIE_LIMITS, COOKIE_SAME_SITE, type ClearSiteDataResult, type CookieSameSite, type CookieView, type StorageAnswer } from '@app/specs/devtools.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';
import { cut } from './network-log';

// The devtools drawer's Storage tab (spec `devtools.spec.ts`, `COOKIE_LIMITS`, `CLEAR_SITE_DATA`;
// acceptance `devtools.feature.md`, Storage). Cookies of the tab's URL come from the tab's own
// (browse-class) session's cookie store; values are masked (`value: null`) unless the user revealed that cookie
// for the tab's current document. Which cookies are revealed is kept here, in memory only, each
// stamped with the tab's committed document when it was asked for; a stale stamp shows nothing, and
// the reveals are forgotten when the tab commits its next document (`did-navigate`), on "Clear this
// site's data" and when the tab goes. The values themselves are never kept: each answer reads the
// store again. One "Clear this site's data" dialog at a time: the same origin shares it, another
// origin is `busy`.

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
  /** The cookies for `url` of WebContents `contentsId`'s own session (main: `site-data.ts` `tabSiteData`, its `contents.session.cookies.get({ url })`). */
  readonly cookies: (url: string, contentsId: number) => Promise<readonly CookieLike[]>;
  /** Asks in main's own dialog (`CLEAR_SITE_DATA`); `true` to clear. */
  readonly confirmClear: (origin: string) => Promise<boolean>;
  /** Clears the origin's data from WebContents `contentsId`'s own session (`session.clearData`, `CLEAR_SITE_DATA.dataTypes`). */
  readonly clearOrigin: (origin: string, contentsId: number) => Promise<void>;
  /**
   * The store WebContents `contentsId` reads and clears (main: its own browse-class session, or `null`
   * for none). A "Clear this site's data" in flight is shared only by a request for the same store and
   * origin. Without it every tab shares one store.
   */
  readonly storeOf?: (contentsId: number) => unknown;
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
  /**
   * Asks, then clears the page origin's data from the tab's store; `refused` for a non-web page
   * (nothing asked), `failed` when clearing threw. One dialog at a time: a request for the same store
   * (`storeOf`: the tab's session) and origin as the one being asked about shares its answer, any
   * other is `busy`. Never rejects.
   */
  clearSiteData(contentsId: number, pageUrl: string): Promise<ClearSiteDataResult>;
  /** The tab committed a cross-document navigation (`did-navigate`): a new document, its reveals forgotten. */
  committed(contentsId: number): void;
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
  /** Per tab: revealed cookie key → the committed document it was revealed in. */
  const revealed = new Map<number, Map<string, number>>();
  /** Per tab: its committed document (counts up with each commit). */
  const documents = new Map<number, number>();
  const documentOf = (contentsId: number): number => documents.get(contentsId) ?? 0;
  let clearing: { readonly store: unknown; readonly origin: string; readonly answer: Promise<ClearSiteDataResult> } | null = null;
  const storeOf = (contentsId: number): unknown => {
    try {
      return options.storeOf ? options.storeOf(contentsId) : null;
    } catch {
      return null;
    }
  };
  const log = (message: string): void => options.log?.(`devtools: ${message}`);

  const read = async (url: string, contentsId: number): Promise<readonly CookieLike[] | null> => {
    try {
      const cookies = await options.cookies(url, contentsId);
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
      const cookies = (await read(page.href, contentsId)) ?? [];
      const shown = revealed.get(contentsId);
      const now = documentOf(contentsId);
      return {
        status: 'ready',
        origin: page.origin,
        cookies: cookies.slice(0, COOKIE_LIMITS.maxCookies).map((c) => {
          const masked = cookieView(c, false);
          return shown?.get(keyOf(masked)) === now ? cookieView(c, true) : masked;
        }),
        cookieTotal: cookies.length,
        // The web storage reader's (`web-storage.ts`), filled in by the service.
        usage: null,
        quota: null,
        webStorage: null,
      };
    },

    async reveal(contentsId, pageUrl, cookie) {
      const page = parseWebUrl(pageUrl);
      if (!page) return false;
      // Stamped now: a commit that lands while the store is read leaves this reveal in the old document.
      const stamp = documentOf(contentsId);
      const cookies = (await read(page.href, contentsId)) ?? [];
      if (documentOf(contentsId) !== stamp) return false;
      const key = keyOf(cookie);
      // Only a cookie the drawer lists (within `maxCookies`), compared by its listed (capped) fields.
      const listed = cookies.slice(0, COOKIE_LIMITS.maxCookies).some((c) => keyOf(cookieView(c, false)) === key);
      if (!listed) return false;
      let shown = revealed.get(contentsId);
      if (!shown) revealed.set(contentsId, (shown = new Map()));
      shown.set(key, stamp);
      options.changed?.(contentsId);
      return true;
    },

    clearSiteData(contentsId, pageUrl) {
      const page = parseWebUrl(pageUrl);
      if (!page) return Promise.resolve('refused');
      const store = storeOf(contentsId);
      if (clearing) return clearing.origin === page.origin && clearing.store === store ? clearing.answer : Promise.resolve('busy');
      const answer = (async (): Promise<ClearSiteDataResult> => {
        let confirmed = false;
        try {
          confirmed = await options.confirmClear(page.origin);
        } catch (error) {
          log(`the confirmation failed (${error instanceof Error ? error.message : String(error)})`);
        }
        if (!confirmed) return 'cancelled';
        let result: ClearSiteDataResult = 'cleared';
        try {
          await options.clearOrigin(page.origin, contentsId);
        } catch (error) {
          result = 'failed';
          log(`clearing site data failed (${error instanceof Error ? error.message : String(error)})`);
        }
        // Every reveal goes (the origin's tabs may be several; some data may be gone even on a failure).
        revealed.clear();
        options.changed?.(contentsId);
        return result;
      })().finally(() => {
        clearing = null;
      });
      clearing = { store, origin: page.origin, answer };
      return answer;
    },

    committed(contentsId) {
      documents.set(contentsId, documentOf(contentsId) + 1);
      if (revealed.delete(contentsId)) options.changed?.(contentsId);
    },

    forget(contentsId) {
      revealed.delete(contentsId);
      documents.delete(contentsId);
    },

    clear() {
      revealed.clear();
    },
  };
}
