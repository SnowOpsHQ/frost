import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { SELECTOR_PACK_LIMITS, type PackVerifyFailure } from '@app/specs/serp-selector-pack.spec';
import { SelectorPackSchema, type SelectorPack } from '@app/specs/serp-selector-pack.schema';

// Selector pack verification (spec `serp-selector-pack.spec.ts`, trust model; acceptance
// `serp-selector-pack.feature.md`, Verification; review focus `pack-rejects-forged-and-stale`).
// Pure: bytes, signature text and trusted keys in, a parsed pack or one refusal out; never throws.
// Order matters: the size cap first (nothing past it is read), then the Ed25519 signature over the
// exact bytes against each trusted key, and only then are the bytes decoded and parsed (fatal UTF-8,
// `JSON.parse`, `SelectorPackSchema`), so a forged pack never reaches a parser.

export type PackVerifyResult = { readonly ok: true; readonly pack: SelectorPack } | { readonly ok: false; readonly reason: PackVerifyFailure };

/** Base64 of exactly 64 bytes: 86 characters of the alphabet, then `==`. */
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** A `.sig` file's text as signature bytes, or `null` when it is not one (surrounding whitespace aside). */
export function decodeSignature(text: string): Uint8Array | null {
  if (text.length > SELECTOR_PACK_LIMITS.maxSignatureChars) return null;
  const trimmed = text.trim();
  if (!SIGNATURE_BASE64.test(trimmed)) return null;
  const bytes = Buffer.from(trimmed, 'base64');
  // Canonical base64 only (the last character's unused bits zero), so one signature has one text.
  if (bytes.byteLength !== SELECTOR_PACK_LIMITS.signatureBytes || bytes.toString('base64') !== trimmed) return null;
  return new Uint8Array(bytes);
}

/** A trusted key (SPKI DER, base64) as an Ed25519 public key, or `null` when it is not one. */
function publicKey(spki: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** Whether `signature` is an Ed25519 signature of `bytes` by any of `publicKeys`. */
function signedByAny(bytes: Uint8Array, signature: Uint8Array, publicKeys: readonly string[]): boolean {
  for (const spki of publicKeys) {
    const key = publicKey(spki);
    if (key === null) continue;
    try {
      if (verify(null, bytes, key, signature)) return true;
    } catch {
      // A key or signature the runtime refuses verifies nothing.
    }
  }
  return false;
}

/**
 * Verifies a pack's bytes against its `.sig` text and the trusted keys, then parses it. `too-large`:
 * over `SELECTOR_PACK_LIMITS.maxPackBytes` (unread); `bad-signature`: a malformed signature, or one
 * no trusted key made; `invalid-pack`: signed, but not UTF-8 JSON that is a `SelectorPackSchema` pack.
 */
export function verifyPack(bytes: Uint8Array, signatureText: string, publicKeys: readonly string[]): PackVerifyResult {
  if (bytes.byteLength > SELECTOR_PACK_LIMITS.maxPackBytes) return { ok: false, reason: 'too-large' };
  const signature = decodeSignature(signatureText);
  if (signature === null || !signedByAny(bytes, signature, publicKeys)) return { ok: false, reason: 'bad-signature' };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return { ok: false, reason: 'invalid-pack' };
  }
  const parsed = SelectorPackSchema.safeParse(value);
  return parsed.success ? { ok: true, pack: parsed.data } : { ok: false, reason: 'invalid-pack' };
}
