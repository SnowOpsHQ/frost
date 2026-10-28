/**
 * The signed update manifest (design doc §4 Phase 7: auto-update, signed and staged; Phase 7 Task 3).
 * The Zod side is `update-manifest.schema.ts`; acceptance `update-manifest.feature.md`. Implemented
 * by `apps/desktop/src/main/update/manifest.ts` (verify, compare, decide) and
 * `scripts/sign-update-manifest.mjs` (`pnpm sign:update-manifest`, the maintainer's signer).
 *
 * The feed serves one **envelope**: `{ format: 1, keyId, payload, signature }`. `payload` is the
 * base64 of the exact manifest JSON bytes and `signature` the base64 Ed25519 signature over
 * `UPDATE_SIGNATURE_CONTEXT` followed by those bytes. Nothing is canonicalised: the bytes the
 * maintainer reviewed are the bytes that are signed, and the app parses the manifest only after the
 * signature over them verifies. Neither the envelope nor the manifest may repeat a key in any
 * object (`duplicate-key`), so no reader can see a different value than another.
 *
 * Self-contained (no imports, erasable TypeScript only) so the signing script can load it with
 * Node's built-in type stripping.
 */

/** `format` of the envelope and of the manifest inside it. Any other value is refused. */
export const UPDATE_ENVELOPE_FORMAT = 1;
export const UPDATE_MANIFEST_FORMAT = 1;

/**
 * The public keys the app trusts, by `keyId`: SPKI DER, base64 (canonical, padded). Ed25519 only;
 * an envelope naming any other `keyId` is refused. Exactly one production key. Its private half
 * never enters the repo: it lives in the maintainer's private key store (`frost-private/keys/`) and
 * `pnpm sign:update-manifest` reads it from the path in `FROST_UPDATE_SIGNING_KEY`. Rotating the key
 * means adding a new entry here, shipping that build, then signing with the new key.
 */
export const UPDATE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'frost-update-2026-10': 'MCowBQYDK2VwAyEAbKYcnXCPysVbNh32TtYuiCJor/K++8te/zvOyIK+s8U=',
});

/**
 * Domain separation: what is signed is this prefix (UTF-8, ending in a NUL) followed by the payload
 * bytes, so an Ed25519 signature made for anything else with the same key never verifies as a
 * manifest signature, and vice versa. A new manifest format gets a new prefix.
 */
export const UPDATE_SIGNATURE_CONTEXT = 'frost-update-manifest-v1\0';

/** The environment variable holding the path of the signer's PEM private key (PKCS#8, unencrypted). */
export const UPDATE_SIGNING_KEY_ENV = 'FROST_UPDATE_SIGNING_KEY';

/** A `keyId`: lowercase letters, digits and `-`, at most 64 characters. */
export const UPDATE_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The manifest JSON (the signed bytes) is at most 64 KiB. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * The envelope's `payload` is at most the base64 length of `MAX_MANIFEST_BYTES` bytes, and the
 * envelope itself at most that plus `UPDATE_ENVELOPE_OVERHEAD_BYTES` (its other fields and
 * whitespace). This is the most a client reads from the feed, and `verifyEnvelope` refuses anything
 * larger before it parses a byte.
 */
export const MAX_PAYLOAD_CHARS = 4 * Math.ceil(MAX_MANIFEST_BYTES / 3);
export const UPDATE_ENVELOPE_OVERHEAD_BYTES = 1024;
export const MAX_ENVELOPE_BYTES = MAX_PAYLOAD_CHARS + UPDATE_ENVELOPE_OVERHEAD_BYTES;

/**
 * Release notes are plain text, at most 8192 UTF-16 code units (even fully `\u`-escaped they fit in
 * `MAX_MANIFEST_BYTES`). Refused anywhere in them: C0 and C1 controls and DEL except tab, line feed
 * and carriage return; the bidi embedding, override and isolate controls (U+202A–U+202E,
 * U+2066–U+2069); the line and paragraph separators (U+2028, U+2029); and lone surrogates.
 */
export const MAX_NOTES_CHARS = 8192;
export const UPDATE_NOTES_PATTERN =
  /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]*$/u;

/**
 * Freshness. Every manifest carries a signed `expiresAt` (ISO 8601, UTC) after its `releasedAt` and
 * at most `MAX_MANIFEST_LIFETIME_MS` (90 days) after it, so the maintainer re-signs a current
 * manifest at least that often. A client refuses a manifest whose `expiresAt` is not after its clock
 * (`expired`) or whose `releasedAt` is more than `MAX_CLOCK_SKEW_MS` (1 day) after its clock
 * (`not-yet-valid`). The signer checks the same against its own clock before it signs.
 */
export const MAX_MANIFEST_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Replay protection across checks (implemented by the update client, Task 4). Expiry bounds how
 * long an old, correctly signed manifest stays usable, and `decide` never offers a version that is
 * not newer than the running one. On top of that, the client keeps a high-water mark in its prefs:
 * the highest `version` it has verified, with that manifest's `releasedAt`. It refuses (as a replay,
 * offering nothing) a verified manifest whose `version` is below the mark's, or whose `version`
 * equals it with an earlier `releasedAt`, and raises the mark after each manifest it accepts. So a
 * feed that once served 1.3.0 can't later make the client fall back to offering 1.2.0.
 */
export interface UpdateHighWaterMark {
  version: string;
  releasedAt: string;
}

/** An artifact is at most 1 GiB (the download cap, Task 4). */
export const MAX_ARTIFACT_BYTES = 1024 ** 3;

/** An artifact URL is at most this long. */
export const MAX_ARTIFACT_URL_CHARS = 2048;

/**
 * An artifact URL: printable ASCII with no spaces (an internationalised host is written in its
 * punycode form), `https:` only, a host, and no user name or password.
 */
export const UPDATE_ARTIFACT_URL_CHARS_PATTERN = /^[\x21-\x7e]+$/;

/** An artifact's SHA-256: 64 lowercase hex digits. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** An Ed25519 signature is 64 bytes: 88 base64 characters. */
export const ED25519_SIGNATURE_BYTES = 64;

/**
 * The platforms an artifact can be published for (`<process.platform>-<process.arch>`), with the
 * package each one expects (the `make:*` outputs, `macos-package.spec.ts`, `linux-package.spec.ts`,
 * `windows-package.spec.ts`) and the fixed extension the client saves it with:
 * - `darwin-arm64`: the zip of `frost.app` (macOS can't update an unsigned app in place, so the
 *   user unzips and moves it by hand), `.zip`;
 * - `linux-x64`: the AppImage, `.AppImage`;
 * - `win32-x64`: the Squirrel `…-setup.exe`, `.exe`.
 *
 * A manifest lists at least one of them; a platform with no artifact gets `no-artifact`.
 */
export const UPDATE_PLATFORMS = ['darwin-arm64', 'linux-x64', 'win32-x64'] as const;
export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];
export const UPDATE_ARTIFACT_KINDS = {
  'darwin-arm64': { package: 'zip', extension: 'zip' },
  'linux-x64': { package: 'AppImage', extension: 'AppImage' },
  'win32-x64': { package: 'Setup.exe', extension: 'exe' },
} as const satisfies Record<UpdatePlatform, { package: string; extension: string }>;

/** The platform key for this process, or `null` when frost publishes no update for it. */
export function updatePlatformKey(platform: string, arch: string): UpdatePlatform | null {
  const key = `${platform}-${arch}`;
  return (UPDATE_PLATFORMS as readonly string[]).includes(key) ? (key as UpdatePlatform) : null;
}

/**
 * A version: semver `MAJOR.MINOR.PATCH` with an optional `-prerelease` (dot-separated identifiers of
 * `[0-9A-Za-z-]`; numeric identifiers, like the core numbers, without leading zeros). No `+build`
 * metadata. At most `MAX_VERSION_CHARS` characters. Precedence is semver's (§11).
 */
export const MAX_VERSION_CHARS = 64;
export const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/**
 * The name the client saves a downloaded artifact under (in `userData/updates/<version>/`, Task 4):
 * `frost-<version>-<platformKey>.<extension>`, with the extension fixed per platform
 * (`UPDATE_ARTIFACT_KINDS`). Never taken from the artifact URL or a response header. Throws for a
 * string that is not a version or a platform (a version's characters are `[0-9A-Za-z.-]` only).
 */
export function artifactFileName(version: string, platformKey: UpdatePlatform): string {
  if (version.length > MAX_VERSION_CHARS || !VERSION_PATTERN.test(version)) throw new TypeError('not a version');
  if (!(UPDATE_PLATFORMS as readonly string[]).includes(platformKey)) throw new TypeError('not an update platform');
  return `frost-${version}-${platformKey}.${UPDATE_ARTIFACT_KINDS[platformKey].extension}`;
}

/**
 * Strict base64: the standard alphabet (`+`, `/`), padded, no whitespace, and canonical (decoding
 * and re-encoding gives the same text, so the unused bits of the last character are zero).
 */
export const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function isCanonicalBase64(text: string): boolean {
  if (!BASE64_PATTERN.test(text)) return false;
  try {
    return btoa(atob(text)) === text;
  } catch {
    return false;
  }
}

/** Staged rollout: an install's bucket is 0–99 (`rolloutBucket`); it gets the update when its bucket is below `rolloutPercent`. */
export const ROLLOUT_BUCKETS = 100;

/**
 * Why `verifyEnvelope` refused the feed's bytes (a closed list; the client shows the reason):
 * - `too-large`: over `MAX_ENVELOPE_BYTES` (checked before parsing), or a payload over `MAX_MANIFEST_BYTES`;
 * - `not-json`: not UTF-8 JSON;
 * - `duplicate-key`: the envelope, or the signed manifest, repeats a key in some object;
 * - `bad-envelope`: not an envelope (`UpdateEnvelopeSchema`: unknown keys, wrong format, non-canonical base64, a signature that is not 64 bytes);
 * - `unknown-key`: its `keyId` is not in the trusted keys;
 * - `bad-key`: the trusted entry for that `keyId` is not an Ed25519 SPKI public key;
 * - `bad-signature`: the signature does not verify over `UPDATE_SIGNATURE_CONTEXT` + the payload bytes;
 * - `bad-payload`: the signed bytes are not UTF-8 JSON;
 * - `bad-manifest`: the signed JSON is not a manifest (`UpdateManifestSchema`; `minimumVersion` above
 *   `version`; `expiresAt` not after `releasedAt` or more than `MAX_MANIFEST_LIFETIME_MS` after it);
 * - `expired`: its `expiresAt` is not after the client's clock;
 * - `not-yet-valid`: its `releasedAt` is more than `MAX_CLOCK_SKEW_MS` after the client's clock.
 */
export const UPDATE_VERIFY_REASONS = [
  'too-large',
  'not-json',
  'duplicate-key',
  'bad-envelope',
  'unknown-key',
  'bad-key',
  'bad-signature',
  'bad-payload',
  'bad-manifest',
  'expired',
  'not-yet-valid',
] as const;
export type UpdateVerifyReason = (typeof UPDATE_VERIFY_REASONS)[number];

/** One published package. */
export interface UpdateArtifact {
  url: string;
  sha256: string;
  size: number;
}

/** The manifest (the signed JSON). */
export interface UpdateManifest {
  format: typeof UPDATE_MANIFEST_FORMAT;
  version: string;
  /** ISO 8601 date-time, UTC (`…Z`). */
  releasedAt: string;
  /** ISO 8601 date-time, UTC: after `releasedAt`, at most `MAX_MANIFEST_LIFETIME_MS` after it. */
  expiresAt: string;
  notes: string;
  /** An install older than this has a required update: staging and "Skip this version" don't hold it back (it still waits for consent). */
  minimumVersion?: string | undefined;
  /** 0–100: the share of installs (by bucket) offered this version. */
  rolloutPercent: number;
  artifacts: Partial<Record<UpdatePlatform, UpdateArtifact>>;
}

/** The envelope the feed serves. */
export interface UpdateEnvelope {
  format: typeof UPDATE_ENVELOPE_FORMAT;
  keyId: string;
  payload: string;
  signature: string;
}

export type UpdateVerifyResult =
  | { ok: true; manifest: UpdateManifest; keyId: string }
  | { ok: false; reason: UpdateVerifyReason };

/**
 * What `decide` makes of a verified (and fresh) manifest for this install, checked in this order:
 * 1. `up-to-date`: the manifest's version is not newer than the running one (also a replayed or
 *    downgrade manifest);
 * 2. `prerelease-ignored`: the manifest's version is a pre-release and the running one is not (a
 *    release build is only ever offered releases; the client shows it as up to date);
 * 3. `no-artifact`: nothing published for this platform;
 * 4. `required`: the running version is below `minimumVersion` (bypasses skip and staging);
 * 5. `skipped`: the user chose "Skip this version" for exactly this version;
 * 6. `staged-out`: this install's bucket is not below `rolloutPercent`;
 * 7. `available`.
 */
export const UPDATE_DECISIONS = ['up-to-date', 'prerelease-ignored', 'no-artifact', 'required', 'skipped', 'staged-out', 'available'] as const;
export type UpdateDecisionKind = (typeof UPDATE_DECISIONS)[number];

export type UpdateDecision =
  | { kind: 'up-to-date' | 'prerelease-ignored' | 'no-artifact' | 'skipped' | 'staged-out'; version: string }
  | { kind: 'available' | 'required'; version: string; releasedAt: string; notes: string; artifact: UpdateArtifact };

/** What `decide` needs to know about this install. */
export interface UpdateDecideInput {
  currentVersion: string;
  platformKey: UpdatePlatform;
  /** Random, local, never sent (Task 4's prefs). */
  installId: string;
  skippedVersion?: string | undefined;
}
