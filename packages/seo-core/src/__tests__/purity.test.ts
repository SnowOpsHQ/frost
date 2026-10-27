// Spec: specs/seo-rules.feature.md (seo-core is pure TypeScript: no Electron, DOM, Node or Zod)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

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
      const allowed = specifier.startsWith('.') || ['@app/specs/seo-rules.spec', '@app/specs/seo-sidebar.spec', '@app/specs/seo-limits.spec', '@app/specs/schema-types.spec', '@app/specs/seo-indexability.spec', '@app/specs/seo-compliance.spec'].includes(specifier) || (specifier === '@app/specs/seo-snapshot.spec' && /import type|export type/.test(code));
      expect(allowed, `${path.relative(SRC, file)} imports ${specifier}`).toBe(true);
    }
    for (const value of code.matchAll(/^import (?!type)[^;]*from '@app\/specs\/seo-snapshot\.spec'/gm)) expect.fail(`${file}: value import of the Zod snapshot spec: ${value[0]}`);
    expect(code, file).not.toMatch(/\b(document|window|process|require|globalThis)\b\s*[.[(]/);
  }
});
