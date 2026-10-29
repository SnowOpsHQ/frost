/**
 * Security-policy contract (design doc §3 "Security model"; Phase 0 Task 2).
 *
 * Single source of truth for the `openExternal` scheme allowlist, the user-gesture signal, the app
 * origin that navigation is pinned to, the deny-by-default permission policy and the strict CSP for
 * the app's own `app://` pages. Implemented by `apps/desktop/src/main/security/{policy,register}.ts`;
 * acceptance list: `external-url.feature.md`.
 */

/** Schemes `shell.openExternal` may ever be called with (compared against the parsed, lowercased protocol). */
export const ALLOWED_EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:'] as const;
export type AllowedExternalScheme = (typeof ALLOWED_EXTERNAL_SCHEMES)[number];

/**
 * Scope of the strict string rules below: they apply to the URL **string the main process receives**
 * and are defense in depth for raw-string callers (e.g. a future IPC "open link" procedure). They
 * are not a claim about end-to-end `window.open` behaviour: Chromium canonicalizes `window.open` /
 * `target=_blank` URLs before `setWindowOpenHandler` sees them (`http:evil` → `http://evil/`,
 * `' https://x.com '` → `https://x.com/`, `https://x.com\@evil.com` → `https://x.com/@evil.com`),
 * so on that path the canonical form is judged as an ordinary URL.
 *
 * Allowlisted schemes that must be written in hierarchical form (`scheme://host`) with a non-empty
 * host and no credentials. WHATWG URL silently repairs `http:evil` / `https:/x` / `https:\\x` into
 * `http://evil/` etc.; we deny those raw strings instead of opening a URL the caller never wrote.
 */
export const HOST_REQUIRED_EXTERNAL_SCHEMES = ['http:', 'https:'] as const satisfies readonly AllowedExternalScheme[];

/**
 * Raw external URL strings containing ASCII whitespace/control characters (anywhere, including
 * leading or trailing) or backslashes are denied rather than trimmed/normalized: WHATWG URL strips
 * or rewrites them, so the URL opened would differ from the string the main process received.
 */
export const FORBIDDEN_EXTERNAL_URL_CHARS = /[\u0000- \u007f\\]/;

/**
 * The only `mailto:` header fields (query keys, compared case-insensitively) an external open may
 * carry. Anything else is denied — notably `attach` / `attachment`, which some mail clients honour
 * to attach local files (`mailto:a@b.c?attach=/etc/passwd`).
 */
export const ALLOWED_MAILTO_PARAMS = ['to', 'cc', 'bcc', 'subject', 'body'] as const;

/**
 * User-gesture signal (Review Focus `denies-without-gesture`). Electron 45's `setWindowOpenHandler`
 * details carry no gesture flag, popups without a gesture are *not* blocked before the handler, and
 * `disposition` is `foreground-tab` for both gesture and gesture-less `window.open()` (verified
 * empirically) — so disposition is not a gesture signal. Instead the main process records trusted
 * `webContents` `'input-event'`s (OS/browser input only; page-dispatched synthetic events never
 * appear there) and treats a window-open as gesture-backed only if one of these activation input
 * types arrived within the window below. Like Chromium's transient activation, each activation is
 * consumed by the first window-open that reads it.
 *
 * Known limit: activation is tracked per `webContents`, not per frame — Electron 45 reports
 * `input-event` per WebContents and `HandlerDetails` carries no frame, so a click in one frame can
 * back a `window.open` from another frame of the same `webContents`. App windows host only the
 * app's own page, so there it does not matter (their popups keep the external-open flow). Tabs
 * (untrusted subframes) close both routes a subframe could use (`browse-guard.feature.md`): a
 * navigation is offered to the external-open flow only when the tab's **main frame** initiated it
 * (`will-frame-navigate`'s `initiator`), and a popup, which has no frame to check, never is.
 */
export const USER_ACTIVATION_INPUT_TYPES = ['mouseDown', 'rawKeyDown', 'keyDown', 'touchEnd', 'gestureTap'] as const;
/** Matches Chromium's transient user-activation lifespan. */
export const USER_ACTIVATION_WINDOW_MS = 5000;

/** Custom privileged scheme the app's own pages are served from (registered in Task 4). */
export const APP_SCHEME = 'app';
/** Host of the app's pages; the app origin is `app://app` (the IPC sender origin in Task 3). */
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}` as const;

/**
 * Navigation pin: renderer-initiated navigations of **any frame** (main frame and subframes,
 * Electron's `will-frame-navigate`) and server redirects (`will-redirect`) must stay on
 * `APP_ORIGIN`, plus the Vite dev-server origin when unpackaged under `electron-forge start`
 * (`MAIN_WINDOW_VITE_DEV_SERVER_URL`). Programmatic `loadURL`/`loadFile` from the main process is
 * not a renderer navigation and is not pinned. Off-origin navigations are dropped, never forwarded
 * to `shell.openExternal`.
 */
export const PINNED_NAVIGATION_EVENTS = ['will-frame-navigate', 'will-redirect'] as const;

/**
 * Permissions granted to any origin: none. Every permission request/check and device-permission
 * query is denied in Phase 0 (per-permission, per-origin prompting arrives in a later phase).
 */
export const GRANTED_PERMISSIONS = [] as const satisfies readonly string[];

/**
 * Strict CSP for `app://` responses. `'self'` only, so the Vite production bundle (module scripts
 * and stylesheets from the app origin) boots, while inline script/style, eval, plugins, `<base>`,
 * framing and form posts are refused. Trusted Types are required with no policies allowed (React
 * 19 renders without TT sinks). Not applied to the Vite dev server (`http://localhost`).
 */
export const APP_CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'none'"],
  'require-trusted-types-for': ["'script'"],
  'trusted-types': ["'none'"],
} as const satisfies Record<string, readonly string[]>;

export const APP_CSP = Object.entries(APP_CSP_DIRECTIVES)
  .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
  .join('; ');

/**
 * Packaged builds refuse to start with a remote-debugging switch: the Chrome DevTools Protocol
 * would expose the trusted app page and its IPC bridge to any local process. Checked first thing in
 * main, before any window exists: `app.commandLine.hasSwitch` for each of
 * `PACKAGED_FORBIDDEN_SWITCHES` (Chromium's own parsing, any switch prefix), plus — belt and braces
 * — any `process.argv` entry matching `PACKAGED_FORBIDDEN_ARGV` (`--inspect*` is also disabled by
 * the `EnableNodeCliInspectArguments` fuse). On a match the app prints one line to stderr and
 * exits with code `1`. Unpackaged runs (`electron-forge start`, the Playwright e2e harness, which
 * passes `--remote-debugging-port=0` / `--inspect`) are unaffected.
 */
/*
 * `host-resolver-rules` too (Phase 2.5 Task 4 review): it lets whoever starts the app point any
 * host name at any address, which would defeat the "Open in" private-address check
 * (`command-palette.spec.ts`, `browser.openTool`) and the robots.txt fetcher's private-host refusal.
 * The e2e suite, unpackaged, uses it to give a loopback server a public-looking name.
 * `frost-e2e-public-hosts` too (Phase 2.5 Task 2 review): the e2e seam that exempts those names
 * from the bounded fetcher's DNS check (`E2E_PUBLIC_HOSTS_SWITCH`, `fetcher.spec.ts`).
 * `frost-e2e-serp-pack-key` and `frost-e2e-serp-pack-url` too (Phase 3 Task 1): the e2e seams that
 * trust one more selector pack key and fetch the remote pack from another URL
 * (`SERP_E2E_PACK_KEY_SWITCH`, `SERP_E2E_PACK_URL_SWITCH`, `serp-selector-pack.spec.ts`).
 * `frost-e2e-intent-fake` too (Phase 3 Task 2): the e2e seam that runs the intent utility process's
 * deterministic fake in place of the model (`INTENT_E2E_FAKE_SWITCH`, `intent-classifier.spec.ts`).
 */
// `frost-e2e-agent-script` too (Phase 5 Task 6a): the agent's scripted-model seam (`AGENT_E2E_SCRIPT_SWITCH`, `agent-session.spec.ts`).
export const PACKAGED_FORBIDDEN_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'host-resolver-rules', 'frost-e2e-public-hosts', 'frost-e2e-serp-pack-key', 'frost-e2e-serp-pack-url', 'frost-e2e-intent-fake', 'frost-e2e-agent-script'] as const;
export const PACKAGED_FORBIDDEN_ARGV = /^--?(remote-debugging-|inspect)/i;

/**
 * Start of the refusal line (followed by ` (<offending switch>)`). The app prints it to stderr as
 * `frost: <refusal>`; `apps/desktop/scripts/verify-mac-package.mjs` looks for it in the packaged
 * app's stderr.
 */
export const PACKAGED_DEBUG_REFUSAL = 'remote debugging is disabled in packaged builds';
