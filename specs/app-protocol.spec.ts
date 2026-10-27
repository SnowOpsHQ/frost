/**
 * `app://` protocol contract (design doc §3 "Security model": app pages load from `app://`, never
 * `file://`; Phase 0 Task 4). Implemented by `apps/desktop/src/main/protocol/{resolve,register}.ts`;
 * acceptance list: `app-protocol.feature.md`.
 */
import { APP_HOST, APP_SCHEME } from './security-policy.spec';

/**
 * Privileges for `protocol.registerSchemesAsPrivileged` (before `app.whenReady`).
 * - `standard`: real origin (`app://app`), relative URL resolution, lowercased host.
 * - `secure`: a secure context, like `https:`.
 * - `supportFetchAPI`: `fetch()` of the app's own resources.
 * - `corsEnabled: false`: nothing cross-origin may read `app://` (same-origin module scripts don't need it).
 * - `bypassCSP: false`: the strict app CSP always applies.
 * Not granted: service workers, streaming, code cache.
 */
export const APP_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: false,
  bypassCSP: false,
  allowServiceWorkers: false,
  stream: false,
} as const;

/** The URL the main window loads in every non-dev build. */
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/` as const;

/** A request for a directory path (`/`, `/x/`) serves this file from that directory. */
export const APP_INDEX_FILE = 'index.html';

/** Request methods the handler serves; anything else is `405`. */
export const APP_ALLOWED_METHODS = ['GET', 'HEAD'] as const;

/**
 * Content types by lowercased file extension. Anything else is served as
 * `APP_DEFAULT_MIME_TYPE`, and every response carries `X-Content-Type-Options: nosniff`.
 */
export const APP_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
} as const satisfies Record<string, string>;
export const APP_DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Characters never allowed in a **decoded** path segment: `/` and `\` (a segment must not become two),
 * `:` (Windows drive / ADS), and NUL / C0 controls. `.` and `..` segments are also refused rather
 * than resolved, as are empty segments (`//`). Refused requests are answered `404`, like a missing
 * file, so the handler reveals nothing about the filesystem.
 */
export const APP_FORBIDDEN_SEGMENT_CHARS = /[\u0000-\u001f\u007f/\\:]/;

/**
 * A **decoded** path segment ending in `.` or a space is also refused (`404`): Windows strips
 * trailing dots and spaces from file names, so `index.html.` / `index.html%20` / `assets./x.js`
 * would alias a real file under a name the resolver never checked.
 */
export const APP_FORBIDDEN_SEGMENT_SUFFIX = /[. ]$/;

/**
 * Who may load `app://` at all. Chromium does not enforce CORP for custom schemes and
 * `protocol.handle` receives no `Origin` / `Sec-Fetch-*` headers, so the handler alone cannot tell
 * an app page from any other page in the session embedding `<script src="app://app/…">`. The
 * session's `webRequest.onBeforeRequest` listener, filtered to `APP_REQUEST_FILTER`, therefore
 * cancels every `app://` request whose `details.webContents` is not a live app window's WebContents
 * (or that window's own DevTools WebContents); requests with no WebContents are cancelled too.
 *
 * Ownership: a session holds a single `onBeforeRequest` listener (registering again replaces it).
 * It is owned by `apps/desktop/src/main/protocol/requests.ts`; nothing else may register one
 * (the single `onHeadersReceived` listener is owned by `security/register.ts`).
 *
 * Known limit: the check is per requesting WebContents, not per frame or origin. That is enough
 * while app windows can only show app pages (navigation is pinned to `APP_ORIGIN`); it is not a
 * boundary between frames of one WebContents.
 *
 * Phase 1 rule: browsing tabs use a separate `session.fromPartition(...)` with no `app:` handler
 * registered, so untrusted pages cannot reach `app://` at all; and nothing secret is ever served
 * over `app://` (it holds only the public renderer bundle).
 */
export const APP_REQUEST_FILTER = { urls: [`${APP_SCHEME}://*/*`] } as const;
