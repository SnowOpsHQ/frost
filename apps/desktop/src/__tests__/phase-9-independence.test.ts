// Spec: specs/ai-answers.spec.ts (Phase 9 independence; AI_ANSWERS_TABLES), specs/ai-readiness.spec.ts (Phase 9's
// AI-readiness score)
// Acceptance: specs/ai-answers.feature.md (Independence) · plan docs/plans/phase-12-big-bets.md Decision 9 (cross-plan
// ruling: Phase 9's AI-readiness score must not read `ai_answers` or import this phase's modules), Global constraints
// ("Phase 9 independence"), Task 9 (`phase-9-score-does-not-read-ai-answers`)
//
// An import-graph walk: from every Phase 9 AI-readiness module (the score in seo-core, its specs, the llms.txt probe that
// feeds it, and the renderer's view of it), follow every relative and `@app/*` import, value or type, to the files they
// name. None may be an `ai-answers*` module, Task 8's `specs/ai-search.*`, or anything under `main/ai-search/` or
// `main/data-sources/` (the BYO keys and the paid data client), and none may name the `ai_answers` table.
//
// Not a seed, on purpose: `main/serp/serp-worker.ts`. It is the SERP worker's entry, shared by several features' jobs
// (the SERP, the probes, `llms-txt`, the data APIs' `api` job and Task 8's `ai-answer` job, so it imports
// `main/ai-search/parse.ts`). No Phase 9 module imports it: the probe client (`probe-parser.ts`) only posts
// `{ kind: 'llms-txt' }` jobs to a worker it is handed (`spawn`: `serp/setup.ts` starts the bundled `serp-analysis.cjs`
// by path, `new Worker(…)`), and the worker hands
// that job to `llms-parse.ts`, which is a seed. So the score's code never loads the AI search parse; the walk would
// reach the worker only through an import, and it finds none.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { AI_ANSWERS_TABLES } from '@app/specs/ai-answers.spec';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const at = (...parts: string[]) => path.join(REPO, ...parts);

/** Each workspace package's import name → its source entry points (`exports`), as `package.json` maps them. */
const PACKAGES: Readonly<Record<string, string>> = { '@app/seo-core': 'packages/seo-core', '@app/db': 'packages/db', '@app/ai-skills': 'packages/ai-skills', '@app/ipc-contract': 'packages/ipc-contract' };

/** Every `.ts` / `.tsx` source under `dir` (tests left out). */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The file `base` names, trying the extensions TypeScript would; `null` when there is none. */
function fileOf(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The source file `specifier` (imported from `from`) resolves to; `null` for a package outside the workspace or a non-source asset. */
function resolve(specifier: string, from: string): string | null {
  if (/\.(css|svg|png|json)$/.test(specifier)) return null;
  if (specifier.startsWith('.')) {
    const file = fileOf(path.resolve(path.dirname(from), specifier.replace(/\.js$/, '')));
    expect(file, `${path.relative(REPO, from)} imports ${specifier}`).not.toBeNull();
    return file;
  }
  if (specifier.startsWith('@app/specs/')) {
    const file = fileOf(at('specs', specifier.slice('@app/specs/'.length)));
    expect(file, specifier).not.toBeNull();
    return file;
  }
  const name = Object.keys(PACKAGES).find((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
  if (name === undefined) return null;
  const dir = at(PACKAGES[name]!);
  const exportsMap = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { exports: Record<string, string> }).exports;
  const key = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  const target = exportsMap[key];
  expect(target, specifier).toBeDefined();
  return path.join(dir, target!);
}

/** Every module specifier `code` imports or re-exports (static and dynamic, value and type). */
function specifiersOf(source: string): string[] {
  // Comments first: a doc comment may show an import as an example.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const found = [...code.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g), ...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)];
  return found.map((match) => match[1]!);
}

/** The Phase 9 AI-readiness modules the walk starts from. */
function phase9Modules(): string[] {
  return [
    // The score itself (seo-core, pure).
    ...sources(at('packages/seo-core/src/ai-readiness')),
    // Its specs.
    at('specs/ai-readiness.spec.ts'),
    at('specs/ai-readiness.schema.ts'),
    // The llms.txt probe that feeds it (main) and its worker-side parse.
    at('apps/desktop/src/main/serp/llms-parse.ts'),
    at('apps/desktop/src/main/serp/probes.ts'),
    at('apps/desktop/src/main/serp/probe-parser.ts'),
    // The renderer's view of the score.
    at('apps/desktop/src/renderer/ai-readiness-view.ts'),
    at('apps/desktop/src/renderer/ai-readiness-palette.ts'),
    at('apps/desktop/src/renderer/components/seo/AiReadiness.tsx'),
  ];
}

test('phase-9-score-does-not-read-ai-answers', () => {
  const seeds = phase9Modules();
  for (const seed of seeds) expect(existsSync(seed), seed).toBe(true);
  expect(seeds.length).toBeGreaterThan(9);
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      const next = resolve(specifier, file);
      if (next !== null && !seen.has(next)) queue.push(next);
    }
  }
  // The walk reaches well past the seeds (seo-core's engine and its specs), so the check means something.
  expect(seen.size).toBeGreaterThan(40);
  expect([...seen].some((file) => file.endsWith(path.join('seo-core', 'src', 'ai-readiness', 'score.ts')))).toBe(true);
  const relative = [...seen].map((file) => path.relative(REPO, file).split(path.sep).join('/'));
  const offending = relative.filter(
    (file) =>
      /(^|\/)ai-answers[^/]*$/.test(file) ||
      file.includes('/ai-answers/') ||
      file.startsWith('specs/ai-search.') ||
      file.startsWith('apps/desktop/src/main/ai-search/') ||
      file.startsWith('apps/desktop/src/main/data-sources/') ||
      file.endsWith('/main/serp/serp-worker.ts'),
  );
  expect(offending).toEqual([]);
  // No reached module names the table.
  for (const file of seen) for (const table of AI_ANSWERS_TABLES) expect(readFileSync(file, 'utf8').includes(table), path.relative(REPO, file)).toBe(false);
  // The walk would catch it: the AI answers modules do reach both.
  const self = specifiersOf(readFileSync(at('apps/desktop/src/main/ai-answers/service.ts'), 'utf8')).map((s) => resolve(s, at('apps/desktop/src/main/ai-answers/service.ts')));
  expect(self.some((file) => file !== null && file.includes(path.join('main', 'ai-search')))).toBe(true);
});
