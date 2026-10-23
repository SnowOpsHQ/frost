# Feature: the `app://` protocol

Spec: `specs/app-protocol.spec.ts` (+ `APP_SCHEME`, `APP_HOST`, `APP_CSP` from
`security-policy.spec.ts`). Design doc §3. Each line maps to one named test.
Tests: `apps/desktop/src/main/protocol/__tests__/resolve.test.ts` (pure path resolution) and
`apps/desktop/src/main/protocol/__tests__/register.test.ts` (Electron wiring, via the electron fake).

## Path resolution — `resolveAppRequest(url, root)` (resolve.test.ts)
- **Scenario: serves-index-for-root** — `app://app/` and `app://app` → `<root>/index.html`.
- **Scenario: serves-files-inside-root** — `app://app/assets/index-abc.js` →
  `<root>/assets/index-abc.js`; query and fragment are ignored; percent-encoded ordinary characters
  are decoded (`/a%20b.js` → `<root>/a b.js`).
- **Scenario: serves-index-for-directory-path** — `app://app/sub/` → `<root>/sub/index.html`.
- **Scenario: rejects-other-hosts** — any host other than `APP_HOST` (`app://evil/`, `app://app.evil/`,
  `app://APP.x/`, `app://app:1/`, credentials `app://u:p@app/`) or another scheme → not found.
- **Scenario: rejects-path-traversal** — raw `..`/`.` segments, percent-encoded dot segments
  (`%2e%2e`, `%2E%2e`, `.%2e`), encoded slash/backslash (`%2f`, `%5c`), raw backslashes, NUL
  (`%00`) and other control characters, `:` (drive letters), empty segments (`//`), double-encoded
  `%252e%252e` (served only as a literal file name, never decoded twice) and malformed escapes
  (`%zz`, `%`) → not found. No accepted request resolves outside `root`.
- **Scenario: rejects-trailing-dot-or-space-segments** — a decoded segment ending in `.` or a space
  (`APP_FORBIDDEN_SEGMENT_SUFFIX`: `index.html.`, `index.html%20`, `index.html%2e`, `assets./x.js`,
  `assets%20/x.js`, `...`) → not found, since Windows would alias it to the trimmed name.
- **Scenario: assigns-mime-types** — the content type comes from `APP_MIME_TYPES` by lowercased
  extension (`.html`, `.js`, `.css`, `.svg`, `.woff2` …); unknown extensions get
  `APP_DEFAULT_MIME_TYPE`.

## Electron wiring — `registerAppScheme()` / `handleAppProtocol(root)` (register.test.ts)
- **Scenario: registers-privileged-scheme** — `protocol.registerSchemesAsPrivileged` is called once
  with `{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }`.
- **Scenario: serves-bundle-with-csp** — a `GET app://app/` returns `200`, the file body, its MIME
  type, `Content-Security-Policy: APP_CSP` and `X-Content-Type-Options: nosniff`.
- **Scenario: answers-404-with-csp** — a missing file, a directory, a foreign host or a traversal
  attempt returns `404` with an empty body and the CSP header; file reads outside `root` never happen.
- **Scenario: rejects-non-get-methods** — `POST`/`PUT`/`DELETE` → `405`.

## Who may load `app://` — `restrictAppRequests(session, isAppWebContents)` (`apps/desktop/src/main/protocol/__tests__/requests.test.ts`)
The session's single `onBeforeRequest` slot is owned here (`APP_REQUEST_FILTER`); see the known
limit and Phase 1 rule in `app-protocol.spec.ts`. Real-Electron coverage: `ipc-e2e.feature.md`.
- **Scenario: registers-one-app-request-filter** — exactly one `webRequest.onBeforeRequest`
  listener, with filter `APP_REQUEST_FILTER` (`app://*/*`).
- **Scenario: allows-app-window-requests** — a request whose `details.webContents` is an app
  window's WebContents (its document and subresources) or that window's DevTools WebContents is
  not cancelled.
- **Scenario: cancels-foreign-requests** — a request from any other WebContents (an untracked
  window, a closed app window), with no WebContents, or for which the check throws is cancelled.

## App window registry — `isAppWebContents` (`apps/desktop/src/main/__tests__/app-windows.test.ts`)
- **Scenario: recognizes-app-webcontents** — `isAppWebContents(c)` is true only for the WebContents
  of a tracked, not-yet-closed window, or the DevTools WebContents currently opened for one.

## Loading the renderer — `loadRenderer(win, { devServerUrl })` (`apps/desktop/src/main/__tests__/boot.test.ts`)
- **Scenario: loads-renderer-from-app-scheme** — without a dev-server URL the window loads
  `APP_ENTRY_URL` with `loadURL`; `loadFile` / `file://` are never used.
- **Scenario: loads-dev-server-only-when-given** — with `devServerUrl` (passed only when unpackaged
  under `electron-forge start`) the window loads that URL instead.
