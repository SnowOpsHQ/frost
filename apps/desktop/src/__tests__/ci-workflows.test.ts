// Spec: specs/ci-pipeline.spec.ts · Acceptance: specs/ci-pipeline.feature.md (The workflow), specs/ci-gates.feature.md (Gates)
import { readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CI_ALWAYS_JOBS,
  CI_DEFAULT_SCOPE,
  CI_LINUX_VERDICT_NAME,
  CI_PLATFORM_JOBS,
  CI_REQUIRE_BUBBLEWRAP_ENV,
  CI_SCOPE_ENV,
  CI_SCOPES,
  CI_VERDICT_JOB,
  CI_VERDICT_NAME,
} from '@app/specs/ci-pipeline.spec';
import { CI_WORKFLOW, PINNED_USES, SETUP_ACTION, SETUP_USES, jobNamed, jobsOf, read, stepNamed, stepsOf, triggers } from './workflow-text';

const workflow = read(CI_WORKFLOW);
const jobs = jobsOf(workflow);
const job = (id: string) => jobNamed(jobs, id);

/** The steps that keep Windows' checkout on LF, then check out. */
const KEEP_LF = { name: 'Keep LF line endings', if: "${{ runner.os == 'Windows' }}", run: 'git config --global core.autocrlf false' };
const USERNS = 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0';

describe('CI pipeline', () => {
  test('pipeline-triggers', () => {
    expect(workflow).toMatch(/^name: CI$/m);
    const on = triggers(workflow);
    expect(on.startsWith("  push:\n    branches: [main]\n    tags: ['v*']\n  pull_request:\n  workflow_dispatch:\n    inputs:\n      scope:\n")).toBe(true);
    // Every pull request: no path or branch filter.
    expect(on).not.toMatch(/paths|branches-ignore|types:/);
    // On demand, one input: the scope, a choice of `CI_SCOPES` that defaults to every platform.
    expect(on.match(/^ {6}\w+:$/gm)).toEqual(['      scope:']);
    expect(on).toMatch(new RegExp(`^ {8}type: choice\\n {8}options: \\[${CI_SCOPES.join(', ')}\\]\\n {8}default: ${CI_DEFAULT_SCOPE}\\n`, 'm'));
    expect(on).toContain(`'${CI_LINUX_VERDICT_NAME}'`);

    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(workflow.match(/^\s*permissions:/gm)).toHaveLength(1);
    expect(workflow).toMatch(/^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n(?: {2}#.*\n)* {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
    expect(workflow).toMatch(/^defaults:\n {2}run:\n(?: {4}#.*\n)* {4}shell: bash$/m);
    // No job or step picks another shell.
    for (const { steps } of jobs) for (const step of steps) expect(step.shell).toBeUndefined();

    // The one workflow: the platform packages are jobs of it.
    expect(readdirSync(new URL('../../../../.github/workflows/', import.meta.url)).sort()).toEqual(['ci.yml']);
  });

  test('pipeline-jobs', () => {
    const others = [...CI_ALWAYS_JOBS, ...CI_PLATFORM_JOBS];
    expect(jobs.map(({ id }) => id).sort()).toEqual([...others, CI_VERDICT_JOB].sort());
    for (const { id, keys } of jobs) {
      expect(keys['timeout-minutes'], id).toMatch(/^\d+$/);
      expect(keys['name'], id).toBeTruthy();
      expect(keys['runs-on'], id).toBeTruthy();
    }
    expect(job('preflight').keys['needs']).toBeUndefined();
    for (const id of others.filter((other) => other !== 'preflight')) expect(job(id).keys['needs'], id).toBe('preflight');
    const verdict = job(CI_VERDICT_JOB);
    expect(verdict.keys['needs']).toBe(`[${others.join(', ')}]`);
    expect(verdict.keys['if']).toBe('${{ always() }}');
    // Only the verdict job runs after a failure elsewhere.
    for (const id of others) expect(job(id).keys['if'] ?? '', id).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
  });

  test('preflight-plans-the-run', () => {
    const preflight = job('preflight');
    expect(preflight.keys['runs-on']).toBe('ubuntu-24.04');
    expect(preflight.steps[0]?.uses).toMatch(/^actions\/checkout@/);
    expect(preflight.steps[0]?.with).toContain('fetch-depth: 2');
    const plan = stepNamed(preflight.steps, 'Plan');
    expect(plan.id).toBe('plan');
    // The scope a run on demand asked for (empty for every other event).
    expect(plan.env).toBe(`${CI_SCOPE_ENV}: \${{ inputs.scope }}`);
    expect(plan.run).toBe(
      ['if [ "$GITHUB_EVENT_NAME" = pull_request ]; then', 'git diff --name-only HEAD^1 HEAD | node scripts/ci-plan.mjs plan', 'else', 'node scripts/ci-plan.mjs plan < /dev/null', 'fi'].join('\n'),
    );
    expect(preflight.text).toMatch(/^ {4}outputs:\n {6}platforms: \$\{\{ steps\.plan\.outputs\.platforms \}\}\n {6}unit: \$\{\{ steps\.plan\.outputs\.unit \}\}\n {6}e2e: \$\{\{ steps\.plan\.outputs\.e2e \}\}$/m);
    // Node 24 for the script's type stripping; nothing is installed.
    expect(preflight.steps.some((step) => /^actions\/setup-node@/.test(step.uses ?? '') && /node-version: 24$/m.test(step.with ?? ''))).toBe(true);
    expect(preflight.steps.map((step) => step.uses)).not.toContain(SETUP_USES);
  });

  test('matrices-come-from-the-plan', () => {
    for (const id of ['unit', 'e2e']) {
      const { text, keys } = job(id);
      expect(text, id).toMatch(new RegExp(`^ {4}strategy:\\n {6}fail-fast: false\\n {6}matrix: \\$\\{\\{ fromJSON\\(needs\\.preflight\\.outputs\\.${id}\\) \\}\\}$`, 'm'));
      expect(keys['runs-on'], id).toBe('${{ matrix.os }}');
      expect(keys['name'], id).toContain('${{ matrix.name }}');
      expect(keys['if'], id).toBeUndefined();
    }
    // No job may fail quietly: a failed check on a job that "does not count" would still mark the
    // commit as failed. (The e2e step of a shard that does not gate is the one exception: `e2e-job`.)
    for (const { id, keys, steps } of jobs) {
      expect(keys['continue-on-error'], id).toBeUndefined();
      for (const step of steps) if (!(id === 'e2e' && step.name === 'Gate: e2e')) expect(step['continue-on-error'], `${id} › ${step.name}`).toBeUndefined();
    }
    for (const id of CI_PLATFORM_JOBS) expect(job(id).keys['if'], id).toBe("${{ needs.preflight.outputs.platforms == 'true' }}");
    for (const id of ['lint', 'security']) expect(job(id).keys['if'], id).toBeUndefined();
  });

  test('gates-map-to-steps', () => {
    const gates = [...read('specs/ci-gates.feature.md').matchAll(/^- \*\*Gate: ([\w-]+)\*\* \(job `([\w-]+)`\) — (?:[^`]*?)`([^`]+)`/gm)].map(([, name, jobId, command]) => ({
      name: `Gate: ${name}`,
      jobId: jobId as string,
      command: command as string,
    }));
    expect(gates.map(({ name, jobId }) => `${jobId} › ${name}`)).toEqual([
      'lint › Gate: lint',
      'lint › Gate: actionlint',
      'unit › Gate: unit',
      'security › Gate: electronegativity',
      'security › Gate: semgrep-rule-test',
      'security › Gate: semgrep-repo-scan',
      'e2e › Gate: e2e',
    ]);
    for (const { name, jobId, command } of gates) {
      // A gate may be several steps (`Gate: unit (packages)`: the three are pinned by `unit-job`).
      const steps = job(jobId).steps.filter((step) => step.name === name || step.name?.startsWith(`${name} (`));
      expect(steps.some((step) => step.run?.includes(command)), `${name}: ${command}`).toBe(true);
    }
    // No gate the spec does not list.
    const named = (name: string | undefined) => gates.some((gate) => name === gate.name || name?.startsWith(`${gate.name} (`));
    for (const { id, steps } of jobs) for (const step of steps) if (step.name?.startsWith('Gate: ')) expect(named(step.name), `${id} › ${step.name}`).toBe(true);
    // In a job, each gate is in the order the spec lists them.
    for (const jobId of new Set(gates.map((gate) => gate.jobId))) {
      const inJob = job(jobId)
        .steps.map((step) => gates.find((gate) => step.name === gate.name || step.name?.startsWith(`${gate.name} (`))?.name)
        .filter((name) => name !== undefined);
      expect([...new Set(inJob)], jobId).toEqual(gates.filter((gate) => gate.jobId === jobId).map((gate) => gate.name));
    }

    const lint = job('lint');
    expect(stepNamed(lint.steps, 'Gate: lint').run).toBe('pnpm turbo run lint');
    expect(stepNamed(lint.steps, 'Gate: actionlint').run).toBe('pnpm lint:workflows');
    // A failed type-check does not hide the workflow lint, nor one security gate another.
    expect(stepNamed(lint.steps, 'Gate: actionlint').if).toBe("${{ !cancelled() && steps.setup.outcome == 'success' }}");
    const security = job('security');
    expect(stepNamed(security.steps, 'Gate: electronegativity').run).toBe('pnpm security:electronegativity');
    for (const name of ['Gate: semgrep-rule-test', 'Gate: semgrep-repo-scan']) expect(stepNamed(security.steps, name).if, name).toBe("${{ !cancelled() && steps.setup.outcome == 'success' }}");
    for (const id of ['lint', 'security']) {
      expect(job(id).keys['runs-on'], id).toBe('ubuntu-24.04');
      expect(job(id).steps.find((step) => step.uses === SETUP_USES)?.id, id).toBe('setup');
    }
  });

  test('unit-job', () => {
    const { steps } = job('unit');
    expect(steps[0]).toEqual(KEEP_LF);
    expect(steps[1]?.uses).toMatch(/^actions\/checkout@/);
    expect(steps[2]?.uses).toBe(SETUP_USES);

    expect(stepNamed(steps, 'Gate: unit (every workspace)')).toMatchObject({ if: "${{ matrix.scope == 'all' }}", run: 'pnpm turbo run test' });
    expect(stepNamed(steps, 'Gate: unit (packages)')).toMatchObject({ if: "${{ matrix.scope == 'packages' }}", run: "pnpm turbo run test --filter='!@app/desktop'" });
    const desktop = stepNamed(steps, 'Gate: unit (desktop shard)');
    expect(desktop).toMatchObject({ if: "${{ matrix.scope == 'desktop' }}", run: 'pnpm --filter @app/desktop test --shard="$SHARD"' });
    expect(desktop.env).toContain('SHARD: ${{ matrix.shard }}');
    // The three scopes are the plan's, one step each.
    expect(steps.filter((step) => step.name?.startsWith('Gate: unit'))).toHaveLength(3);

    // On Linux the containment suite must run: bubblewrap and user namespaces first, then the switch.
    const sandbox = stepNamed(steps, 'Install bubblewrap and allow unprivileged user namespaces');
    expect(sandbox.if).toBe("${{ runner.os == 'Linux' && matrix.scope != 'packages' }}");
    expect(sandbox.run).toBe(['command -v bwrap >/dev/null || { sudo apt-get update && sudo apt-get install -y --no-install-recommends bubblewrap; }', USERNS].join('\n'));
    expect(steps.indexOf(sandbox)).toBeLessThan(steps.indexOf(desktop));
    const required = `${CI_REQUIRE_BUBBLEWRAP_ENV}: \${{ runner.os == 'Linux' && '1' || '' }}`;
    expect(desktop.env).toContain(required);
    expect(stepNamed(steps, 'Gate: unit (every workspace)').env).toContain(required);
  });

  test('e2e-job', () => {
    const { steps } = job('e2e');
    expect(steps[0]).toEqual(KEEP_LF);
    expect(steps[1]?.uses).toMatch(/^actions\/checkout@/);
    expect(steps[2]?.uses).toBe(SETUP_USES);
    const order = ['Build', 'Allow unprivileged user namespaces (Chromium sandbox)', 'Gate: e2e', 'Report a failure that does not gate', 'Upload Playwright report'];
    expect(steps.map((step) => step.name).filter((name) => name !== undefined && order.includes(name))).toEqual(order);
    expect(stepNamed(steps, 'Build').run).toBe('pnpm --filter @app/desktop build');
    expect(stepNamed(steps, 'Allow unprivileged user namespaces (Chromium sandbox)')).toMatchObject({ if: "${{ runner.os == 'Linux' }}", run: USERNS });

    const gate = stepNamed(steps, 'Gate: e2e');
    expect(gate.env).toContain('SHARD: ${{ matrix.shard }}');
    // A shard that does not gate (a platform switched off in CI_E2E_GATING) keeps its job green when the suite fails, and says so.
    expect(gate).toMatchObject({ id: 'e2e', 'continue-on-error': '${{ !matrix.gating }}' });
    const report = stepNamed(steps, 'Report a failure that does not gate');
    expect(report.if).toBe("${{ !cancelled() && !matrix.gating && steps.e2e.outcome == 'failure' }}");
    expect(report.run).toMatch(/^echo "::warning title=E2E failed \(not gating\)::/);
    expect(gate.run).toBe(
      [
        'if [ "$RUNNER_OS" = Linux ]; then',
        'command -v xvfb-run >/dev/null || { sudo apt-get update && sudo apt-get install -y xvfb; }',
        // The screen the screenshot baselines were rendered on (specs/visual-baseline.feature.md).
        'xvfb-run -a -s "-screen 0 1280x1024x24" pnpm --filter @app/desktop test:e2e --shard="$SHARD"',
        'else',
        'pnpm --filter @app/desktop test:e2e --shard="$SHARD"',
        'fi',
      ].join('\n'),
    );

    const upload = stepNamed(steps, 'Upload Playwright report');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}\b/);
    expect(upload.if).toBe("${{ !cancelled() && (failure() || steps.e2e.outcome == 'failure') }}");
    expect(upload.with).toContain('name: playwright-report-${{ matrix.id }}');
    expect(upload.with).toContain('apps/desktop/playwright-report/');
    expect(upload.with).toContain('apps/desktop/test-results/');
    expect(upload.with).toMatch(/retention-days: 7$/m);
  });

  test('e2e-retries-only-in-ci', () => {
    const config = read('apps/desktop/playwright.config.ts');
    expect(config).toMatch(/^ {2}retries: process\.env\['CI'\] \? 2 : 0,$/m);
    // The `github` reporter is what names a flaky test on the run.
    expect(config).toMatch(/^ {2}reporter: process\.env\['CI'\] \? \[\['list'\], \['github'\], \['html', \{ open: 'never' \}\]\] : \[\['list'\]\],$/m);
    // The screenshot baseline is never retried; no other suite changes its retries.
    const folder = new URL('../../e2e/', import.meta.url);
    const suites = readdirSync(folder).filter((file) => file.endsWith('.e2e.ts'));
    expect(suites.length).toBeGreaterThan(10);
    const setsRetries = suites.filter((file) => /\bretries\s*:/.test(read(`apps/desktop/e2e/${file}`)));
    expect(setsRetries).toEqual(['visual.e2e.ts']);
    expect(read('apps/desktop/e2e/visual.e2e.ts')).toMatch(/^test\.describe\.configure\(\{ retries: 0 \}\);$/m);
  });

  test('ci-passed-runs-the-verdict', () => {
    const { steps, keys } = job(CI_VERDICT_JOB);
    expect(keys['runs-on']).toBe('ubuntu-24.04');
    // The required check's name, except in a run on demand with the `linux` scope: what only the
    // Linux jobs earned must not stand in for the required check on that commit.
    expect(CI_VERDICT_NAME).toBe('CI passed');
    expect(CI_LINUX_VERDICT_NAME).not.toBe(CI_VERDICT_NAME);
    expect(keys['name']).toBe(`\${{ inputs.scope == 'linux' && '${CI_LINUX_VERDICT_NAME}' || '${CI_VERDICT_NAME}' }}`);
    // Nothing else in the workflow reads the input but the plan.
    expect(workflow.match(/inputs\.scope/g)).toHaveLength(2);
    expect(steps[0]?.uses).toMatch(/^actions\/checkout@/);
    expect(steps.some((step) => /^actions\/setup-node@/.test(step.uses ?? '') && /node-version: 24$/m.test(step.with ?? ''))).toBe(true);
    const verdict = stepNamed(steps, 'Verdict');
    expect(verdict.run).toBe('node scripts/ci-plan.mjs verdict');
    expect(verdict.env).toBe(['NEEDS: ${{ toJSON(needs) }}', 'PLATFORMS: ${{ needs.preflight.outputs.platforms }}'].join('\n'));
    // Nothing may let the verdict's own failure pass.
    expect(keys['continue-on-error']).toBeUndefined();
    for (const step of steps) expect(step['continue-on-error']).toBeUndefined();
  });

  test('sandbox-stays-on', () => {
    for (const file of [CI_WORKFLOW, SETUP_ACTION]) {
      const text = read(file);
      expect(text, file).not.toContain('--no-sandbox');
      expect(text, file).not.toContain('--static');
      expect(text, file).not.toContain('ELECTRON_DISABLE_SANDBOX');
    }
  });

  test('actions-are-pinned', () => {
    const uses = (text: string) => [...text.matchAll(/^\s*(?:- )?uses: (.+)$/gm)].map((match) => match[1] as string);
    const inWorkflow = uses(workflow);
    const inAction = uses(read(SETUP_ACTION));
    expect(inWorkflow.length).toBeGreaterThan(10);
    expect(inAction.length).toBeGreaterThan(2);
    for (const value of inWorkflow) if (value !== SETUP_USES) expect(value, value).toMatch(PINNED_USES);
    for (const value of inAction) expect(value, value).toMatch(PINNED_USES);
    // One version of each action across the workflow and the setup action.
    const pins = new Map<string, Set<string>>();
    for (const value of [...inWorkflow, ...inAction]) {
      if (value === SETUP_USES) continue;
      const [action, pin] = value.split('@') as [string, string];
      pins.set(action, (pins.get(action) ?? new Set()).add(pin));
    }
    for (const [action, versions] of pins) expect([...versions], action).toHaveLength(1);
    // Every checkout drops its credentials.
    for (const { id, steps } of jobs) {
      const checkouts = steps.filter((step) => /^actions\/checkout@/.test(step.uses ?? ''));
      expect(checkouts, id).toHaveLength(1);
      expect(checkouts[0]?.with, id).toContain('persist-credentials: false');
    }
  });

  test('setup-action', () => {
    const action = read(SETUP_ACTION);
    expect(action).toMatch(/^runs:\n {2}using: composite\n {2}steps:$/m);
    const steps = stepsOf(action, 4);
    expect(steps.map((step) => step.uses?.split('@')[0] ?? step.name)).toEqual(['pnpm/action-setup', 'actions/setup-node', 'Read the Electron version', 'actions/cache', 'Install']);
    // pnpm's version is package.json#packageManager's: the action is given none.
    expect(steps[0]?.with).toBeUndefined();
    expect(JSON.parse(read('package.json'))).toHaveProperty('packageManager', expect.stringMatching(/^pnpm@\d+\.\d+\.\d+$/));
    expect(steps[1]?.with).toBe('node-version: 24\ncache: pnpm');

    const electron = stepNamed(steps, 'Read the Electron version');
    expect(electron).toMatchObject({ id: 'electron', shell: 'bash' });
    expect(electron.run).toBe(`echo "version=$(grep -oE '^  electron@[0-9][^:(]*' pnpm-lock.yaml | sed 's/^ *electron@//' | sort -u | paste -sd+ -)" >> "$GITHUB_OUTPUT"`);
    // That command finds the lockfile's Electron: the cache key is never empty.
    const versions = [...new Set([...read('pnpm-lock.yaml').matchAll(/^ {2}electron@([0-9][^:(]*)/gm)].map((match) => match[1]))];
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version).toMatch(/^\d+\.\d+\.\d+/);

    const cache = steps[3];
    expect(cache?.with).toContain('key: electron-${{ runner.os }}-${{ runner.arch }}-${{ steps.electron.outputs.version }}');
    // @electron/get's cache on Linux, macOS and Windows.
    for (const folder of ['~/.cache/electron', '~/Library/Caches/electron', '~/AppData/Local/electron/Cache']) expect(cache?.with, folder).toContain(folder);
    // No fallback to another Electron's cache.
    expect(cache?.with).not.toContain('restore-keys');
    expect(stepNamed(steps, 'Install')).toMatchObject({ shell: 'bash', run: 'pnpm install --frozen-lockfile' });

    // Every job that installs uses it right after checkout (and, on Windows, the LF step).
    for (const { id, steps: jobSteps } of jobs) {
      const index = jobSteps.findIndex((step) => step.uses === SETUP_USES);
      if (id === 'preflight' || id === CI_VERDICT_JOB) {
        expect(index, id).toBe(-1);
        continue;
      }
      expect(jobSteps[index - 1]?.uses, id).toMatch(/^actions\/checkout@/);
      expect(jobSteps.filter((step) => step.uses === SETUP_USES), id).toHaveLength(1);
      for (const step of jobSteps) expect(step.run ?? '', id).not.toMatch(/pnpm install/);
    }
  });

  test('workflows-lint-clean', () => {
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(scripts['lint:workflows']).toMatch(/^uvx --from actionlint-py==\d+\.\d+\.\d+\.\d+ actionlint -shellcheck= -pyflakes=$/);
  });
});

describe('turbo', () => {
  test('turbo-cache-follows-dependencies', () => {
    const turbo = JSON.parse(read('turbo.json')) as { tasks: Record<string, { dependsOn?: string[]; cache?: boolean; inputs?: string[] }> };
    expect(turbo.tasks['transit']?.dependsOn).toEqual(['^transit']);
    for (const task of ['lint', 'test']) {
      expect(turbo.tasks[task]?.dependsOn, task).toContain('transit');
      expect(turbo.tasks[task]?.cache, task).not.toBe(false);
    }
    // No package runs anything as `transit`: it exists only to carry its dependencies' hashes.
    for (const pkg of ['apps/desktop', 'packages/db', 'packages/ipc-contract', 'specs']) {
      const scripts = (JSON.parse(read(`${pkg}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {};
      expect(Object.keys(scripts), pkg).not.toContain('transit');
    }
    // The tests read these files of the repository root.
    for (const input of ['$TURBO_ROOT$/.github/workflows/*.yml', '$TURBO_ROOT$/.github/actions/**/*.yml', '$TURBO_ROOT$/scripts/*.mjs', '$TURBO_ROOT$/package.json']) {
      expect(turbo.tasks['test']?.inputs, input).toContain(input);
    }
  });

  test('turbo-build-follows-its-config', () => {
    const { build } = (JSON.parse(read('turbo.json')) as { tasks: Record<string, { inputs?: string[]; env?: string[]; outputs?: string[] }> }).tasks;
    // What Vite bakes into the bundle: `FROST_PUBLIC_*` and `VITE_*` (vite.main.config.ts, envPrefix),
    // from the environment or from `apps/desktop/.env*` (ignored by git, so named besides the default inputs).
    const envPrefix = /envPrefix: \[([^\]]*)\]/.exec(read('apps/desktop/vite.main.config.ts'))?.[1] ?? '';
    const prefixes = [...envPrefix.matchAll(/'([A-Z_]+)'/g)].map((match) => `${match[1]}*`);
    expect(prefixes).toEqual(['VITE_*', 'FROST_PUBLIC_*']);
    expect([...(build?.env ?? [])].sort()).toEqual([...prefixes].sort());
    expect(build?.inputs).toEqual(['$TURBO_DEFAULT$', '.env*']);
    // The task makes `.vite/` and the packaged app under `out/`; the installers under `out/make/`
    // are `make`'s, never this task's to store or to put back.
    expect(build?.outputs).toEqual(['.vite/**', 'out/**', '!out/make/**']);
  });
});
