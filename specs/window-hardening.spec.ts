/**
 * Window-hardening contract (design doc §3 "Security model": every WebContents sets
 * `sandbox`, `contextIsolation`, `nodeIntegration: false` and `webSecurity` **explicitly**,
 * never relying on Electron defaults).
 *
 * Single source of truth: `createMainWindow()` sets each of these explicitly in its `webPreferences`, and the
 * boot test asserts the window conforms. Acceptance list: `window-hardening.feature.md`.
 */
export const HARDENED_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
} as const satisfies { sandbox: true; contextIsolation: true; nodeIntegration: false; webSecurity: true };

export type HardenedWebPreferences = typeof HARDENED_WEB_PREFERENCES;
