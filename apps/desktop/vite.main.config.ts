import { defineConfig } from 'vite';

// Forge's Vite plugin supplies the lib entry and CJS output; see forge.config.ts.
// `node:sqlite` (the browser-session database, `@app/db`) is a Node builtin of Electron's main
// process: Forge already leaves `module.builtinModules` external, but whether that list names
// `node:sqlite` depends on the Node running the build, so it is listed here too. Everything else
// `@app/db` needs (Drizzle) is bundled: the packaged app reads nothing from `node_modules`.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node:sqlite'],
    },
  },
});
