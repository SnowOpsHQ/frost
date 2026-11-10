import type { BeforeSendResponse, HeadersReceivedResponse, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, Session } from 'electron';
import { COOKIE_BLOCK } from '@app/specs/render-profile.spec';

// Cookies off on HTTP, a tab override (spec `render-profile.feature.md`, Page writes and Tab
// overrides; Phase 11 Task 6, Decision 8). The one module allowed a blocking `webRequest` listener on
// a browse-class session (Semgrep `webrequest-blocking-outside-allowlisted-modules`): while at least
// one tab of a browse-class session (`browse-class.ts`; Phase 12 Task 10a) has cookies off, it
// registers a blocking `onBeforeSendHeaders` / `onHeadersReceived` pair on **that tab's own
// session** (never a partition lookup; one pair per session, each removed on its own), which removes
// `Cookie` from the requests and `Set-Cookie` from the responses of those tabs only (by
// `webContentsId`: their frames and dedicated workers too; a service worker's requests carry no tab
// and keep their cookies). The pair goes when the session's last cookies-off tab closes or turns it
// off. Electron keeps one listener per event per session and its filters cannot select a tab, so
// while the pair is registered every request of the session passes through here, answered at once
// for other tabs.
//
// Fail-open, on purpose: each listener body is try / catch / finally. The catch logs one line (the
// listener and the error's code or name, never a URL, header or message) and swallows the error; the
// finally always answers, with the edited headers on success and `{}` (unchanged) on error. A
// listener that failed to answer would hang every tab, and failing closed would break or log out tabs
// that never asked for cookies off; cookies off is a testing aid, not a privacy guarantee
// (`COOKIES_OFF_HINT` says a request frost cannot apply it to is sent as normal).

/** The parts of a session's `webRequest` this module registers (Electron's, or a fake in tests). */
export interface CookieBlockSession {
  readonly webRequest: Pick<Session['webRequest'], 'onBeforeSendHeaders' | 'onHeadersReceived'>;
}

export interface CookieBlock {
  /**
   * The tab whose WebContents is `webContentsId`, on `session`, has cookies off (moved there if it was
   * on another). Answers whether the block is in effect for it: `false` when `session` is not
   * browse-class or its pair could not be registered (the tab then keeps its cookies, and
   * `tab-overrides.ts` reports its overrides `failed`, so the UI never claims "cookies off").
   */
  add(webContentsId: number, session: CookieBlockSession): boolean;
  /** That WebContents no longer has cookies off (switched off, or its tab closed); a no-op if it had not. */
  remove(webContentsId: number): void;
  /** Whether `session` has the pair registered now. */
  isRegistered(session: CookieBlockSession): boolean;
}

export interface CookieBlockOptions {
  /** Where a listener's failure is logged (one line each). */
  readonly log?: (line: string) => void;
  /**
   * Whether a session may get the pair: main passes the browse-class registry's
   * `isBrowseClassSession` (`browse-class.ts`), so only a tab's session ever holds a blocking
   * listener from here; a tab on any other session keeps its cookies (fail-open, as below) and
   * nothing is registered. Without it (unit tests of the block alone) every session may.
   */
  readonly isBrowseClass?: (session: CookieBlockSession) => boolean;
}

/** An error's code or name: never its message (it may hold a URL or a header). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : 'unknown error';
};

/** `headers` without the names in `names` (any letter case), or `null` when none of them is there. */
function without<T>(headers: Record<string, T>, names: readonly string[]): Record<string, T> | null {
  let removed = false;
  const kept: Record<string, T> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (names.includes(name.toLowerCase())) removed = true;
    // Defined, not assigned: a header named `__proto__` stays a header (never the object's prototype).
    else Object.defineProperty(kept, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return removed ? kept : null;
}

const FILTER = { urls: [...COOKIE_BLOCK.urls] };

export function createCookieBlock(options: CookieBlockOptions = {}): CookieBlock {
  const log = (line: string): void => {
    try {
      (options.log ?? ((text: string) => console.warn(`frost: ${text}`)))(line);
    } catch {
      // Logging never breaks a request.
    }
  };
  /** Each cookies-off WebContents and the session its pair is on. */
  const sessionOf = new Map<number, CookieBlockSession>();
  /** Each session with a pair, and its cookies-off WebContents. */
  const tabsOf = new Map<CookieBlockSession, Set<number>>();

  const register = (session: CookieBlockSession, ids: ReadonlySet<number>): void => {
    session.webRequest.onBeforeSendHeaders(FILTER, (details: OnBeforeSendHeadersListenerDetails, callback: (response: BeforeSendResponse) => void) => {
      let answer: BeforeSendResponse = {};
      try {
        if (ids.has(details.webContentsId as number)) {
          const kept = without(details.requestHeaders, COOKIE_BLOCK.requestHeaders);
          if (kept) answer = { requestHeaders: kept };
        }
      } catch (error) {
        answer = {};
        log(`cookie-block: onBeforeSendHeaders failed (${codeOf(error)}); the request was sent unchanged`);
      } finally {
        try {
          callback(answer);
        } catch (error) {
          log(`cookie-block: onBeforeSendHeaders could not answer (${codeOf(error)})`);
        }
      }
    });
    session.webRequest.onHeadersReceived(FILTER, (details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => {
      let answer: HeadersReceivedResponse = {};
      try {
        if (ids.has(details.webContentsId as number) && details.responseHeaders) {
          const kept = without(details.responseHeaders, COOKIE_BLOCK.responseHeaders);
          if (kept) answer = { responseHeaders: kept };
        }
      } catch (error) {
        answer = {};
        log(`cookie-block: onHeadersReceived failed (${codeOf(error)}); the response was passed on unchanged`);
      } finally {
        try {
          callback(answer);
        } catch (error) {
          log(`cookie-block: onHeadersReceived could not answer (${codeOf(error)})`);
        }
      }
    });
  };

  const unregister = (session: CookieBlockSession): void => {
    try {
      session.webRequest.onBeforeSendHeaders(null);
      session.webRequest.onHeadersReceived(null);
    } catch (error) {
      log(`cookie-block: the listeners could not be removed (${codeOf(error)})`);
    }
  };

  const remove = (webContentsId: number): void => {
    const session = sessionOf.get(webContentsId);
    if (!session) return;
    sessionOf.delete(webContentsId);
    const ids = tabsOf.get(session);
    ids?.delete(webContentsId);
    if (ids && ids.size === 0) {
      tabsOf.delete(session);
      unregister(session);
    }
  };

  const mayBlock = (session: CookieBlockSession): boolean => {
    if (!options.isBrowseClass) return true;
    try {
      return options.isBrowseClass(session) === true;
    } catch {
      return false;
    }
  };

  return {
    add(webContentsId, session) {
      const current = sessionOf.get(webContentsId);
      if (current === session) return true;
      if (current) remove(webContentsId);
      if (!mayBlock(session)) {
        log('cookie-block: not a browse-class session; the tab keeps its cookies');
        return false;
      }
      let ids = tabsOf.get(session);
      if (!ids) {
        ids = new Set();
        tabsOf.set(session, ids);
        try {
          register(session, ids);
        } catch (error) {
          tabsOf.delete(session);
          log(`cookie-block: the listeners could not be registered (${codeOf(error)})`);
          // Half a pair (the first registered, the second threw) would hold every request for nothing.
          unregister(session);
          return false;
        }
      }
      ids.add(webContentsId);
      sessionOf.set(webContentsId, session);
      return true;
    },
    remove,
    isRegistered: (session) => tabsOf.has(session),
  };
}
