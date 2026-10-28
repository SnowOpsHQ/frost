# Feature: signed selector packs

Spec: `specs/serp-selector-pack.spec.ts` (`SERP_PACK_PUBLIC_KEYS`, `SERP_PACK_REMOTE_URL`,
`SERP_PACK_SIGNATURE_SUFFIX`, `SERP_PACK_DIR`, `SELECTOR_PACK_LIMITS`, `SERP_PACK_FETCH_LIMITS`,
`PACK_VERIFY_FAILURES`, `PACK_UPDATE_OUTCOMES`, `PACK_UPDATE_MESSAGES`, `PACK_SOURCES`,
`SERP_RESULT_TYPES`, `SERP_E2E_PACK_KEY_SWITCH`, `SERP_E2E_PACK_URL_SWITCH`, `SIGNING_KEY_ENV`),
`specs/serp-selector-pack.schema.ts` (`SelectorPackSchema`) and `specs/security-policy.spec.ts`
(`PACKAGED_FORBIDDEN_SWITCHES`). Phase 3 Task 1; review focus `pack-rejects-forged-and-stale`. Each
line maps to one named test.

## Decisions
- **Selectors are signed data.** A pack is JSON (engines, hosts, pathnames, parameter names, CSS
  selectors per result type, the parameters that mean another vertical, the click redirects by
  host, path, parameter and a named decoding), never code. Its `.sig` is the base64 Ed25519
  signature of the file's exact bytes; the app embeds the public key.
- **Size, signature, then parse.** `verifyPack` refuses a pack over 256 KiB unread (`too-large`),
  then verifies the signature against each trusted key (`crypto.verify(null, bytes, key, sig)`)
  before decoding a byte (`bad-signature`), then parses it (fatal UTF-8, `JSON.parse`,
  `SelectorPackSchema`: `invalid-pack`). A malformed signature (not base64, not 64 bytes, too long)
  and an unusable trusted key are refusals, never exceptions.
- **Newer than the pack in use, or nothing.** A verified pack replaces the one in use only when its
  version is higher; equal or older is `not-newer`. A refused pack changes nothing: no write, no
  swap, no `changed` event.
- **The bundled pack.** Imported as raw text by main's Vite build (`?raw`), so the bytes verified are
  the bytes signed; the file is kept byte-exact in git (`.gitattributes`, `-text`). If it fails
  verification, SERP reading is disabled (`pack-invalid`), the stored pack is not used and updates
  are `disabled`.
- **The stored pack.** `userData/serp-selectors/serp-selectors.json` and its `.sig`, written
  atomically (each to a temporary file in the same directory, then renamed; a crash between the two
  renames leaves a pair that does not verify, which falls back to the bundled pack). Verified again
  at every start and used only if newer than the bundled pack; anything else (missing, unreadable,
  oversize, tampered, invalid, not newer) leaves the bundled pack in use.
- **Updates are the user's.** Only `checkForUpdate()` (the SERP panel's "Check for selector
  updates", the palette) fetches; creating the store and `load()` never do. Concurrent checks share
  one run. The pack, then its `.sig`, through the bounded fetcher's `checks` lane: `https:` only
  (the URL, every hop and the final URL), the pack capped at 256 KiB (`too-large` past it), the
  signature at 256 bytes, 10 s each, the pack URL as the request's page. An installed pack is
  written, used at once and announced to `changed` listeners.
- **Signing.** `pnpm sign:selectors <pack.json>` writes `<pack.json>.sig` with the PKCS8 PEM key at
  `$FROST_SERP_SIGNING_KEY` (never printed, refused from inside the repo) and checks the result;
  `--verify <pack.json> [--key <SPKI base64>]` checks a pack against the embedded keys or the one
  given. A pack that is not UTF-8 without a BOM, or not a format 1 pack with a positive integer
  version, is not signed.
- **e2e seams.** `frost-e2e-serp-pack-key` (one more trusted key) and `frost-e2e-serp-pack-url` (the
  remote URL, which may be `http:`) are read only by unpackaged builds; packaged builds refuse to
  start with either.

## Verification (`apps/desktop/src/main/serp/__tests__/pack-verify.test.ts`)
- `pack-accepts-valid-signature` — a pack signed with an ephemeral key verifies and parses; surrounding whitespace in the `.sig` is ignored; any one trusted key will do.
- `pack-rejects-forged-and-stale` — one changed byte, another key's signature, a truncated signature, non-base64 and a 63- or 65-byte signature are `bad-signature`; a valid signature over a pack that is not JSON, not UTF-8 or not `SelectorPackSchema` is `invalid-pack` (the stale half: `pack-store.test.ts`).
- `pack-verifies-before-parsing` — a forged pack is never decoded or parsed (`JSON.parse` not called).
- `pack-too-large-never-read` — a pack one byte over the cap is `too-large`, even validly signed; an over-long `.sig` is `bad-signature`.
- `pack-ignores-unusable-keys` — a malformed or non-Ed25519 trusted key is skipped, never thrown.
- `pack-schema-is-strict-and-capped` — unknown keys, format 2, version 0 or 1.5, a bad result type, a blank or over-long selector, too many engines or blocks, an uppercase or wildcard host, a pathname without `/`, an offset page parameter without `perPage`, duplicate engine ids and a host in two engines are refused; so are (Task 3) a `reject` list empty or over `maxRejects`, a rule with both `values` and `except`, an uppercase or over-long value, `redirects` empty or over `maxRedirects`, an unknown `decode`, a redirect path without `/` or an uppercase host, and a blank or over-long `notInside` or `box`.

## Store (`apps/desktop/src/main/serp/__tests__/pack-store.test.ts`)
- `bundled-pack-is-signed` — the bundled pack, as main imports it (`?raw`), is byte-identical to the file, verifies with `SERP_PACK_PUBLIC_KEYS` and covers Google, Bing and DuckDuckGo.
- `bundled-pack-invalid-disables` — a bundled pack that fails verification disables SERP reading (`pack-invalid`): the stored pack is ignored and updates are `disabled`, nothing requested.
- `stored-pack-reverified-at-start` — a stored pack is used at start only if it verifies and is newer than the bundled one; a tampered, corrupt, oversize, older or equal stored pack, or a storage error, leaves the bundled pack.
- `pack-rejects-forged-and-stale` — an update that is forged, tampered, signed but invalid, older or equal keeps the pack in use: nothing written, no `changed` event.
- `pack-update-installs-newer` — a newer verified pack is written, used at once and announced; checking again is `not-newer` against it.
- `pack-update-outcomes` — a failed pack or signature fetch is `unreachable`, an oversize one `too-large`, no fetcher `disabled`, a non-`https:` URL `unreachable` with nothing requested; a write failure still uses the pack.
- `pack-update-is-user-action-only` — creating the store and `load()` request nothing; only `checkForUpdate()` does, and concurrent checks share one run.
- `pack-fetch-uses-checks-lane` — the fetch adapter asks the given bounded fetcher for the pack with the pack URL as the page and the spec's caps and deadline; `truncated` is `too-large`, a non-200 answer or a non-`https:` hop `unreachable`.
- `pack-file-storage-is-atomic` — the file storage round-trips, answers `null` when empty, reads no more than the cap, and leaves no temporary files.
- `pack-e2e-switches-refused-when-packaged` — both e2e switches are in `PACKAGED_FORBIDDEN_SWITCHES`.

## Signing (`apps/desktop/src/main/serp/__tests__/sign-script.test.ts`)
- `sign-script-roundtrip` — signs a pack with a PEM key from the env var, the signature verifies with `verifyPack` and with `--verify --key`; the key is never printed.
- `sign-script-refuses-without-key` — without `FROST_SERP_SIGNING_KEY` it exits non-zero, says why and writes nothing.
- `sign-script-verify-detects-tampering` — `--verify` fails on one changed byte, and against the embedded keys for an ephemeral key's pack.
- `sign-script-refuses-bad-packs` — a pack with a BOM, or not a format 1 pack, is not signed.
