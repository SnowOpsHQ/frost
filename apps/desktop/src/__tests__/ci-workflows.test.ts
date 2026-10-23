// Spec: specs/macos-package.spec.ts, specs/ci-gates.feature.md · Acceptance: specs/macos-package.feature.md (CI)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { MAC_ARCHS, macArtifacts } from '@app/specs/macos-package.spec';

const read = (file: string) => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');

type Step = Partial<Record<'name' | 'id' | 'if' | 'run' | 'uses', string>> & { with?: string };

/**
 * The steps of a single-job workflow, as written in this repo (2-space indent, steps at 6 spaces).
 * Keeps each step's scalar keys (block scalars joined with newlines) and its raw `with:` block.
 */
function workflowSteps(workflow: string): Step[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (start === -1) throw new Error('no steps');
  const steps: Step[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = /^ {6}(- | {2})([\w-]+):\s?(.*)$/.exec(lines[i] ?? '');
    if (!match) continue;
    const [, lead, key, rest] = match as unknown as [string, string, keyof Step, string];
    if (lead === '- ') steps.push({});
    const step = steps.at(-1);
    if (!step) continue;
    let value = rest.replace(/^"(.*)"$/, '$1');
    if (value === '|' || value === '') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^( {10}|\s*$)/.test(lines[i + 1] ?? '')) block.push((lines[++i] ?? '').trim());
      value = block.filter(Boolean).join('\n');
    }
    step[key] = value;
  }
  return steps;
}

/** The workflow's `on:` block. */
function triggers(workflow: string): string {
  return /^on:\n((?: .*\n|\n)*)/m.exec(workflow)?.[1] ?? '';
}

function stepNamed(steps: Step[], name: string): Step {
  const step = steps.find((s) => s.name === name);
  if (!step) throw new Error(`no step "${name}"`);
  return step;
}

describe('CI workflows (macOS package)', () => {
  test('macos-ci-job', () => {
    const workflow = read('.github/workflows/macos.yml');
    expect(workflow).toMatch(/^ {4}runs-on: macos-15\b/m);

    const on = triggers(workflow);
    expect(on).toMatch(/^ {2}push:\n {4}branches: \[main\]\n {4}tags: \['v\*'\]$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    const paths = [...on.matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]);
    for (const required of [
      'apps/desktop/**',
      'packages/**',
      'specs/**',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      'turbo.json',
      'tsconfig.base.json',
      '.github/workflows/macos.yml',
    ]) {
      expect(paths, required).toContain(required);
    }

    const steps = workflowSteps(workflow);
    const order = ['Install', 'Lint and test', 'Build', 'e2e', 'Make (zip + dmg, arm64)', 'Verify package', 'Upload zip + dmg'];
    expect(steps.map((s) => s.name).filter((name) => name !== undefined && order.includes(name))).toEqual(order);
    expect(stepNamed(steps, 'Install').run).toBe('pnpm install --frozen-lockfile');
    expect(stepNamed(steps, 'Lint and test').run).toBe('pnpm turbo run lint test');
    expect(stepNamed(steps, 'Build')).toMatchObject({ id: 'build', run: 'pnpm --filter @app/desktop build' });
    expect(stepNamed(steps, 'e2e')).toMatchObject({ id: 'e2e', run: 'pnpm --filter @app/desktop test:e2e' });
    expect(stepNamed(steps, 'Make (zip + dmg, arm64)')).toMatchObject({ id: 'make', run: 'pnpm make:mac' });
    expect(stepNamed(steps, 'Verify package')).toMatchObject({ id: 'verify', run: 'pnpm verify:mac' });

    // Only a package whose app passed e2e and whose bundle passed verify:mac is published.
    const upload = stepNamed(steps, 'Upload zip + dmg');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}\b/);
    expect(upload.if).toContain("steps.e2e.outcome == 'success'");
    expect(upload.if).toContain("steps.verify.outcome == 'success'");
    for (const arch of MAC_ARCHS) {
      const { zip, dmg } = macArtifacts('0.0.0', arch);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(zip)}/*.zip`);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(dmg)}/*.dmg`);
    }
    expect(upload.with).toMatch(/retention-days: 14$/m);
    expect(stepNamed(steps, 'Upload Playwright report').if).toBe('${{ failure() }}');
  });

  test('linux-ci-unaffected', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toMatch(/^ {4}runs-on: ubuntu-24\.04$/m);
    const on = triggers(workflow);
    expect(on).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
    // Every pull request: no path or branch filter.
    expect(on).toMatch(/^ {2}pull_request:\s*$/m);
    expect(on).not.toMatch(/paths|branches-ignore/);

    const gates = [...read('specs/ci-gates.feature.md').matchAll(/^- \*\*Gate: ([\w-]+)\*\* — (?:[^`]*?)`([^`]+)`/gm)].map(
      ([, name, command]) => ({ name: `Gate: ${name}`, command }),
    );
    expect(gates.map((g) => g.name)).toEqual([
      'Gate: lint-test-build',
      'Gate: electronegativity',
      'Gate: semgrep-rule-test',
      'Gate: semgrep-repo-scan',
      'Gate: e2e',
    ]);
    const steps = workflowSteps(workflow);
    expect(steps.map((s) => s.name).filter((name) => name?.startsWith('Gate: '))).toEqual(gates.map((g) => g.name));
    for (const { name, command } of gates) expect(stepNamed(steps, name).run, name).toContain(command);
  });
});
