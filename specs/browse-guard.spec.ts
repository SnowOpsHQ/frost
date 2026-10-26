/**
 * Browsed-content guard contract (design doc §3 "Security model"; Phase 1 Task 3). Acceptance:
 * `browse-guard.feature.md`. Implemented by `apps/desktop/src/main/browser/guard.ts` (decisions and
 * per-WebContents wiring), `apps/desktop/src/main/security/{gesture,register}.ts` (the Phase 0
 * external-open flow and the app-wide certificate policy), `browser/controller.ts` (tab error,
 * crash and popup state) and the chrome's page panels (`renderer/page-error.ts`).
 *
 * Plain values with no imports, so the chrome renderer can use them without bundling Zod (whose
 * eval probe the app's strict Trusted Types CSP blocks).
 */

/**
 * `about:` documents a tab may navigate to, compared on the parsed URL's path (so any query or
 * fragment is allowed: `about:blank#x` is `about:blank`, as in Chromium, whose renderer commits it
 * without reporting a `will-frame-navigate` at all). `about:blank` in any frame; besides it, the
 * only `about:` URL a **subframe** may navigate to is `<iframe srcdoc>` (`SUBFRAME_ONLY_URLS`).
 */
export const BLANK_ABOUT_PATH = 'blank' as const;

/**
 * Besides `BROWSABLE_SCHEMES` and `about:blank`, the only URL a **subframe** may navigate to:
 * `<iframe srcdoc>`. Its document is written by the embedding page and inherits that page's
 * origin, so it grants nothing the page cannot already do with an `about:blank` frame. Never a
 * main-frame target. (Electron 45 does not report srcdoc loads through `will-frame-navigate`;
 * the rule pins the decision should it ever do so.)
 *
 * Deliberately **not** allowed, in any frame: `data:` (Chromium already blocks top-level `data:`
 * navigations; frost denies `data:` iframes as well, the simpler rule), `blob:`, `filesystem:`,
 * `javascript:` (never reaches main: Chromium runs it inside the page's own context), `file:`,
 * `app:`, `chrome:`, `devtools:`, and any custom scheme.
 */
export const SUBFRAME_ONLY_URLS = ['about:srcdoc'] as const;

/**
 * Load failures the chrome does not report: `ERR_ABORTED` (a navigation the guard dropped, a stop,
 * a superseded load, a link that turned into a download). `ERR_UNSAFE_REDIRECT` (-311) **is**
 * reported: Chromium refuses a server redirect to `data:`, `file:` or `about:` itself (the guard's
 * `will-redirect` never sees it) and commits an error page, so the chrome shows the generic panel
 * rather than a blank tab.
 */
export const IGNORED_LOAD_ERROR_CODES = [-3] as const;

/**
 * Chromium net error codes the error panel reports as an untrusted certificate (inclusive range;
 * `net/base/net_error_list.h`: the certificate errors are -200…-299), plus `ERR_INSECURE_RESPONSE`
 * (-501). A certificate error is never bypassable: main always refuses it (`certificate-error`
 * answers `callback(false)`) and the panel offers no "proceed" action.
 */
export const CERT_ERROR_CODE_RANGE = { min: -299, max: -200 } as const;
export const INSECURE_RESPONSE_ERROR_CODE = -501;

/**
 * Net errors reported as "can't be reached": the connection could not be made or broke
 * (`ERR_TIMED_OUT` -7, `ERR_CONNECTION_CLOSED` -100, `_RESET` -101, `_REFUSED` -102, `_ABORTED`
 * -103, `_FAILED` -104, `ERR_NAME_NOT_RESOLVED` -105, `ERR_ADDRESS_INVALID` -108,
 * `ERR_ADDRESS_UNREACHABLE` -109, `ERR_CONNECTION_TIMED_OUT` -118, `ERR_NAME_RESOLUTION_FAILED`
 * -137, `ERR_EMPTY_RESPONSE` -324).
 */
export const UNREACHABLE_ERROR_CODES = [-7, -100, -101, -102, -103, -104, -105, -108, -109, -118, -137, -324] as const;
/** `ERR_INTERNET_DISCONNECTED`. */
export const OFFLINE_ERROR_CODES = [-106] as const;

/**
 * Error-panel headline per failure class (the body names the host; see `renderer/page-error.ts`).
 */
export const LOAD_ERROR_TITLES = {
  certificate: 'Your connection to this site isn’t private',
  unreachable: 'This site can’t be reached',
  offline: 'You’re offline',
  generic: 'This page couldn’t be loaded',
} as const;
export type LoadErrorClass = keyof typeof LOAD_ERROR_TITLES;

/** Crash-panel headline (`render-process-gone`). */
export const CRASH_TITLE = 'This page crashed' as const;

/**
 * Tab placement of a gesture-backed popup (`window.open` / `target=_blank`): a new **background**
 * tab to the right of its opener, after the tabs that opener already opened (so a run of popups
 * keeps its order). The opener stays active.
 */
export const POPUP_TAB_DISPOSITION = 'background' as const;
