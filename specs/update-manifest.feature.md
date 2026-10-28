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
`verifyEnvelope(bytes, { now, keys? })`: `now` is the client's clock (ms since the epoch), `keys`
the trusted keys (`UPDATE_PUBLIC_KEYS` unless a test injects its own).
- **Scenario: accepts-signed-manifest** — an envelope whose payload is a valid, fresh manifest,
  signed (over `UPDATE_SIGNATURE_CONTEXT` + the payload) by a trusted Ed25519 key under its
  `keyId`, verifies: `{ ok: true, manifest, keyId }`, and the manifest equals the signed JSON.
- **Scenario: domain-separated-signature** — `UPDATE_SIGNATURE_CONTEXT` is
  `frost-update-manifest-v1` followed by a NUL; a signature by the trusted key over the bare payload
  (no prefix), or over another prefix, is `bad-signature`.
- **Scenario: rejects-bad-signature** — each of these is refused, with the reason in parentheses:
  a payload with one byte flipped and a signature with one byte flipped (`bad-signature`); a
  signature by another Ed25519 key (`bad-signature`); a `keyId` not in the trusted keys
  (`unknown-key`); an RSA, EC, X25519 or Ed448 public key (or garbage) registered under the `keyId`
  (`bad-key`); a bad signature over a payload that is not even JSON (`bad-signature`: the signature
  is checked before the payload is read); an empty, short or 65-byte signature, and non-canonical base64 in the payload or
  signature: whitespace, the URL-safe alphabet, missing padding, non-zero trailing bits
  (`bad-envelope`).
- **Scenario: rejects-malformed** — refused before or after the signature, as named: bytes over
  `MAX_ENVELOPE_BYTES` (`too-large`, before any parsing); bytes that are not UTF-8 JSON
  (`not-json`); an envelope with an extra key or another `format` (`bad-envelope`); a signed payload
  that is not JSON (`bad-payload`); and these signed manifests (`bad-manifest`): an extra key, at
  the top or in an artifact; an `http:` artifact URL; a URL with a user name or password; a hash
  that is not 64 lowercase hex digits; a version that is not `VERSION_PATTERN` (leading zero, build
  metadata, too long); `rolloutPercent` 101 or fractional; no artifacts, an unknown platform (also
  `__proto__`); a size of 0 or over `MAX_ARTIFACT_BYTES`; `minimumVersion` above `version`; no
  `expiresAt`, or one not in UTC.
- **Scenario: rejects-duplicate-keys** — an envelope repeating a key (`duplicate-key`, before the
  signature is looked at), and a signed manifest repeating one at the top, in `artifacts`, or in an
  artifact, also when the two spellings differ only by escapes (`"url"` and `"\u0075rl"`):
  `duplicate-key`. The same key in different objects, or a key equal to a string value, is fine.
- **Scenario: notes-are-plain-text** — notes over `MAX_NOTES_CHARS`, or holding a C0 or C1 control
  (other than tab, LF, CR), DEL, a bidi embedding/override/isolate control (U+202A–U+202E,
  U+2066–U+2069), U+2028, U+2029 or a lone surrogate: `bad-manifest`. Tabs, newlines, accents,
  emoji (paired surrogates) and exactly `MAX_NOTES_CHARS` characters are fine.
- **Scenario: rejects-stale** — with `now` at or after `expiresAt`: `expired`; with `releasedAt`
  more than `MAX_CLOCK_SKEW_MS` after `now`: `not-yet-valid` (exactly that much is fine); an
  `expiresAt` not after `releasedAt`, or more than `MAX_MANIFEST_LIFETIME_MS` after it, is
  `bad-manifest` (exactly that much is fine). `checkFreshness` answers the same for a parsed
  manifest (for the client to re-check before a later download).

## Deciding (`manifest.test.ts`)
- **Scenario: rejects-downgrade** — a correctly signed manifest for the running version or an older
  one is `up-to-date`, whatever its rollout or minimum version (a replayed old manifest offers
  nothing).
- **Scenario: decide-eligibility** — a newer version with no artifact for this platform is
  `no-artifact`; the skipped version is `skipped` (a later version is not); outside the rollout
  `staged-out` (with no bucket in the result); otherwise `available` with this platform's artifact.
- **Scenario: prerelease-only-for-prerelease** — a pre-release version is `prerelease-ignored` for
  an install running a release, even when `minimumVersion` would make it required; an install
  running a pre-release is offered newer pre-releases and releases.
- **Scenario: artifact-file-name** — `artifactFileName(version, platformKey)` is
  `frost-<version>-<platformKey>.<extension>` with `UPDATE_ARTIFACT_KINDS`' fixed extension (`zip`,
  `AppImage`, `exe`), whatever the URL's file name; it throws for a non-version (`../x`, `1.2`) or an
  unknown platform.
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
`pnpm sign:update-manifest <manifest.json> [--out <envelope.json>] [--force]` reads the PEM path
from `FROST_UPDATE_SIGNING_KEY`, writes `<manifest>.signed.json` by default (`x.json` →
`x.signed.json`), and never prints key material or the key's path. Relative paths are taken from
the directory `pnpm` was run in. It checks the manifest's freshness against its own clock. On
Windows it warns that the key file's ACLs are not checked.
- **Scenario: signs-and-verifies** — with a trusted key, the script writes an envelope that
  `verifyEnvelope` accepts under that key's `keyId`, to `--out` or to the default path, and prints,
  before writing, a summary of what it signs: version, minimum version, rollout, release and expiry
  times, each platform's URL, SHA-256 and size, and the SHA-256 of the signed manifest bytes.
- **Scenario: output-is-safe** — the envelope is written to a temporary file in the output's
  directory and then moved into place (no temporary file is left behind); an existing output is
  refused unless `--force`; an output that is, or links to, the key or the manifest (same device
  and inode, through a symlink or a hard link, or through a symlinked directory) is refused even
  with `--force`.
- **Scenario: signs-exact-bytes** — the envelope's payload decodes to exactly the manifest file's
  bytes (its whitespace and key order kept; nothing is re-serialised).
- **Scenario: refuses-world-readable-key** — (POSIX) a key file with any group or other permission
  bit, or owned by another user, is refused, exit 1, and nothing is written.
- **Scenario: warns-acls-unchecked-on-windows** — (Windows only) signing still works, and the
  script warns that the key file's ACLs are not checked.
- **Scenario: refuses-unusable-key** — `FROST_UPDATE_SIGNING_KEY` unset, a path that is not a
  regular file (a directory; a FIFO, opened non-blocking, so the script doesn't hang), or a key
  that is not an Ed25519 private key: refused, exit 1, nothing written, and no key material in the
  output.
- **Scenario: refuses-untrusted-key** — an Ed25519 key whose public half is not in the trusted keys
  is refused (the app would not trust what it signs), exit 1, nothing written.
- **Scenario: refuses-invalid-manifest** — a manifest that `parseManifest` refuses (not JSON, an
  `http:` URL, over `MAX_MANIFEST_BYTES`), that repeats a key, that has expired, or whose
  `releasedAt` is more than `MAX_CLOCK_SKEW_MS` ahead, is not signed, exit 1, nothing written.
- **Scenario: runs-under-node** — the root `package.json` runs `node scripts/sign-update-manifest.mjs`
  for `sign:update-manifest`, and the script runs under plain Node (type stripping loads the specs
  and `manifest.ts`): with an untrusted key it exits 1 and says why.
