# @app/desktop

The frost Electron app (main, preload, renderer), packaged with Electron Forge. As of Phase 1 it is a
usable, hardened browser; the SEO sidebar and the agent come in later phases
(`docs/design/IMPLEMENTATION-PLAN.md` §4).

## What it does
- **Tabs.** A tab strip with new / close / switch (click, middle-click to close, Cmd/Ctrl+1…9,
  Ctrl+Tab), up to 50 tabs; each tab is its own `WebContentsView` with its own history. A page that
  calls `window.close()` closes its tab; the window always keeps at least one tab.
- **Address bar.** URLs, scheme-less hosts (`example.com`, `localhost:5173`) and searches (Google);
  anything that is not `http(s)` becomes a search, never a navigation. Back, forward, reload / stop,
  a lock or not-secure badge, and a status bar (loading, connection, notices, page zoom).
- **Page commands.** Reload (Cmd/Ctrl+R, F5), Hard Reload (Shift+Cmd/Ctrl+R), Back / Forward (Cmd+[ /
  Cmd+] on macOS, Alt+Left / Alt+Right elsewhere), Zoom In / Out / Actual Size (Cmd/Ctrl + `=` `-`
  `0`, per host), Stop (Esc while loading). A right-click menu in pages: Back / Forward / Reload,
  Open Link / Image in New Tab, Copy Link / Image Address, Cut / Copy / Paste / Select All, and
  Search Google for the selection.
- **Error and crash panels.** A failed load (unreachable, offline, refused certificate …) or a
  crashed renderer shows frost's own panel with Try again / Reload; a refused certificate offers no
  way to proceed. A hung page is reported in the status bar.
- **Permission prompts.** Notifications, geolocation, camera / microphone and clipboard-read ask
  in a bar under the toolbar, naming the requesting origin (and the site embedding it). Allow lasts
  for this run; Block is remembered. Everything else is denied without asking. HTML fullscreen is
  allowed, with a notice; Esc always leaves it.
- **Session restore.** Open tabs come back on relaunch (the active one loads at once, the others
  when first shown); visits and Block decisions are kept in a local SQLite database in the profile.
  **Clear Browsing Data…** (File menu; the app menu on macOS) clears visits, permission decisions
  and site storage, after a confirmation.
- One frost per profile: launching it again shows the running window.

## Security model (summary)
The details, each with its named tests, are in `specs/*.feature.md`.
- **Two kinds of WebContents.** The chrome (the React UI) is served from `app://app` with a strict
  CSP and Trusted Types, and talks to main only through the typed, sender-guarded tRPC channel
  (`packages/ipc-contract`; every procedure runs `enforceSender`). Tabs run on their own session
  partition (`persist:frost-browser`) with no preload, `sandbox`, `contextIsolation`, `webSecurity`
  on and `nodeIntegration` off, set explicitly by one allowlisted factory (`createTabView`); they
  have no IPC at all and can never load `app://` or `file:`.
- **Navigation guards.** Tabs navigate and redirect only to `http(s)` and `about:blank`; `mailto:`
  reaches `shell.openExternal` only on a real user gesture, from the tab's main frame, with no
  attachment keys. Popups become background tabs only on a gesture. `<webview>` is refused,
  downloads are cancelled (no download manager yet), certificate errors are always refused,
  JavaScript dialogs are off, and `beforeunload` cannot trap the user.
- **Permissions** are deny-by-default and scoped to (requesting origin, top-level origin); the
  prompt's buttons arm only after a delay, and not while a fullscreen page covers them.
- **Packaged builds** refuse remote debugging, and the Electron fuses (`PACKAGED_FUSES` in
  `specs/macos-package.spec.ts`) disable run-as-Node, `NODE_OPTIONS` and the Node inspector flags,
  and turn on cookie encryption, ASAR integrity validation and loading the app only from its ASAR.
- CI gates: Electronegativity, Semgrep (`ipc-sender-guard`, `webcontents-factory`) and the e2e
  suite (`specs/ci-gates.feature.md`).

## Running, building, testing
From the repo root (`pnpm install` first):
- `pnpm --filter @app/desktop start` — dev run (Vite dev server; it overwrites `.vite/build` with a
  dev bundle, so run `build` again before the e2e).
- `pnpm --filter @app/desktop build` — `electron-forge package` for the host platform.
- `pnpm lint` / `pnpm test` — strict TypeScript and the Vitest suites of every package.
- `pnpm --filter @app/desktop test:e2e` — Playwright e2e against the unpackaged build (run `build`
  first; needs a display, `xvfb-run` on a headless Linux).
- `pnpm security:electronegativity`, `pnpm security:semgrep` (needs `uv`) — the CI security gates.
- `pnpm make:mac` (on macOS) — `electron-forge make --platform darwin --arch arm64`
  (see [Building on a Mac](#building-on-a-mac)).
- `pnpm verify:mac` (on macOS, after `make:mac`) — checks the bundle id, arch, signature and
  entitlements, fuses, launch and debugging lockdown, and that the `.app` inside the published zip
  and dmg verifies too (`specs/macos-package.feature.md`). CI: `.github/workflows/macos.yml`.

If your shell exports `ELECTRON_RUN_AS_NODE` (some terminals and agent harnesses do), unset it for
manual launches (`env -u ELECTRON_RUN_AS_NODE …`); the e2e harness strips it itself.

## Source layout
- `src/main/` — the main process: `index.ts` (wiring), `browser/` (the browser controller and its
  parts, the navigation guard, permissions, address resolution, shortcuts, the context menu),
  `security/`, `protocol/` (`app://`), `menu.ts`, `session-store.ts`, `window.ts` (the window and
  tab-view factories).
- `src/preload/` — the chrome's preload: the IPC bridge only.
- `src/renderer/` — the chrome (React): `App.tsx` (layout), `components/`, `hooks/`, and pure
  helpers with unit tests.
- `e2e/` — Playwright suites (`harness.ts` launches the app; `helpers.ts` holds shared helpers).

## Building on a Mac
Prerequisites:
- An Apple Silicon Mac (builds are arm64 only for now).
- Xcode Command Line Tools (`xcode-select --install`): `codesign`, plus the compiler node-gyp needs
  to build the DMG maker's native addons (`fs-xattr`, `macos-alias`).
- Python 3 (for node-gyp; the one the Command Line Tools ship is enough).
- Node ≥ 22.18 (`verify-mac-package.mjs` imports the `specs/*.ts` files with Node's built-in type
  stripping).
- pnpm 12.15.0 (`package.json#packageManager`). Without changing a global pnpm, prefix each
  command below with `npx -y pnpm@12.15.0` instead of `pnpm`.

From the repo root:

```sh
pnpm install
pnpm make:mac
pnpm verify:mac
```

Artifacts, under `apps/desktop/out/`:
- `frost-darwin-arm64/frost.app`
- `make/zip/darwin/arm64/frost-darwin-arm64-<version>.zip`
- `make/dmg/arm64/frost-<version>-arm64.dmg` (ULFO)

## macOS signing
By default the app is **ad-hoc signed**. A build made on your own Mac is not quarantined and opens
normally. A **downloaded** build (e.g. the `frost-macos-arm64` artifact of the macOS workflow, a zip
holding the `.zip` and the `.dmg` above) is quarantined, and Gatekeeper refuses it because it is not
notarized. macOS 15 and later no longer offer Control-click › Open; either:

- **(a)** remove the quarantine attribute before mounting the dmg:
  `xattr -d com.apple.quarantine ~/Downloads/frost-*.dmg` (or, after copying the app out,
  `xattr -dr com.apple.quarantine /Applications/frost.app`); or
- **(b)** try to open the app once, then go to System Settings › Privacy & Security and click
  **Open Anyway** (macOS asks once more to confirm).

Developer ID signing and notarization turn on only when **all four** variables are set when running
`make:mac`; otherwise none of them is used:

| Variable | Used for |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | `osxSign.identity`, e.g. `Developer ID Application: Name (TEAMID)` (in the keychain) |
| `APPLE_ID` | notarytool Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | notarytool app-specific password |
| `APPLE_TEAM_ID` | notarytool team id |

Real signing uses the hardened runtime with only `com.apple.security.cs.allow-jit`
(`MAC_ENTITLEMENTS` in `specs/macos-package.spec.ts`). It has not been exercised yet (no Developer
ID); CI never receives these secrets.

## Follow-ups
App icon (Electron's default for now), x64/universal builds, signing in CI, signed auto-update.
