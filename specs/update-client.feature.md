# Feature: The update client (check, download, verify)

Spec: `specs/update-client.spec.ts` (values, types, states) and `specs/update-client.schema.ts`
(Zod, the prefs file). Builds on `specs/update-manifest.spec.ts` (Task 3: the signed envelope,
`verifyEnvelope`, `decide`, `checkFreshness`, `artifactFileName`, `UpdateHighWaterMark`).
Design doc §4 Phase 7 (auto-update, signed and staged). Phase 7 Task 4.
Code: `apps/desktop/src/main/update/` (`feed.ts`, `prefs.ts`, `fetch.ts`, `download.ts`,
`client.ts`; pure Node, no Electron import: main injects `net`, the update session and timers).
Tests: `apps/desktop/src/main/update/__tests__/{feed,prefs,fetch,download,client}.test.ts`, every
CI run, against a local fake feed (`__tests__/fake-feed.ts`: Node `http` on `127.0.0.1`, a random
port, envelopes signed with an Ed25519 key generated per run and injected as the trusted key).
Each scenario maps to one named test. Nothing here contacts a real host; only the e2e scenarios
(Chrome, below) launch Electron.

**Honest install.** No build today can be updated in place: frost has no Apple Developer ID, and
the feed publishes the Windows `Setup.exe`, not a Squirrel `RELEASES` feed. So every build is
`install: 'manual'`: the client downloads and verifies the file, and the user installs it by hand.

## Feed (`feed.test.ts`)
- **Scenario: feed-rules** — `resolveFeed({ env, switchValue, isPackaged })`, as a table:
  - nothing set, or empty strings: no feed (`null`);
  - `FROST_UPDATE_FEED_URL=https://updates.frost.example.com/feed.json`: that URL, packaged or not;
  - the switch `--frost-update-feed` is read only when unpackaged, and then wins over the env; a
    packaged build ignores it (the env still applies);
  - `http:` only to `127.0.0.1` or `[::1]` and only when unpackaged; `http://localhost`, another
    `http:` host, or any `http:` in a packaged build: no feed;
  - refused (no feed): another scheme (`file:`, `ftp:`, `data:`), a user name or password, no
    host, a space or a non-ASCII character, longer than `MAX_FEED_URL_CHARS`, unparsable.
- **Scenario: trusted-keys-switch** — `resolveTrustedKeys({ switchValue, isPackaged })`: packaged,
  or no switch: `UPDATE_PUBLIC_KEYS`. Unpackaged with `<keyId>:<spki-base64>`: exactly that one key
  (the production key is no longer trusted). A malformed value (no `:`, a bad `keyId`,
  non-canonical base64, longer than `MAX_SWITCH_KEY_CHARS`): no trusted key at all.

## Prefs (`prefs.test.ts`)
- **Scenario: prefs-defaults** — with no file, the first read creates `userData/frost-update.json`
  with `{ format: 1, installId: <random UUIDv4>, checks: 'on' }`, mode 0600 (POSIX); a second read
  gives the same install ID.
- **Scenario: prefs-round-trip** — a written `checks: 'off'`, `skippedVersion` and `highWaterMark`
  read back equal; the write goes through a temporary file renamed over the old one (no temporary
  file is left; a lax mode is fixed to 0600 on POSIX).
- **Scenario: prefs-update-in-order** — `update(change)` runs `change` against the latest prefs
  inside the store's serial queue: two overlapping updates (a raised mark, `checks: 'off'`) both
  land, on disk and in the answers; a failed write leaves the prefs as they were; an update before
  any read starts from the file.
- **Scenario: prefs-not-a-file** — (POSIX) a FIFO at the prefs path is refused at once (checked
  with `lstat`, opened `O_NONBLOCK`, so startup can't hang) and replaced by a regular file with the
  defaults; a symbolic link (even to a valid prefs file) is refused and replaced, its target left
  alone.
- **Scenario: prefs-tamper-resets** — a file that is not UTF-8 JSON, repeats a key, has an unknown
  key, another `format`, an install ID that is not a UUIDv4, `checks` other than `on`/`off`, a
  `skippedVersion` that is not a version, a malformed `highWaterMark`, or is over
  `MAX_PREFS_BYTES`: read as the defaults with a **new** install ID, and rewritten so, with one
  log line that holds neither the install ID nor a path (a first run, with no file, logs nothing).

## Requests (`fetch.test.ts`)
- **Scenario: feed-request-carries-nothing** — the request the fake feed receives has exactly the
  headers `host`, `user-agent` (`frost/<version> (update check)`) and the transport's own
  `connection`: no `cookie`, no `authorization`, no `referer`, nothing holding the install ID. The
  Electron transport (`netTransport`) asks `net.request` for a `GET` through the given session with
  `credentials: 'omit'`, `useSessionCookies: false`, `redirect: 'manual'`, `cache: 'no-store'`,
  `referrerPolicy: 'no-referrer'`, and sets only `User-Agent`; the update session's header filter
  (`updateRequestHeaders`) drops every header but `User-Agent`, which it forces to the update agent.
- **Scenario: hop-rules** — before each hop: `https:` only (`http:` only to a loopback literal in
  an unpackaged build, never after an `https:` hop); no user name or password; an IP literal must be
  public; a name must not be local-only (`localhost`, `*.local`, single labels…) and must resolve to
  public addresses only (a resolver answering `null` means not checked, the e2e seam, and only in
  an unpackaged build: a packaged one refuses the hop as `private-address`); a name that does not
  resolve is unreachable. The header filter keeps exactly the `UPDATE_ALLOWED_REQUEST_HEADERS`
  names (with another allowlist, exactly those). Timeouts: no response within `responseMs`, a body
  still arriving at `totalMs`, and a sink (the disk) that never finishes a write by `totalMs` all
  end the request as `timeout`.

## Download (`download.test.ts`)
- **Scenario: download-verified** — an artifact whose bytes match its signed size and SHA-256 is
  streamed to `updates/<version>/<artifactFileName>.partial`, then renamed to
  `updates/<version>/<artifactFileName>` (mode 0600 on POSIX); no `.partial` is left, and every
  other entry in `updates/` (older versions) is removed.
- **Scenario: rejects-hash-mismatch** — one byte different (same size): `hash-mismatch`, and
  neither the `.partial` nor a final file exists; an older ready version is kept.
- **Scenario: download-is-bounded** — each of these fails, the reason in parentheses, and leaves
  no file: a body one byte longer than `size` (`too-large`, reading stops), a `Content-Length`
  above `size` (`too-large`, before the body), a body shorter than `size` (`size-mismatch`), more
  than `maxRedirects` redirects (`too-many-redirects` → `download-failed`), an `https:` hop
  redirected to `http:` (`insecure-redirect`, the `http:` target is never requested), an artifact
  on a private IP literal, on a name resolving to a private address, or redirected to one
  (`private-address`, never requested), a status other than 200 (`download-failed`), no bytes for
  `idleMs` (`timeout` → `download-failed`).
- **Scenario: prune-downloads** — `pruneDownloads(userData, keep)` removes every entry of
  `updates/` but `keep`'s (all for `null`); a missing directory is fine; a symbolic link in place
  of `updates/` is left alone, and so is everything it points to.
- **Scenario: download-stays-in-updates** — a version that is not `VERSION_PATTERN` (`../x`) writes
  nothing (`disk`); an `updates` directory, or a version directory, that is a symbolic link is
  refused (`disk`).

## Client (`client.test.ts`)
`createUpdateClient(deps)`: `state()`, `watch(sinceVersion, signal)`, `checkNow()`, `download()`,
`skip()`, `setChecks(on|off)`, and main-only `readyFile()` (the verified path) and `lastCheck()`
(the internal outcome: `decide`'s kind, or why a check failed), `dispose()`.
- **Scenario: no-feed-no-requests** — no feed: state `disabled`; through the first-check delay and
  several intervals, and `checkNow()`, `download()`, `setChecks('on')`: zero requests.
- **Scenario: checks-off-no-requests** — a feed, but `checks: 'off'`: state `off`, and no request
  through the first-check delay and several intervals; `checkNow()` (a user action) checks once.
- **Scenario: check-schedule** — with checks on, the first check runs `firstCheckMs` after start,
  each delay scaled by `jittered` (± `jitter`), then every `intervalMs` (jittered); `checkNow()`
  within `manualMinIntervalMs` of the last check answers the current state without a request.
- **Scenario: available-after-verified-check** — a fresh manifest signed by the trusted key, newer,
  in rollout: `checking`, then `available` with its version, notes, `releasedAt`, `required: false`
  and size; the high-water mark is saved; `lastCheckedAt` is set; no artifact request.
- **Scenario: check-errors** — the feed unreachable or a 404 (`feed-unreachable`), a body over
  `MAX_ENVELOPE_BYTES` (`feed-too-large`), a wrong signature or a key not trusted (`bad-envelope`),
  an expired manifest (`stale`); `lastCheck()` keeps the verify reason.
- **Scenario: older-than-seen** — after a verified 1.3.0, a correctly signed (and fresh) 1.2.0, or
  1.3.0 with an earlier `releasedAt`, is `older-than-seen` and the mark is unchanged; the same 1.3.0
  again, or re-signed with a later `releasedAt`, is accepted (the mark moves to the later one).
- **Scenario: prerelease-does-not-raise-mark** — a release build (1.2.0) that verifies
  `2.0.0-beta.1` shows `up-to-date` (`prerelease-ignored`) and leaves the high-water mark unset, so
  a later `1.5.0` is offered (and raises the mark), and `2.0.0-beta.2` then leaves it at `1.5.0`;
  an install running `1.6.0-beta.1` is offered `2.0.0-beta.2`, which raises its mark. A pulled
  release can't be rolled back: once seen, an older version is `older-than-seen`; the fix is a
  higher version.
- **Scenario: staged-out-stays-quiet** — outside the rollout: `up-to-date` (no offer), and
  `lastCheck()` says `staged-out`; likewise a pre-release for a release build (`prerelease-ignored`)
  and no artifact for this platform (`no-artifact`); the high-water mark still moves (except for
  `prerelease-ignored`).
- **Scenario: skip-version** — `skip()` on an offer stores `skippedVersion` and shows `up-to-date`;
  the next check of that version is `up-to-date` (`lastCheck()`: `skipped`); a later version is
  offered again.
- **Scenario: required-cannot-be-skipped** — a manifest whose `minimumVersion` is above the running
  one: `available` with `required: true`, even at 0 % rollout or with that version skipped; `skip()`
  changes nothing.
- **Scenario: download-needs-consent** — nothing requests the artifact until `download()`;
  `download()` outside `available` is a no-op; with it: `downloading` (bytes, total), then `ready`
  with `install: 'manual'` and the file name (no path); `readyFile()` gives the verified path.
- **Scenario: download-errors-shown** — a tampered artifact: `error` `hash-mismatch` with the
  offered version, no file left, `readyFile()` `null`; an offer whose manifest expired since the
  check is `stale` and requests nothing.
- **Scenario: stale-before-ready** — a manifest that expires while its artifact downloads: the
  verified file is deleted and the state is `error` `stale`, `readyFile()` `null`.
- **Scenario: dispose-during-download** — `dispose()` while the artifact arrives ends the request;
  the `.partial` is deleted and nothing is ready.
- **Scenario: prefs-writes-not-lost** — a check raising the mark and `setChecks('off')`, their
  writes in flight at once, in either order: the file and the state end with both (`checks: 'off'`
  and the new mark).
- **Scenario: set-checks** — `setChecks('off')` saves it, stops the schedule, and shows `off` (an
  offer, a download or a ready file stays); `setChecks('on')` shows `idle` and schedules a check
  `firstCheckMs` (jittered) later.
- **Scenario: watch-long-poll** — `watch(v)` answers at once when the state is newer than `v`,
  otherwise on the next change, or when its signal aborts; a version from the future waits for the
  next change only (`Infinity` too); `NaN` or a negative version answers at once; with
  `MAX_PENDING_UPDATE_WATCHES` waiting one more answers the oldest at once.
- **Scenario: errors-are-caught** — a running version that is not semver makes a check `error`
  `internal`, never a rejection; a prefs write that fails is `disk`.

## Prefs read errors (`prefs.test.ts`, Phase 7 Task 5)
- **Scenario: prefs-unreadable-kept** — (POSIX, not root) a prefs file that exists but cannot be
  read (`EACCES`; likewise `EMFILE`, `EIO`): the store answers in-memory defaults (a new install ID,
  checks on, no mark) for this run, logs one line, and **never writes**: neither the read nor a later
  `update()` replaces the file, so its install ID and high-water mark survive for the next run. Only
  a missing file (`ENOENT`) or one whose content is invalid is reset and rewritten. A lax mode is
  fixed through the open handle (`handle.chmod`), never by path.

## Download stops (`download.test.ts`, Phase 7 Task 5)
- **Scenario: hung-write-does-not-hold** — a disk write that never finishes: at `totalMs` the
  download answers `timeout` at once, without waiting for the file to close (a pending write would
  hold `close()`); the `.partial` is removed once it can be.
- **Scenario: fresh-before-prune** — `downloadArtifact` asks `isFresh()` after the hash verifies and
  before it renames the file or prunes other versions: a stale manifest is `stale`, the partial is
  deleted, and an older ready version is kept.

## Router (`packages/ipc-contract/src/__tests__/update-router.test.ts`)
`update-router.ts` exports `UpdateService` (main implements it, `apps/desktop/src/main/update/service.ts`)
and `updateRouter` (`update.*`). Every procedure is `publicProcedure.use(enforceSender).use(requireUpdate)`
with a strict Zod input (`specs/update-router.schema.ts`): `watch({ sinceVersion })` (an integer,
`-1` up to `MAX_SAFE_INTEGER`), `setChecks({ checks: 'on' | 'off' })`, and no input at all for
`check`, `download`, `skip`, `install`. `watch` answers `UpdateState`; `check`, `download`, `skip` and
`setChecks` answer the `UpdateState` after the step (`download` once it has started, not finished);
`install` answers whether it showed the file. Release notes travel in the state as plain text: there
is no separate notes procedure.
- **Scenario: every-update-procedure-enforces-sender** — every `update.*` procedure, called from a
  foreign origin, with a valid, a malformed or no input: `FORBIDDEN`, and the service is never
  touched (not even `state()`).
- **Scenario: update-without-service-fails-closed** — no `update` service in the context: every
  procedure is the masked internal error.
- **Scenario: update-inputs-validated** — a missing, fractional, below `-1`, string or extra-key
  `sinceVersion`; `checks` other than `on`/`off` or an extra key; any input to `check`, `download`,
  `skip` or `install`: `BAD_REQUEST`, the service untouched.
- **Scenario: update-watch-long-polls** — `watch` answers at once for an older version, else on the
  service's next change, else the current state after `WATCH_TIMEOUT_MS`, the service's waiter
  released either way.

## Main (`apps/desktop/src/main/update/__tests__/service.test.ts`)
`startUpdateService({ app, net, session, shell, env, log })` builds the client from Electron's objects
(the in-memory `UPDATE_PARTITION` session, hardened with `hardenUpdateSession`; `netTransport`;
`netResolve`, wrapped by the `E2E_PUBLIC_HOSTS_SWITCH` seam when unpackaged; `resolveFeed`,
`resolveTrustedKeys`, `createPrefsStore(userData, { log })`) and answers `{ service, dispose }`.
`index.ts` only starts it in `whenReady`, passes `update: service` and calls `dispose()` on quit.
- **Scenario: install-shows-file** — `install()` on `ready` with `install: 'manual'` calls
  `shell.showItemInFolder` with exactly `readyFile()` (a regular file, checked first) and answers
  `true`. It never calls `openExternal` or `openPath` and never runs the file.
- **Scenario: install-refused-unless-ready** — in every other state, or when the ready file is gone
  or is not a regular file: `false`, and the shell is not touched. `restart` mode (unreachable today)
  is refused too until Electron's `autoUpdater` holds the update.
- **Scenario: download-starts-not-awaits** — `download()` answers the `downloading` state at once;
  `check()`, `skip()` and `setChecks()` answer the client's state after the step.
- **Scenario: switches-unpackaged-only** — the feed, public-key, test-certificate and e2e public-host
  switches are read only when unpackaged; packaged, they are ignored (and the app refuses to start
  with any of them: `PACKAGED_FORBIDDEN_SWITCHES` holds `frost-update-feed`,
  `frost-update-public-key` and `frost-update-test-cert`). The refusal is the shared one, so its
  line reads `PACKAGED_DEBUG_REFUSAL` ("remote debugging is disabled in packaged builds") followed by
  the offending switch, even for these non-debugging switches.
- **Scenario: start-fails-safe** — `startUpdateService` returns at once and never throws: the client
  is built in the background (`disabled` at version 0 until then), and a throw or rejection while
  building it is one log line and a service that stays `disabled` (steps answer that state, `install`
  `false`, `watch` waits for its signal). Startup goes on to the IPC handler and the window either way.
- **Scenario: no-feed-no-prefs** — without a feed the prefs file is never read or created (no
  install ID exists): `setChecks` is a no-op and `checkNow` makes no request.
- **Scenario: test-cert-pins-one-certificate** — with `UPDATE_TEST_CERT_SWITCH` (unpackaged) the
  update session's certificate check accepts (`0`) only a certificate whose DER SHA-256 is the
  switch's value, and defers (`-3`, Chromium's own verdict) for every other one; a malformed value,
  or a packaged build, installs no check at all. No other session is touched.

## Chrome (`apps/desktop/src/renderer/__tests__/update-view.test.ts`, `e2e/update.e2e.ts`)
`renderer/update-view.ts` (pure view model), `hooks/useUpdate.ts` (long-polls `update.watch` from the
chrome's start), `components/UpdateBar.tsx` (the notice row, always-present `update-slot` under the
find bar) and `renderer/update-palette.ts` (registered by `UpdateBar.tsx` at load). The chrome makes
no request of its own: everything goes through `update.*`.
- **Scenario: update-bar-hidden-at-rest** — `disabled`, `off`, `idle`, `checking`, `up-to-date`, or
  no state yet: no row (`UPDATE_BAR_KINDS`).
- **Scenario: update-bar-available** — "frost X.Y.Z is available" (`updateAvailableText`), with
  Release notes (expands the notes as plain text, never HTML), Download, Skip this version and Later.
  A required update says `UPDATE_REQUIRED_TEXT` and offers no Skip. Later hides the offer of that
  version for this window's session.
- **Scenario: update-bar-downloading** — `updateDownloadingText` and the progress (a `progress`
  element and a whole percentage, `0` for a zero total).
- **Scenario: update-bar-ready** — `install: 'manual'`: `updateReadyManualText`, Show file
  (`update.install`) and Dismiss; `restart`: `updateReadyRestartText` and Dismiss only.
- **Scenario: update-bar-error** — `UPDATE_ERROR_MESSAGES[reason]` and Dismiss; a dismissal is keyed
  by the state version the error came with, so the same error after a new check shows again, even
  when the chrome never saw the states in between.
- **Scenario: update-palette** — with a feed: "Check for Updates" (answers what the check found:
  `updateAvailableText`, `UPDATE_PALETTE_MESSAGES.upToDate`, or the error's message) and "Turn
  Automatic Update Checks Off" while on, "…On" while off. Without a feed (`disabled`), or before the
  first state: none of them is offered (nothing update-related shows).

### e2e (`apps/desktop/e2e/update.e2e.ts`)
Against a TLS fake feed (`__tests__/fake-feed.ts` over Node `https` with a per-run self-signed
certificate, `e2e/tls.ts`) on 127.0.0.1 under a public-looking name (`--host-resolver-rules`,
`--frost-e2e-public-hosts`), its manifest signed with a key generated per run and trusted through
`--frost-update-public-key`; the feed through `--frost-update-feed`, the certificate through
`--frost-update-test-cert`. Each test launches on a fresh profile whose prefs file has checks off (so
no automatic check runs mid-test); the check is the palette's "Check for Updates".
- **Scenario: update-available-download-verify-show** — the bar shows the offer; Download; Ready
  with the "install it by hand" text; Show file calls `shell.showItemInFolder` (stubbed in main) with
  the verified path, whose SHA-256 is the signed one.
- **Scenario: no-silent-install** — with an offer on screen and time passing, the fake feed never
  sees an artifact request until Download is clicked.
- **Scenario: tampered-artifact-shows-error** — an artifact one byte off: the bar shows
  `UPDATE_ERROR_MESSAGES['hash-mismatch']`, and no file is left in `updates/`.
- **Scenario: feed-request-headers** — the manifest request Chromium sends carries only the
  allowlisted headers (`host`, `user-agent` = `updateUserAgent`, and Chromium's own `connection`,
  `accept-encoding`), no cookie, no referrer, nothing holding the install ID.
- **Scenario: no-feed-no-update-ui** — a launch with no feed configured: no update request, no bar,
  and the palette offers no update action.
