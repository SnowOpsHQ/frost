/**
 * The CI pipeline's plan and verdict (`.github/workflows/ci.yml`). The workflow's `preflight` job
 * runs `scripts/ci-plan.mjs plan`, which prints `planCi()` as the matrices of the `unit` and `e2e`
 * jobs and the `platforms` switch of the package jobs; its last job, `ci-passed`, runs
 * `scripts/ci-plan.mjs verdict`, which is `ciVerdict()`. Checked by
 * `apps/desktop/src/__tests__/ci-plan.test.ts` (this file and the script) and
 * `apps/desktop/src/__tests__/ci-workflows.test.ts` (the workflow). Acceptance list:
 * `ci-pipeline.feature.md`.
 *
 * Self-contained (no imports, erasable TypeScript only) so the script can load it with Node's
 * built-in type stripping.
 */

/** The runner image of each platform. Pinned images, never `-latest`. */
export const CI_RUNNERS = { linux: 'ubuntu-24.04', macos: 'macos-15', windows: 'windows-2025' } as const;
export type CiPlatform = keyof typeof CI_RUNNERS;
export const CI_PLATFORMS = ['linux', 'macos', 'windows'] as const satisfies readonly CiPlatform[];

/** How a platform is written in a job's name. */
export const CI_PLATFORM_LABELS = { linux: 'Linux', macos: 'macOS', windows: 'Windows' } as const satisfies Record<CiPlatform, string>;

/**
 * How many jobs share `@app/desktop`'s unit tests (`vitest run --shard=<i>/<n>`) on each platform.
 * The other workspaces' tests then run in one more job (`packages`). `0`: a single job runs every
 * workspace's tests (`turbo run test`).
 *
 * macOS is `0` because GitHub's Free plan, which the organisation is on, runs at most five macOS
 * jobs at once (and twenty jobs in all): one unit job, the e2e shards and the package job are
 * exactly five. Windows has the most shards because the desktop suite takes over twice as long
 * there (file-backed SQLite syncs every write).
 */
export const CI_UNIT_DESKTOP_SHARDS = { linux: 2, macos: 0, windows: 3 } as const satisfies Record<CiPlatform, number>;

/** How many jobs share the e2e suite (`playwright test --shard=<i>/<n>`) on each platform. */
export const CI_E2E_SHARDS = { linux: 4, macos: 3, windows: 4 } as const satisfies Record<CiPlatform, number>;

/**
 * Whether a failed e2e shard fails its job, and so the run. Every platform does (Windows since
 * 2026-11-13, once its harness issues were fixed). A platform set to `false` here, for the time its
 * suite is being repaired, reports a failed shard as a warning instead and has no e2e job in a
 * pull request's plan.
 */
export const CI_E2E_GATING: Readonly<Record<CiPlatform, boolean>> = { linux: true, macos: true, windows: true };

/**
 * What only the Linux jobs read. A pull request that changes nothing else runs lint, the security
 * gates and the Linux unit and e2e jobs, and skips macOS, Windows and the three package jobs. A
 * name ending in `/` is a directory at the repository root; the others are files there.
 *
 * Any path not listed here runs every platform, so a new kind of file is covered until someone
 * decides it need not be.
 */
export const CI_LINUX_ONLY_PATHS = ['docs/', 'semgrep/', 'security/', 'LICENSE'] as const;

/** A Markdown file at the repository root (`README.md`, `CONTRIBUTING.md`) is Linux-only too. */
export const CI_LINUX_ONLY_ROOT_PATTERN = /^[^/]+\.md$/;

/** The event whose plan follows its changed files. */
export const CI_PULL_REQUEST_EVENT = 'pull_request';

/** The event of a run on demand (`gh workflow run ci.yml --ref <branch>`): the only one with a scope. */
export const CI_DISPATCH_EVENT = 'workflow_dispatch';

/**
 * What a run on demand covers, its `scope` input (`-f scope=linux`): `all`, every platform, as a
 * push to `main`; `linux`, the Linux jobs only, as a pull request that changes Linux-only paths.
 *
 * `linux` is enough to fetch screenshot baselines (specs/visual-baseline.feature.md), which only
 * the Linux e2e jobs make, and it leaves the macOS runners to the runs that need them: one full
 * run uses all five the Free plan runs at once, so a second run waits for them.
 */
export const CI_SCOPES = ['all', 'linux'] as const;
export type CiScope = (typeof CI_SCOPES)[number];

/** The scope of a run on demand that names none, and of every other event. */
export const CI_DEFAULT_SCOPE: CiScope = 'all';

/** The variable `preflight` passes the `scope` input in (empty for every other event). */
export const CI_SCOPE_ENV = 'CI_SCOPE';

export function isCiScope(value: string): value is CiScope {
  return (CI_SCOPES as readonly string[]).includes(value);
}

export function isLinuxOnlyPath(file: string): boolean {
  if (CI_LINUX_ONLY_ROOT_PATTERN.test(file)) return true;
  return CI_LINUX_ONLY_PATHS.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}

/** One `unit` job (a `matrix.include` entry). */
export interface CiUnitJob {
  /** Unique; also names the job's artifacts. */
  readonly id: string;
  /** The job is shown as `Unit · <name>`. */
  readonly name: string;
  readonly os: string;
  /**
   * `all`: every workspace (`turbo run test`); `packages`: every workspace but `@app/desktop`;
   * `desktop`: `@app/desktop`'s shard `shard`.
   */
  readonly scope: 'all' | 'packages' | 'desktop';
  /** `<i>/<n>` for `desktop`, otherwise empty. */
  readonly shard: string;
}

/** One `e2e` job (a `matrix.include` entry). */
export interface CiE2eJob {
  /** Unique; the Playwright report artifact is `playwright-report-<id>`. */
  readonly id: string;
  /** The job is shown as `E2E · <name>`. */
  readonly name: string;
  readonly os: string;
  /** `<i>/<n>`. */
  readonly shard: string;
  /** `false`: a failed suite is reported as a warning on the run and does not fail its job. */
  readonly gating: boolean;
}

export interface CiPlan {
  /** Whether macOS, Windows and the package jobs run. */
  readonly platforms: boolean;
  readonly unit: readonly CiUnitJob[];
  readonly e2e: readonly CiE2eJob[];
}

/**
 * The run's plan. `changed` is the pull request's changed files (repository-relative, as
 * `git diff --name-only` prints them); it is ignored for every other event. `scope` is what a run
 * on demand asked for (`CI_DEFAULT_SCOPE` when left out); it is ignored for every other event, so
 * a push to `main` and a pull request can never be narrowed by it. `e2eGating` is `CI_E2E_GATING`
 * unless given (the tests give one with a platform off, which the workflow never does).
 */
export function planCi(input: {
  readonly event: string;
  readonly changed: readonly string[];
  readonly scope?: CiScope;
  readonly e2eGating?: Readonly<Record<CiPlatform, boolean>>;
}): CiPlan {
  const pullRequest = input.event === CI_PULL_REQUEST_EVENT;
  const linuxOnDemand = input.event === CI_DISPATCH_EVENT && (input.scope ?? CI_DEFAULT_SCOPE) === 'linux';
  const platforms = pullRequest ? !input.changed.every(isLinuxOnlyPath) : !linuxOnDemand;
  const unit: CiUnitJob[] = [];
  const e2e: CiE2eJob[] = [];
  for (const platform of CI_PLATFORMS) {
    if (platform !== 'linux' && !platforms) continue;
    const os = CI_RUNNERS[platform];
    const label = CI_PLATFORM_LABELS[platform];
    const desktopShards = CI_UNIT_DESKTOP_SHARDS[platform];
    if (desktopShards === 0) {
      unit.push({ id: platform, name: label, os, scope: 'all', shard: '' });
    } else {
      unit.push({ id: `${platform}-packages`, name: `${label} · packages`, os, scope: 'packages', shard: '' });
      for (let i = 1; i <= desktopShards; i += 1) {
        unit.push({ id: `${platform}-desktop-${i}`, name: `${label} · desktop ${i}/${desktopShards}`, os, scope: 'desktop', shard: `${i}/${desktopShards}` });
      }
    }
    const gating = (input.e2eGating ?? CI_E2E_GATING)[platform];
    if (!gating && pullRequest) continue;
    const e2eShards = CI_E2E_SHARDS[platform];
    for (let i = 1; i <= e2eShards; i += 1) {
      e2e.push({ id: `${platform}-${i}`, name: `${label} ${i}/${e2eShards}`, os, shard: `${i}/${e2eShards}`, gating });
    }
  }
  return { platforms, unit, e2e };
}

/**
 * Set to `1` for the desktop unit tests on Linux, where the workflow installs bubblewrap and allows
 * unprivileged user namespaces first: the MCP containment suite (`mcp-manager.test.ts`), which
 * skips itself on a machine whose bubblewrap cannot make a sandbox, then fails instead.
 */
export const CI_REQUIRE_BUBBLEWRAP_ENV = 'FROST_REQUIRE_BUBBLEWRAP';

/**
 * Set to `1` for the desktop unit tests on Linux when `scripts/fetch-intent-model.mjs` put the
 * pinned model files in place first: the real-model intent suite (`intent-model.test.ts`), which
 * skips itself where the files are not cached, then fails instead. Left empty when the model's
 * host could not be reached, so that host's bad day fails no run.
 */
export const CI_REQUIRE_INTENT_MODEL_ENV = 'FROST_REQUIRE_INTENT_MODEL';

/** The jobs `ci-passed` waits for that run in every plan. */
export const CI_ALWAYS_JOBS = ['preflight', 'lint', 'security', 'unit', 'e2e'] as const;

/** The jobs `ci-passed` waits for that run only when the plan's `platforms` is on. */
export const CI_PLATFORM_JOBS = ['package-linux', 'package-macos', 'package-windows'] as const;

/** The job every other job's result is folded into: the one check to require on `main`. */
export const CI_VERDICT_JOB = 'ci-passed';

/** The verdict job's name: the check to require on `main`. */
export const CI_VERDICT_NAME = 'CI passed';

/**
 * The verdict job's name in a run on demand with the `linux` scope. It is another name on purpose:
 * a check called `CI_VERDICT_NAME` that only the Linux jobs earned would satisfy the required
 * check for that commit.
 */
export const CI_LINUX_VERDICT_NAME = 'CI passed (Linux only)';

/**
 * Whether the run passed: every `CI_ALWAYS_JOBS` job succeeded, and every `CI_PLATFORM_JOBS` job
 * succeeded when the plan's `platforms` is on and was skipped when it is off. A job missing from
 * `needs` is a problem (so removing one from the workflow's `needs:` fails the run), as is any
 * other job in `needs` that did not succeed. `platforms` is `preflight`'s output: `'true'` or
 * `'false'`; anything else (a failed preflight leaves it empty) is a problem.
 */
export function ciVerdict(input: { readonly needs: Readonly<Record<string, { readonly result?: unknown } | undefined>>; readonly platforms: string }): {
  readonly ok: boolean;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  const result = (job: string): string => {
    const value = Object.hasOwn(input.needs, job) ? input.needs[job]?.result : undefined;
    return typeof value === 'string' ? value : 'missing';
  };
  if (input.platforms !== 'true' && input.platforms !== 'false') problems.push(`the plan has no platforms answer (${JSON.stringify(input.platforms)})`);
  for (const job of CI_ALWAYS_JOBS) {
    if (result(job) !== 'success') problems.push(`${job}: ${result(job)}`);
  }
  const expected = input.platforms === 'false' ? 'skipped' : 'success';
  for (const job of CI_PLATFORM_JOBS) {
    if (result(job) !== expected) problems.push(`${job}: ${result(job)} (the plan expects ${expected})`);
  }
  const known: readonly string[] = [...CI_ALWAYS_JOBS, ...CI_PLATFORM_JOBS];
  for (const job of Object.keys(input.needs)) {
    if (!known.includes(job) && result(job) !== 'success') problems.push(`${job}: ${result(job)}`);
  }
  return { ok: problems.length === 0, problems };
}
