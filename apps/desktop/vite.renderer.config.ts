import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('./src/renderer'),
  build: {
    // Forge's default outDir is relative to root; keep it at .vite/renderer/<name> under the app.
    outDir: here('./.vite/renderer/main_window'),
    emptyOutDir: true,
  },
  // Forge's renderer defaults set preserveSymlinks; workspace packages (@app/specs, …) then resolve
  // under node_modules and the dev optimizer pre-bundles their raw .ts, failing on `type` imports.
  resolve: { preserveSymlinks: false },
  plugins: [react()],
});
