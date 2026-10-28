# Feature: The signed update manifest and `sign:update-manifest`

Spec: `specs/update-manifest.spec.ts` (values, types) and `specs/update-manifest.schema.ts` (Zod).
Design doc §4 Phase 7 (auto-update, signed and staged). Phase 7 Task 3.
Code: `apps/desktop/src/main/update/manifest.ts` (pure Node, no Electron) and
`scripts/sign-update-manifest.mjs` (`pnpm sign:update-manifest`).
Tests: `apps/desktop/src/main/update/__tests__/manifest.test.ts` and
`apps/desktop/src/main/update/__tests__/sign-update-manifest.test.ts` (every CI run; Ed25519 test
keys generated per run, injected as the trusted keys). Each scenario maps to one named test.

**Trust root.** The app trusts exactly the public keys in `UPDATE_PUBLIC_KEYS` (Ed25519, SPKI). The
only production private key lives in the maintainer's private key store (`frost-private/keys/`),
never in the repo or CI; no test or CI job signs with it. Nothing here publishes a feed.

## Verifying the envelope (`manifest.test.ts`)
- **Scenario: accepts-signed-manifest** — an envelope whose payload is a valid manifest, signed by
  a trusted Ed25519 key under its `keyId`, verifies: `{ ok: true, manifest, keyId }`, and the
  manifest equals the signed JSON.
- **Scenario: rejects-bad-signature** — each of these is refused, with the reason in parentheses:
  a payload with one byte flipped and a signature with one byte flipped (`bad-signature`); a
  signature by another Ed25519 key (`bad-signature`); a `keyId` not in the trusted keys
  (`unknown-key`); an RSA or EC public key (or garbage) registered under the `keyId`
  (`bad-key`); an empty, short or 65-byte signature, and non-canonical base64 in the payload or
  signature: whitespace, the URL-safe alphabet, missing padding, non-zero trailing bits
  (`bad-envelope`).
- **Scenario: rejects-malformed** — refused before or after the signature, as named: bytes over
  `MAX_ENVELOPE_BYTES` (`too-large`, before any parsing); bytes that are not UTF-8 JSON
  (`not-json`); an envelope with an extra key or another `format` (`bad-envelope`); a signed payload
  that is not JSON (`bad-payload`); and these signed manifests (`bad-manifest`): an extra key, at
  the top or in an artifact; an `http:` artifact URL; a URL with a user name or password; a hash
  that is not 64 lowercase hex digits; a version that is not `VERSION_PATTERN` (leading zero, build
  metadata, too long); `rolloutPercent` 101 or fractional; notes over `MAX_NOTES_CHARS` or with a
  control character; no artifacts, an unknown platform (also `__proto__`); a size of 0 or over
  `MAX_ARTIFACT_BYTES`; `minimumVersion` above `version`.

## Deciding (`manifest.test.ts`)
- **Scenario: rejects-downgrade** — a correctly signed manifest for the running version or an older
  one is `up-to-date`, whatever its rollout or minimum version (a replayed old manifest offers
  nothing).
- **Scenario: decide-eligibility** — a newer version with no artifact for this platform is
  `no-artifact`; the skipped version is `skipped` (a later version is not); otherwise, inside the
  rollout `available` with this platform's artifact.
- **Scenario: rollout-is-deterministic** — `rolloutBucket(installId, version)` is the first 4 bytes
  (big-endian) of SHA-256(`installId:version`) mod 100: the same pair always gives the same bucket,
  and a known pair gives the expected bucket; 0 % offers nobody and 100 % everybody; over 10 000
  random install IDs every bucket is used and each holds 100 ± 50.
- **Scenario: minimum-version-required** — an install below `minimumVersion` gets `required` with
  the artifact, even at 0 % rollout and with that version skipped; at or above it, the usual rules
  apply.
- **Scenario: compare-versions** — `compareVersions` follows semver precedence: numeric core
  (`1.10.0` > `1.9.0`), a pre-release below its release, identifiers compared left to right
  (numeric numerically, alphanumeric in ASCII order, numeric below alphanumeric, a longer list above
  its prefix); `isVersion` accepts exactly `VERSION_PATTERN` up to `MAX_VERSION_CHARS`, and
  `compareVersions` throws on anything else.
- **Scenario: production-key-is-ed25519** — `UPDATE_PUBLIC_KEYS` holds exactly one key,
  `frost-update-2026-10`, which parses as an Ed25519 SPKI public key whose DER re-encodes to the same
  base64.

## Signing (`sign-update-manifest.test.ts`)
`pnpm sign:update-manifest <manifest.json> [--out <envelope.json>]` reads the PEM path from
`FROST_UPDATE_SIGNING_KEY`, writes `<manifest>.signed.json` by default (`x.json` →
`x.signed.json`), and never prints key material. Relative paths are taken from the directory
`pnpm` was run in.
- **Scenario: signs-and-verifies** — with a trusted key, the script writes an envelope that
  `verifyEnvelope` accepts under that key's `keyId`, to `--out` or to the default path.
- **Scenario: signs-exact-bytes** — the envelope's payload decodes to exactly the manifest file's
  bytes (its whitespace and key order kept; nothing is re-serialised).
- **Scenario: refuses-world-readable-key** — (POSIX) a key file with any group or other permission
  bit is refused, exit 1, and nothing is written.
- **Scenario: refuses-unusable-key** — `FROST_UPDATE_SIGNING_KEY` unset, a path that is not a
  regular file, or a key that is not an Ed25519 private key: refused, exit 1, nothing written, and
  no key material in the output.
- **Scenario: refuses-untrusted-key** — an Ed25519 key whose public half is not in the trusted keys
  is refused (the app would not trust what it signs), exit 1, nothing written.
- **Scenario: refuses-invalid-manifest** — a manifest that `parseManifest` refuses (not JSON, an
  `http:` URL, over `MAX_MANIFEST_BYTES`) is not signed, exit 1, nothing written.
- **Scenario: runs-under-node** — the root `package.json` runs `node scripts/sign-update-manifest.mjs`
  for `sign:update-manifest`, and the script runs under plain Node (type stripping loads the specs
  and `manifest.ts`): with an untrusted key it exits 1 and says why.
