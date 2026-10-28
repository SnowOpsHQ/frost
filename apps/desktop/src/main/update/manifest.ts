import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  ED25519_SIGNATURE_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_VERSION_CHARS,
  ROLLOUT_BUCKETS,
  UPDATE_PUBLIC_KEYS,
  VERSION_PATTERN,
  isCanonicalBase64,
  type UpdateDecideInput,
  type UpdateDecision,
  type UpdateManifest,
  type UpdateVerifyReason,
  type UpdateVerifyResult,
} from '@app/specs/update-manifest.spec';
import { UpdateEnvelopeSchema, UpdateManifestSchema } from '@app/specs/update-manifest.schema';

/**
 * The signed update manifest (specs/update-manifest.spec.ts; acceptance:
 * specs/update-manifest.feature.md). Pure Node, no Electron: the update client (Task 4) and the
 * maintainer's signer (`scripts/sign-update-manifest.mjs`, loaded there with Node's type stripping,
 * so erasable TypeScript only) both use it.
 *
 * Nothing in the feed's bytes is believed before the Ed25519 signature over the exact payload bytes
 * verifies against a trusted key: the size is capped first, then the envelope is parsed, and only
 * the verified payload is decoded and parsed as a manifest.
 */

const refuse = (reason: UpdateVerifyReason): UpdateVerifyResult => ({ ok: false, reason });

/** UTF-8 that refuses invalid sequences (a lenient decoder would substitute U+FFFD). */
const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const parseJson = (text: string): { value: unknown } | null => {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
};

/**
 * Strict base64 to bytes: `null` unless `text` is canonical (`isCanonicalBase64`), and, as a second
 * check with Node's own codec, unless the bytes re-encode to exactly `text`.
 */
function decodeBase64(text: string): Buffer | null {
  if (!isCanonicalBase64(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

/** The trusted Ed25519 public key for `keyId`, `'unknown'` if none, `'bad'` if it isn't an Ed25519 SPKI key. */
function trustedKey(keys: Readonly<Record<string, string>>, keyId: string): KeyObject | 'unknown' | 'bad' {
  if (!Object.hasOwn(keys, keyId)) return 'unknown';
  const spki = keys[keyId];
  const der = typeof spki === 'string' ? decodeBase64(spki) : null;
  if (der === null || der.length === 0) return 'bad';
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.type === 'public' && key.asymmetricKeyType === 'ed25519' ? key : 'bad';
  } catch {
    return 'bad';
  }
}

/**
 * A manifest from parsed JSON: `UpdateManifestSchema`, and a `minimumVersion` (if any) not above
 * `version`. `error` names the first problems (paths and messages, for the signer).
 */
export function parseManifest(value: unknown): { ok: true; manifest: UpdateManifest } | { ok: false; error: string } {
  const parsed = UpdateManifestSchema.safeParse(value);
  if (!parsed.success) {
    const error = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join('.') || '(manifest)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error };
  }
  const manifest = parsed.data;
  if (manifest.minimumVersion !== undefined && compareVersions(manifest.minimumVersion, manifest.version) > 0) {
    return { ok: false, error: 'minimumVersion: above version' };
  }
  return { ok: true, manifest };
}

/**
 * Verifies the feed's bytes against the trusted keys (`UPDATE_PUBLIC_KEYS` unless a test injects
 * its own) and, only if the signature verifies, parses the signed payload as a manifest.
 */
export function verifyEnvelope(bytes: Uint8Array, keys: Readonly<Record<string, string>> = UPDATE_PUBLIC_KEYS): UpdateVerifyResult {
  // 1. The size, before anything is parsed.
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) return refuse('too-large');

  // 2. The envelope: UTF-8 JSON, strictly shaped, strict base64.
  const text = decodeUtf8(bytes);
  const json = text === null ? null : parseJson(text);
  if (json === null) return refuse('not-json');
  const envelope = UpdateEnvelopeSchema.safeParse(json.value);
  if (!envelope.success) return refuse('bad-envelope');
  const { keyId } = envelope.data;
  const payload = decodeBase64(envelope.data.payload);
  const signature = decodeBase64(envelope.data.signature);
  if (payload === null || signature === null || signature.length !== ED25519_SIGNATURE_BYTES) return refuse('bad-envelope');
  if (payload.length > MAX_MANIFEST_BYTES) return refuse('too-large');

  // 3. The key and the signature over the exact payload bytes.
  const key = trustedKey(keys, keyId);
  if (key === 'unknown') return refuse('unknown-key');
  if (key === 'bad') return refuse('bad-key');
  let valid = false;
  try {
    valid = verify(null, payload, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return refuse('bad-signature');

  // 4. Only now: the signed bytes as a manifest.
  const manifestText = decodeUtf8(payload);
  const manifestJson = manifestText === null ? null : parseJson(manifestText);
  if (manifestJson === null) return refuse('bad-payload');
  const manifest = parseManifest(manifestJson.value);
  if (!manifest.ok) return refuse('bad-manifest');
  return { ok: true, manifest: manifest.manifest, keyId };
}

// ---- Versions -----------------------------------------------------------------------------------

/** Whether `value` is a version (`VERSION_PATTERN`, at most `MAX_VERSION_CHARS`). */
export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_VERSION_CHARS && VERSION_PATTERN.test(value);
}

const NUMERIC = /^\d+$/;

/** Two digit strings without leading zeros, compared as numbers of any size. */
const compareNumeric = (a: string, b: string) => (a.length !== b.length ? Math.sign(a.length - b.length) : a < b ? -1 : a > b ? 1 : 0);

/** Semver §11.4: one pre-release identifier against another. */
function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return compareNumeric(a, b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function versionParts(version: string) {
  if (!isVersion(version)) throw new TypeError('not a version');
  const dash = version.indexOf('-');
  const core = (dash === -1 ? version : version.slice(0, dash)).split('.');
  const prerelease = dash === -1 ? [] : version.slice(dash + 1).split('.');
  return { core, prerelease };
}

/**
 * Semver precedence (§11): -1, 0 or 1. The core numbers compare numerically; a version with a
 * pre-release is below the same version without; pre-release identifiers compare left to right.
 * Throws a `TypeError` for anything that is not a version (`isVersion`).
 */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(left.core[i]!, right.core[i]!);
    if (order !== 0) return order;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const order = compareIdentifier(left.prerelease[i]!, right.prerelease[i]!);
    if (order !== 0) return order;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

// ---- Staging and eligibility ---------------------------------------------------------------------

/** This install's bucket for `version`, 0–99: SHA-256(`installId:version`), first 4 bytes big-endian, mod 100. */
export function rolloutBucket(installId: string, version: string): number {
  return createHash('sha256').update(`${installId}:${version}`, 'utf8').digest().readUInt32BE(0) % ROLLOUT_BUCKETS;
}

/**
 * What a verified manifest means for this install (`UPDATE_DECISIONS`, in that order). Decided on
 * the device: nothing about the install leaves it. Throws if `currentVersion` is not a version.
 */
export function decide(manifest: UpdateManifest, input: UpdateDecideInput): UpdateDecision {
  const { version } = manifest;
  if (compareVersions(version, input.currentVersion) <= 0) return { kind: 'up-to-date', version };
  const artifact = Object.hasOwn(manifest.artifacts, input.platformKey) ? manifest.artifacts[input.platformKey] : undefined;
  if (artifact === undefined) return { kind: 'no-artifact', version };
  const offer = { version, releasedAt: manifest.releasedAt, notes: manifest.notes, artifact };
  if (manifest.minimumVersion !== undefined && compareVersions(input.currentVersion, manifest.minimumVersion) < 0) {
    return { kind: 'required', ...offer };
  }
  if (input.skippedVersion === version) return { kind: 'skipped', version };
  const bucket = rolloutBucket(input.installId, version);
  if (bucket >= manifest.rolloutPercent) return { kind: 'staged-out', version, bucket };
  return { kind: 'available', ...offer };
}
