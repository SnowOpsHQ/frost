# Scaffolding checklist (Phase 0, Task 1)

Quick reference for standing up the repo. The authoritative steps live in
`docs/plans/phase-0-foundations.md`; this is the environment preflight + a tick list.

## Preflight (target host)
- [ ] Node.js LTS (>= 22) with Corepack enabled.
- [ ] pnpm (`corepack enable`).
- [ ] git + `gh` authed to an account with SnowOpsHQ access.
- [ ] Repo cloned and opened as a project in the T3 Code environment.

## Scaffold (Task 1)
- [ ] Create a working branch off `main`.
- [ ] Root `package.json`, `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `turbo.json`, `tsconfig.base.json`.
- [ ] `apps/desktop` via Electron Forge (Vite + TypeScript template).
- [ ] Vitest configured for `apps/desktop`.
- [ ] `createMainWindow()` with explicit hardened webPreferences; boot test passes.
- [ ] `pnpm --filter @app/desktop start` shows a blank window; `turbo run test` green.
- [ ] Commit: `chore: scaffold monorepo and hardened electron shell`.

## Then
Proceed through Tasks 2–5 in the Phase 0 plan: security policy → IPC contract → wire IPC → CI gates.
