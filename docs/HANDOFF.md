# frost — implementation handoff

## For the implementing agent (other host)
You are picking up a greenfield, **clean-room** desktop app called **frost**: an SEO browser with an
AI agent. Design and planning are complete; your job is to implement it, starting with Phase 0.

Read, in order:
1. `README.md`
2. `CONTRIBUTING.md` — the clean-room rule and the spec-driven + TDD rhythm. Follow it exactly.
3. `docs/design/IMPLEMENTATION-PLAN.md` — intent, stack, security model, 8-phase roadmap.
4. `docs/plans/phase-0-foundations.md` — your task list for Phase 0.
5. `docs/scaffolding-checklist.md` — environment preflight + Task 1 tick list.

Then implement Phase 0 task-by-task (subagent-driven recommended). Keep CI green. UI direction for
later phases is in `docs/ui-reference/README.md`; no third-party screenshots or assets are kept in
this repo.

---

## Copy-paste kickoff prompt
Paste this to the agent in the other environment:

> You're implementing **frost**, a clean-room SEO browser + AI agent, in this repo. Everything you
> need is in `docs/`. First read `README.md`, `CONTRIBUTING.md`, `docs/design/IMPLEMENTATION-PLAN.md`,
> and `docs/plans/phase-0-foundations.md`. Then implement the Phase 0 plan task-by-task using
> spec-driven development + TDD exactly as `CONTRIBUTING.md` describes: for each task author the
> `specs/` artifact first, write the failing test that cites it, implement minimally to pass, then
> commit (conventional commits). Use subagent-driven execution — a fresh implementer per task and a
> fresh reviewer before the next. Honor the non-negotiables: build only from `docs/` (never copy
> third-party code or assets); route all IPC through `packages/ipc-contract` with `enforceSender` on
> every procedure; set sandbox/contextIsolation/webSecurity explicitly true; load app pages from the
> `app://` scheme; and scheme-allowlist `shell.openExternal`. Keep CI green (Electronegativity +
> Semgrep sender-guard + the openExternal-deny e2e). Begin with Task 1 (monorepo + hardened Electron
> shell); confirm the boot test passes and report before moving to Task 2.
