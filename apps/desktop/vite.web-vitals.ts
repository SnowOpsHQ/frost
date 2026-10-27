import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

// The web-vitals library's IIFE build, bundled into main as a string (specs/seo-speed.feature.md,
// Measurement): main injects it into a tab's isolated speed world only, never the main world and
// never the chrome. The package's `exports` map does not expose `dist/web-vitals.iife.js`, so this
// plugin reads it from the installed package (beside the entry `require` resolves) and serves it as
// the default export of `virtual:web-vitals-iife`. Used by the main build and by vitest.

export const WEB_VITALS_MODULE = 'virtual:web-vitals-iife';
const RESOLVED = `\0${WEB_VITALS_MODULE}`;

/** The IIFE's source, its source-map comment dropped; it must define the `webVitals` global. */
export function readWebVitalsIife(): string {
  const entry = createRequire(import.meta.url).resolve('web-vitals');
  const code = readFileSync(path.join(path.dirname(entry), 'web-vitals.iife.js'), 'utf8').replace(/\n\/\/# sourceMappingURL=\S*\s*$/, '\n');
  if (!code.startsWith('var webVitals=')) throw new Error('web-vitals: unexpected IIFE build (no `var webVitals=`)');
  return code;
}

export function webVitalsSource(): Plugin {
  return {
    name: 'frost-web-vitals-source',
    resolveId: (id) => (id === WEB_VITALS_MODULE ? RESOLVED : null),
    load: (id) => (id === RESOLVED ? `export default ${JSON.stringify(readWebVitalsIife())};` : null),
  };
}
