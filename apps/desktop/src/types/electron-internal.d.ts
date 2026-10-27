// Types for Electron APIs that exist at runtime but are absent from electron.d.ts.

declare global {
  namespace Electron {
    interface WebContents {
      /**
       * Undocumented internal: the webPreferences the WebContents was last created/navigated with
       * (`null` once destroyed). Used by tests to assert effective hardening; verified present in
       * Electron 45. Do not depend on it from production code.
       */
      getLastWebPreferences(): WebPreferences | null;
    }
  }
}

export {};
