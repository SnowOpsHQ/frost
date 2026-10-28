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
- [ ] commit `feat(packaging): Windows Squirrel and zip packages, verify:win and its CI job`

### Batch B — Signed, staged auto-update

#### Task 3: The signed update manifest and `sign:update-manifest` (security review)
- **Spec:** `specs/update-manifest.spec.ts`, `specs/update-manifest.schema.ts` (Zod) and
  `specs/update-manifest.feature.md`.
  - **Envelope:** `{ format: 1, keyId, payload, signature }`. `payload` is the base64 of the exact
    manifest JSON bytes, and `signature` is the base64 Ed25519 signature over those bytes (no
    canonicalization).
  - **Manifest:**
    - `{ version, releasedAt, notes }`;
    - `minimumVersion`: an install older than this has a required update, which still waits for
      consent, but staging doesn't hold it back;
    - `rolloutPercent` (0–100);
    - `artifacts`: one per `platform-arch`, each `{ url (https), sha256 (hex), size }`.
  - **Constants:** the embedded public key (SPKI DER, base64) and its `keyId`, and the size caps
    (manifest 64 KiB, notes 8 KiB, artifact 1 GiB).
- **Code:** `apps/desktop/src/main/update/manifest.ts`, with these functions:
  - `verifyEnvelope(bytes, keys)`, using `node:crypto` `verify(null, …)` with Ed25519 keys only;
  - `parseManifest`;
  - `compareVersions` (semver core plus pre-release);
  - `rolloutBucket(installId, version)`: the first 32 bits of SHA-256(`installId:version`) mod 100;
  - `decide(manifest, { current, platform, arch, installId })`, which returns `none`,
    `up-to-date`, `staged-out`, `available` or `required`.
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
- [ ] commit `feat(update): Ed25519-signed update manifest and sign:update-manifest`

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
- [ ] commit `feat(update): update client with verified download and staged rollout`

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
- [ ] commit `feat(update): update notice, setting and IPC with a fake-feed e2e`

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
- [ ] commit `feat(db): driver seam with a libSQL driver behind the repository API`

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
- [ ] commit `feat(packaging): ship libSQL's native module unpacked, allowlisted`

#### Task 8: Opt-in sync config and the sync service
- **Spec:** `sync.spec.ts`, `sync-config.feature.md`.
- **Code:** `apps/desktop/src/main/sync/`:
  - `config.ts`: `userData/frost-sync.json`, holding `enabled`, `url` (`libsql:`/`https:`) and the
    token encrypted with `safeStorage`. Sync refuses to enable when `safeStorage` is unavailable.
  - `service.ts`: opens the change-intelligence database through `driver-libsql` as an embedded
    replica, calls `sync()` on demand and on an interval, and reports status.

  `packages/ipc-contract/src/sync-router.ts` is registered if the service is exposed.
- **Tests:** a mocked sync layer (a fake `@libsql/client`), plus an optional `sqld` integration
  test that runs only when `SQLD_BIN` is set.
- **Dependency:** the change-intelligence tables come from Phase 6. If Phase 6 hasn't merged when
  Tasks 1–5 are done, only Tasks 6 and 7, plus whatever of Task 8 doesn't need its tables, ship in
  this PR. Sync of the Phase 6 tables is then listed as not done, with the design note below.
- [ ] commit `feat(sync): opt-in libSQL sync config with tokens in safeStorage`

---

## Sync design note
- **One database per sync domain.** libSQL embedded replicas sync a whole database file, not chosen
  tables, so change intelligence (captures, versions, diffs) needs its own file, apart from the
  browser-session database. Browsing history, permission decisions and content notes never sync.
- **Append-only fits replication.** Phase 6's tables are append-only, with immutability enforced by
  triggers. Writes are inserts with globally unique IDs (UUID or ULID, not `INTEGER` autoincrement),
  so two devices never collide.
- **How writes flow.** An embedded replica reads locally and forwards writes to the primary.
  - Offline, captures queue in a local outbox table (same schema), and are replayed when the primary
    is reachable.
  - libSQL's own offline-write mode is not yet relied on.
- **Screenshots and other blobs.** They stay as local files. Only their hashes and metadata rows
  sync, until an object-store design exists.

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
