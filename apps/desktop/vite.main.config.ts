import { defineConfig } from 'vite';
import { webVitalsSource } from './vite.web-vitals.ts';

// Forge's Vite plugin supplies the lib entry and CJS output; see forge.config.ts.
// `node:sqlite` (the browser-session database, `@app/db`) is a Node builtin of Electron's main
// process: Forge already leaves `module.builtinModules` external, but whether that list names
// `node:sqlite` depends on the Node running the build, so it is listed here too. Everything else
// `@app/db` needs (Drizzle) is bundled: the packaged app reads nothing else from `node_modules`.
// The exception is libSQL (specs/sync-package.spec.ts): its native module is found at runtime, so
// `@libsql/client` and `libsql` (and their subpaths) stay external, `import()` of them is emitted as
// `require` (`dynamicImportInCjs: false`), and the packaged app ships them in app.asar/node_modules
// (libsql-packaging.ts).
// `virtual:web-vitals-iife` is the web-vitals IIFE as a string (vite.web-vitals.ts).
export default defineConfig({
  plugins: [webVitalsSource()],
  build: {
    rollupOptions: {
      external: ['node:sqlite', /^@libsql\/client(\/|$)/, /^libsql(\/|$)/],
      output: { dynamicImportInCjs: false },
    },
  },
});
