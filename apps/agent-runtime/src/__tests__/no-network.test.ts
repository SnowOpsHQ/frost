// Spec: docs/plans/phase-5-ai-agent.md decisions 5 and 6 · Acceptance: specs/agent-runtime.feature.md
// (No network). The runtime's own sources import nothing that opens a socket, a process, a worker
// or a file: only the AI SDK, its providers, Zod, frost's specs and tool definitions, and its own
// files; and none reaches a builtin around its imports. This reads the runtime's own sources only:
// third-party code in the bundle is not scanned here (the startup lockdown removes the globals and
// the `process` functions it could use to reach one).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'child_process',
  'worker_threads',
  'cluster',
  'fs',
  'fs/promises',
  'vm',
  'inspector',
  'module',
  'electron',
  'electron/main',
  'electron/utility',
  'ws',
  'undici',
  'node-fetch',
  'axios',
];

const ALLOWED_PACKAGES = ['ai', '@ai-sdk/anthropic', '@ai-sdk/openai', '@ai-sdk/gateway', '@ai-sdk/provider', 'zod', '@app/ai-skills'];
const ALLOWED_PREFIXES = ['@app/specs/agent-', './'];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Every module specifier a source names: static and dynamic imports, re-exports and `require`. */
export function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1] !== undefined) found.push(match[1]);
  return found;
}

describe('runtime-has-no-network', () => {
  const files = sources(SRC);

  test('the scan sees the runtime and its imports', () => {
    expect(files.map((file) => path.basename(file))).toEqual(expect.arrayContaining(['index.ts', 'chat.ts', 'proxy-fetch.ts', 'provider.ts', 'lockdown.ts', 'transport.ts', 'runtime.ts']));
    expect(specifiers("import { a } from 'node:http';\nexport * from \"ws\";\nconst x = await import('node:net'); require('child_process'); import 'electron';")).toEqual(['node:http', 'ws', 'electron', 'node:net', 'child_process']);
  });

  test('runtime-has-no-network', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of specifiers(source)) {
        const bare = specifier.replace(/^node:/, '');
        const where = `${path.relative(SRC, file)} imports ${specifier}`;
        expect(FORBIDDEN.includes(bare), where).toBe(false);
        expect(ALLOWED_PACKAGES.includes(specifier) || ALLOWED_PREFIXES.some((prefix) => specifier.startsWith(prefix)), where).toBe(true);
      }
      // No reach for a builtin around the import scan (lockdown.ts names them to remove them).
      if (path.basename(file) !== 'lockdown.ts') {
        expect(source, path.relative(SRC, file)).not.toMatch(/getBuiltinModule|createRequire|process\.binding|_linkedBinding|dlopen|globalThis\.require/);
      }
    }
  });
});
