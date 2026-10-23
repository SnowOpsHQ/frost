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
  plugins: [react()],
});
