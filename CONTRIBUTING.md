# Contributing to frost

## Clean-room rule (read first)
frost is built **clean-room**. Work only from the written spec in `docs/` — the design doc and the
phase plans. Do **not** copy code, markup, CSS, or UI assets from any third-party product, and do
not add screenshots or assets of other apps to this repo. If you need behavioral detail,
capture it in `docs/` as our own prose first, then as a `specs/` artifact.

## How we build: spec-driven + TDD
Every task in a phase plan follows the same rhythm:
1. **Spec first** — author/update a machine-checkable artifact under `specs/` (a Zod schema, a typed
   policy object, or a Gherkin-style `.feature.md`). The spec is the single source of truth.
2. **Red** — write the failing test; it imports/cites the spec. Run it; confirm it fails.
3. **Green** — implement the minimal code to pass. Run; confirm pass.
4. **Commit** — one conventional commit per task.

A task is done only when its spec exists, its tests cite it, and they pass.

## Execution model
Implement phase plans task-by-task. **Subagent-driven** is recommended: a fresh implementer per
task, a fresh reviewer before the next starts, and a whole-branch review at the end.

## Non-negotiable constraints (enforced in CI)
- TypeScript `strict`, ESM.
- `sandbox`, `contextIsolation`, `webSecurity` set **explicitly true** on every WebContents.
- **No** raw `ipcRenderer`/`ipcMain` passthrough exposed to any renderer. All IPC flows through
  `packages/ipc-contract`, and every procedure passes `enforceSender`.
- App pages load from the `app://` scheme, never `file://`.
- `shell.openExternal` only for the scheme allowlist, and only on a real user gesture.
- CI must stay green: Electronegativity, the Semgrep rules in `semgrep/`, and the
  `openExternal`-deny e2e (`.github/workflows/ci.yml`; gates listed in `specs/ci-gates.feature.md`).
  Run them locally with `pnpm security:electronegativity`, `pnpm security:semgrep` (needs `uv`) and
  `pnpm test:e2e` (needs a display). Accepting an Electronegativity finding means adding it, with a
  one-line rationale, to `security/electronegativity-baseline.json` in a reviewed PR.
- CI is one workflow, `.github/workflows/ci.yml` (`specs/ci-pipeline.feature.md`): a `preflight` job
  plans the run, then lint, the security gates, the unit and e2e shards on Linux, macOS and Windows
  and the three package jobs run side by side, and `CI passed` is green only if every one of them
  did what the plan said. A pull request that changes only `docs/`, `semgrep/`, `security/`,
  `LICENSE` or a root Markdown file runs the Linux jobs only. Shard counts and runner images live in
  `specs/ci-pipeline.spec.ts`; check a workflow change with `pnpm lint:workflows` (needs `uv`).

## Commits & branches
- Conventional commits (`feat:`, `fix:`, `chore:`, `ci:`, `docs:` …).
- Branch per phase/task; open a PR for review; keep `main` green.

## Repo layout
- `docs/design/` — the design doc.
- `docs/plans/` — executable phase plans.
- `docs/ui-reference/` — UI direction notes (frost's own design).
- `specs/` — machine-checkable spec artifacts.
- `apps/`, `packages/` — the app, the backend, the agent runtime and the shared packages (see the README's Layout).
