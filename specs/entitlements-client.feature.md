# Feature: entitlements in the desktop main process

Spec: `specs/entitlements-snapshot.spec.ts` (the wire format, `EntitlementsSchema`, `NO_ENTITLEMENTS`,
`INVALID_ENTITLEMENTS`, `ENTITLED_STATUSES`, `TIMED_STATUSES`, `OFFLINE_GRACE_MS`, `entitlementGrants`,
`FEATURE_NOT_ENTITLED_CODE`, `ENTITLEMENT_REFRESH_FAILURES`, `HIGH_WATER_PERSIST_INTERVAL_MS`,
`ENTITLEMENT_HEARTBEAT_MS`) and `specs/secret-store.spec.ts` (`SECRET_NAMES`, `SECRETS_DIR_NAME`,
`SECRET_FILE_SUFFIX`, `SECRET_TEMP_SUFFIX`, `SECRET_FILE_MODE`, `SECRETS_DIR_MODE`, `MAX_SECRET_CHARS`,
`INSECURE_LINUX_BACKENDS`). Phase 4 Task 4; the backend side is `entitlements.feature.md`. Review
focus "A snapshot cannot be forged or replayed past its life". Each line maps to one named test.

## Decisions
- **Verified in main, against the build's keys only.** A snapshot is checked against the JWKS baked
  into the build (`FROST_PUBLIC_ENTITLEMENT_JWKS`, validated with `EntitlementJwksSchema`; a malformed
  or missing set makes every snapshot `invalid`). The protected header must match
  `EntitlementHeaderSchema` exactly before any key is chosen, so an embedded `jwk`, a `jku`, `crit`,
  `b64: false`, `alg: none` or an HMAC algorithm is refused; the key is the JWKS entry with the
  header's `kid` (unknown `kid` → `invalid`), and the signature is checked with EdDSA only.
- **Claims.** The verified payload must match `EntitlementClaimsSchema` (`iss`, `aud`, `ver`,
  `exp - iat <= ENTITLEMENT_TTL_SECONDS`), its `sub` must be the signed-in user's ID, and its `iat`
  at most `MAX_CLOCK_SKEW_SECONDS` after the effective now. Any failure is `INVALID_ENTITLEMENTS`.
- **Effective now never moves back.** Main keeps a time high-water mark: the latest of every clock
  reading and every verified `iat` (server time). Status is computed at `max(now, highWater)`, so
  setting the clock back neither revives an expired snapshot nor extends grace. The mark is stored
  with the snapshot (in the same blob, so one cannot be dropped without the other), written when it
  changes state and at most every `HIGH_WATER_PERSIST_INTERVAL_MS` otherwise; a heartbeat raises it
  at least every `ENTITLEMENT_HEARTBEAT_MS` while a snapshot is held. It survives sign-out.
- **Status over time.** `active` before `exp`; after it, `grace` until `exp + OFFLINE_GRACE_SECONDS`
  only while the last refresh failed for a network reason; otherwise `expired` (free). Status is
  recomputed on every read and at the next boundary (a timer), and `onChange` fires when it changes.
- **A refresh that fails.** `network` keeps the snapshot and allows grace; `auth` (the server refused
  the credential) drops it (`none`); `invalid` (an answer that does not verify) and an `update` with
  a snapshot that does not verify replace whatever was held with `invalid` (free), logged with a
  fixed reason only. A newer valid snapshot clears the failure.
- **Flags, not plans.** Only `FEATURE_FLAGS` are kept; a plan this build does not know is shown as
  `free` (its known flags still count, since gating reads flags).
- **Secrets need a real keychain.** The secret store encrypts with `safeStorage`; it is memory-only
  (nothing written, `persistent: false`) when encryption is unavailable or Linux selected
  `basic_text` or `unknown`. A blob that does not decrypt or parse is treated as absent and deleted.
  Logs name the blob, never its content.

## Spec schemas (`apps/desktop/src/main/account/__tests__/entitlements-spec.test.ts`)
- `header-schema-is-exact` — the header schema refuses `jwk`, `jku`, `x5u`, `crit`, `b64`, another `alg` (`none`, `HS256`, `ES256`) and another `typ`.
- `claims-schema-caps-ttl` — `exp - iat > ENTITLEMENT_TTL_SECONDS` and `exp <= iat` are refused; exactly the TTL is accepted.
- `entitlements-schema-fails-closed` — a non-entitled status carrying `pro` or any feature is refused.
- `entitlements-schema-ties-times-to-status` — `active`/`grace`/`expired` need both times with `graceEndsAtMs = expiresAtMs + OFFLINE_GRACE_MS`; `none`/`invalid` need `null`s; an unknown plan or flag is refused.
- `entitlement-grants-needs-entitled-status` — `entitlementGrants` is true only for `active`/`grace` with the flag.

## Verification (`apps/desktop/src/main/account/__tests__/entitlements-verify.test.ts`)
- `valid-snapshot-is-active` — a snapshot signed like the backend's is `active` with its flags and times; the verified `iat` is returned.
- `rotation-key-verifies` — a snapshot signed by any `kid` of the JWKS verifies.
- `tampered-payload-is-invalid` — a changed payload (plan, features or `sub`) under the original signature is `invalid`.
- `tampered-signature-is-invalid` — a changed signature is `invalid`.
- `alg-none-is-invalid` — an unsigned snapshot (`alg: none`, empty signature) is `invalid`.
- `hs256-with-public-key-is-invalid` — a snapshot HMAC-signed with the public key's bytes as secret is `invalid`.
- `unknown-kid-is-invalid` — a valid signature by a key whose `kid` is not in the JWKS is `invalid`.
- `wrong-key-type-in-jwks-is-invalid` — a JWKS with a key of another `kty`/`crv`, or a private member, makes every snapshot `invalid`.
- `embedded-jwk-header-is-ignored` — a snapshot signed by another key that embeds it as `jwk` (with a trusted `kid`) is `invalid`.
- `wrong-claims-are-invalid` — another `iss`, `aud`, `typ` or `ver` is `invalid`.
- `wrong-sub-is-invalid` — a snapshot for another account is `invalid`.
- `future-iat-beyond-skew-is-invalid` — `iat` beyond `MAX_CLOCK_SKEW_SECONDS` after the effective now is `invalid`; within it, `active`.
- `ttl-over-limit-is-invalid` — `exp - iat > ENTITLEMENT_TTL_SECONDS` is `invalid` even when signed.
- `expired-online-is-free` — past `exp` without a network failure: `expired`, `free`, no features.
- `expired-offline-within-grace-is-grace` — past `exp`, offline, before `graceEndsAtMs`: `grace` with the flags.
- `beyond-grace-is-expired` — offline at or after `graceEndsAtMs`: `expired`.
- `clock-rollback-does-not-extend-grace` — with the high-water mark past `exp` (or past grace), a clock set back yields `expired`, never `active` or `grace`.
- `unknown-flags-dropped` — unknown flags are dropped; an unknown plan is shown as `free` with its known flags.
- `malformed-jwks-is-invalid` — a JWKS that is not JSON, empty, or repeats a `kid` makes every snapshot `invalid`.
- `malformed-snapshot-is-invalid` — a non-string, an over-long string or one that is not three base64url segments is `invalid`.
- `snapshot-fails-closed` — none of the forgeries above is ever entitled, at any time or offline state.

## Store (`apps/desktop/src/main/account/__tests__/entitlements.test.ts`)
- `reader-current-has-require` — `current()`, `has(flag)` and `requireFeature(flag)` agree with the verified snapshot.
- `require-feature-throws-coded-error` — `requireFeature` throws `FeatureNotEntitledError` with `code = FEATURE_NOT_ENTITLED_CODE` and the flag.
- `onchange-fires-at-boundary` — an `active` snapshot becomes `expired` (online) or `grace` then `expired` (offline) at its boundaries without a new update, and `onChange` fires once per change; unsubscribing stops it.
- `entitlements-persist-across-instances` — a new instance over the same store answers the same entitlements (offline flag included).
- `high-water-persists` — a restart with the clock set back does not revive an expired snapshot; between state changes reads write the mark at most every `HIGH_WATER_PERSIST_INTERVAL_MS`.
- `older-snapshot-does-not-replace-newer` — a verified snapshot with an earlier `iat` than the held one (same account) is ignored.
- `update-racing-clear-does-not-revive` — an `update` whose verification finishes after `clear()` changes nothing.
- `missing-jwks-makes-every-snapshot-invalid` — without a usable JWKS every update is `invalid`, and a stored snapshot is re-verified at start against this build's keys.
- `unverified-update-fails-closed` — after a valid snapshot, an update that does not verify (or is for another account) is `invalid`, persisted as such; the log carries a fixed reason, no snapshot.
- `refresh-failure-kinds` — `network` allows grace, `auth` drops to `none`, `invalid` is `invalid`; a later valid update clears it.
- `clear-drops-snapshot-keeps-high-water` — `clear()` is `none` and survives a restart; the high-water mark stays.
- `corrupt-state-is-none` — a stored state that does not parse is `none`, deleted and logged without content.

## Secret store (`apps/desktop/src/main/account/__tests__/secret-store.test.ts`)
- `secret-round-trip` — a written blob reads back, also from a new instance; on disk it is the `safeStorage` ciphertext, not the value.
- `secret-file-modes` — the file is `0600`, the directory `0700`, and no temporary file is left.
- `basic-text-is-memory-only` — with Linux `basic_text` nothing is written to disk and `persistent` is false; values live for the run.
- `unknown-backend-is-memory-only` — with Linux `unknown`, as `basic_text`.
- `encryption-unavailable-is-memory-only` — with encryption unavailable, as `basic_text`.
- `corrupt-secret-is-absent` — a blob that does not decrypt reads as absent, is deleted, and the log names the blob only.
- `secret-names-allowlisted` — a name outside `SECRET_NAMES` (or a path) is refused, as is an over-long value.
- `secret-delete-and-clear` — `delete(name)` and `clear()` remove blobs (and stray temporary files).
- `failed-write-leaves-no-stale-value` — when the rename fails, the old file is removed and the run keeps the new value.

## Router (`packages/ipc-contract/src/__tests__/account-router.test.ts`)
- `account-procedures-enforce-sender` — `account.*` rejects a foreign sender before the service is called.
- `account-without-service-fail-closed` — without `services.account`, a masked internal error.
- `entitlements-answers-verified-state` — `account.entitlements` answers `EntitlementsSchema` from the service.
- `answers-carry-no-secret` — the serialized answer carries no snapshot or token; a service answer with extra members is refused (masked), not forwarded.
- `require-feature-passes-when-entitled` — `requireFeature(flag)` lets the call through for `active` and `grace` with the flag.
- `require-feature-forbidden-when-not` — otherwise `FORBIDDEN` with message and `cause.code` `FEATURE_NOT_ENTITLED_CODE`, the handler not run.
- `require-feature-after-sender` — a foreign sender gets the sender error first; the service is not asked.
- `require-feature-without-service-masked` — without `services.account`, a masked internal error.
