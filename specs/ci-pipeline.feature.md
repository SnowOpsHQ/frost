# Feature: The CI pipeline

Spec: `specs/ci-pipeline.spec.ts` (runners, shard counts, the plan and the verdict).
Workflow: `.github/workflows/ci.yml`, with the shared install steps in
`.github/actions/setup/action.yml` and the plan's command line in `scripts/ci-plan.mjs`.
Tests: `apps/desktop/src/__tests__/ci-plan.test.ts` (the spec and the script),
`apps/desktop/src/__tests__/ci-workflows.test.ts` (the workflow's shape, its gates and the setup
action) and `apps/desktop/src/__tests__/platform-workflows.test.ts` (the three package jobs). Each
scenario maps to one named test. The security gates themselves are in `ci-gates.feature.md`; what
each package job checks is in `linux-package.feature.md`, `macos-package.feature.md` and
`windows-package.feature.md`.

One workflow run, in three stages:

```
preflight ─┬─ lint ───────────────────────────────┐
           ├─ security ────────────────────────────┤
           ├─ unit  (a job per platform and shard) ┤
           ├─ e2e   (a job per platform and shard) ┼─ ci-passed
           ├─ package-linux ───────────────────────┤
           ├─ package-macos ───────────────────────┤
           └─ package-windows ─────────────────────┘
```

`preflight` decides what runs, the jobs after it run side by side, and `ci-passed` succeeds only if
the run did what the plan said. `ci-passed` is the one check to require on `main`.

## The workflow (`ci-workflows.test.ts`)
- **Scenario: pipeline-triggers** — the workflow runs for every pull request (no path or branch
  filter), for pushes to `main` and to `v*` tags, and on demand (`workflow_dispatch`, e.g.
  `gh workflow run ci.yml --ref <branch>` for a branch without a pull request). A superseded
  pull-request run is cancelled; no other run is. The token is read-only (`contents: read`), and
  every `run` step uses bash (Git Bash on Windows). It is the only workflow in the repository.
- **Scenario: pipeline-jobs** — the jobs are exactly `preflight`, `lint`, `security`, `unit`, `e2e`,
  `package-linux`, `package-macos`, `package-windows` and `ci-passed`, each with a time limit.
  `preflight` needs nothing; every job but `ci-passed` needs `preflight` only, so none waits for
  another; `ci-passed` needs every other job (`CI_ALWAYS_JOBS` and `CI_PLATFORM_JOBS`) and runs
  whatever their results (`always()`).
- **Scenario: preflight-plans-the-run** — `preflight` checks out with depth 2 and runs
  `node scripts/ci-plan.mjs plan` in the step `plan`, fed `git diff --name-only HEAD^1 HEAD` for a
  pull request (checked out as its merge commit, whose first parent is the base branch) and nothing
  otherwise. The job's outputs `platforms`, `unit` and `e2e` are that step's.
- **Scenario: matrices-come-from-the-plan** — `unit` and `e2e` take their whole matrix from
  `preflight`'s `unit` and `e2e` outputs, never stop the other shards when one fails
  (`fail-fast: false`) and run on `matrix.os`. Each package job runs only when `platforms` is
  `'true'`. No job has `continue-on-error`: a failed job, even one that did not fail the run, would
  mark the commit as failed.
- **Scenario: gates-map-to-steps** — every gate of `ci-gates.feature.md` is a step named
  `Gate: <name>` running the gate's command, in the job the gate names; the workflow has no other
  `Gate:` step.
- **Scenario: unit-job** — `unit` runs, by `matrix.scope`: `all`, `pnpm turbo run test`;
  `packages`, the same without `@app/desktop`; `desktop`, `pnpm --filter @app/desktop test` with
  `--shard` from `matrix.shard`. On Linux, before the desktop suite, it installs bubblewrap if it is
  missing and allows unprivileged user namespaces, and runs the suite with
  `CI_REQUIRE_BUBBLEWRAP_ENV` set to `1`, so the MCP containment suite cannot be skipped there
  (`agent-mcp.feature.md`, `mcp-bubblewrap-required-where-asked`). On Windows, LF line endings are kept
  before checkout (`git config --global core.autocrlf false`): the tests read repository files and
  match on `\n`.
- **Scenario: e2e-job** — `e2e` builds the app (`pnpm --filter @app/desktop build`) and runs
  `pnpm --filter @app/desktop test:e2e` with `--shard` from `matrix.shard`: on Linux under
  `xvfb-run -a -s "-screen 0 1280x1024x24"` after allowing unprivileged user namespaces (the
  Chromium sandbox stays on), elsewhere in the runner's own desktop session. A failed shard uploads
  its Playwright report and test results as `playwright-report-<matrix.id>` (7 days). For a shard
  whose `gating` is off (Windows), a failed suite does not fail the step or the job
  (`continue-on-error` on that one step): a warning on the run says which shard failed, and the
  report is uploaded all the same.
- **Scenario: e2e-retries-only-in-ci** — `apps/desktop/playwright.config.ts` runs a failed e2e test
  again, up to twice, when `CI` is set, and never otherwise. A test that then passes is flaky: its
  shard stays green, and Playwright's `github` reporter (CI only) puts the failed attempt and a
  summary naming the test on the run. A test that fails all three times fails its shard. The
  screenshot baseline (`visual.e2e.ts`) sets its own retries to 0, and no other suite sets any.
- **Scenario: ci-passed-runs-the-verdict** — `ci-passed` runs `node scripts/ci-plan.mjs verdict`
  with `NEEDS` set to the JSON of the jobs it needs and `PLATFORMS` to `preflight`'s `platforms`.
- **Scenario: sandbox-stays-on** — nothing in the workflow or the setup action passes
  `--no-sandbox`, and `verify:win` never runs with `--static`.
- **Scenario: actions-are-pinned** — every `uses:` in the workflow and the setup action is either
  the local `./.github/actions/setup` or pinned to a full commit SHA with its version in a comment.
- **Scenario: setup-action** — `.github/actions/setup/action.yml` is a composite action: pnpm at
  the version `package.json#packageManager` pins, Node 24 with pnpm's store cached, Electron's
  download cache for the platform keyed by the Electron version in `pnpm-lock.yaml` (so a lockfile
  change that leaves Electron alone downloads nothing), then `pnpm install --frozen-lockfile`.
  Every job that installs the workspace uses it right after checkout.
- **Scenario: workflows-lint-clean** — the root script `lint:workflows` runs actionlint at a pinned
  version with its shellcheck and pyflakes passes off, so the result depends only on the pinned
  package and the workflow files.
- **Scenario: turbo-cache-follows-dependencies** — as in `ci-gates.feature.md`; also, the `test`
  task's inputs include the workflow, the setup action and `scripts/*.mjs`, so a change to any of
  them is never answered from Turbo's cache.

## The plan (`ci-plan.test.ts`, `planCi`)
- **Scenario: plan-runs-everything-outside-pull-requests** — for `push`, `workflow_dispatch` and
  any other event that is not `pull_request`, `platforms` is on whatever the changed files, and
  every platform has unit and e2e jobs.
- **Scenario: plan-follows-a-pull-requests-files** — for a pull request, `platforms` is off only
  when every changed file is Linux-only (`CI_LINUX_ONLY_PATHS`: `docs/`, `semgrep/`, `security/`,
  `LICENSE`; or a Markdown file at the repository root). Then the plan holds Linux jobs only. One
  file anywhere else turns it on: under `apps/`, `packages/`, `specs/`, `scripts/` or `.github/`, a
  root file such as `pnpm-lock.yaml`, `.gitattributes` or a name not yet known, a Markdown file
  outside the root, a path that only starts like a listed one (`docs.txt`, `LICENSE.txt`,
  `securityx/a`), and a name git printed quoted. A pull request with no changed files is Linux-only.
- **Scenario: plan-unit-covers-every-suite-once** — on each platform the unit jobs are either one
  `all` job, or one `packages` job and the desktop shards `1/n` … `n/n` for
  `CI_UNIT_DESKTOP_SHARDS`, each exactly once; every job runs on `CI_RUNNERS`' image for its
  platform; ids and names are unique.
- **Scenario: plan-e2e-shards** — on each platform the e2e jobs are the shards `1/n` … `n/n` for
  `CI_E2E_SHARDS`, each exactly once, on that platform's image, `gating` as `CI_E2E_GATING` says.
  A platform that is not gating (Windows) has no e2e job in a pull request's plan and all of them
  otherwise.
- **Scenario: plan-fits-the-macos-limit** — a full plan holds at most four macOS unit and e2e jobs
  (with `package-macos`, five: what GitHub's Free plan, which the organisation is on, runs at once).

## The verdict (`ci-plan.test.ts`, `ciVerdict`)
- **Scenario: verdict-passes-a-full-run** — with `platforms` `'true'` and every job `success`, the
  run passed.
- **Scenario: verdict-passes-a-linux-only-run** — with `platforms` `'false'`, the `CI_ALWAYS_JOBS`
  `success` and the `CI_PLATFORM_JOBS` `skipped`, the run passed.
- **Scenario: verdict-fails-anything-else** — each of these is a problem that names the job: any
  job `failure` or `cancelled`; a `CI_ALWAYS_JOBS` job `skipped`; a package job `skipped` while
  `platforms` is `'true'`, or `success` while it is `'false'`; a job missing from `needs` (also one
  named like an `Object.prototype` key); a job outside both lists that did not succeed; a `platforms`
  that is neither `'true'` nor `'false'` (a failed `preflight` leaves it empty).

## The command line (`ci-plan.test.ts`, `scripts/ci-plan.mjs`)
- **Scenario: plan-cli-writes-the-outputs** — `plan` prints and appends to `GITHUB_OUTPUT` exactly
  three lines: `platforms=<true|false>`, `unit={"include":[…]}` and `e2e={"include":[…]}`, the
  matrices being `planCi`'s for `GITHUB_EVENT_NAME` and the changed files on stdin (one per line,
  LF or CRLF, blank lines ignored). It appends a Markdown table of the planned jobs to
  `GITHUB_STEP_SUMMARY`. Without those two variables it only prints. Stdin is read only for a pull
  request.
- **Scenario: plan-cli-refuses-bad-input** — a missing or malformed `GITHUB_EVENT_NAME` exits 1 and
  writes nothing; an unknown command, no command or an extra argument exits 2 with the usage.
- **Scenario: verdict-cli-exit-codes** — `verdict` prints `<job>: <result>` for every job in
  `NEEDS`, then exits 0 with `CI passed.` when `ciVerdict` passes, or 1 with one line per problem.
  `NEEDS` that is missing, not JSON or not an object exits 1.
- **Scenario: cli-runs-under-node** — run as a process by the Node that runs the tests,
  `scripts/ci-plan.mjs plan` loads the spec with Node's own type stripping and prints a plan (the
  workflow runs it before anything is installed).

## Not covered
- **Publishing.** The pipeline uploads the verified packages as run artifacts and publishes
  nothing: no GitHub Release, no update feed (`update-manifest.feature.md`). A package artifact is
  uploaded once its own job's checks passed, whatever the other jobs did, so use the artifacts of a
  run only when its `ci-passed` job succeeded.
- **Requiring the check.** Branch protection is a repository setting, not a file: nothing here
  makes `ci-passed` required.
- Node 22 (`package.json#engines` allows it) is not run; every job uses Node 24.
