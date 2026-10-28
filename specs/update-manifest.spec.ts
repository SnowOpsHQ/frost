/**
 * The signed update manifest (design doc §4 Phase 7: auto-update, signed and staged; Phase 7 Task 3).
 * The Zod side is `update-manifest.schema.ts`; acceptance `update-manifest.feature.md`. Implemented
 * by `apps/desktop/src/main/update/manifest.ts` (verify, compare, decide) and
 * `scripts/sign-update-manifest.mjs` (`pnpm sign:update-manifest`, the maintainer's signer).
 *
 * The feed serves one **envelope**: `{ format: 1, keyId, payload, signature }`. `payload` is the
 * base64 of the exact manifest JSON bytes and `signature` the base64 Ed25519 signature over those
 * bytes. Nothing is canonicalised: the bytes the maintainer reviewed are the bytes that are signed,
 * and the app parses the manifest only after the signature over them verifies.
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
 * Release notes are plain text, at most 8192 UTF-16 code units, with no control characters except
 * tab, line feed and carriage return. (Even fully `\u`-escaped they fit in `MAX_MANIFEST_BYTES`.)
 */
export const MAX_NOTES_CHARS = 8192;
export const UPDATE_NOTES_PATTERN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

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
 * `windows-package.spec.ts`):
 * - `darwin-arm64`: the zip of `frost.app` (macOS can't update an unsigned app in place, so the
 *   user unzips and moves it by hand);
 * - `linux-x64`: the AppImage;
 * - `win32-x64`: the Squirrel `…-setup.exe`.
 *
 * A manifest lists at least one of them; a platform with no artifact gets `no-artifact`.
 */
export const UPDATE_PLATFORMS = ['darwin-arm64', 'linux-x64', 'win32-x64'] as const;
export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];
export const UPDATE_ARTIFACT_KINDS = {
  'darwin-arm64': 'zip',
  'linux-x64': 'AppImage',
  'win32-x64': 'Setup.exe',
} as const satisfies Record<UpdatePlatform, string>;

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
 * - `bad-envelope`: not an envelope (`UpdateEnvelopeSchema`: unknown keys, wrong format, non-canonical base64, a signature that is not 64 bytes);
 * - `unknown-key`: its `keyId` is not in the trusted keys;
 * - `bad-key`: the trusted entry for that `keyId` is not an Ed25519 SPKI public key;
 * - `bad-signature`: the signature does not verify over the payload bytes;
 * - `bad-payload`: the signed bytes are not UTF-8 JSON;
 * - `bad-manifest`: the signed JSON is not a manifest (`UpdateManifestSchema`, `minimumVersion` above `version`).
 */
export const UPDATE_VERIFY_REASONS = [
  'too-large',
  'not-json',
  'bad-envelope',
  'unknown-key',
  'bad-key',
  'bad-signature',
  'bad-payload',
  'bad-manifest',
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
 * What `decide` makes of a verified manifest for this install, checked in this order:
 * 1. `up-to-date`: the manifest's version is not newer than the running one (also a replayed or
 *    downgrade manifest);
 * 2. `no-artifact`: nothing published for this platform;
 * 3. `required`: the running version is below `minimumVersion` (bypasses skip and staging);
 * 4. `skipped`: the user chose "Skip this version" for exactly this version;
 * 5. `staged-out`: this install's bucket is not below `rolloutPercent`;
 * 6. `available`.
 */
export const UPDATE_DECISIONS = ['up-to-date', 'no-artifact', 'required', 'skipped', 'staged-out', 'available'] as const;
export type UpdateDecisionKind = (typeof UPDATE_DECISIONS)[number];

export type UpdateDecision =
  | { kind: 'up-to-date' | 'no-artifact' | 'skipped'; version: string }
  | { kind: 'staged-out'; version: string; bucket: number }
  | { kind: 'available' | 'required'; version: string; releasedAt: string; notes: string; artifact: UpdateArtifact };

/** What `decide` needs to know about this install. */
export interface UpdateDecideInput {
  currentVersion: string;
  platformKey: UpdatePlatform;
  /** Random, local, never sent (Task 4's prefs). */
  installId: string;
  skippedVersion?: string | undefined;
}
