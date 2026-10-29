import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  ED25519_SIGNATURE_BYTES,
  MAX_CLOCK_SKEW_MS,
  MAX_ENVELOPE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_LIFETIME_MS,
  MAX_VERSION_CHARS,
  ROLLOUT_BUCKETS,
  UPDATE_PUBLIC_KEYS,
  UPDATE_SIGNATURE_CONTEXT,
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
 * Nothing in the feed's bytes is believed before the Ed25519 signature over
 * `UPDATE_SIGNATURE_CONTEXT` + the exact payload bytes verifies against a trusted key: the size is
 * capped first, then the envelope is parsed, and only the verified payload is decoded and parsed as
 * a manifest, which must then be fresh against the caller's clock.
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

/**
 * Whether JSON text repeats a key in any object, at any depth (`"a"` and `"\u0061"` are the same
 * key). For text `JSON.parse` has already accepted: it only tracks strings, braces, brackets and
 * commas, so it relies on the text being valid JSON.
 */
export function hasDuplicateKeys(text: string): boolean {
  // One entry per open container: the keys seen so far for an object, `null` for an array.
  const open: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const keys = open.at(-1);
      if (expectKey && keys instanceof Set) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
      i = end;
    } else if (char === '{') {
      open.push(new Set());
      expectKey = true;
    } else if (char === '[') {
      open.push(null);
      expectKey = false;
    } else if (char === '}' || char === ']') {
      open.pop();
      expectKey = false;
    } else if (char === ',') {
      expectKey = open.at(-1) instanceof Set;
    }
  }
  return false;
}

/** UTF-8 JSON with no repeated key in any object: its value, or why not. */
export function readJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false; reason: 'not-json' | 'duplicate-key' } {
  const text = decodeUtf8(bytes);
  if (text === null) return { ok: false, reason: 'not-json' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  return hasDuplicateKeys(text) ? { ok: false, reason: 'duplicate-key' } : { ok: true, value };
}

/** What is signed and verified: `UPDATE_SIGNATURE_CONTEXT` (UTF-8) followed by the payload bytes. */
export function signatureInput(payload: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(UPDATE_SIGNATURE_CONTEXT, 'utf8'), payload]);
}

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
 * A manifest from parsed JSON: `UpdateManifestSchema`, a `minimumVersion` (if any) not above
 * `version`, and an `expiresAt` after `releasedAt` by at most `MAX_MANIFEST_LIFETIME_MS`. `error`
 * names the first problems (paths and messages, for the signer). Freshness against a clock is
 * `checkFreshness`.
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
  const lifetime = Date.parse(manifest.expiresAt) - Date.parse(manifest.releasedAt);
  if (!(lifetime > 0)) return { ok: false, error: 'expiresAt: not after releasedAt' };
  if (lifetime > MAX_MANIFEST_LIFETIME_MS) return { ok: false, error: 'expiresAt: more than MAX_MANIFEST_LIFETIME_MS after releasedAt' };
  return { ok: true, manifest };
}

/**
 * Whether a manifest is usable at `now` (ms since the epoch): `expired` once `now` reaches
 * `expiresAt` (or `now` is not a number), `not-yet-valid` while `releasedAt` is more than
 * `MAX_CLOCK_SKEW_MS` ahead of `now`, else `null`.
 */
export function checkFreshness(manifest: Pick<UpdateManifest, 'releasedAt' | 'expiresAt'>, now: number): 'expired' | 'not-yet-valid' | null {
  if (!Number.isFinite(now) || now >= Date.parse(manifest.expiresAt)) return 'expired';
  if (Date.parse(manifest.releasedAt) - now > MAX_CLOCK_SKEW_MS) return 'not-yet-valid';
  return null;
}

/**
 * Verifies the feed's bytes against the trusted keys (`UPDATE_PUBLIC_KEYS` unless a test injects
 * its own) and, only if the signature verifies, parses the signed payload as a manifest and checks
 * it is fresh at `now` (the caller's clock, ms since the epoch).
 */
export function verifyEnvelope(
  bytes: Uint8Array,
  { now, keys = UPDATE_PUBLIC_KEYS }: { now: number; keys?: Readonly<Record<string, string>> },
): UpdateVerifyResult {
  // 1. The size, before anything is parsed.
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) return refuse('too-large');

  // 2. The envelope: UTF-8 JSON without repeated keys, strictly shaped, strict base64.
  const json = readJson(bytes);
  if (!json.ok) return refuse(json.reason);
  const envelope = UpdateEnvelopeSchema.safeParse(json.value);
  if (!envelope.success) return refuse('bad-envelope');
  const { keyId } = envelope.data;
  const payload = decodeBase64(envelope.data.payload);
  const signature = decodeBase64(envelope.data.signature);
  if (payload === null || signature === null || signature.length !== ED25519_SIGNATURE_BYTES) return refuse('bad-envelope');
  if (payload.length > MAX_MANIFEST_BYTES) return refuse('too-large');

  // 3. The key and the signature over the context prefix and the exact payload bytes.
  const key = trustedKey(keys, keyId);
  if (key === 'unknown') return refuse('unknown-key');
  if (key === 'bad') return refuse('bad-key');
  let valid = false;
  try {
    valid = verify(null, signatureInput(payload), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return refuse('bad-signature');

  // 4. Only now: the signed bytes as a manifest, fresh at `now`.
  const manifestJson = readJson(payload);
  if (!manifestJson.ok) return refuse(manifestJson.reason === 'duplicate-key' ? 'duplicate-key' : 'bad-payload');
  const manifest = parseManifest(manifestJson.value);
  if (!manifest.ok) return refuse('bad-manifest');
  const stale = checkFreshness(manifest.manifest, now);
  if (stale !== null) return refuse(stale);
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

const isPrerelease = (version: string) => version.includes('-');

/**
 * What a verified, fresh manifest means for this install (`UPDATE_DECISIONS`, in that order).
 * Decided on the device: nothing about the install leaves it, and the bucket is not reported.
 * Throws if `currentVersion` is not a version.
 */
export function decide(manifest: UpdateManifest, input: UpdateDecideInput): UpdateDecision {
  const { version } = manifest;
  if (compareVersions(version, input.currentVersion) <= 0) return { kind: 'up-to-date', version };
  if (isPrerelease(version) && !isPrerelease(input.currentVersion)) return { kind: 'prerelease-ignored', version };
  const artifact = Object.hasOwn(manifest.artifacts, input.platformKey) ? manifest.artifacts[input.platformKey] : undefined;
  if (artifact === undefined) return { kind: 'no-artifact', version };
  const offer = { version, releasedAt: manifest.releasedAt, notes: manifest.notes, artifact };
  if (manifest.minimumVersion !== undefined && compareVersions(input.currentVersion, manifest.minimumVersion) < 0) {
    return { kind: 'required', ...offer };
  }
  if (input.skippedVersion === version) return { kind: 'skipped', version };
  if (rolloutBucket(input.installId, version) >= manifest.rolloutPercent) return { kind: 'staged-out', version };
  return { kind: 'available', ...offer };
}
