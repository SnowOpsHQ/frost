// Spec: specs/changes-diff.feature.md (change-intel is pure TypeScript: no Electron, DOM, Node or Zod)
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

test('change-intel-is-pure', () => {
  // The pattern itself catches every import form.
  const probe = `import a from "x1"; export { b } from 'x2'; const c = import("x3"); import 'x4';`;
  expect([...probe.matchAll(/\b(?:from|import)\s*\(?\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2])).toEqual(['x1', 'x2', 'x3', 'x4']);
  const files = sources();
  expect(files.length).toBeGreaterThan(3);
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    // `import … from`, `export … from`, side-effect `import '…'` and `import('…')`, either quote.
    const imports = [...code.matchAll(/\b(?:from|import)\s*\(?\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2]!);
    for (const specifier of imports) {
      // Relative modules and the Zod-free capture spec only.
      const allowed = specifier.startsWith('.') || specifier === '@app/specs/capture.spec';
      expect(allowed, `${path.relative(SRC, file)} imports ${specifier}`).toBe(true);
    }
    expect(code, file).not.toMatch(/\b(document|window|process|require|globalThis)\b\s*[.[(]/);
  }
});
