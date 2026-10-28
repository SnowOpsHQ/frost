// Spec: specs/intent-classifier.spec.ts (Least privilege: the utility process never opens a file or a
// socket) · Acceptance: specs/intent-classifier.feature.md (Utility process); review focus
// intent-host-protocol-is-closed
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The utility process's own sources (tests excluded). */
const sources = readdirSync(WORKER_DIR)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, text: readFileSync(path.join(WORKER_DIR, file), 'utf8') }));

/**
 * What the worker may import: its own modules, the specs (plain values and Zod), Zod, and ONNX
 * Runtime (loaded lazily, never under the fake). Anything else — `fs`, `net`, `http(s)`,
 * `child_process`, `worker_threads`, `electron` … — would give the process a file, a socket or a
 * process of its own.
 */
const ALLOWED = [/^\.\.?\//, /^@app\/specs\/[a-z0-9-]+\.(spec|schema)$/, /^zod$/, /^onnxruntime-node$/];

/** Module specifiers in `import … from`, `export … from`, `import(…)` and `require(…)`. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, /^\s*import\s*['"]([^'"]+)['"]/gm]) {
    for (const match of text.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

/** Globals that reach the network or the OS without an import. */
const FORBIDDEN_GLOBALS = /\b(fetch|WebSocket|EventSource|XMLHttpRequest|process\.binding|process\.dlopen|process\.env|createRequire)\b/;

describe('intent worker sources', () => {
  test('intent-worker-imports-nothing-privileged', () => {
    expect(sources.map(({ file }) => file).sort()).toEqual(expect.arrayContaining(['embed.ts', 'fake.ts', 'index.ts', 'prototypes.ts', 'tokenizer.ts', 'worker.ts']));
    for (const { file, text } of sources) {
      for (const specifier of specifiers(text)) expect(ALLOWED.some((pattern) => pattern.test(specifier)), `${file} imports ${specifier}`).toBe(true);
      // Comments may name them; code may not.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(FORBIDDEN_GLOBALS.exec(code)?.[0], file).toBeUndefined();
      expect(/['"`](node:)?(fs|fs\/promises|net|tls|dgram|dns|http|https|http2|child_process|cluster|worker_threads|electron|inspector|module)['"`]/.exec(code)?.[0], file).toBeUndefined();
    }
  });

  test('intent-worker-scan-catches-privileged-imports', () => {
    // The scan itself: each of these would fail the test above.
    for (const line of ["import { readFile } from 'node:fs/promises';", "import net from 'net';", "const cp = require('child_process');", "const e = await import('electron');", "export * from 'https';"]) {
      expect(specifiers(line).some((specifier) => !ALLOWED.some((pattern) => pattern.test(specifier))), line).toBe(true);
    }
    expect(FORBIDDEN_GLOBALS.test('await fetch(url)')).toBe(true);
  });
});
