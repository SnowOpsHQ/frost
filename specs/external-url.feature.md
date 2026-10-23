# Feature: external URLs, navigation pinning, permissions and the app CSP

Spec: `specs/security-policy.spec.ts`. Design doc §3. Each line maps to one named test.
Tests: `apps/desktop/src/main/security/__tests__/policy.test.ts` (pure policy) and
`apps/desktop/src/main/security/__tests__/register.test.ts` (Electron wiring, via the electron fake).

## External open policy — `resolveExternalOpen(url, { userGesture })` (policy.test.ts)
These rules judge the URL **string the main process receives**. They are defense in depth for
raw-string callers (e.g. a future IPC "open link"); on the `window.open` path Chromium has already
canonicalized the URL (`http:evil` → `http://evil/`, `' https://x.com '` → `https://x.com/`,
`https://x.com\@evil.com` → `https://x.com/@evil.com`), so the malformed-string scenarios below do
not describe end-to-end `window.open` behaviour (see `window-open-judges-chromium-normalized-url`).

- **Scenario: allows https with gesture** — `https://x.com` with a gesture → `allow`.
- **Scenario: allows-allowlisted-schemes-with-gesture** — `http://`, `https://`, `mailto:` (any
  letter case of the scheme, e.g. `HtTpS://x.com`, which parses to `https:`) with a gesture → `allow`.
- **Scenario: denies-non-web-scheme** — any scheme not in `ALLOWED_EXTERNAL_SCHEMES` (`vscode:`,
  `file:`, `ftp:`, `smb:`, `ms-settings:` …) → `deny`, even with a gesture.
- **Scenario: denies-malformed-schemes** — malformed / cased / scheme-tricky raw strings → `deny` even with a
  gesture: `FILE://x`, `http:evil`, `https:/x.com`, `https:\\x.com`, `javascript:alert(1)`,
  `javascript:1`, `data:text/html,x`, `vbscript:x`, `''`, `' '`, `'  https://x.com'`,
  `'https://x.com '`, `https://x.com` with an embedded tab/newline, `https://`, unparseable strings.
  Whitespace is **denied, not trimmed** (`FORBIDDEN_EXTERNAL_URL_CHARS`); `http(s)` must be written
  `scheme://host` (`HOST_REQUIRED_EXTERNAL_SCHEMES`).
- **Scenario: denies-without-gesture** — an allowlisted URL without a gesture → `deny`.
- **Scenario: denies-credentials-in-web-urls** — `https://user:pass@x.com`, `https://x.com@evil.com`
  → `deny` (userinfo is a phishing vector).
- **Scenario: denies-mailto-attachments** — a `mailto:` query key outside `ALLOWED_MAILTO_PARAMS`
  (`to`, `cc`, `bcc`, `subject`, `body`; keys compared case-insensitively) → `deny`:
  `?attach=/etc/passwd`, `?attachment=…`, `?ATTACH=…`, and `?subject=hi&attach=…` (one forbidden key
  among allowed ones). `?Subject=hi&CC=x@y.z&body=…` stays `allow`.

## User-gesture signal (policy.test.ts)
- **Scenario: counts-only-activation-inputs-as-gestures** — only `USER_ACTIVATION_INPUT_TYPES`
  (`mouseDown`, `rawKeyDown`, `keyDown`, `touchEnd`, `gestureTap`) are activations; `mouseMove`,
  `mouseUp`, `mouseWheel`, `keyUp`, `char` … are not.
- **Scenario: gesture-expires-after-activation-window** — an activation counts for
  `USER_ACTIVATION_WINDOW_MS` (inclusive) and not after; no activation → no gesture.
- **Known limit (not a scenario; revisit in Phase 1, browsing tabs):** activation is tracked per
  `webContents`, not per frame — `HandlerDetails` has no frame info, so a click in one frame can back
  a `window.open` from another frame of the same `webContents`.

## Navigation pinning — `isAllowedAppNavigation(url, { devServerUrl })` (policy.test.ts)
- **Scenario: pins-app-navigation-to-app-origin** — only `APP_ORIGIN` (`app://app`, any path) is an
  allowed in-window navigation; `https://…`, `file://…`, `app://other`, `javascript:` … are not.
- **Scenario: allows-dev-server-origin-only-when-configured** — the Vite dev-server origin is allowed
  only when `devServerUrl` is passed (unpackaged `electron-forge start`); other localhost ports are not.

## App CSP — `appCspHeader()` (policy.test.ts)
- **Scenario: app-csp-allows-own-bundle** — the CSP equals `APP_CSP` and allows the renderer's own
  bundle: `script-src 'self'`, `style-src 'self'`, `default-src 'self'`.
- **Scenario: app-csp-is-strict** — `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
  `form-action 'none'`, `require-trusted-types-for 'script'`; no `'unsafe-inline'`, `'unsafe-eval'`, `*`.

## Electron wiring — `registerSecurity(session, win, options?)` (register.test.ts)
- **Scenario: window-open-is-always-denied-in-app** — the window-open handler returns
  `{ action: 'deny' }` for every URL (no child windows, ever).
- **Scenario: opens-allowlisted-url-externally-on-gesture** — after a trusted activation input,
  `window.open('https://x.com')` calls `shell.openExternal` once with the normalized URL.
- **Scenario: does-not-open-externally-without-gesture** — with no activation input, no
  `shell.openExternal` call.
- **Scenario: does-not-open-non-allowlisted-scheme-on-gesture** — `vscode://x` after an activation
  input → no `shell.openExternal` call.
- **Scenario: window-open-judges-chromium-normalized-url** — documents reality: the handler receives
  Chromium's canonical form, so `http://evil/` (what `window.open('http:evil')` becomes) after an
  activation input is an ordinary `http:` URL and is opened externally.
- **Scenario: consumes-gesture-on-first-window-open** — one activation input allows at most one
  external open; the next window-open is gesture-less.
- **Scenario: ignores-expired-gesture** — an activation older than `USER_ACTIVATION_WINDOW_MS` does
  not count.
- **Scenario: denies-every-permission-request** — the permission request handler calls back `false`.
- **Scenario: denies-every-permission-check** — the permission check handler returns `false`.
- **Scenario: denies-device-permissions** — the device permission handler returns `false`.
- **Scenario: prevents-navigation-off-app-origin** — a main-frame `will-frame-navigate` to a non-app
  URL is prevented; to `app://app/…` it is not.
- **Scenario: prevents-subframe-navigation-off-app-origin** — a subframe `will-frame-navigate`
  (`isMainFrame: false`; Electron's `will-navigate` is main-frame-only) to a non-app URL is
  prevented; to `app://app/…` it is not.
- **Scenario: does-not-open-external-navigation** — an in-window navigation to an allowlisted
  `https:` URL is prevented and is **not** forwarded to `shell.openExternal`, even with a gesture.
  External URLs leave the app only via `window.open` / `target="_blank"` on a gesture.
- **Scenario: allows-dev-server-navigation-in-dev-only** — navigation to the dev-server origin is
  allowed only when `registerSecurity` is given `devServerUrl` (so `electron-forge start` keeps
  working); other localhost ports are still prevented.
- **Scenario: prevents-redirect-off-app-origin** — `will-redirect` off the app origin is prevented
  (main frame and subframes).
- **Scenario: blocks-webview-attach** — `will-attach-webview` is always prevented.
- **Scenario: applies-csp-to-app-responses** — `onHeadersReceived` sets exactly one
  `Content-Security-Policy: APP_CSP` header on `app://` responses, replacing any existing CSP header
  in any letter case.
- **Scenario: leaves-non-app-responses-untouched** — non-`app://` responses (incl. the dev server)
  are passed through unmodified.
- **Scenario: guards-every-new-webcontents** — `registerAppWideGuards()` applies the window-open,
  navigation and webview guards to every WebContents created later (`web-contents-created`).
- **Scenario: guards-each-webcontents-once** — guarding the same WebContents twice registers its
  listeners once.
- **Scenario: registers-guards-through-one-path** — WebContents guards come only from the app-wide
  hook: `registerSecurity(session, win, options)` installs it (if not yet installed) with `options`,
  guards `win` (created before the call) with those same options, and later WebContents get the same
  options. Omitting `options` reuses the installed ones.
- **Scenario: rejects-conflicting-security-options** — `registerSecurity` / `registerAppWideGuards`
  with options that differ from the installed ones throws instead of silently ignoring them; the
  same options object (or equal fields) is accepted.
