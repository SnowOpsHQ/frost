// Spec: specs/ci-pipeline.spec.ts · Acceptance: specs/ci-pipeline.feature.md (The plan, The verdict, The command line)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  CI_ALWAYS_JOBS,
  CI_E2E_GATING,
  CI_E2E_SHARDS,
  CI_PLATFORM_JOBS,
  CI_PLATFORM_LABELS,
  CI_PLATFORMS,
  CI_RUNNERS,
  CI_UNIT_DESKTOP_SHARDS,
  ciVerdict,
  isLinuxOnlyPath,
  planCi,
  type CiPlatform,
} from '@app/specs/ci-pipeline.spec';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/ci-plan.mjs');

/** The script's exports (it is plain JavaScript; this is the part the tests use). */
interface PlanModule {
  main(
    argv: readonly string[],
    options: {
      env: Readonly<Record<string, string | undefined>>;
      stdin?: () => string;
      stdout?: (line: string) => void;
      stderr?: (line: string) => void;
      append?: (file: string, text: string) => void;
    },
  ): number;
}
const cli = (await import(pathToFileURL(SCRIPT).href)) as PlanModule;

const full = planCi({ event: 'push', changed: [] });
const platformOf = (os: string): CiPlatform => {
  const platform = CI_PLATFORMS.find((candidate) => CI_RUNNERS[candidate] === os);
  if (!platform) throw new Error(`no platform runs on ${os}`);
  return platform;
};
const shards = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}/${n}`);

describe('planCi', () => {
  test('plan-runs-everything-outside-pull-requests', () => {
    for (const event of ['push', 'workflow_dispatch', 'schedule', 'merge_group', '']) {
      for (const changed of [[], ['docs/a.md'], ['apps/desktop/src/main/index.ts']]) {
        const plan = planCi({ event, changed });
        expect(plan, event).toEqual(full);
        expect(plan.platforms, event).toBe(true);
        for (const platform of CI_PLATFORMS) {
          expect(plan.unit.some((job) => job.os === CI_RUNNERS[platform]), platform).toBe(true);
          expect(plan.e2e.some((job) => job.os === CI_RUNNERS[platform]), platform).toBe(true);
        }
      }
    }
  });

  test('plan-follows-a-pull-requests-files', () => {
    const linuxOnly = ['docs/plans/phase-7.md', 'docs/ui-reference/shot.png', 'semgrep/ipc-sender-guard.yml', 'security/electronegativity-baseline.json', 'LICENSE', 'README.md', 'CONTRIBUTING.md'];
    for (const file of linuxOnly) expect(isLinuxOnlyPath(file), file).toBe(true);
    for (const changed of [[], linuxOnly, [linuxOnly[0] as string]]) {
      const plan = planCi({ event: 'pull_request', changed });
      expect(plan.platforms).toBe(false);
      expect([...plan.unit, ...plan.e2e].map((job) => job.os)).toSatisfy((list: string[]) => list.length > 0 && list.every((os) => os === CI_RUNNERS.linux));
      // The Linux jobs are the full plan's.
      expect(plan.unit).toEqual(full.unit.filter((job) => job.os === CI_RUNNERS.linux));
      expect(plan.e2e).toEqual(full.e2e.filter((job) => job.os === CI_RUNNERS.linux));
    }

    const everyPlatform = [
      'apps/desktop/src/main/index.ts',
      'apps/desktop/README.md',
      'apps/agent-runtime/src/index.ts',
      'apps/backend/src/index.ts',
      'packages/db/src/migrations.ts',
      'specs/ci-pipeline.spec.ts',
      'specs/ci-pipeline.feature.md',
      'scripts/ci-plan.mjs',
      '.github/workflows/ci.yml',
      '.github/actions/setup/action.yml',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      'turbo.json',
      'tsconfig.base.json',
      '.gitattributes',
      '.gitignore',
      'a-new-file',
      'new-folder/a.md',
      // Only starts like a listed path.
      'docs.txt',
      'docsx/a.md',
      'LICENSE.txt',
      'LICENSE/a',
      'securityx/a',
      'x/docs/a.md',
      'x/LICENSE',
      // Not at the root, or not Markdown.
      'apps/README.md',
      'README.mdx',
      'README.md/a',
      '.md/a',
      // As git prints a name it had to quote.
      '"docs/caf\\303\\251.md"',
    ];
    for (const file of everyPlatform) {
      expect(isLinuxOnlyPath(file), file).toBe(false);
      expect(planCi({ event: 'pull_request', changed: [file] }).platforms, file).toBe(true);
      // One such file among Linux-only ones is enough.
      expect(planCi({ event: 'pull_request', changed: [...linuxOnly, file] }).platforms, file).toBe(true);
    }
    // With platforms on, a pull request's plan is the full one without the e2e shards that do not gate.
    const plan = planCi({ event: 'pull_request', changed: ['package.json'] });
    expect(plan.unit).toEqual(full.unit);
    expect(plan.e2e).toEqual(full.e2e.filter((job) => job.gating));
  });

  test('plan-unit-covers-every-suite-once', () => {
    for (const platform of CI_PLATFORMS) {
      const jobs = full.unit.filter((job) => job.os === CI_RUNNERS[platform]);
      const n = CI_UNIT_DESKTOP_SHARDS[platform];
      if (n === 0) {
        expect(jobs.map((job) => [job.scope, job.shard]), platform).toEqual([['all', '']]);
      } else {
        expect(jobs.filter((job) => job.scope === 'packages').map((job) => job.shard), platform).toEqual(['']);
        expect(jobs.filter((job) => job.scope === 'desktop').map((job) => job.shard), platform).toEqual(shards(n));
        expect(jobs.filter((job) => job.scope === 'all'), platform).toEqual([]);
      }
      for (const job of jobs) expect(job.name.startsWith(CI_PLATFORM_LABELS[platform]), job.name).toBe(true);
    }
    // Every job belongs to a platform (throws otherwise), and ids and names are unique.
    for (const job of full.unit) platformOf(job.os);
    expect(new Set(full.unit.map((job) => job.id)).size).toBe(full.unit.length);
    expect(new Set(full.unit.map((job) => job.name)).size).toBe(full.unit.length);
    for (const job of full.unit) expect(job.id, job.id).toMatch(/^[a-z0-9-]+$/);
    // Some platform is sharded and some is not, so both branches above are exercised.
    expect(Object.values(CI_UNIT_DESKTOP_SHARDS).some((n) => n === 0)).toBe(true);
    expect(Object.values(CI_UNIT_DESKTOP_SHARDS).some((n) => n > 1)).toBe(true);
  });

  test('plan-e2e-shards', () => {
    const pullRequest = planCi({ event: 'pull_request', changed: ['package.json'] });
    for (const platform of CI_PLATFORMS) {
      const jobs = full.e2e.filter((job) => job.os === CI_RUNNERS[platform]);
      expect(jobs.map((job) => job.shard), platform).toEqual(shards(CI_E2E_SHARDS[platform]));
      expect(CI_E2E_SHARDS[platform], platform).toBeGreaterThan(0);
      for (const job of jobs) {
        expect(job.gating, job.id).toBe(CI_E2E_GATING[platform]);
        expect(job.name.startsWith(CI_PLATFORM_LABELS[platform]), job.name).toBe(true);
      }
      const inPullRequest = pullRequest.e2e.filter((job) => job.os === CI_RUNNERS[platform]);
      expect(inPullRequest, platform).toEqual(CI_E2E_GATING[platform] ? jobs : []);
    }
    for (const job of full.e2e) platformOf(job.os);
    expect(new Set(full.e2e.map((job) => job.id)).size).toBe(full.e2e.length);
    expect(new Set(full.e2e.map((job) => job.name)).size).toBe(full.e2e.length);
    for (const job of full.e2e) expect(job.id, job.id).toMatch(/^[a-z0-9-]+$/);
    // Linux gates every run; Windows is the platform that does not.
    expect(CI_E2E_GATING).toEqual({ linux: true, macos: true, windows: false });
  });

  test('plan-fits-the-macos-limit', () => {
    const macos = [...full.unit, ...full.e2e].filter((job) => job.os === CI_RUNNERS.macos);
    expect(macos.length).toBeGreaterThan(0);
    // With `package-macos`: five, the limit of concurrent macOS jobs.
    expect(macos.length).toBeLessThanOrEqual(4);
  });
});

describe('ciVerdict', () => {
  const all = (result: string, platformResult = result) =>
    Object.fromEntries([...CI_ALWAYS_JOBS.map((job) => [job, { result }] as const), ...CI_PLATFORM_JOBS.map((job) => [job, { result: platformResult }] as const)]);

  test('verdict-passes-a-full-run', () => {
    expect(ciVerdict({ needs: all('success'), platforms: 'true' })).toEqual({ ok: true, problems: [] });
    // `needs` as the workflow gives it: each job also carries its outputs.
    const needs = { ...all('success'), preflight: { result: 'success', outputs: { platforms: 'true', unit: '{}', e2e: '{}' } } };
    expect(ciVerdict({ needs, platforms: 'true' }).ok).toBe(true);
  });

  test('verdict-passes-a-linux-only-run', () => {
    expect(ciVerdict({ needs: all('success', 'skipped'), platforms: 'false' })).toEqual({ ok: true, problems: [] });
  });

  test('verdict-fails-anything-else', () => {
    const fails = (needs: Record<string, { result?: unknown } | undefined>, platforms: string, job: string) => {
      const verdict = ciVerdict({ needs, platforms });
      expect(verdict.ok, job).toBe(false);
      expect(verdict.problems.some((problem) => problem.startsWith(`${job}:`)), `${job}: ${verdict.problems.join('; ')}`).toBe(true);
      return verdict.problems;
    };
    for (const job of [...CI_ALWAYS_JOBS, ...CI_PLATFORM_JOBS]) {
      for (const result of ['failure', 'cancelled']) {
        // Exactly that job is the problem.
        expect(fails({ ...all('success'), [job]: { result } }, 'true', job)).toHaveLength(1);
      }
      // Missing from `needs`, or present without a result.
      const { [job]: _removed, ...rest } = all('success');
      expect(fails(rest, 'true', job)).toEqual([expect.stringContaining('missing')]);
      fails({ ...all('success'), [job]: undefined }, 'true', job);
      fails({ ...all('success'), [job]: {} }, 'true', job);
      fails({ ...all('success'), [job]: { result: 7 } }, 'true', job);
    }
    for (const job of CI_ALWAYS_JOBS) {
      fails({ ...all('success'), [job]: { result: 'skipped' } }, 'true', job);
      fails({ ...all('success', 'skipped'), [job]: { result: 'skipped' } }, 'false', job);
    }
    for (const job of CI_PLATFORM_JOBS) {
      // Skipped although the plan runs it; run although the plan skips it.
      fails({ ...all('success'), [job]: { result: 'skipped' } }, 'true', job);
      fails({ ...all('success', 'skipped'), [job]: { result: 'success' } }, 'false', job);
    }
    // A name that only `Object.prototype` has is still missing.
    const empty = ciVerdict({ needs: {}, platforms: 'true' });
    expect(empty.problems).toHaveLength(CI_ALWAYS_JOBS.length + CI_PLATFORM_JOBS.length);
    expect(ciVerdict({ needs: Object.create({ preflight: { result: 'success' } }) as Record<string, { result: string }>, platforms: 'true' }).problems).toContain('preflight: missing');
    // A job outside both lists must have succeeded too.
    fails({ ...all('success'), extra: { result: 'failure' } }, 'true', 'extra');
    fails({ ...all('success'), extra: { result: 'skipped' } }, 'true', 'extra');
    expect(ciVerdict({ needs: { ...all('success'), extra: { result: 'success' } }, platforms: 'true' }).ok).toBe(true);
    // The plan's answer is 'true' or 'false' and nothing else.
    for (const platforms of ['', 'True', 'yes', '1', ' true']) {
      const verdict = ciVerdict({ needs: all('success'), platforms });
      expect(verdict.ok, platforms).toBe(false);
      expect(verdict.problems.join('\n'), platforms).toContain('platforms');
    }
  });
});

describe('scripts/ci-plan.mjs', () => {
  function run(argv: string[], env: Record<string, string | undefined>, stdin?: string) {
    const out: string[] = [];
    const err: string[] = [];
    const files = new Map<string, string>();
    let reads = 0;
    const code = cli.main(argv, {
      env,
      stdin: () => {
        reads += 1;
        return stdin ?? '';
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      append: (file, text) => files.set(file, (files.get(file) ?? '') + text),
    });
    return { code, out, err, files, reads };
  }

  test('plan-cli-writes-the-outputs', () => {
    const expected = (plan: ReturnType<typeof planCi>) => [`platforms=${plan.platforms}`, `unit=${JSON.stringify({ include: plan.unit })}`, `e2e=${JSON.stringify({ include: plan.e2e })}`];

    const linuxOnly = run(['plan'], { GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'summary' }, 'README.md\r\n\nLICENSE\r\ndocs/a.md\n');
    // (A line's `\r` left on would make `README.md` and `LICENSE` other files, and so every platform's.)
    const linuxOnlyPlan = planCi({ event: 'pull_request', changed: ['README.md', 'LICENSE', 'docs/a.md'] });
    expect(linuxOnly.code).toBe(0);
    expect(linuxOnly.out).toEqual(expected(linuxOnlyPlan));
    expect(linuxOnly.out[0]).toBe('platforms=false');
    expect(linuxOnly.files.get('out')).toBe(`${expected(linuxOnlyPlan).join('\n')}\n`);
    expect(linuxOnly.err).toEqual([]);
    // Each output is one line: a value with a newline would end the output early.
    for (const line of linuxOnly.out) expect(line).not.toMatch(/[\r\n]/);
    const summary = linuxOnly.files.get('summary') ?? '';
    expect(summary).toContain('**skipped**');
    for (const job of linuxOnlyPlan.unit) expect(summary).toContain(`| Unit · ${job.name} | ${job.os} |`);
    for (const job of linuxOnlyPlan.e2e) expect(summary).toContain(`| E2E · ${job.name} | ${job.os} | ${job.shard} | yes |`);

    const app = run(['plan'], { GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: 'out' }, 'docs/a.md\napps/desktop/package.json\n');
    expect(app.out).toEqual(expected(planCi({ event: 'pull_request', changed: ['docs/a.md', 'apps/desktop/package.json'] })));
    expect(app.out[0]).toBe('platforms=true');
    expect([...app.files.keys()]).toEqual(['out']);

    // Any other event: the full plan, without reading stdin; without the two variables, only printed.
    const push = run(['plan'], { GITHUB_EVENT_NAME: 'push' }, 'docs/a.md\n');
    expect(push.code).toBe(0);
    expect(push.out).toEqual(expected(full));
    expect(push.reads).toBe(0);
    expect(push.files.size).toBe(0);
    expect(app.reads).toBe(1);
    const pushSummary = run(['plan'], { GITHUB_EVENT_NAME: 'push', GITHUB_STEP_SUMMARY: 'summary' }).files.get('summary') ?? '';
    expect(pushSummary).toContain('**run**');
    for (const job of full.e2e) expect(pushSummary).toContain(`| E2E · ${job.name} | ${job.os} | ${job.shard} | ${job.gating ? 'yes' : 'no'} |`);

    // The matrices are what the workflow's `fromJSON` reads.
    const unit = JSON.parse((push.out[1] ?? '').slice('unit='.length)) as { include: unknown[] };
    expect(unit.include).toEqual(full.unit);
  });

  test('plan-cli-refuses-bad-input', () => {
    for (const event of [undefined, '', 'Pull_Request', 'push\nplatforms=true', 'pull request', '_push']) {
      const result = run(['plan'], { GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'summary' }, 'docs/a.md\n');
      expect(result.code, String(event)).toBe(1);
      expect(result.out, String(event)).toEqual([]);
      expect(result.files.size, String(event)).toBe(0);
      expect(result.err.join('\n'), String(event)).toContain('GITHUB_EVENT_NAME');
    }
    for (const argv of [[], ['plans'], ['plan', 'extra'], ['verdict', 'extra'], ['--help']]) {
      const result = run(argv, { GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: 'out' });
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.err.join('\n'), argv.join(' ')).toContain('usage:');
      expect(result.out).toEqual([]);
      expect(result.files.size).toBe(0);
    }
  });

  test('verdict-cli-exit-codes', () => {
    const needs = Object.fromEntries([...CI_ALWAYS_JOBS, ...CI_PLATFORM_JOBS].map((job) => [job, { result: 'success' }]));
    const passed = run(['verdict'], { NEEDS: JSON.stringify(needs), PLATFORMS: 'true' });
    expect(passed.code).toBe(0);
    expect(passed.out).toEqual([...Object.keys(needs).map((job) => `${job}: success`), 'CI passed.']);
    expect(passed.err).toEqual([]);

    const failed = run(['verdict'], { NEEDS: JSON.stringify({ ...needs, unit: { result: 'failure' }, lint: {} }), PLATFORMS: 'true' });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('unit: failure');
    expect(failed.out).toContain('lint: missing');
    expect(failed.out).not.toContain('CI passed.');
    expect(failed.err).toEqual(['ci-plan: lint: missing', 'ci-plan: unit: failure']);

    // The plan's answer decides what the package jobs must have done.
    expect(run(['verdict'], { NEEDS: JSON.stringify(needs), PLATFORMS: 'false' }).code).toBe(1);
    expect(run(['verdict'], { NEEDS: JSON.stringify(needs) }).code).toBe(1);

    for (const value of [undefined, '', 'not json', '[]', 'null', '"x"', '7']) {
      const result = run(['verdict'], { NEEDS: value, PLATFORMS: 'true' });
      expect(result.code, String(value)).toBe(1);
      expect(result.err.join('\n'), String(value)).toContain('NEEDS');
      expect(result.out, String(value)).toEqual([]);
    }
  });

  test('cli-runs-under-node', () => {
    // No loader, no install: the workflow runs it right after checkout.
    const result = spawnSync(process.execPath, [SCRIPT, 'plan'], { cwd: ROOT, env: { PATH: process.env['PATH'], GITHUB_EVENT_NAME: 'pull_request' }, input: 'docs/a.md\n', encoding: 'utf8', timeout: 30_000 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const plan = planCi({ event: 'pull_request', changed: ['docs/a.md'] });
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([`platforms=false`, `unit=${JSON.stringify({ include: plan.unit })}`, `e2e=${JSON.stringify({ include: plan.e2e })}`]);

    const usage = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, env: { PATH: process.env['PATH'] }, encoding: 'utf8', timeout: 30_000 });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage:');
  });
});
