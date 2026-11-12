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
 * Whether a failed e2e shard fails the run. Windows does not, and never runs for a pull request:
 * a few of its tests still fail on Windows-only harness issues
 * (docs/plans/phase-7-sync-update-platforms.md, As built, Task 2).
 */
export const CI_E2E_GATING = { linux: true, macos: true, windows: false } as const satisfies Record<CiPlatform, boolean>;

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

/** The event whose plan follows its changed files. Every other event runs every platform. */
export const CI_PULL_REQUEST_EVENT = 'pull_request';

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
  /** `false`: a failure is shown but does not fail the run. */
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
 * `git diff --name-only` prints them); it is ignored for every other event.
 */
export function planCi(input: { readonly event: string; readonly changed: readonly string[] }): CiPlan {
  const pullRequest = input.event === CI_PULL_REQUEST_EVENT;
  const platforms = !pullRequest || !input.changed.every(isLinuxOnlyPath);
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
    const gating = CI_E2E_GATING[platform];
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

/** The jobs `ci-passed` waits for that run in every plan. */
export const CI_ALWAYS_JOBS = ['preflight', 'lint', 'security', 'unit', 'e2e'] as const;

/** The jobs `ci-passed` waits for that run only when the plan's `platforms` is on. */
export const CI_PLATFORM_JOBS = ['package-linux', 'package-macos', 'package-windows'] as const;

/** The job every other job's result is folded into: the one check to require on `main`. */
export const CI_VERDICT_JOB = 'ci-passed';

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
