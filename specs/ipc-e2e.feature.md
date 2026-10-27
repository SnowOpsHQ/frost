# Feature: end-to-end IPC over `app://` (real Electron)

Specs: `ipc-transport.spec.ts`, `ipc-sender.spec.ts`, `app-protocol.spec.ts`,
`window-hardening.spec.ts`, `security-policy.spec.ts`. Design doc §3. Each line maps to one named
test in `apps/desktop/e2e/ipc.e2e.ts` (Playwright `_electron`).

**Harness:** the **unpackaged built** app (`pnpm --filter @app/desktop build` → `.vite/build`) is
launched with `electron <apps/desktop>`; that bundle has no dev-server URL, so it loads
`APP_ENTRY_URL`. `ELECTRON_RUN_AS_NODE` is removed from the child environment. A global setup
refuses to run against a missing bundle or a dev bundle left by `electron-forge start` (which bakes
in the dev-server URL). The packaged binary cannot be driven: its fuses disable the Node inspector
arguments Playwright needs, and they stay on. Entry points: `pnpm test:e2e` (Turbo, builds first) or
`pnpm --filter @app/desktop test:e2e` after a build; both need a display. Every suite closes its
app with the harness's `closeApp`: Playwright's `close()` (the app quits), and if that has not
finished within `APP_CLOSE_TIMEOUT_MS` (10 s) the app's whole process tree is killed (`SIGKILL`), so
a wedged app fails only its own test, never the worker's teardown. An app that already quit on its
own (closing its last window quits it on Linux) is already closed: `closeApp` then does nothing.

- **Scenario: close-app-kills-wedged-app** — an app whose main process refuses to quit
  (`before-quit` prevented) is still closed by `closeApp`: after its timeout the main process and
  every renderer it had are gone, and the app's `close` event fired.
- **Scenario: close-app-tolerates-app-that-quit** — once an app has quit by itself (its `close`
  event fired; Playwright no longer answers `process()` for it), `closeApp` resolves without
  throwing.
- **Scenario: loads-app-from-app-scheme** — the main window's URL starts with `app://app/`.
- **Scenario: renders-pong-over-ipc** — the renderer's `<output data-testid="ping">` shows `pong`,
  i.e. a real sender-validated `ping` round trip through preload and main.
- **Scenario: effective-webpreferences-are-hardened** — in the main process,
  `webContents.getLastWebPreferences()` of the window matches `HARDENED_WEB_PREFERENCES`.
- **Scenario: renderer-has-no-node-or-ipc-globals** — the page has no `require`, `process`,
  `ipcRenderer`, `module` or `Buffer` globals, and `window[IPC_BRIDGE_KEY]` has exactly
  `IPC_BRIDGE_METHODS` as keys.
- **Scenario: boots-under-strict-csp-without-violations** — the response CSP is `APP_CSP` and a
  reload of the app page logs no console errors, no CSP / Trusted Types violations and no page errors.

## Foreign pages and untracked windows
Both use windows the test creates from the main process (`openUntrackedWindow`): the same
`HARDENED_WEB_PREFERENCES` and the app's own preload, but never `track`ed by the app, so they are
not app windows. Foreign content is a page on a loopback HTTP server started by the test.
- **Scenario: app-scheme-refuses-foreign-pages** — (`APP_REQUEST_FILTER`, `app-protocol.spec.ts`)
  an untracked window cannot load the app document: `loadURL(APP_ENTRY_URL)` fails with
  `ERR_BLOCKED_BY_CLIENT`. A loopback page in an untracked window (same session) loads its own
  `/ok.js` (control) but `<script src="app://app/assets/index-*.js">` fires `error`. The app window
  still fetches that script (`200`).
- **Scenario: untracked-window-is-forbidden** — because an untracked window cannot load `app://`
  at all (above), the sender gate is exercised from a loopback page in an untracked window: the
  preload bridge exists there (`window[IPC_BRIDGE_KEY]`), and `invoke({ type: 'query', path:
  'ping' })` resolves exactly the `FORBIDDEN` error envelope (unknown window and a non-`app://`
  origin), never `pong`.

