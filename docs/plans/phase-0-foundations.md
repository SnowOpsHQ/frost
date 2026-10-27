# Phase 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo and a hardened, security-first Electron shell whose only renderer↔main communication is a typed, sender-validated tRPC channel, with the security guardrails enforced in CI from the first commit.

**Architecture:** A pnpm/Turbo monorepo with an Electron Forge desktop app. Renderer and main share a `packages/ipc-contract` (Zod + tRPC) so every channel is typed and validated by one `enforceSender` middleware. A single `security-policy` module owns webPreferences, the `openExternal` allowlist, permission handling, navigation pinning, and the `app://` CSP. CI runs Electronegativity + a Semgrep rule + a Playwright `openExternal`-deny test on every push.

**Tech Stack:** TypeScript, Electron (latest stable) + Electron Forge (Vite), React, pnpm workspaces, Turborepo, @trpc/server + @trpc/client v11 (IPC transport: a small in-repo link in `@app/ipc-contract`, since electron-trpc supports tRPC v10 only, and trpc-electron crashes main on a null `senderFrame`), Zod, Vitest, Playwright, Electronegativity, Semgrep.

**Spec:** `docs/design/IMPLEMENTATION-PLAN.md` (§2 stack, §3 security model, Phase 0 deliverable). The plan argues from that design; executors read both.

## Spec-Driven Development protocol

This plan is spec-first. **Every task begins by authoring or updating a machine-checkable spec artifact under `specs/`, and every test cites it:**
- Contracts (IPC, security policy) are expressed as code specs: a Zod schema or a typed policy object in `specs/*.spec.ts`, exported and imported by both the implementation and its tests. The spec is the single source of truth; the test asserts the implementation conforms to it; the implementation satisfies the test.
- Behavioural rules (e.g. "non-web schemes are denied") are written as a short Gherkin-style `specs/<feature>.feature.md` acceptance list, and each line maps to one named test.
- A task is not done until its spec artifact exists, its tests cite it, and they pass. Reviewers check spec↔test↔code agreement.

## Global Constraints

- Language: **TypeScript**, `strict: true`. ESM modules.
- Electron **latest stable line**; `sandbox`, `contextIsolation`, `webSecurity` set **explicitly true** on every `WebContents` (never defaulted).
- No raw `ipcRenderer`/`ipcMain` passthrough is exposed to any renderer; all IPC flows through `packages/ipc-contract`.
- Every `ipcMain`/tRPC procedure passes through the shared `enforceSender` middleware — no exceptions.
- App's own pages load from a custom `app://` scheme (registered privileged), never `file://`.
- Naming: packages are `@app/<name>`; the product name is `frost` (no third-party assets, code, or marks).
- Commit after every task with a conventional-commit message.

## Review Focus

Inputs the spec implies but the happy-path tests don't exercise; each line's test is added to the owning task.
- **Malformed / cased / scheme-tricky external URLs** (`FILE://`, `http:evil`, `javascript:alert(1)`, empty): must be denied, not opened — pinned in Task 2 (`denies-malformed-schemes`).
- **IPC call from an unexpected frame/origin** (subframe, wrong window): `enforceSender` must reject — pinned in Task 3 (`rejects-foreign-sender`).
- **A new IPC handler added without a sender guard**: the Semgrep rule must fail CI — pinned in Task 5 (`semgrep-flags-unguarded-handler`).
- **`window.open` without a user gesture**: must not open externally — pinned in Task 2 (`denies-without-gesture`).
- **CSP on `app://` must still allow the renderer's own bundle to boot** (no self-inflicted breakage) — pinned in Task 2 (`app-csp-allows-own-bundle`).

---

### Task 1: Monorepo + hardened Electron shell skeleton

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`
- Create: `apps/desktop/` (Electron Forge + Vite TS template: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/`, `forge.config.ts`, `vitest.config.ts`)
- Test: `apps/desktop/src/main/__tests__/boot.test.ts`

**Interfaces:**
- Produces: `createMainWindow(): BrowserWindow` in `apps/desktop/src/main/window.ts` (consumed by Tasks 2, 4).

- [ ] **Step 1: `git init`; scaffold the monorepo and the Electron Forge (Vite+TS) app under `apps/desktop`.** pnpm workspace includes `apps/*` and `packages/*`; Turbo `build`/`test`/`lint` pipelines.
- [ ] **Step 2: Write the failing test** `boot.test.ts`:

```ts
test('createMainWindow returns a window with hardened webPreferences', () => {
  const win = createMainWindow();
  const wp = win.webContents.getLastWebPreferences();
  expect(wp).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
});
```

- [ ] **Step 3: Run it, verify it fails** — `pnpm --filter @app/desktop test` → FAIL (`createMainWindow` undefined).
- [ ] **Step 4: Implement `createMainWindow()` in `apps/desktop/src/main/window.ts`** with the four webPreferences set explicitly; `index.ts` calls it on `app.whenReady`.
- [ ] **Step 5: Run the test → PASS; manually `pnpm --filter @app/desktop start` shows a blank window.**
- [ ] **Step 6: Commit** — `chore: scaffold monorepo and hardened electron shell`.

---

### Task 2: Security-policy spec + module

**Files:**
- Create: `specs/security-policy.spec.ts` (the policy contract), `specs/external-url.feature.md`
- Create: `apps/desktop/src/main/security/policy.ts`, `apps/desktop/src/main/security/register.ts`
- Test: `apps/desktop/src/main/security/__tests__/policy.test.ts`

**Interfaces:**
- Consumes: `createMainWindow` (Task 1).
- Produces: `resolveExternalOpen(url: string, opts: { userGesture: boolean }): 'allow' | 'deny'`; `appCspHeader(): string`; `registerSecurity(session: Session, win: BrowserWindow): void` (consumed by Task 4 wiring).

- [ ] **Step 1 (spec):** In `specs/security-policy.spec.ts` export `ALLOWED_EXTERNAL_SCHEMES = ['http:','https:','mailto:'] as const` and the `app://` CSP string constant. In `specs/external-url.feature.md` list the rules (allow http/https/mailto with gesture; deny all else; deny without gesture; deny malformed).
- [ ] **Step 2: Write the failing tests** (each cites the spec):

```ts
test('allows https with gesture', () => expect(resolveExternalOpen('https://x.com',{userGesture:true})).toBe('allow'));
test('denies-non-web-scheme', () => expect(resolveExternalOpen('vscode://x',{userGesture:true})).toBe('deny'));
test('denies-malformed-schemes', () => ['FILE://x','http:evil','javascript:1','',' '].forEach(u => expect(resolveExternalOpen(u,{userGesture:true})).toBe('deny')));
test('denies-without-gesture', () => expect(resolveExternalOpen('https://x.com',{userGesture:false})).toBe('deny'));
test('app-csp-allows-own-bundle', () => expect(appCspHeader()).toContain("script-src 'self'"));
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement `policy.ts`** — `resolveExternalOpen` normalizes via `new URL()` (deny on throw), lowercases the protocol, checks membership in the spec's allowlist, and requires `userGesture`. `appCspHeader` returns the spec's `'self'`-based CSP. `register.ts` wires `setWindowOpenHandler` (deny + conditional `shell.openExternal`), `setPermissionRequestHandler` (deny-by-default), a `will-navigate` guard pinning `app://`, and `onHeadersReceived` CSP for `app://` only.
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** — `feat(security): scheme allowlist, deny-by-default permissions, nav pin, app CSP`.

---

### Task 3: Typed IPC contract package

**Files:**
- Create: `packages/ipc-contract/src/trpc.ts` (init + `enforceSender`), `packages/ipc-contract/src/router.ts` (appRouter with a `ping` procedure), `packages/ipc-contract/src/index.ts`
- Create: `specs/ipc-sender.feature.md`
- Test: `packages/ipc-contract/src/__tests__/sender.test.ts`

**Interfaces:**
- Produces: `appRouter` and `type AppRouter`; `enforceSender(ctx)` middleware; `createContext({ senderFrame, window })`. Consumed by Task 4.

- [ ] **Step 1 (spec):** `specs/ipc-sender.feature.md` — a procedure call is accepted only when `senderFrame` is the main frame of a known app window on the `app://` origin; otherwise it throws `FORBIDDEN`.
- [ ] **Step 2: Write the failing tests:**

```ts
test('ping returns pong for a valid app-window sender', async () => {
  const caller = appRouter.createCaller(ctxFor({ origin: 'app://app', isMainFrame: true }));
  expect(await caller.ping()).toBe('pong');
});
test('rejects-foreign-sender', async () => {
  const caller = appRouter.createCaller(ctxFor({ origin: 'https://evil.com', isMainFrame: true }));
  await expect(caller.ping()).rejects.toThrow('FORBIDDEN');
});
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** the tRPC init, `enforceSender` (reads origin/frame from ctx, throws `TRPCError FORBIDDEN` on mismatch), and `appRouter` with `ping: publicProcedure.use(enforceSender).query(() => 'pong')`.
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** — `feat(ipc): typed tRPC contract with enforceSender`.

---

### Task 4: Wire IPC end-to-end (main ↔ minimal preload ↔ renderer)

**Files:**
- Create: `packages/ipc-contract/src/transport/*` (in-repo tRPC v11 transport: main handler on the single `ipcMain.handle` channel `app:trpc`, preload `exposeIpcBridge()` → `window.frostIpc.invoke`, renderer `ipcLink`; in-repo because electron-trpc supports tRPC v10 only, and trpc-electron crashes main on a null `senderFrame`)
- Modify: `apps/desktop/src/main/index.ts` (register `app://`, call `registerSecurity`, `attachIpcHandler` with `createContext` from the real `senderFrame`)
- Create: `apps/desktop/src/preload/index.ts` (expose **only** the IPC bridge via `exposeIpcBridge()` — no generic ipc)
- Modify: `apps/desktop/src/renderer/` (tRPC client calls `ping`, renders the result)
- Test: `apps/desktop/e2e/ipc.e2e.ts` (Playwright + Electron)

**Interfaces:**
- Consumes: `appRouter`, `createContext` (Task 3); `registerSecurity`, `createMainWindow` (Tasks 1–2).

- [ ] **Step 1: Write the failing e2e test** `ipc.e2e.ts`: launch the Electron app, wait for the renderer, assert the DOM shows `pong` (proving a real sender-validated round-trip over `app://`).
- [ ] **Step 2: Run → FAIL** (renderer shows nothing / app not wired).
- [ ] **Step 3: Implement** `protocol.handle('app', …)` serving the renderer bundle; `createContext` derives origin/frame from the `ipcMain.handle` event's `senderFrame`; preload exposes only `exposeIpcBridge()`; renderer calls `ping` through the in-repo `ipcLink` client and renders it.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(ipc): end-to-end sender-validated ping over app://`.

---

### Task 5: CI security gates

**Files:**
- Create: `.github/workflows/ci.yml`, `semgrep/ipc-sender-guard.yml`
- Create: `apps/desktop/e2e/external-url.e2e.ts`
- Test: the workflow itself (self-checking steps below)

**Interfaces:**
- Consumes: the security module (Task 2) and the e2e harness (Task 4).

- [ ] **Step 1: Write the failing e2e** `external-url.e2e.ts`: a test page served on loopback calls `window.open('reaprobe://x')` on a click; assert **no** external open occurs (spy/stub `shell.openExternal` in the main process test build and assert it was not called for the non-web scheme, and IS called for an allowlisted `https:` link).
- [ ] **Step 2: Write `semgrep/ipc-sender-guard.yml`** — pattern: a tRPC procedure definition that does not include `enforceSender`, or any `ipcMain.handle(...)`/`ipcMain.on(...)` outside the transport's single `app:trpc` handler (`packages/ipc-contract/src/transport/main.ts`); plus a deliberately-unguarded fixture under `semgrep/__fixtures__/bad.ts`. Test `semgrep-flags-unguarded-handler`: running Semgrep on the fixture returns a finding; running on `packages/ipc-contract` returns none.
- [ ] **Step 3: Run both → FAIL** (no workflow / scripts yet).
- [ ] **Step 4: Implement** `ci.yml` running: `pnpm install`, `turbo run lint test build`, `npx @doyensec/electronegativity -i apps/desktop`, `semgrep --config semgrep/ipc-sender-guard.yml`, and the Playwright e2e suite. Add the fixture + rule.
- [ ] **Step 5: Run the e2e and Semgrep tests locally → PASS; push and confirm the workflow is green.**
- [ ] **Step 6: Commit** — `ci: electronegativity + semgrep ipc guard + openExternal e2e`.

---

## Self-review notes (completed)
- **Spec coverage:** design §3 security model → Tasks 2,4,5; §2 stack/monorepo → Task 1; typed-IPC root-cause fix → Tasks 3,4; CI guardrails → Task 5. No Phase-0 requirement is unassigned (UI panels are Phase 2+, out of scope here).
- **Type consistency:** `resolveExternalOpen`, `appCspHeader`, `registerSecurity`, `appRouter`, `createContext`, `enforceSender`, `createMainWindow` are named identically where produced and consumed.
- **Review Focus:** all five lines are pinned to named tests in Tasks 2/3/5.
- **Proportion:** steps carry signatures, spec constants, and test assertions only — no full implementation bodies.
