# Feature: hardened main window

Spec: `specs/window-hardening.spec.ts` (`HARDENED_WEB_PREFERENCES`). Design doc §3.
Tests: `apps/desktop/src/main/__tests__/boot.test.ts`. Each line maps to one named test.

- **Scenario: createMainWindow returns a window with hardened webPreferences**
  Given the app creates its main window, when its effective webPreferences are read,
  then they match `HARDENED_WEB_PREFERENCES`.
- **Scenario: sets sandbox explicitly** — `sandbox: true` is present in the BrowserWindow options (not defaulted).
- **Scenario: sets contextIsolation explicitly** — `contextIsolation: true` is present in the options.
- **Scenario: sets nodeIntegration explicitly** — `nodeIntegration: false` is present in the options.
- **Scenario: sets webSecurity explicitly** — `webSecurity: true` is present in the options.
- **Scenario: sets no webPreferences beyond the hardened set** — the BrowserWindow's `webPreferences`
  has exactly the keys of `HARDENED_WEB_PREFERENCES` plus `preload`: nothing that loosens the
  window (`webviewTag`, `nodeIntegrationInSubFrames`, `nodeIntegrationInWorker`,
  `allowRunningInsecureContent`, `experimentalFeatures` …) can be added without changing this spec.

## Tab views on any browse-class partition (`apps/desktop/src/main/browser/__tests__/browse-class.test.ts`)
Spec: `specs/browser.spec.ts` (`TAB_VIEW_WEB_PREFERENCES`, `BROWSE_CLASS_PARTITIONS`). A tab's page
view is made only by `createTabView(partition = BROWSE_PARTITION)` in `window.ts` (Semgrep
`webcontents-factory`), whose hardened values stay literals so Electronegativity sees them; the
caller picks the partition (a browse-class one), never the preferences.
- **Scenario: tab-view-hardened-on-any-partition** — `createTabView()` and `createTabView(<another
  partition>)` both set `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `webSecurity: true`, `disableDialogs: true` and no `preload`; only `partition` differs.
- **Scenario: tab-classified-by-the-registry** — a WebContents is a tab (browse guard, browse
  wiring) only when its session is browse-class (`isBrowseClassSession`); the app window's
  WebContents (the default session) never is, so it keeps the hardened app pin.
