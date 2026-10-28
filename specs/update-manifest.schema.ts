/**
 * The Zod side of the signed update manifest (Phase 7 Task 3; plain values in
 * `update-manifest.spec.ts`; acceptance `update-manifest.feature.md`): the envelope the feed serves
 * and the manifest inside it. Main-only (Zod), and the signing script's pre-signing check. Strict
 * throughout: an unknown key anywhere is refused.
 */
import { z } from 'zod';
import {
  BASE64_PATTERN,
  ED25519_SIGNATURE_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_URL_CHARS,
  MAX_NOTES_CHARS,
  MAX_PAYLOAD_CHARS,
  MAX_VERSION_CHARS,
  SHA256_HEX_PATTERN,
  UPDATE_ARTIFACT_URL_CHARS_PATTERN,
  UPDATE_ENVELOPE_FORMAT,
  UPDATE_KEY_ID_PATTERN,
  UPDATE_MANIFEST_FORMAT,
  UPDATE_NOTES_PATTERN,
  UPDATE_PLATFORMS,
  VERSION_PATTERN,
  isCanonicalBase64,
  type UpdateEnvelope,
  type UpdateManifest,
} from './update-manifest.spec';

/** Strict base64 (`BASE64_PATTERN`, canonical) of at most `maxChars` characters. */
const base64 = (maxChars: number) =>
  z.string().max(maxChars).regex(BASE64_PATTERN).refine(isCanonicalBase64, { message: 'not canonical base64' });

/** The base64 length of `ED25519_SIGNATURE_BYTES` bytes (88). */
const SIGNATURE_CHARS = 4 * Math.ceil(ED25519_SIGNATURE_BYTES / 3);

/** `version` / `minimumVersion` (`VERSION_PATTERN`, at most `MAX_VERSION_CHARS`). */
export const UpdateVersionSchema = z.string().max(MAX_VERSION_CHARS).regex(VERSION_PATTERN);

/** An `https:` URL with a host and no user name or password (`UPDATE_ARTIFACT_URL_CHARS_PATTERN`). */
export const UpdateArtifactUrlSchema = z
  .string()
  .max(MAX_ARTIFACT_URL_CHARS)
  .regex(UPDATE_ARTIFACT_URL_CHARS_PATTERN)
  .refine(
    (text) => {
      if (!URL.canParse(text)) return false;
      const url = new URL(text);
      return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
    },
    { message: 'not an https: URL without credentials' },
  );

/** One published package. */
export const UpdateArtifactSchema = z.strictObject({
  url: UpdateArtifactUrlSchema,
  sha256: z.string().regex(SHA256_HEX_PATTERN),
  size: z.int().min(1).max(MAX_ARTIFACT_BYTES),
});

/**
 * `artifacts`: an object whose own keys are all `UPDATE_PLATFORMS` (checked on the input, because a
 * Zod record drops a `__proto__` key rather than refusing it), with at least one entry.
 */
const UpdateArtifactsSchema = z
  .custom<Record<string, unknown>>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => (UPDATE_PLATFORMS as readonly string[]).includes(key)),
    { message: 'artifacts: an object keyed by UPDATE_PLATFORMS' },
  )
  .pipe(z.partialRecord(z.enum(UPDATE_PLATFORMS), UpdateArtifactSchema))
  .refine((artifacts) => Object.keys(artifacts).length > 0, { message: 'artifacts: at least one platform' });

/**
 * The manifest (the signed JSON). `minimumVersion` above `version` is refused by `parseManifest`
 * (`apps/desktop/src/main/update/manifest.ts`), which owns version precedence.
 */
export const UpdateManifestSchema = z.strictObject({
  format: z.literal(UPDATE_MANIFEST_FORMAT),
  version: UpdateVersionSchema,
  releasedAt: z.iso.datetime(),
  notes: z.string().max(MAX_NOTES_CHARS).regex(UPDATE_NOTES_PATTERN),
  minimumVersion: UpdateVersionSchema.optional(),
  rolloutPercent: z.int().min(0).max(100),
  artifacts: UpdateArtifactsSchema,
}) satisfies z.ZodType<UpdateManifest>;

/**
 * The envelope the feed serves: `payload` is strict base64 of at most `MAX_PAYLOAD_CHARS`
 * characters, `signature` strict base64 of exactly `ED25519_SIGNATURE_BYTES` bytes.
 */
export const UpdateEnvelopeSchema = z.strictObject({
  format: z.literal(UPDATE_ENVELOPE_FORMAT),
  keyId: z.string().regex(UPDATE_KEY_ID_PATTERN),
  payload: base64(MAX_PAYLOAD_CHARS).min(4),
  signature: base64(SIGNATURE_CHARS)
    .length(SIGNATURE_CHARS)
    .refine((text) => isCanonicalBase64(text) && atob(text).length === ED25519_SIGNATURE_BYTES, { message: 'not a 64-byte signature' }),
}) satisfies z.ZodType<UpdateEnvelope>;
