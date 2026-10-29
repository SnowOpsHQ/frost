import { defineConfig } from 'vite';
import { webVitalsSource } from './vite.web-vitals.ts';

// Forge's Vite plugin supplies the lib entry and CJS output; see forge.config.ts.
// `node:sqlite` (the browser-session database, `@app/db`) is a Node builtin of Electron's main
// process: Forge already leaves `module.builtinModules` external, but whether that list names
// `node:sqlite` depends on the Node running the build, so it is listed here too. Everything else
// `@app/db` needs (Drizzle) is bundled: the packaged app reads nothing from `node_modules`.
// `virtual:web-vitals-iife` is the web-vitals IIFE as a string (vite.web-vitals.ts).
export default defineConfig({
  plugins: [webVitalsSource()],
  // Public build-time values (`import.meta.env.FROST_PUBLIC_*`, src/main/account/config.ts); never a secret.
  envPrefix: ['VITE_', 'FROST_PUBLIC_'],
  build: {
    rollupOptions: {
      external: ['node:sqlite'],
    },
  },
});
