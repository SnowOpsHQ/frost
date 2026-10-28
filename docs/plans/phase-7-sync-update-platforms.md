# Phase 7 — Cross-Platform Packaging, Signed Auto-Update and Sync Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven, in order. Each task gets a fresh
> implementer subagent: spec first, then a failing test, then the code, then one conventional commit.
> A fresh reviewer checks each task before the next starts; the update-signature tasks (3 and 4) get
> a security-focused review. A whole-branch review runs at the end. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** design doc §4 Phase 7: "libSQL/local-first sync of change-intelligence; auto-update (signed,
staged); cross-platform".
- Package frost for Linux (AppImage, deb) and Windows (Squirrel installer, zip), with the same fuses
  and the same packaged-build checks as macOS.
- Update frost from a signed, staged manifest. Nothing installs without the user's consent.
- Lay the groundwork for libSQL sync of change intelligence behind the existing async repository API.

**Architecture:** the Phase 0–2.5 architecture holds:
- main owns all state;
- the chrome reaches it only through `enforceSender`-first tRPC procedures in `@app/ipc-contract`;
- the fuses and ASAR rules of `macos-package.spec.ts` (`PACKAGED_FUSES`) apply on every platform.

New in this phase:
- **Updates.** An update module in main (`apps/desktop/src/main/update/`) fetches a signed manifest
  through Electron's `net`. It checks the manifest's Ed25519 signature against a public key compiled
  into the app, decides eligibility and staging locally, then downloads the artifact and checks its
  SHA-256. Only then does it offer the update.
- **Database drivers.** `@app/db` gains a driver seam (`packages/db/src/driver-*.ts`). Drizzle runs
  over `node:sqlite` (the default, unchanged) or over `@libsql/client`, behind the same repository
  API. libSQL is opened only when sync is turned on.

**Spec:**
- `docs/design/IMPLEMENTATION-PLAN.md` §2 (Data: `node:sqlite` now, libSQL when sync lands) and §4
  Phase 7.
- Phase 6's schema: `docs/plans/phase-6-change-intelligence.md`, "Schema" (branch
  `phase-6/change-intelligence`).

## Spec-Driven Development protocol
As before:
- every task authors `specs/` artifacts first;
- each scenario has a named test or verify check that cites it;
- reviewers check that spec, test and code agree.

## Global Constraints
Everything in the Phase 0–2.5 Global Constraints and `CONTRIBUTING.md` still holds, plus the following.
- **Honest signing.** frost has no code-signing certificates: no Apple Developer ID, no Windows
  Authenticode certificate, and no Linux repository key.
  - Every build in this phase is unsigned. macOS stays ad-hoc signed, as today.
  - Docs, specs and UI text never claim otherwise.
  - Where a platform needs a signed app to update in place (macOS Squirrel.Mac), frost downloads and
    verifies the update, then tells the user to install it by hand.
- **The update channel is not trusted until verified.** Nothing from the feed is acted on until two
  checks pass:
  - the manifest bytes verify against the embedded Ed25519 public key;
  - the downloaded artifact's SHA-256 equals the signed manifest's.

  A failed check discards the download and shows why. The feed URL needs `https:`; `http:` is
  allowed only for loopback (the tests' fake feed).
- **Consent.**
  - Update checks are off unless a feed is configured.
  - The user's setting can turn checks off.
  - Downloading starts only after the user asks for it.
  - Installing (opening the downloaded file) starts only after the user asks for it.
  - Nothing installs silently.
- **No identifying data leaves the machine.**
  - The install ID is random, local and never sent.
  - Staged rollout is decided on the device.
  - A feed request carries no cookies, no install ID and no extra headers.
- **Never publish.** No GitHub releases, no uploaded update feed. Tests use a local fake feed.
  `pnpm sign:update-manifest` signs a manifest file locally.
- **Private key handling.** The signing key lives only under `frost-private/keys/` on the
  maintainer's machine. `sign:update-manifest` reads its path from `FROST_UPDATE_SIGNING_KEY`. The
  repo holds only the public key.
- **Team contract.** Phase 7 owns these files:
  - new workflow files;
  - `apps/desktop/scripts/verify-{linux,windows}-package.mjs` and `verify-package-common.mjs`;
  - `specs/{update,sync,linux-package,windows-package}*`;
  - `apps/desktop/src/main/{update,sync}/`;
  - `packages/db/src/driver-*.ts`;
  - `packages/ipc-contract/src/{update,sync}-router.ts`;
  - the renderer's `update-view.ts`, `sync-view.ts` and the components they need.

  Hub files get one-line, append-only registrations. `ci.yml` and `macos.yml`, and their check names,
  are unchanged. DB migrations, if any, use IDs `0060`–`0069`. Phase 7's own preferences (update
  setting, install ID, sync config) live in their own small JSON files in `userData`, so no shared
  table or migration list is touched.

## Review Focus
- **A forged or replayed update is never offered.** Task 3 (`rejects-bad-signature`,
  `rejects-downgrade`) and Task 4 (`rejects-hash-mismatch`):
  - any change to the signed bytes, a wrong key, an unknown `keyId` or a malformed envelope is
    refused;
  - a manifest for the running or an older version is ignored;
  - an artifact whose hash differs is deleted.
- **The feed can't make frost fetch elsewhere or fill the disk.** Task 4 (`download-is-bounded`):
  - the manifest and artifact sizes are capped;
  - redirects are capped and stay `https:`;
  - no private address is used unless the feed is loopback in an unpackaged test build.
- **Nothing installs without consent.** Task 5 (`no-silent-install`): every step past "check" waits
  for a user action in the chrome.
- **The packaged app keeps its fuses and integrity on every platform.** Tasks 1 and 2
  (`fuses-read-back`, `no-stray-files`, `asar-integrity`), Task 7:
  - the packaged app holds `app.asar` and only allowlisted resources;
  - unpacked native modules, if any, are on an allowlist.
- **Sync never moves browsing data.** Task 6:
  - only the change-intelligence database is a sync candidate;
  - the browser-session database (history, permissions) stays local.

---

### Batch A — Cross-platform packaging

#### Task 1: Linux packages (AppImage, deb) and their CI job
- **Spec:** `specs/linux-package.spec.ts` (names, archs `x64`, the artifact paths, deb metadata, the
  allowlist of files in `resources/`) and `specs/linux-package.feature.md`.
- **Makers:**
  - `@electron-forge/maker-deb`: name `frost`, a category, a maintainer, the license, no postinst
    scripts;
  - `@reforged/maker-appimage`, for Linux only;
  - the existing zip maker keeps `linux`.
- **Verify:** `apps/desktop/scripts/verify-linux-package.mjs` (`pnpm verify:linux`), with checks
  shared with Windows in `verify-package-common.mjs`. Every check prints `PASS`/`FAIL`, and any
  failure exits 1.
  - `fuses-read-back`.
  - `asar-integrity`: the fuse is on. Electron enforces ASAR integrity only on macOS and Windows,
    so on Linux the check reports this as a known platform gap and checks `OnlyLoadAppFromAsar`.
  - `no-stray-files`: `resources/` holds only the allowlist, and `app.asar` holds only `.vite/**`
    and `package.json`.
  - `launches-and-stays-alive`, on a throwaway profile.
  - `refuses-remote-debugging`.
  - `deb-metadata`: `dpkg-deb -I`/`-c` (name, version, arch, the install path) and the same
    resource checks on the extracted tree.
  - `appimage-runs`: `--appimage-extract`, then the resource checks.
- **Scripts:** `make:linux`, `verify:linux` in `@app/desktop`; root `make:linux`, `verify:linux`
  (append-only).
- **CI:** `.github/workflows/linux-package.yml`, job `linux-package`, on `ubuntu-24.04`:
  - path-filtered like `macos.yml`, plus `main` pushes and manual runs;
  - install, then build, `make:linux`, then `verify:linux` under Xvfb;
  - uploads the AppImage and deb (7 days);
  - no lint/test/e2e: `ci` already runs them on Linux.
- **Failing tests:**
  - `apps/desktop/src/__tests__/linux-package-config.test.ts` (makers, deb options);
  - `apps/desktop/src/__tests__/platform-workflows.test.ts` (`linux-package-ci-job`);
  - `forge-config.test.ts` `makes-zip-and-dmg` narrowed to the darwin makers (the scenario in
    `macos-package.feature.md` is amended to match).
- **Files:**
  - `apps/desktop/forge.config.ts` (makers appended);
  - `apps/desktop/package.json` (devDeps, scripts);
  - root `package.json` (two scripts);
  - `pnpm-workspace.yaml`, if a maker needs a build;
  - the new spec, script, test and workflow files.
- [x] commit `feat(packaging): Linux AppImage and deb packages, verify:linux and its CI job`

#### Task 2: Windows packages (Squirrel, zip) and their CI job
- **Spec:** `specs/windows-package.spec.ts` (Squirrel options, artifact paths, the `resources/`
  allowlist, the ASAR integrity resource) and `specs/windows-package.feature.md`.
- **Makers:** `@electron-forge/maker-squirrel` (`setupExe`, `name`, no `certificateFile`: unsigned)
  and `zip` for `win32`.
- **Verify:** `apps/desktop/scripts/verify-windows-package.mjs` (`pnpm verify:win`), with these
  checks:
  - `fuses-read-back`.
  - `asar-integrity`: the `Integrity`/`ElectronAsar` PE resource of `frost.exe` holds the SHA-256
    of `app.asar`'s header.
  - `asar-tamper-refused`: a copy with one header byte changed refuses to start.
  - `no-stray-files`.
  - `launches-and-stays-alive`.
  - `refuses-remote-debugging`.
  - `squirrel-artifacts`: `Setup.exe`, the `.nupkg` and `RELEASES` exist.
  - `unsigned-as-documented`: the exe carries no Authenticode signature. If one appears, the check
    fails until the docs are updated.
- **CI:** `.github/workflows/windows.yml`, job `windows`, on `windows-2025`:
  - path-filtered, plus `main` pushes and manual runs;
  - install, `turbo run lint test`, build, `make:win`, `verify:win`;
  - e2e as a separate step;
  - uploads `Setup.exe` and the zip (7 days).

  If the e2e suite isn't reliable on Windows, the step is kept on `workflow_dispatch` only and the
  reason is recorded in As built.
- **Failing tests:** `windows-package-config.test.ts`; `platform-workflows.test.ts`
  (`windows-ci-job`).
- **Files:** the Forge config (one maker line, one zip platform), `apps/desktop/package.json`, root
  `package.json`, and the new spec, script, test and workflow files.
- [x] commit `feat(packaging): Windows Squirrel and zip packages, verify:win and its CI job`

### Batch B — Signed, staged auto-update

#### Task 3: The signed update manifest and `sign:update-manifest` (security review)
- **Spec:** `specs/update-manifest.spec.ts`, `specs/update-manifest.schema.ts` (Zod) and
  `specs/update-manifest.feature.md`.
  - **Envelope:** `{ format: 1, keyId, payload, signature }`. `payload` is the base64 of the exact
    manifest JSON bytes, and `signature` is the base64 Ed25519 signature over
    `UPDATE_SIGNATURE_CONTEXT` (`frost-update-manifest-v1` + NUL) followed by those bytes (no
    canonicalization). No object in the envelope or the manifest may repeat a key.
  - **Manifest:**
    - `{ version, releasedAt, expiresAt, notes }`; `expiresAt` (required) is after `releasedAt`
      and at most `MAX_MANIFEST_LIFETIME_MS` (90 days) after it; notes are plain text (no
      controls, bidi controls, line/paragraph separators or lone surrogates);
    - `minimumVersion`: an install older than this has a required update, which still waits for
      consent, but staging doesn't hold it back;
    - `rolloutPercent` (0–100);
    - `artifacts`: one per `platform-arch`, each `{ url (https), sha256 (hex), size }`.
  - **Constants:** the embedded public key (SPKI DER, base64) and its `keyId`, the size caps
    (manifest 64 KiB, notes 8 KiB, artifact 1 GiB), the signature context, the lifetime and clock
    skew (`MAX_CLOCK_SKEW_MS`, 1 day), and `artifactFileName(version, platformKey)` (the client's
    fixed download file name). The spec also records the high-water mark Task 4 keeps.
- **Code:** `apps/desktop/src/main/update/manifest.ts`, with these functions:
  - `verifyEnvelope(bytes, { now, keys })`, using `node:crypto` `verify(null, …)` with Ed25519 keys
    only; a manifest past `expiresAt` is `expired`, one released more than the skew ahead of `now`
    is `not-yet-valid`;
  - `parseManifest`;
  - `compareVersions` (semver core plus pre-release);
  - `rolloutBucket(installId, version)`: the first 32 bits of SHA-256(`installId:version`) mod 100;
  - `decide(manifest, { currentVersion, platformKey, installId, skippedVersion })`, which returns
    `up-to-date`, `prerelease-ignored` (a pre-release, for a release build), `no-artifact`,
    `required`, `skipped`, `staged-out` or `available`.
- **Script:** `scripts/sign-update-manifest.mjs` (root `pnpm sign:update-manifest <manifest.json>
  [--out envelope.json]`).
  - It reads the PEM path from `FROST_UPDATE_SIGNING_KEY` and refuses a key file readable by group
    or others.
  - It validates the manifest against the schema before signing, then verifies its own output with
    the public key.
- **Failing tests:** `apps/desktop/src/main/update/__tests__/manifest.test.ts` (test keys generated
  per run), with these cases:
  - `accepts-signed-manifest`;
  - `rejects-bad-signature` (flipped payload byte, flipped signature byte, other key, unknown keyId,
    non-Ed25519 key);
  - `rejects-malformed`;
  - `rejects-downgrade`;
  - `rollout-is-deterministic` (stable per install, spread across buckets, 0 % and 100 % edges);
  - `minimum-version-required`.

  Plus `scripts/__tests__/sign-update-manifest.test.ts`, which signs, verifies and refuses a
  world-readable key.
- [x] commit `feat(update): Ed25519-signed update manifest and sign:update-manifest`

#### Task 4: The update client: check, download, verify (security review)
- **Spec:** `specs/update-client.spec.ts` (states, settings, feed rules, caps) and
  `specs/update-client.feature.md`.
- **Code:** `apps/desktop/src/main/update/`:
  - **`prefs.ts`:** `userData/frost-update.json`, file mode 0600, Zod-checked on read. It holds:
    - `installId`, a random UUID created on first read;
    - `checks`, `on` or `off`;
    - `skippedVersion`.
  - **`feed.ts`:** the feed URL comes from `FROST_UPDATE_FEED_URL` or the unpackaged-only
    `--frost-update-feed` switch. With neither set, there is no feed and updates are off, which is
    the default in dev, tests and today's builds (there's no hosting yet).
  - **`client.ts`:** the state machine, with these states:
    - `disabled`, `idle`, `checking`, `up-to-date`, `available`, `downloading`, `ready`, `error`;
    - for `ready`, the reasons `manual-install` (unsigned build) or `restart-to-install` (only
      where Electron's `autoUpdater` can apply it: a signed macOS or Squirrel.Windows build; not
      reachable today).

    It checks at startup plus 30 s, then every 6 h, only when checks are on.
  - **`download.ts`:** streams the artifact to `userData/updates/<version>/` and hashes it on the
    way. It enforces the size cap and the `https:`-only redirect cap, and discards the file on any
    mismatch.
- **Failing tests:** `update/__tests__/client.test.ts` and `download.test.ts`, run against a local
  HTTP fake feed:
  - `no-feed-no-requests`;
  - `checks-off-no-requests`;
  - `available-after-verified-check`;
  - `rejects-hash-mismatch`;
  - `download-is-bounded`;
  - `feed-request-carries-nothing`;
  - `staged-out-stays-quiet`;
  - `skip-version`.
- [x] commit `feat(update): update client with verified download and staged rollout`

#### Task 5: Update setting, notification and IPC
- **Spec:** `update-client.feature.md`, sections Router and Chrome.
- **IPC:** `packages/ipc-contract/src/update-router.ts` (with its `UpdateService` interface). Its
  procedures, each `enforceSender`-first and Zod-validated:
  - `update.watch` (a long-poll);
  - `update.check`, `update.download`, `update.install`, `update.skip`;
  - `update.setChecks`.

  `install` on an unsigned build reveals the verified file with `shell.showItemInFolder`, which is
  never `openExternal`. Registered with one line each in `router.ts` and `services.ts`.
- **Main:** `apps/desktop/src/main/update/service.ts`, plus one line in `index.ts`. An e2e-only
  switch `frost-update-public-key` swaps in a test public key in unpackaged builds only; it's
  appended to `PACKAGED_FORBIDDEN_SWITCHES`, so `verify:mac` and the Linux and Windows verifiers
  check that the packaged app refuses it.
- **Chrome:**
  - `renderer/update-view.ts` (pure view model) and `components/UpdateBar.tsx` (the notice row: "frost
    X.Y.Z is available", Release notes, Download, Skip this version, Later; then "Downloaded and
    verified. Install it by hand: Show file" on unsigned builds).
  - Command-palette entries: Check for Updates, Turn automatic update checks on/off.
- **Failing tests:**
  - `update-router.test.ts` (`every-update-procedure-enforces-sender`);
  - `renderer/__tests__/update-view.test.ts`;
  - `e2e/update.e2e.ts`: a fake signed feed, then available, download, verified, show file;
    `no-silent-install`; a tampered artifact shows the error.
- [x] commit `feat(update): update notice, setting and IPC with a fake-feed e2e`

### Batch C — libSQL sync groundwork (depends on Phase 6's schema)

#### Task 6: Driver seam: Drizzle over `node:sqlite` or `@libsql/client`
- **Spec:** `specs/sync.spec.ts` (driver ids, sync config rules, which database may sync) and
  `specs/sync-driver.feature.md`.
- **Code:**
  - `packages/db/src/driver-types.ts`: `SqlDriver`, with async `execute(sql, params, method)`,
    `batch(queries)` in one transaction, `exec(sql)` and `close()`.
  - `driver-node-sqlite.ts`, wrapping today's `DatabaseSync` path.
  - `driver-libsql.ts`: `@libsql/client` `createClient({ url: 'file:…', syncUrl?, authToken?,
    syncInterval? })`, loaded with `await import()` only when used.
  - `driver-migrations.ts`: the same `MIGRATIONS` list applied over any driver.
  - `driver-drizzle.ts`: a Drizzle `sqlite-proxy` database over any driver.

  `node:sqlite` stays the default, and `openSessionStore` is unchanged.
- **Failing tests:** `packages/db/src/__tests__/driver.test.ts`. The repository suites (session,
  history, settings) run over both drivers, then migrations over both, then a batch rollback over
  both.
- [x] commit `feat(db): driver seam with a libSQL driver behind the repository API`

#### Task 7: libSQL's native module in the packaged app
- **Spec:** `linux-package.spec.ts` / `windows-package.spec.ts` / `sync.spec.ts`,
  `PACKAGED_UNPACKED_ALLOWLIST`: exactly the libSQL `.node` prebuild for the target.
- **Code:** in the Forge config and `vite.main.config.ts`:
  - `libsql` and `@libsql/client` stay external;
  - a `packageAfterCopy` hook copies them and their production dependencies into the app;
  - `asar.unpack` takes only `**/*.node`.

  ASAR integrity covers `app.asar`; unpacked `.node` files are outside it, a known Electron limit
  recorded in the spec. `OnlyLoadAppFromAsar` stays on.
- **Verify:** `verify:linux` and `verify:win` gain `unpacked-allowlist`. `verify:mac` must still
  pass, since `codesign --deep` seals the unpacked prebuild.
- [x] commit `feat(packaging): ship libSQL's native module unpacked, allowlisted`

#### Task 8: Opt-in sync config and the row-mirror sync engine
- **Spec:**
  - `sync.spec.ts`: `SYNC_TABLES`, each table's merge rule, and the config rules;
  - `sync-config.feature.md`;
  - `sync-engine.feature.md`.
- **Code:** `apps/desktop/src/main/sync/`:
  - `config.ts`: `userData/frost-sync.json`, holding `enabled`, `url` (`libsql:`/`https:`) and the
    token, encrypted with `safeStorage`. Sync refuses to enable when `safeStorage` is unavailable.
  - `engine.ts`: mirrors only the `SYNC_TABLES` rows between the session database and a separate
    libSQL embedded replica, `userData/frost-sync.db`. The merge rules (see the design note):
    - append-only rows are inserted by `id` if missing;
    - mutable rows are merged last-writer-wins on `updated_at`;
    - tombstones are replayed as deletes.

    A table that doesn't exist yet (Phase 6 not merged) is skipped and reported.
  - `service.ts`: runs `replica.sync()` on demand and on an interval, and reports status.

  `packages/ipc-contract/src/sync-router.ts` is registered only if the service is exposed in the
  chrome.
- **Tests:**
  - a mocked sync layer: a fake replica client, plus libSQL `file:` databases standing in for the
    replica;
  - engine tests over fixture tables with Phase 6's conventions (UUIDv7 `id`, `created_at`,
    `updated_at`/`deleted_at`, `ci_tombstones`);
  - an optional `sqld` integration test that runs only when `SQLD_BIN` is set.
- **Dependency:** the `ci_*` tables come from Phase 6. If Phase 6 hasn't merged when Tasks 1–5 are
  done, this PR ships Tasks 6 and 7 and the parts of Task 8 that don't need those tables (config,
  token storage, and the engine against fixtures). Turning on sync of the real Phase 6 tables, and
  any UI for it, is then listed as not done.
- [ ] commit `feat(sync): opt-in libSQL sync config and row-mirror engine`

---

## Sync design note
Phase 6's schema (`docs/plans/phase-6-change-intelligence.md`, Schema) puts the change-intelligence
tables in the browser-session database (`frost-browser.db`, migrations `0040`/`0041`). That shapes
sync.
- **No whole-file replica of the session database.** A libSQL embedded replica syncs a whole
  database file. Replicating `frost-browser.db` would also upload browsing history, permission
  decisions, render-profile pins and content notes, which must stay local. So sync mirrors rows.
  - Only the tables in `SYNC_TABLES` are copied: the `ci_*` tables, which are `ci_projects`,
    `ci_project_pages`, `ci_project_queries`, `ci_versions`, `ci_captures`, `ci_diffs`,
    `ci_screenshots`, `ci_purges` and `ci_tombstones`.
  - They are copied between the session database and a dedicated replica file, `frost-sync.db`. That
    file is the libSQL embedded replica, opened through `driver-libsql`, and the only file that
    talks to the sync endpoint.
- **Merge rules, from Phase 6's conventions.**
  - Every row has a UUIDv7 `id` and `created_at`, so rows from two devices never collide.
  - **Captured tables** are append-only (`ci_versions`, `ci_captures`, `ci_diffs`, `ci_screenshots`):
    rows are inserted if missing and never updated. A row that has a `ci_tombstones` entry is never
    re-inserted, matching Phase 6's `no_resurrect` trigger.
  - **Mutable tables** (`ci_projects`, `ci_project_pages`, `ci_project_queries`) merge
    last-writer-wins on `updated_at`. A tie goes to the larger `id`. Deletion is a `deleted_at`
    tombstone, never a `DELETE`.
  - **Purges** (`ci_purges` with `ci_tombstones`) travel as rows. On arrival they are applied
    through Phase 6's own purge path (tombstones first, then children-first deletes), so the
    append-only triggers still hold.
- **One direction at a time, in one transaction.**
  - Push copies the new local rows into the replica, then `sync()`.
  - Pull runs `sync()`, then copies the new replica rows into the session database in one
    `BEGIN IMMEDIATE` batch.
  - A high-water mark per table (`created_at`/`updated_at`, then `id`) keeps each pass incremental.
- **Offline.** The replica's own writes go to the primary, so while offline the engine leaves rows
  in the session database and pushes them on the next successful pass. libSQL's offline-write mode
  isn't relied on.
- **Screenshots.** Only the `ci_screenshots` rows sync. The PNG files
  (`frost-captures/screenshots/<sha256>.png`) are content-addressed blobs that need an object store
  of their own, which is not designed yet.
- **Tokens.** The endpoint and token come from the user. The token is kept only as `safeStorage`
  ciphertext and is never sent to the chrome.

## As built
(filled in as tasks land)

### Task 1 (Linux packages)
- **Makers.** `@electron-forge/maker-deb` 8.0.1 and `@reforged/maker-appimage` 6.0.0 (it builds
  the image with the system `mksquashfs`, so CI installs `squashfs-tools`; no native build, so
  `pnpm-workspace.yaml` is unchanged). The AppImage maker downloads its runtime from a moving
  `continuous` tag and does not check it; `linux-package.spec.ts` pins it to the `20251108`
  release (SHA-256 recorded; the release's own signature was checked when pinning), and
  `appimage-contents` checks the AppImage starts with exactly those bytes before running it.
  `@electron/asar` 4.x became a direct devDependency (the verifier lists `app.asar` with it).
- **Check names.** The plan's `appimage-runs` is `appimage-contents`: the AppImage is extracted
  and checked, not launched (FUSE is not needed). Only the packaged tree `out/frost-linux-x64` is
  launched; the deb and AppImage trees are extracted unprivileged (the deb's setuid
  `chrome-sandbox` is not root-owned there) and get the static fuse and resource checks.
- **ASAR integrity gap.** Electron enforces ASAR integrity only on macOS and Windows; Packager
  embeds no integrity data for Linux. `asar-integrity` asserts the fuse is on, prints an `INFO`
  line stating the gap and asserts `OnlyLoadAppFromAsar`.
- **Verified locally** (Arch Linux, Wayland, no Xvfb; `dpkg-deb` 1.23 and `mksquashfs` 4.7 used
  from their distro packages, unpacked into a temporary directory): `make:linux` produced all
  three artifacts, and `verify:linux` passed every check: `fuses-read-back`, `asar-integrity`,
  `no-stray-files`, `launches-and-stays-alive`, `refuses-remote-debugging`, `deb-metadata`,
  `appimage-contents`. **Left to CI:** the same run on Ubuntu 24.04 (its `dpkg-deb`, Xvfb, the
  AppArmor user-namespace sysctl). Installing the deb with `apt`/`dpkg -i` is not exercised.
- **Known limits.** The deb's `/usr/share/doc/frost/copyright` is Electron's `LICENSE` from the
  packaged tree (electron-installer-debian copies it; it has no license option); frost's own
  license is `package.json#license`. The AppImage (and the unzipped zip) does not start on stock
  Ubuntu 23.10+/24.04: AppArmor restricts unprivileged user namespaces and `chrome-sandbox` cannot
  be setuid inside the `nosuid` mount; the deb is fine. CI sets the sysctl, so its pass does not
  show otherwise (README, `linux-package.feature.md`).
- **Review fixes.** The Linux makers moved to `apps/desktop/linux-makers.ts` (`forge.config.ts`
  only spreads them in); an arch without a pinned AppImage runtime throws
  (`appimage-runtime-fails-closed`). `deb-metadata` allows only the exact `LINUX_DEB_INSTALL_PATHS`;
  `zip-contents` checks the unzipped tree; every external command in the verifier is killed after
  5 minutes. Re-verified locally: all eight checks pass.

### Task 2 (Windows packages)
- **Makers.** `@electron-forge/maker-squirrel` 8.0.1 with `electron-winstaller` 5.4.4 as a direct
  devDependency (the maker lists it only as an optional dependency, and the maker refuses to run
  without it; a direct dependency keeps it locked and installed). Its install script only copies the bundled 7-Zip for the host arch, so it is allowed in
  `pnpm-workspace.yaml` (`allowBuilds`, with a comment). The Windows makers live in
  `apps/desktop/windows-makers.ts`: Squirrel (`WIN_SQUIRREL_OPTIONS`: `name` `frost`, since the
  maker's default would be `@app/desktop`; `authors`, which NuGet requires; `noMsi`, `noDelta`;
  setup file `frost-<version>-x64-setup.exe`; an arch outside `WIN_ARCHS` throws) and a zip maker
  of its own for `win32`. `forge.config.ts` only spreads them in; the darwin/linux zip maker is
  unchanged. `resedit` 2.x became a direct devDependency (the verifier reads PE resources with it).
- **Facts checked against the packaged output** (`electron-forge package --platform win32 --arch
  x64` on Linux; Packager writes the PE resources with resedit, no Wine): `frost.exe` carries one
  `INTEGRITY`/`ELECTRONASAR` resource, `[{"file":"resources\\app.asar","alg":"SHA256","value":…}]`,
  whose value is the SHA-256 of `getRawHeader().headerString`; the exe and the vendored Squirrel
  `Setup.exe` / `Squirrel.exe` have no certificate table. Forge's zip on Windows holds the tree's
  contents without a top folder (cross-zip uses .NET's `CreateFromDirectory`), unlike macOS/Linux.
- **Verify.** `verify:win` runs every planned check plus `zip-contents`; `squirrel-artifacts` also
  checks the `RELEASES` SHA-1 and size and runs the tree checks on the `.nupkg`'s `lib/net45`.
  `--static` runs `fuses-read-back`, `asar-integrity`, `no-stray-files` and
  `unsigned-as-documented` (`frost.exe` only) off Windows. `verify-package-common.mjs` now removes
  temporary trees with retries (Windows file locks right after an app exits).
- **Verified locally** (Linux, `--static` against the win32 package): the four static checks pass;
  a copy with one header letter changed fails `asar-integrity`, and a copy with a forged
  certificate-table entry fails `unsigned-as-documented`. **Left to Windows CI:** `make:win`
  (NuGet, Squirrel, 7-Zip), `asar-tamper-refused` (that Electron really refuses the tampered copy
  and exits rather than waiting on a crash dialog), `launches-and-stays-alive`,
  `refuses-remote-debugging` (stderr from a GUI-subsystem exe), `squirrel-artifacts` (the
  `RELEASES` format), `zip-contents`, `unsigned-as-documented` on `Setup.exe`, and the whole
  `turbo run lint test` suite on Windows.
- **e2e on Windows: not reliable yet, so it doesn't gate.** The first full run (`windows-2025`,
  commit `a8cfcab`) passed 183 of 187 in 8.3 min. The 4 failures are Windows-specific harness or
  test issues, not app behaviour:
  - `page-dialogs-are-disabled-e2e` and `emulation-is-invisible-to-page`: `EBUSY` removing the temp
    profile, because Chromium still holds `declarative_performance_observer.db` when the test deletes
    it;
  - `close-app-kills-wedged-app`: the harness's process-tree kill doesn't take a wedged app down on
    Windows;
  - `delete-all-notes-and-clear-browsing-data`: the stubbed message box is never reached through the
    menu on Windows.

  These belong to the shared e2e harness (`e2e/harness.ts`) and other phases' tests. So the step
  stays non-gating (`continue-on-error`) and runs only on pushes to `main` and manual dispatch. That
  saves about 8 minutes per pull-request run; pull requests rely on the Linux (`ci`) and macOS e2e.
  It can gate once those four are made Windows-portable.
- **Line endings.** The job runs `git config --global core.autocrlf false` before checkout:
  `ci-workflows.test.ts`, `platform-workflows.test.ts` and other tests read repo files and match
  on `\n`. No `.gitattributes` was added.
- **Review fixes.** Squirrel's events are handled: Electron's exe is Squirrel-aware
  (`SquirrelAwareVersion` 1), so `apps/desktop/src/main/update/squirrel-events.ts` runs in main
  right after the remote-debugging refusal and before `start()` (no single-instance lock, database
  or window). Packaged on Windows only, and only for an exact `argv[1]`: install/updated run
  `..\Update.exe --createShortcut frost.exe`, uninstall `--removeShortcut` (no shell, detached, no
  stdio), then exit 0 when it exits or after 5 s; obsolete exits 0 at once; firstrun starts
  normally; a missing `Update.exe` or a spawn failure exits 0 quietly (`squirrel-events.test.ts`).
  `verify:win` gains `squirrel-obsolete-exits` (`launch` can now put the profile argument last).
  `frost.exe`'s version resource carries `WIN_VERSION_STRINGS` (`windowsPackagerConfig`, one
  spread line in `packagerConfig`; `appCopyright` is also the macOS bundle's copyright string).
- **Known limits.** Installing and uninstalling (and so the shortcuts) are not exercised by any
  check (`windows-package.feature.md`).

### Task 3 (signed update manifest)
- **Trust root.** `UPDATE_PUBLIC_KEYS` holds one Ed25519 SPKI key, `frost-update-2026-10`; its
  private half is in the maintainer's private key store (`frost-private/keys/`) only. No test or CI
  job signs with it (tests generate Ed25519 keys per run and inject them as the trusted keys). It
  was checked once by hand: a throwaway manifest outside the repo signed with
  `pnpm sign:update-manifest` verified against the embedded key, and the same envelope with one
  payload byte flipped was `bad-signature`; the files were deleted.
- **Security review fixes** (`fix(update): harden the manifest format and signer after security
  review`):
  - repeated keys in any object of the envelope or the manifest are refused (`duplicate-key`;
    `hasDuplicateKeys`, a small scanner over text `JSON.parse` accepted, comparing decoded keys),
    in `verifyEnvelope` and in the signer;
  - a required, signed `expiresAt` with `MAX_MANIFEST_LIFETIME_MS` and `MAX_CLOCK_SKEW_MS`
    (`expired`, `not-yet-valid`; `checkFreshness` for re-checking later), and the spec's
    `UpdateHighWaterMark` note for Task 4;
  - the signature covers `UPDATE_SIGNATURE_CONTEXT` + the payload (so the envelope from the first
    manual check no longer verifies);
  - `decide` gives `prerelease-ignored` for a pre-release offered to a release build (before
    `required`), and `staged-out` no longer reports the bucket;
  - notes refuse C1 controls, bidi controls, U+2028/U+2029 and lone surrogates;
  - `artifactFileName` and `UPDATE_ARTIFACT_KINDS[platform].extension`;
  - the signer prints a summary (version, minimum version, rollout, release and expiry times, each
    artifact, the manifest's SHA-256) before writing; writes through a temporary file and a hard
    link (or a rename with `--force`), keeping an existing output unless `--force`; refuses an
    output that is the key or the manifest by device and inode; opens files with `O_NONBLOCK` and
    requires the key file to be owned by the current user (POSIX), warning on Windows that ACLs
    aren't checked;
  - `.gitignore` ignores `*.pem` and `*.signed.json`.
- **Caps.** The 64 KiB cap (`MAX_MANIFEST_BYTES`) is on the manifest, the signed bytes. The
  envelope cap `MAX_ENVELOPE_BYTES` (88,408 bytes) is its base64 length plus 1 KiB; it is what
  `verifyEnvelope` checks before parsing, and what Task 4's feed read should cap at.
- **API.** `verifyEnvelope(bytes, { now, keys? })` answers `{ ok, manifest, keyId }` or one of
  `UPDATE_VERIFY_REASONS`. `parseManifest(value)` (the schema plus `minimumVersion` not above
  `version`) is shared with the signer. `decide(manifest, { currentVersion, platformKey,
  installId, skippedVersion? })` replaces the plan's `{ current, platform, arch }`
  (`updatePlatformKey(platform, arch)` in the spec maps to `platformKey`, `null` off
  `UPDATE_PLATFORMS`); its kinds are `up-to-date`, `prerelease-ignored`, `no-artifact` (the plan's
  `none`), `required`, `skipped`, `staged-out`, `available`, in that order, so skip is decided here and Task 4 only
  passes `skippedVersion`. `compareVersions` throws on a non-version (so does `decide`, for a bad
  `currentVersion`).
- **Stricter than the plan.** Base64 is canonical (the standard alphabet, padded, no whitespace,
  zero unused bits) in the schema and again in `manifest.ts`; release notes refuse C0 control
  characters other than tab, CR and LF; artifact URLs are printable ASCII; `releasedAt` is UTC
  (`Z`); a Zod record's silent drop of a `__proto__` key is refused by checking the input's keys.
- **Script.** At the root, as planned: `scripts/sign-update-manifest.mjs` loads the specs and
  `manifest.ts` with Node's type stripping (`zod` resolves from the hoisted root `node_modules`) and
  registers a resolve hook that adds `.ts` to their extensionless relative imports. It signs the
  file's exact bytes and verifies the result with `verifyEnvelope` before writing (default
  `x.json` → `x.signed.json`); relative paths are taken from `INIT_CWD`. Key files are checked on
  the opened descriptor (regular file, no group/other bits on POSIX, at most 16 KiB); the key must
  be Ed25519 and its public half one of `UPDATE_PUBLIC_KEYS`. Errors never quote the key or
  Node's crypto messages. No example manifest was added.
- **Tests.** The plan's `scripts/__tests__/sign-update-manifest.test.ts` is
  `apps/desktop/src/main/update/__tests__/sign-update-manifest.test.ts` (no vitest runs at the
  root). It calls the script's `main` in-process (trusted keys injected) and also spawns it under
  plain Node (`runs-under-node`). Added scenarios: `decide-eligibility`, `compare-versions`,
  `production-key-is-ed25519`, `refuses-unusable-key`, `runs-under-node`, and after the review
  `domain-separated-signature`, `rejects-duplicate-keys`, `notes-are-plain-text`,
  `rejects-stale`, `prerelease-only-for-prerelease`, `artifact-file-name`, `output-is-safe` (and
  `warns-acls-unchecked-on-windows`, Windows only).

### Task 4 (update client)
- **Files.** Spec `specs/update-client.spec.ts` (Zod-free), `specs/update-client.schema.ts` (the
  prefs file) and `specs/update-client.feature.md`. Code in `apps/desktop/src/main/update/`:
  `feed.ts` (`resolveFeed`, `resolveTrustedKeys`), `prefs.ts` (`createPrefsStore`), `fetch.ts`
  (`updateGet`/`getBytes`, `netTransport`, `netResolve`, `hardenUpdateSession`), `download.ts`
  (`downloadArtifact`, `pruneDownloads`), `client.ts` (`createUpdateClient`). No Electron import:
  `fetch.ts` references the global `Electron` types only. Not wired into `index.ts` (Task 5).
- **State names differ from the plan.** `ready` carries `install: 'manual' | 'restart'` (the plan's
  `manual-install` / `restart-to-install`) and `fileName` (no path; `readyFile()` gives the path,
  main-only). Added states: `off` (checks turned off). Added error reason `internal` (any
  unexpected throw, e.g. a non-semver running version), beside the planned closed list.
  `CURRENT_INSTALL_MODE` is `manual`: no Developer ID, and the feed publishes `Setup.exe`, not a
  Squirrel `RELEASES` feed, so `restart` is unreachable today.
- **Consent.** `checks: 'off'` stops automatic checks only; "Check now" still checks once (a user
  action). `download()` acts only from `available`; after a failed download the user re-checks.
- **High-water mark.** Raised after every verified manifest except one `decide` calls
  `prerelease-ignored` (security re-review: a verified `2.0.0-beta.1` must not make a release build
  refuse a later `1.5.0` hotfix; `prerelease-does-not-raise-mark`). Consequence, documented in the
  spec: a pulled release can't be rolled back to an older version; the fix is a higher version.
- **Requests.** Every hop of the feed and the artifact (redirects included) is checked before it
  is requested: `https:` only (unpackaged: `http:` to `127.0.0.1`/`[::1]`, never after `https:`), no
  credentials, `private-address.spec.ts` on the literal or on every resolved address (a resolver
  answering `null` is unchecked: the e2e seam). Redirects at most 5; envelope at most
  `MAX_ENVELOPE_BYTES`; the artifact exactly its signed `size` (`Content-Length` above it is refused
  before the body). Timeouts per `UPDATE_FETCH_LIMITS`. A request sends `Host` and
  `User-Agent: frost/<version> (update check)` only, plus the transport's own `Connection` (Node:
  `close`; Chromium may add `Accept-Encoding`); `netTransport` uses `credentials: 'omit'`,
  `useSessionCookies: false`, `redirect: 'manual'`, `cache: 'no-store'`, `referrerPolicy:
  'no-referrer'`, and `hardenUpdateSession` makes the session send only `User-Agent` and cancel
  anything but `GET` to `https:` (or unpackaged loopback `http:`). The bounded fetcher's `netHop` was not
  reused, so a change for the SEO fetcher can't change what update requests carry.
- **Tests.** `feed`, `prefs`, `fetch`, `download` and `client` tests (red first: the modules did not
  exist; then green, 27 new tests) against `__tests__/fake-feed.ts`: Node `http` on `127.0.0.1`,
  Ed25519 keys per run; its `nodeTransport` sends an `https:` URL whose host it maps to the local
  port as plain HTTP, so the `https:`-only rules are exercised without TLS. Mutating the mark
  guards, the downgrade rule, the resolved-address check, the hash compare or the redirect cap
  each fails a test. Added scenarios: `trusted-keys-switch`, `prefs-defaults`,
  `prefs-round-trip`, `hop-rules`, `download-verified`, `download-stays-in-updates`,
  `prune-downloads`, `check-schedule`, `check-errors`, `download-errors-shown`, `set-checks`,
  `watch-long-poll`, `errors-are-caught`, `prerelease-does-not-raise-mark`.
- **Security review fixes** (`fix(update): address update-client security review findings`):
  - prefs changes go through `UpdatePrefsStore.update(change)`, run against the latest prefs in
    the store's serial queue (a check raising the mark and `setChecks('off')` overlapping lost one
    of the two; `prefs-writes-not-lost`, `prefs-update-in-order`); `write` stays for setup;
  - `pruneDownloads` `lstat`s `updates/` and leaves a symbolic link (and its target) alone;
  - a resolver's `null` ("not checked") is honoured only unpackaged; packaged, the hop is
    `private-address`;
  - `watch` treats `NaN` and negative versions as 0 (answered at once);
  - `updateRequestHeaders(headers, userAgent, allowed = UPDATE_ALLOWED_REQUEST_HEADERS)` filters by
    the allowlist for real;
  - the prefs file is `lstat`ed and opened `O_NONBLOCK | O_NOFOLLOW` (a FIFO or symbolic link is
    reset, never read); the chmod after the rename is gone (the temporary file is created 0600);
    a reset logs one line through `createPrefsStore(userData, { log })` (no install ID, no path);
  - the disk write is raced against the stop signal (`totalMs` bounds a hung write);
  - freshness is checked again just before `ready` (`stale-before-ready`; the file is deleted);
  - new tests for `responseMs`/`totalMs` and for `dispose()` mid-download removing the `.partial`.
- **For Task 5.** Wire in `index.ts`: `const updateSession = session.fromPartition(UPDATE_PARTITION,
  { cache: false })`; `hardenUpdateSession(updateSession, updateUserAgent(app.getVersion()), {
  isPackaged })`; `createUpdateClient({ feed: resolveFeed({ env: process.env, switchValue:
  getSwitchValue(UPDATE_FEED_SWITCH), isPackaged }), keys: resolveTrustedKeys({ switchValue:
  getSwitchValue(UPDATE_PUBLIC_KEY_SWITCH), isPackaged }), currentVersion: app.getVersion(),
  platformKey: updatePlatformKey(process.platform, process.arch), userData, prefs:
  createPrefsStore(userData, { log }), hop: netTransport(net, updateSession), resolve:
  netResolve(updateSession), isPackaged })` (async; `dispose()` on quit). The artifact URL must be
  `https:` (Task 3's schema), so the e2e needs a TLS fake server reachable under a public-looking
  name (`--host-resolver-rules`, a resolver wrapper answering `null` for it, and a test-only
  certificate trust in unpackaged builds). `UPDATE_PUBLIC_KEY_SWITCH` (and probably
  `UPDATE_FEED_SWITCH`) go in `PACKAGED_FORBIDDEN_SWITCHES`. The e2e should assert the exact headers
  the fake feed sees from Chromium (unverified here, since nothing in Task 4 launches Electron).

### Task 5 (update notice, setting and IPC)
- **Files.** Spec: `update-client.feature.md` gains Prefs read errors, Download stops, Router, Main and
  Chrome (with e2e) sections; `update-client.spec.ts` gains `UPDATE_TEST_CERT_SWITCH` and the
  chrome's words (`UPDATE_BAR_KINDS`, `UPDATE_BAR_LABELS`, `UPDATE_ERROR_MESSAGES`,
  `UPDATE_PALETTE_LABELS`/`_MESSAGES`, the text builders); `specs/update-router.schema.ts` (Zod,
  main-only) holds the inputs. IPC: `packages/ipc-contract/src/update-router.ts` (`UpdateService`,
  `updateRouter`). Main: `apps/desktop/src/main/update/service.ts` (`startUpdateService`,
  `createUpdateService`, `pinnedCertificateVerifier`). Chrome: `renderer/update-view.ts`,
  `renderer/update-palette.ts`, `hooks/useUpdate.ts`, `components/UpdateBar.tsx`.
- **Startup and prefs.** `startUpdateService` is synchronous and never throws: the session is set
  up at once, the client is built in the background (`deferredUpdateService`: `disabled` at version 0
  until it is ready; a throw or rejection is one log line and updates stay off for the run), so
  startup never waits on or breaks over updates (`start-fails-safe`). Without a feed the client never
  reads or creates `frost-update.json`, so no install ID exists (`no-feed-no-prefs`); `setChecks`
  without a feed is a no-op. The e2e harness strips `FROST_UPDATE_FEED_URL` from the app's
  environment (`launchApp`, `launchUndrivenApp`). The packaged refusal of the update switches uses the
  shared `PACKAGED_DEBUG_REFUSAL` line (generic wording, left as is: the verifiers match it).
- **Hub lines.** `router.ts` (`update: updateRouter,` and its import), `services.ts`
  (`readonly update?: UpdateService;` and its import), `index.ts` of the IPC package (one type
  export), `App.tsx` (`<UpdateBar />` and its import), `e2e/harness.ts` (the env strip, twice, and its import), `styles.css` (one more `auto` grid row; the
  bar's styles appended), `PACKAGED_FORBIDDEN_SWITCHES` (+ `frost-update-feed`,
  `frost-update-public-key`, `frost-update-test-cert`), main `index.ts` (`shell` in the Electron
  import, the service import, `startUpdateService` (not awaited) + `will-quit` dispose before
  `attachIpcHandler`, `update: update.service`), `palette-all-features.test.ts` (the update sources), and one
  Electronegativity baseline entry (`CERTIFICATE_VERIFY_PROC_JS_CHECK`, the test pin).
- **Router.** Every procedure is `enforceSender` → `requireUpdate` → a strict input: `watch({
  sinceVersion })` (an integer from -1, long-polled with `WATCH_TIMEOUT_MS`), `setChecks({ checks })`,
  and `z.undefined()` for `check`, `download`, `skip`, `install` (any input is `BAD_REQUEST`). No notes
  procedure: the notes travel in the state. `download` answers once started (the client's promise is
  not awaited; the chrome follows `watch`).
- **Install.** `install()` reveals `readyFile()` with `shell.showItemInFolder` only on `ready` +
  `manual`, after `lstat` says it is a regular file and the state is still that file; answers whether
  it did. `restart` returns `false` with a `TODO(update-restart)`: nothing fakes `quitAndInstall`.
- **e2e seams.** The address check reuses `E2E_PUBLIC_HOSTS_SWITCH` (`withE2ePublicHosts` over
  `netResolve(updateSession)`; the client honours `null` only unpackaged). TLS: `UPDATE_TEST_CERT_SWITCH`
  pins one certificate by DER SHA-256 (`X509Certificate.fingerprint256`) through
  `setCertificateVerifyProc` on the update session only; every other certificate gets `-3`. All e2e
  switches are read only when unpackaged (`switchValue` answers `''` packaged), on top of the
  packaged refusal at startup, which `verify:mac`/`linux`/`win` now probe for the three new names.
- **Chrome.** The `update-slot` row (under the find bar) is always mounted, so `useUpdate` long-polls
  from start and the palette knows the state; it is 0 high at rest. Later and Dismiss hide the
  notice by key for this window (an offer or ready file per version; an error per state version, so
  the same error after a new check shows again). The notes are a text node in a `pre`. The palette's entries are **hidden** when
  no feed is configured (my call: no update UI at all without a feed, rather than a disabled entry);
  the toggle is two static actions (`update.checks-off` / `update.checks-on`), one offered at a time.
- **Task 4 re-review items.** `prefs.ts`: only `ENOENT` (first run) or invalid content resets and
  rewrites; any other read error (`EACCES`, `EMFILE`, `EIO`) answers in-memory defaults and puts the
  store in memory-only mode for the run, so neither the read nor a later `update()` writes over the
  file (`prefs-unreadable-kept`); a lax mode is fixed with `handle.chmod`. `download.ts`: a stopped
  (timeout/abort) download returns without awaiting `handle.close()` (which waits for a pending
  write), unlinking the partial at once or, if that fails (Windows), after the close
  (`hung-write-does-not-hold`; an `openFile` seam lets the test hang a write); `isFresh()` is asked
  after the hash verifies and before the rename and the prune (`stale`, `fresh-before-prune`); the
  client's own post-download freshness check moved into it.
- **Headers Chromium sends** (Electron 45, Linux; `feed-request-headers`, recorded each run): the
  manifest request is exactly `Host`, `Connection: keep-alive`, `User-Agent: frost/0.0.0 (update
  check)`, in that order: no `Accept-Encoding`, no `Accept-Language`, no cookie (cookies set for the
  feed URL in the update, browse and default sessions are not sent). The test asserts an allowlist
  (`host`, `user-agent`, `connection`, `accept-encoding`) rather than that exact list, so another
  platform's Chromium adding `Accept-Encoding` still passes; the artifact request meets the same
  allowlist.
- **Tests.** `update-router.test.ts` (4), `service.test.ts` (6), `update-view.test.ts` (7), new
  `prefs`/`download` scenarios (3, each red against the Task 4 code first), and `update.e2e.ts` (5):
  `update-available-download-verify-show`, `no-silent-install` (also toggles the setting through the
  palette and checks the prefs file), `tampered-artifact-shows-error`, `feed-request-headers`,
  `no-feed-no-update-ui` (every seam but the feed, then a plain default launch). Each e2e test
  launches on a fresh profile with checks off in its prefs, so no automatic check runs mid-test;
  checks are the palette's Check for Updates.
- **Known limits.** Not exercised: a packaged build with `FROST_UPDATE_FEED_URL` against a real
  `https:` host (none is hosted), and the real `shell.showItemInFolder` (stubbed in the e2e). The
  e2e ran locally on Linux only; macOS (and, non-gating, Windows) are left to CI.


### Task 6 (driver seam)
- **Versions.** `@libsql/client` 0.18.0 (pinned exactly, like `drizzle-orm`), which pulls
  `libsql` 0.5.29 (the Neon/N-API binding) with `@libsql/core` 0.18.0, `@libsql/hrana-client`
  0.10.0, `@libsql/isomorphic-ws` 0.1.5 → `ws`, `js-base64`, `promise-limit`, `@neon-rs/load`
  0.0.4 and `detect-libc` 2.0.2. The native code is in per-target optional packages, version
  0.5.29: `@libsql/linux-x64-gnu`, `-linux-x64-musl`, `-linux-arm64-gnu`, `-linux-arm64-musl`,
  `-linux-arm-gnueabihf`, `-linux-arm-musleabihf`, `@libsql/darwin-arm64`, `@libsql/darwin-x64`,
  `@libsql/win32-x64-msvc` (no Windows arm64). Each holds one `index.node` (linux-x64-gnu:
  9.7 MB). pnpm installs only the host's. **No install script**: `libsql`'s scripts are
  build/publish only (`prepack`, `build`, …), so `allowBuilds` is unchanged.
- **How the prebuild loads.** `libsql/index.js` asks `@neon-rs/load`'s `currentTarget()` for
  `<platform>-<arch>-<abi>` (glibc/musl via `detect-libc` on Linux), then
  `require('@libsql/<target>')` → its `index.node`, by ordinary Node resolution from `libsql`'s
  directory. N-API, so the same file runs under Node and Electron's main (no rebuild).
  `LIBSQL_JS_DEV` set in the environment makes it load `libsql/index.node` instead (Task 7).
- **Entry point.** The driver imports `@libsql/client/sqlite3` (0.18's local client; it passes
  `syncUrl`/`authToken`/`syncInterval` to the native `libsql` `Database`, which syncs the embedded
  replica itself), so at runtime only `libsql`, `@libsql/core` (+ `js-base64`), `@neon-rs/load`,
  `detect-libc` and the platform prebuild are needed; `@libsql/hrana-client`,
  `@libsql/isomorphic-ws`, `ws` and `promise-limit` are installed but never loaded.
- **SQLite version.** libSQL 0.5.29 bundles SQLite 3.45.1 (2024-01-30), compiled with
  `SQLITE_DEFAULT_RECURSIVE_TRIGGERS`; its connections nevertheless read `PRAGMA
  recursive_triggers` as 0, like `node:sqlite`'s (`drivers-are-named` asserts both, so a libSQL
  upgrade that changes either shows). `node:sqlite` in Node 26 and Electron 45 is SQLite 3.53.4.
  Migrations meant to run over both drivers, and Task 8's mirrored `ci_*` SQL, stay within 3.45
  features (`LIBSQL_SQLITE_VERSION` in `sync.spec.ts`).
- **Seam.** `SqlDriver` (`driver-types.ts`) has `execute`, `batch`, `exec`, `close`, `isOpen`,
  `kind`. `batch` items are statements or scripts (`{ script }`): `runMigrationsOver` runs each
  migration's SQL and its id row as one batch, so a migration is one transaction on both drivers
  (libSQL's pool rolls back anything left open whenever a connection is released, so separate
  `BEGIN`/`exec`/`COMMIT` calls cannot work there). `client.ts`'s `createDrizzle(db)` now delegates
  to `createDrizzleOver(createNodeSqliteDriver(db))`; every existing test passes unchanged. One
  intended difference: a failed batch rolls back only if a transaction is still open (before, an
  unconditional `ROLLBACK` after SQLite had already rolled back would throw "no transaction is
  active" and hide the real error). `@app/db`'s index exports none of the drivers;
  `pnpm --filter @app/desktop build` gives a `main.cjs` with no `libsql` string (`node:sqlite`
  still external).
- **intMode.** `'number'`. Integers are exact to 2^53 − 1; reading a larger one throws a
  `RangeError` on both drivers (`node:sqlite`'s `ERR_OUT_OF_RANGE` too), never rounds.
- **Differences between the drivers** (otherwise rows, values and `sqlite_master` are identical):
  - libSQL returns blobs as `ArrayBuffer`; the driver converts them to `Uint8Array`.
  - Errors: `node:sqlite` throws `ERR_SQLITE_ERROR` with a numeric `errcode` (`open.ts`'s
    move-aside rule reads it); libSQL throws `LibsqlError`/`LibsqlBatchError` with `code`
    (`SQLITE_CONSTRAINT`), `extendedCode` and `rawCode`. Nothing maps one to the other yet.
  - libSQL runs one connection (`concurrency: 1`). A batch holding a script uses an explicit write
    transaction, and a call that arrives while it is open is refused (`TRANSACTION_ACTIVE`), not
    queued. Statement-only batches run inside one `client.batch(…, 'write')` call. `node:sqlite`
    batches are synchronous.
  - libSQL creates its file with the umask's mode (0644 here); only `open.ts` narrows to 0600, and
    only for `node:sqlite`. Task 8 must narrow `frost-sync.db` and its sidecars itself.
  - The busy timeout (`DB_BUSY_TIMEOUT_MS`) applies to libSQL only without a `syncUrl` (libSQL
    ignores `timeout` for embedded replicas).
- **URL rules** (`libsqlConfigProblem`) are checked on the string, before libSQL loads, so libSQL's
  own parser can't read them differently: no query on either URL (`?authToken=`, `?tls=0` would
  turn `libsql:` into `http:`), loopback `http:` only as the literal written. A `syncUrl` is
  accepted only for a file named `frost-sync.db`, never `frost-browser.db`.
- **Windows paths.** libSQL's URL parser (`@libsql/core/uri.js`) hands everything after `file:`
  (or after `file://<empty host>`) to the native module, which opens it as a Rust `Path`: so
  `file:///C:/…` would name `/C:/…`. `libsqlFileUrl` emits `file:C:/…` on Windows (`file:///…` on
  POSIX), and `libsqlFilePath` accepts exactly those two forms and refuses `/C:/…`, drive-relative
  `C:x`, and any UNC / SMB path (a decoded `\` or leading `//`, however encoded). The round-trip
  is unit-tested with `path.win32` on every platform; that libSQL really opens `C:/…` is checked
  only when the suite runs on Windows CI.
- **Not done here.** No driver was opened with a `syncUrl` (that needs a server; Task 8's `sqld`
  test).
- **Review fixes.** Windows file URLs and UNC refusal (above); the `sqlite3` entry; the SQLite
  version note; `libsql-reads-numbers` binds a real `true`, reads a join's duplicate column names
  and expects a `RangeError` past 2^53 − 1; the feature file gained `drivers-are-named`; the
  handle-ownership comments in `client.ts` and `driver-node-sqlite.ts` now agree.

### Task 7 (libSQL in the packaged app)
- **Spec.** The new `specs/sync-package.spec.ts` (self-contained, so the verifiers can load it)
  holds the following:
  - `LIBSQL_RUNTIME_PACKAGES`: `@libsql/client`, `@libsql/core`, `js-base64`, `libsql`,
    `@neon-rs/load` and `detect-libc`, each resolved from the package that requires it;
  - `LIBSQL_UNLOADED_DEPENDENCIES`: `@libsql/hrana-client` and `promise-limit`, declared by
    `@libsql/client` but never loaded by its `sqlite3` entry;
  - `LIBSQL_PREBUILD_TARGETS`: `darwin-arm64`, `linux-x64-gnu` and `win32-x64-msvc`;
  - `LIBSQL_ASAR_UNPACK`, `PACKAGED_UNPACKED_ALLOWLIST` and `PACKAGED_ASAR_NODE_MODULES`.

  `LIBSQL_SQLITE_VERSION` moved there, and `sync.spec.ts` re-exports it, because `sync.spec.ts`
  imports another spec without an extension, which Node's type stripping can't load. The scenarios
  are in `sync-package.feature.md`. The platform specs' `PACKAGED_RESOURCES_ALLOWLIST` gained
  `app.asar.unpacked` and their `PACKAGED_ASAR_TOP_LEVEL` gained `node_modules`.
- **Vite.** Vite 8 (rolldown) keeps `await import()` of an external as a real `import()` in CJS
  output, which Electron would resolve through its ESM loader and the `import` condition
  (`lib-esm`). So `vite.main.config.ts` adds two things: `@libsql/client` and `libsql` (with their
  subpaths) as external regexes, and `output.dynamicImportInCjs: false`. The import then becomes
  `require`. Today's bundles contain no `import()` at all, so this changes nothing else. The
  driver is not reached from main yet (Task 8), so `main.cjs` still has no libSQL string.
- **Forge.** `apps/desktop/libsql-packaging.ts` provides the `packageAfterCopy` hook. Packager
  prunes through its copy filter, which runs before `afterCopy`, so the copied packages are not
  pruned. Forge's "Preparing native dependencies" (`@electron/rebuild`) leaves the prebuild alone.
  The hook:
  - resolves each package by walking `node_modules` up from its dependent (`@libsql/client` and
    `@libsql/core` don't export `./package.json`, so `require.resolve(<pkg>/package.json)` can't
    be used);
  - copies them flat into `<buildPath>/node_modules`, using `libsql`'s nested `detect-libc` 2.0.2,
    not the hoisted 2.1.2;
  - skips `*.md`, `*.d.ts` and `*.map`, but keeps license files;
  - fails the build when a package is missing, the prebuild is missing or isn't the version
    `libsql` pins, a dependency is undeclared or resolves elsewhere, a symlink or a stray `.node` is
    found, or the target isn't packaged.

  `forge.config.ts` gained one hook line and `asar: { unpack: LIBSQL_ASAR_UNPACK }`. The plan said
  `**/*.node`; the pattern now names only `node_modules/@libsql/*/index.node` (see Review fixes for
  its final form). `forge-config.test.ts`'s `identifies-the-mac-bundle`
  and its feature line now expect that object instead of `asar: true`.
- **Integrity.** `@electron/asar` records the unpacked file in the header with `unpacked`, `size`
  and a SHA-256 `integrity`, and the header hash is what Electron checks on macOS and Windows. A
  win32 package made on Linux passed `asar-integrity` with the unpacked entry in it. Electron never
  hashes an unpacked file when it loads it. On macOS, `codesign --deep` seals the file into the
  bundle; on Windows and Linux, `unpacked-allowlist` compares it with the header at build time only.
- **Smoke test.** This is a variant of option (a). `libsql-loads` runs the repository's `electron`
  (the version Forge packaged) with `ELECTRON_RUN_AS_NODE=1`, rather than plain `node` on an
  extracted tree:
  - it loads `@libsql/client/sqlite3` directly from the packaged `resources/app.asar`, resolved from
    `.vite/build/main.cjs`, with Electron's own asar support and the unpacked prebuild;
  - it opens a temporary `file:` database and reads `sqlite_version()` = `LIBSQL_SQLITE_VERSION`;
  - it asserts that every loaded module lies inside that `app.asar`.

  That last assertion matters: plain `node` from an extracted tree falls back to the repository's
  `node_modules` when a package is missing, as an experiment showed. The packaged binary keeps
  `RunAsNode` off, and no CLI switch or production code path was added. Main opening libSQL itself
  is first exercised by Task 8's e2e. The checks run on the packaged tree and on every extracted
  tree (deb, AppImage, zip, nupkg). `verify-mac-package.mjs` gained the same three checks, from the
  common module, on `Contents/Resources`.
- **Cross-target builds.** pnpm installs only the host's prebuild. On Linux,
  `electron-forge package --platform win32 --arch x64` now fails in the hook with
  `@libsql/win32-x64-msvc is not installed … package win32-x64 on a win32 x64 machine`.
  `--platform`-wide `supportedArchitectures` installs were judged not worth it. For the local
  `--static` cross-check, the win32 prebuild was downloaded from the registry, checked against the
  lockfile's SHA-512, placed in `node_modules/@libsql/win32-x64-msvc` by hand and removed afterwards
  (README, Building on Windows). Off Windows, `--static` runs `unpacked-allowlist` and
  `asar-node-modules-allowlist` and skips `libsql-loads` with an `INFO` line.
- **Notices.** `THIRD_PARTY_NOTICES` lists the six JavaScript packages. `libsql`'s entry covers the
  prebuild, which comes from the same project under the same license and ships no license file.
  The Rust crates and SQLite statically linked into the prebuild are not listed separately (a known
  limit).
- **Size.** Linux x64 grows by 0.25 MB of JavaScript in `app.asar` plus 9.72 MB for the unpacked
  `index.node`, about 4.1 MB gzip-compressed. The zip is 128.8 MB, the deb 97.1 MB and the AppImage
  131.0 MB.
- **Verified locally** (Arch Linux; `dpkg-deb` 1.23.11 and `mksquashfs` 4.7.5 came from their Arch
  packages, with signatures checked by `gpgv` and unpacked into a temporary directory, as in Task 1):
  - `make:linux` succeeded, and `verify:linux` passed all 13 checks;
  - the win32 package (as above) passed `verify-windows-package.mjs --static`, all 6 file checks;
  - negative trials failed as expected: an extra unpacked file, a flipped prebuild byte, a missing
    prebuild, an extra package or scope, a nested `node_modules`, a packed `.node`, and a lock file
    in `node_modules`;
  - `pnpm lint`, `pnpm test`, `security:electronegativity` and `security:semgrep:scan` passed.

  **Left to CI:** the following were not run locally:
  - `libsql-loads` on Windows and macOS, under the dev Electron;
  - `codesign --verify --deep --strict` with the unpacked `.node` in `Contents/Resources`
    (`signature-verifies`, `zip-app-verifies`, `dmg-app-verifies`);
  - the nupkg and Windows-zip trees;
  - the Ubuntu run.
- **Not yet proven (as of Task 7): the packaged binary itself loading the prebuild.**
  `libsql-loads` runs the repository's Electron, at the packaged version, as Node against the
  packaged `app.asar`. It does not run the packaged executable, whose `RunAsNode` fuse is off. In
  particular, macOS library validation under the hardened runtime (a Developer ID build) could
  refuse the prebuild. Task 8 adds that proof: a packaged-app check in all three verifiers that
  enables sync through the profile's sync config and confirms main opens the replica.
- **Review fixes.**
  - **Bytes on macOS.** `unpacked-allowlist` checks only the set of unpacked files there. A
    Developer ID `osxSign` run re-signs the `.node` after the asar header recorded its size and
    SHA-256, and the ad-hoc `--force --deep` re-seal may as well. The bundle seal
    (`signature-verifies`) vouches for the bytes instead. Linux and Windows still compare the
    bytes with the header.
  - **Electron version.** `libsql-loads` asserts that the probe's `process.versions.electron`
    equals the packaged app's. On Linux and Windows that comes from the packaged tree's `version`
    file; the nupkg has none, so every extracted tree is compared with the packaged tree's. On
    macOS it comes from the `Electron Framework.framework` Info.plist.
  - **Module paths.** The `app.asar` prefix is realpath'd before module paths are compared with
    it. A trial through a symlinked resources directory passed only with this.
  - **Unpack pattern.** `@electron/asar` matches `unpack` against absolute paths with minimatch
    10. Its only option is `matchBase` (no `dot`), so `**` never crosses a dot directory. The
    pattern is now `**/{.*/**/,}{.*/**/,}{.*/**/,}{.*/**/,}node_modules/@libsql/*/index.node`,
    which allows up to `LIBSQL_ASAR_UNPACK_DOT_DIRS` (4) dot directories anywhere in the build
    path. The test packs under `.cache/build/.tmp`, under 0 and 4 dot directories, and under 5,
    where nothing is unpacked. That case fails closed in `unpacked-allowlist`. With
    `platform: 'win32'`, a Windows path matched by hand too. Not rebuilt: unit tests, lint and a
    synthetic asar exercised the verifier changes.
