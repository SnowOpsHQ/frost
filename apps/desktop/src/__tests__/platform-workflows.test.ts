// Spec: specs/linux-package.spec.ts · Acceptance: specs/linux-package.feature.md (CI)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { LINUX_ARCHS, linuxArtifacts } from '@app/specs/linux-package.spec';

const read = (file: string) => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');

type Step = Partial<Record<'name' | 'id' | 'if' | 'run' | 'uses', string>> & { with?: string };

/**
 * The steps of a single-job workflow, as written in this repo (2-space indent, steps at 6 spaces).
 * Keeps each step's scalar keys (block scalars joined with newlines) and its raw `with:` block.
 * (Same parser as ci-workflows.test.ts.)
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

describe('CI workflows (platform packages)', () => {
  test('linux-package-ci-job', () => {
    const workflow = read('.github/workflows/linux-package.yml');
    expect(workflow).toMatch(/^name: Linux package$/m);
    expect(workflow).toMatch(/^jobs:\n {2}linux-package:\n {4}runs-on: ubuntu-24\.04$/m);

    const on = triggers(workflow);
    expect(on).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
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
      '.github/workflows/linux-package.yml',
    ]) {
      expect(paths, required).toContain(required);
    }

    const steps = workflowSteps(workflow);
    const order = [
      'Install',
      'Install packaging tools',
      'Build',
      'Make (AppImage + deb + zip, x64)',
      'Allow unprivileged user namespaces (Chromium sandbox)',
      'Verify package',
      'Upload AppImage + deb',
    ];
    expect(steps.map((s) => s.name).filter((name) => name !== undefined && order.includes(name))).toEqual(order);
    expect(stepNamed(steps, 'Install').run).toBe('pnpm install --frozen-lockfile');
    expect(stepNamed(steps, 'Install packaging tools').run).toMatch(/apt-get install .*\bsquashfs-tools\b.*\bxvfb\b/);
    expect(stepNamed(steps, 'Build')).toMatchObject({ id: 'build', run: 'pnpm --filter @app/desktop build' });
    expect(stepNamed(steps, 'Make (AppImage + deb + zip, x64)')).toMatchObject({ id: 'make', run: 'pnpm make:linux' });
    // The sandbox stays on: user namespaces are allowed instead (never --no-sandbox).
    expect(stepNamed(steps, 'Allow unprivileged user namespaces (Chromium sandbox)').run).toBe(
      'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    );
    expect(workflow).not.toContain('--no-sandbox');
    expect(stepNamed(steps, 'Verify package')).toMatchObject({ id: 'verify', run: 'xvfb-run -a pnpm verify:linux' });

    // Lean: ci.yml runs lint, test and e2e on Linux already.
    for (const { run } of steps) expect(run ?? '').not.toMatch(/turbo run|test:e2e|\blint\b/);

    // Only packages that passed verify:linux are published.
    const upload = stepNamed(steps, 'Upload AppImage + deb');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}\b/);
    expect(upload.if).toContain("steps.verify.outcome == 'success'");
    for (const arch of LINUX_ARCHS) {
      const { appImage, deb } = linuxArtifacts('0.0.0', arch);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(appImage)}/*.AppImage`);
      expect(upload.with).toContain(`apps/desktop/out/${path.posix.dirname(deb)}/*.deb`);
    }
    expect(upload.with).toMatch(/retention-days: 7$/m);

    // Every action is pinned to a full commit SHA.
    for (const { uses } of steps) if (uses) expect(uses, uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v/);
  });
});
