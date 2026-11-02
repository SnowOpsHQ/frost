// Spec: specs/seo-rules.feature.md (seo-core is pure TypeScript: no Electron, DOM, Node or Zod); specs/page-type.feature.md (Purity)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { pageTypeOf, runAudit } from '../index';
import { page } from './fixtures';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every non-test source file of the engine. */
function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

test('seo-core-is-pure', () => {
  const files = sources();
  expect(files.length).toBeGreaterThan(3);
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    const imports = [...code.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const specifier of imports) {
      // Relative modules and the Zod-free specs only; the snapshot spec (Zod) for its types only.
      const allowed = specifier.startsWith('.') || ['@app/specs/seo-rules.spec', '@app/specs/seo-sidebar.spec', '@app/specs/seo-limits.spec', '@app/specs/schema-types.spec', '@app/specs/seo-indexability.spec', '@app/specs/seo-speed.spec', '@app/specs/seo-compliance.spec', '@app/specs/command-palette.spec', '@app/specs/render-profile.spec', '@app/specs/seo-content.spec', '@app/specs/seo-javascript.spec', '@app/specs/seo-checks.spec', '@app/specs/ai-readiness.spec', '@app/specs/visibility-probes.spec', '@app/specs/page-type.spec'].includes(specifier) || ((specifier === '@app/specs/seo-snapshot.spec' || specifier === '@app/specs/seo-speed.schema.spec' || specifier === '@app/specs/seo-javascript.schema' || specifier === '@app/specs/visibility-probes.schema') && /import type|export type/.test(code));
      expect(allowed, `${path.relative(SRC, file)} imports ${specifier}`).toBe(true);
    }
    for (const value of code.matchAll(/^import (?!type)[^;]*from '@app\/specs\/(seo-snapshot\.spec|seo-speed\.schema\.spec|seo-javascript\.schema|visibility-probes\.schema)'/gm)) expect.fail(`${file}: value import of the Zod snapshot spec: ${value[0]}`);
    expect(code, file).not.toMatch(/\b(document|window|process|require|globalThis)\b\s*[.[(]/);
  }
});

test('pure-no-network', () => {
  // The page type (Decision 14) runs in the analysis worker on the existing snapshot: seo-core modules and Zod-free specs
  // only, and no network, timer, storage or DOM API by name.
  const files = sources(path.join(SRC, 'page-type'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    for (const [, specifier] of code.matchAll(/(?:from|import)\s+'([^']+)'/g)) expect(specifier!.startsWith('.') || /^@app\/specs\/[\w-]+\.spec$/.test(specifier!), `${file} imports ${specifier}`).toBe(true);
    expect(code, file).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator|sendBeacon|importScripts|postMessage|setTimeout|setInterval|localStorage|indexedDB|Date\.now|Math\.random)\b/);
  }
  // Deterministic: the same snapshot, the same page type, in the audit and alone.
  expect(runAudit(page()).pageType).toEqual(runAudit(page()).pageType);
  expect(pageTypeOf(page())).toEqual(runAudit(page()).pageType);
});
