# Feature: CI security gates

Design doc §3 (security model) and §5 (testing & quality gates); Phase 0 Task 5. Specs:
`security-policy.spec.ts`, `window-hardening.spec.ts`, `ipc-sender.spec.ts`,
`ipc-transport.spec.ts`. Workflow: `.github/workflows/ci.yml`. Each gate and scenario below maps to
one named CI step, check or test; any failure fails the workflow.

## Gates (`.github/workflows/ci.yml`, in order)
Runs on every pull request and on pushes to `main`; a superseded PR run is cancelled, a `main` run
never is.
- **Gate: lint-test-build** — `pnpm turbo run lint test build` (strict TypeScript, vitest suites,
  Forge package).
- **Gate: electronegativity** — `pnpm security:electronegativity`
  (`scripts/electronegativity.mjs`): Electronegativity (pinned devDependency) over
  `apps/desktop/src`, `apps/desktop/forge.config.ts` and `packages`, for the installed Electron
  version. Fails on any finding not accepted in `security/electronegativity-baseline.json`, on an
  accepted entry that matches more or fewer findings than its `count` (stale or duplicated), and on
  any file the scanner could not parse.
- **Gate: semgrep-rule-test** — `pnpm security:semgrep:test`: Semgrep's native rule test of each
  `semgrep/<name>.yml` (`ipc-sender-guard`, `webcontents-factory`) against
  `semgrep/__fixtures__/<name>.ts`; every `// ruleid:` line must be flagged and every `// ok:` line
  must not.
- **Gate: semgrep-repo-scan** — `pnpm security:semgrep:scan`: all those rules over `apps`,
  `packages` and `specs` (tracked and untracked files; only git-ignored paths are skipped) report
  **zero** findings.
- **Gate: e2e** — `pnpm --filter @app/desktop test:e2e` under `xvfb-run` against the unpackaged
  build (`ipc-e2e.feature.md` and the scenarios below), Chromium sandbox on.

## Semgrep `ipc-sender-guard` rules (Review Focus `semgrep-flags-unguarded-handler`)
Exercised by **semgrep-rule-test** (fixture) and **semgrep-repo-scan** (the real code is clean).
Test-only code (`__tests__/`, `*.test.ts`, `apps/desktop/src/test/`) is never bundled and is
excluded from every rule.
- **Scenario: semgrep-flags-unguarded-handler** — the fixture's deliberately unguarded handlers
  and procedures are all flagged, the guarded forms are not, and the repo scan is clean. Rules:
  - `ipc-handler-outside-transport` — an `on`/`once`/`handle`/`handleOnce`/`addListener`/
    `prepend*Listener` registration on `ipcMain`, `<x>.ipcMain`, a value typed `IpcMain`, or the
    `ipc` of a WebContents / WebFrameMain (`win.webContents.ipc`, `<contents>.mainFrame.ipc`,
    `event.sender.ipc`, `webContents.fromId(…).ipc`, a value typed `WebContents`/`WebFrameMain`),
    including through an alias, an aliased import or a destructuring, anywhere except
    `packages/ipc-contract/src/transport/main.ts`. Not flagged: the `ipc` property of an unrelated
    object, and the other names of a destructuring that also takes `ipcMain`
    (`const { ipcMain, app } = require('electron'); app.on('ready', …)`).
  - `ipc-main-escapes` — `ipcMain` / `<x>.ipcMain` passed as a call argument (directly or in an
    object literal, shorthand or keyed) or stored in an object literal, anywhere except the
    transport; a registration through the injected value would not be visible to the rule above.
    The one allowed hand-off is `attachIpcHandler({ …, ipcMain, … })`.
  - `trpc-procedure-without-enforce-sender` — any reference to `publicProcedure` (bare or through a
    namespace import) that is not the receiver of an immediate `.use(enforceSender)`: an unguarded
    `.query`/`.mutation`/`.subscription`, `.input()` or another middleware before the guard, an alias
    (`const base = publicProcedure`), an aliased import, a re-export. Its definition in `trpc.ts` is
    the one exception.
  - `trpc-builder-outside-trpc-module` — `initTRPC` (import or use) or a `.procedure` builder chain
    (`<t>.procedure.use/input/output/meta/query/mutation/subscription/concat/unstable_concat(…)`)
    anywhere except `packages/ipc-contract/src/trpc.ts`; a plain read of a `procedure` property is
    not flagged.
  - `renderer-bridge-outside-preload` — `ipcRenderer` / `contextBridge` (identifier, member, import,
    destructuring) anywhere except `packages/ipc-contract/src/transport/preload.ts`.
- **Scenario: semgrep-scan-fails-on-regression** — adding an unguarded procedure to
  `packages/ipc-contract/src/router.ts` makes **semgrep-repo-scan** exit non-zero (verified by hand
  when the gate was introduced; the fixture pins it permanently).

## Semgrep `webcontents-factory` rule (Phase-1 guard: every WebContents is hardened)
Electronegativity cannot see a `WebContentsView` and only resolves literal options, so the
hardening of new WebContents is pinned structurally: every WebContents is created by an allowlisted
factory that sets the hardened webPreferences explicitly (`window-hardening.spec.ts`) and is unit
tested for them. Allowlist (the rule's `paths.exclude`): `apps/desktop/src/main/window.ts`
(`createMainWindow`; and, since Phase 1, the tab-view factory `createTabView`, whose prefs are
pinned to `TAB_VIEW_WEB_PREFERENCES` by `browser/__tests__/tab-view.test.ts`). Test-only code (`__tests__/`, `*.test.ts`, `apps/desktop/src/test/`,
`apps/desktop/e2e/`) is excluded.
- **Scenario: semgrep-flags-webcontents-outside-factory** — `webcontents-outside-factory`:
  `new BrowserWindow(…)`, `new BrowserView(…)` or `new WebContentsView(…)` (bare, `electron.X`, an
  aliased import) and a class extending one of them, anywhere outside the allowlist, are flagged
  (fixture `semgrep/__fixtures__/webcontents-factory.ts`); static calls such as
  `BrowserWindow.fromWebContents(…)` are not; the repo scan is clean.

## Electronegativity (`scripts/electronegativity.mjs`)
- **Scenario: electronegativity-sees-literal-hardening** — `createMainWindow()` writes `sandbox`,
  `contextIsolation`, `nodeIntegration` and `webSecurity` as literals inside `new BrowserWindow({…})`
  (the scanner cannot resolve `HARDENED_WEB_PREFERENCES.*` or see through `satisfies`), so no
  `SANDBOX_JS_CHECK` / `CONTEXT_ISOLATION_JS_CHECK` / `NODE_INTEGRATION_JS_CHECK` finding exists;
  `boot.test.ts` keeps the literals equal to `HARDENED_WEB_PREFERENCES`. (The scanner skips
  `nodeIntegration` while `sandbox: true`, since a sandboxed renderer cannot load Node; the boot test
  and e2e `effective-webpreferences-are-hardened` pin it regardless.)
- **Scenario: electronegativity-fails-on-regression** — setting `sandbox: false`,
  `contextIsolation: false` or `webSecurity: false` in `window.ts` makes **electronegativity** exit
  non-zero (verified by hand when the gate was introduced).
- **Scenario: electronegativity-runs-hermetically** — the scan makes no network calls (the
  translation refresh fails fast to the bundled strings; `AvailableSecurityFixesGlobalCheck`, which
  needs a remote release list that stops at Electron 22, is disabled, as is the informational
  `ElectronVersionJSONCheck` that only feeds it), so its result depends only on
  the pinned package and the sources. Global (whole-app) checks run on `apps/desktop/src` only;
  `apps/desktop/forge.config.ts` and `packages` get the per-file checks.
- **Scenario: electronegativity-baseline-is-reviewed** — every accepted finding is keyed by check
  id, file and source line text (not line number), and carries a one-line rationale; editing an
  accepted line re-opens it for review. An entry accepts exactly `count` findings (default 1): a
  second identical line (e.g. a duplicated `return new BrowserWindow({`) fails the gate instead of
  inheriting the acceptance, as does a key listed twice (verified by hand when introduced).

## openExternal deny e2e (`apps/desktop/e2e/external-url.e2e.ts`)
A loopback page (Node `http` server on `127.0.0.1:0` in the test process) with one button per URL,
each calling `window.open(url)` on click, is loaded with `loadURL` in a test-only `BrowserWindow`
(hardened webPreferences, no preload) created from the main process; it gets the app-wide guards
through `web-contents-created`. `shell.openExternal` is replaced in the main process by a recorder
that opens nothing, and every window-open handler installed on a WebContents is wrapped to record
the URL it judged and its verdict. Gestures are real Playwright clicks (CDP input → trusted
`input-event` `mouseDown`, checked by `real-click-is-a-trusted-activation`).
- **Scenario: real-click-is-a-trusted-activation** — a Playwright click on the page produces a
  `mouseDown` `input-event` on its WebContents (the gesture signal of `USER_ACTIVATION_INPUT_TYPES`).
- **Scenario: does-not-open-non-web-schemes-on-click** — clicking the `reaprobe://x`, `vscode://x`,
  `file:///etc/passwd` and `javascript:void(0)` buttons opens nothing externally. The handler judges
  (and denies) `reaprobe://x`, `vscode://x` and `about:blank` (Chromium's form of a `javascript:`
  open); Chromium refuses a web page's `window.open('file:…')` before any handler runs. A real click
  on the `https:` button afterwards is opened (control: the pipeline is live).
- **Scenario: opens-allowlisted-url-once-on-real-click** — clicking the `https://example.com/`
  button calls `shell.openExternal` exactly once, with `https://example.com/`.
- **Scenario: does-not-open-without-gesture** — `window.open('https://example.com/')` from a timer
  after load (no input at all), from `button.click()` run by page script, and from a script-dispatched
  synthetic `mousedown`+`click` reaches the handler and is denied: no `shell.openExternal` call.
- **Invariant: creates-no-windows** — asserted inside each scenario above: no `BrowserWindow` or
  `WebContents` is created besides the test's own window(s).
