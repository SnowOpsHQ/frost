import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { GEIST_FONTS_ALIAS, GEIST_PACKAGE } from '../../specs/design-tokens.spec.ts';
import { packageDir } from './third-party-notices.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('./src/renderer'),
  build: {
    // Forge's default outDir is relative to root; keep it at .vite/renderer/<name> under the app.
    outDir: here('./.vite/renderer/main_window'),
    emptyOutDir: true,
  },
  resolve: {
    // Forge's renderer defaults set preserveSymlinks; workspace packages (@app/specs, …) then resolve
    // under node_modules and the dev optimizer pre-bundles their raw .ts, failing on `type` imports.
    preserveSymlinks: false,
    // `@geist-fonts/…` (fonts.css) is the installed geist package's dist/fonts/, which its `exports`
    // map does not expose (specs/design-tokens.spec.ts, GEIST_FONTS_ALIAS). Vite emits each woff2 it
    // reaches as a hashed asset (they are well above its 4 KB inline limit, so never a data: URI).
    alias: { [GEIST_FONTS_ALIAS]: path.join(packageDir(GEIST_PACKAGE.name, 'apps/desktop'), 'dist/fonts') },
  },
  plugins: [react()],
});
