# Contributing to frost

## Clean-room rule (read first)
frost is built **clean-room**. Work only from the written spec in `docs/` — the design doc and the
phase plans. Do **not** copy code, markup, CSS, or UI assets from any third-party product, and do
not add decompiled bundles or screenshots of other apps to this repo. If you need behavioral detail,
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
- CI must stay green: Electronegativity, the Semgrep `ipc-sender-guard` rule, and the
  `openExternal`-deny e2e.

## Commits & branches
- Conventional commits (`feat:`, `fix:`, `chore:`, `ci:`, `docs:` …).
- Branch per phase/task; open a PR for review; keep `main` green.

## Repo layout
- `docs/design/` — the design doc.
- `docs/plans/` — executable phase plans.
- `docs/ui-reference/` — pointer to where UI reference screenshots live (not committed).
- `specs/` — machine-checkable spec artifacts.
- `apps/`, `packages/` — created during Phase 0.
