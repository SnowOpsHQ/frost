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
