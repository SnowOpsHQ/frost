// Spec: specs/serp-selector-pack.spec.ts (trust model, SELECTOR_PACK_LIMITS, PACK_VERIFY_FAILURES);
// specs/serp-selector-pack.schema.ts (SelectorPackSchema)
// Acceptance: specs/serp-selector-pack.feature.md (Verification); review focus pack-rejects-forged-and-stale
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PACK_VERIFY_FAILURES, SELECTOR_PACK_LIMITS } from '@app/specs/serp-selector-pack.spec';
import { SelectorPackSchema } from '@app/specs/serp-selector-pack.schema';
import { verifyPack } from '../pack-verify';
import { encode, packObject, signBytes, signedPack, testKey } from './pack-keys';

afterEach(() => vi.restoreAllMocks());

const KEY = testKey();
const OTHER = testKey();

describe('verifyPack', () => {
  test('pack-accepts-valid-signature', () => {
    const { bytes, signature } = signedPack(KEY);
    const result = verifyPack(bytes, signature, [KEY.spki]);
    expect(result).toMatchObject({ ok: true, pack: { format: 1, version: 2, engines: [{ id: 'example' }] } });
    // A `.sig` file's final newline (or other surrounding whitespace) is not part of the signature.
    expect(verifyPack(bytes, `  ${signature}\n`, [KEY.spki]).ok).toBe(true);
    // Any one trusted key will do (a rotation lists two).
    expect(verifyPack(bytes, signature, [OTHER.spki, KEY.spki]).ok).toBe(true);
  });

  test('pack-rejects-forged-and-stale', () => {
    const { bytes, signature } = signedPack(KEY);
    // One changed byte.
    const changed = bytes.slice();
    changed[10] = changed[10]! ^ 0x01;
    expect(verifyPack(changed, signature, [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    // Signed by another key; or verified against no key at all.
    expect(verifyPack(bytes, signBytes(bytes, OTHER), [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyPack(bytes, signature, [])).toEqual({ ok: false, reason: 'bad-signature' });
    // A truncated, non-base64, empty, or wrong-length signature.
    expect(verifyPack(bytes, signature.slice(0, 40), [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyPack(bytes, signature.replace(/[A-Za-z]/, '*'), [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyPack(bytes, '', [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyPack(bytes, `${signature.slice(0, 20)} ${signature.slice(20)}`, [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    // Non-canonical base64: the last character's unused bits set decodes to the same bytes, but is refused.
    const last = signature.at(-3)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const sloppy = `${signature.slice(0, -3)}${alphabet[alphabet.indexOf(last) | 0x03]}${signature.slice(-2)}`;
    if (sloppy !== signature) expect(verifyPack(bytes, sloppy, [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    const raw = Buffer.from(signature, 'base64');
    expect(verifyPack(bytes, raw.subarray(0, 63).toString('base64'), [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyPack(bytes, Buffer.concat([raw, Buffer.of(0)]).toString('base64'), [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    // A valid signature over something that is not a valid pack.
    for (const invalid of [encode('not json'), Uint8Array.of(0xff, 0xfe, 0x7b, 0x7d), encode({ ...packObject(), extra: true }), encode(packObject({ version: 0 }))]) {
      expect(verifyPack(invalid, signBytes(invalid, KEY), [KEY.spki])).toEqual({ ok: false, reason: 'invalid-pack' });
    }
    // Every refusal is one of the spec's.
    expect(PACK_VERIFY_FAILURES).toEqual(['too-large', 'bad-signature', 'invalid-pack']);
  });

  test('pack-verifies-before-parsing', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const forged = encode('{"format":1,"version":99}');
    expect(verifyPack(forged, signBytes(encode('something else'), KEY), [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
    expect(parse).not.toHaveBeenCalled();
    const { bytes, signature } = signedPack(KEY);
    expect(verifyPack(bytes, signature, [KEY.spki]).ok).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  test('pack-too-large-never-read', () => {
    const parse = vi.spyOn(JSON, 'parse');
    // A validly signed pack one byte over the cap (padded with whitespace, still valid JSON).
    const base = encode(packObject());
    const big = new Uint8Array(SELECTOR_PACK_LIMITS.maxPackBytes + 1).fill(0x20);
    big.set(base);
    expect(verifyPack(big, signBytes(big, KEY), [KEY.spki])).toEqual({ ok: false, reason: 'too-large' });
    expect(parse).not.toHaveBeenCalled();
    // Exactly at the cap is fine.
    const full = big.subarray(0, SELECTOR_PACK_LIMITS.maxPackBytes);
    expect(verifyPack(full, signBytes(full, KEY), [KEY.spki]).ok).toBe(true);
    // An over-long `.sig` text is refused before it is decoded.
    const { bytes, signature } = signedPack(KEY);
    expect(verifyPack(bytes, `${signature}${' '.repeat(SELECTOR_PACK_LIMITS.maxSignatureChars)}`, [KEY.spki])).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('pack-ignores-unusable-keys', () => {
    const { bytes, signature } = signedPack(KEY);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const x25519 = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    for (const unusable of ['', 'not a key', 'AAAA', rsa, x25519]) {
      expect(verifyPack(bytes, signature, [unusable])).toEqual({ ok: false, reason: 'bad-signature' });
    }
    expect(verifyPack(bytes, signature, ['not a key', rsa, KEY.spki]).ok).toBe(true);
  });
});

describe('SelectorPackSchema', () => {
  const engine = (packObject().engines as Record<string, unknown>[])[0]!;
  const withEngine = (patch: Record<string, unknown>) => packObject({ engines: [{ ...engine, ...patch }] });
  const layout = engine.layout as { results: string; blocks: Record<string, unknown>[] };
  const withBlock = (patch: Record<string, unknown>) => withEngine({ layout: { ...layout, blocks: [{ ...layout.blocks[0], ...patch }] } });

  test('pack-schema-is-strict-and-capped', () => {
    expect(SelectorPackSchema.safeParse(packObject()).success).toBe(true);
    const refused = [
      packObject({ extra: 1 }),
      packObject({ format: 2 }),
      packObject({ version: 0 }),
      packObject({ version: 1.5 }),
      packObject({ published: 'yesterday' }),
      packObject({ engines: [] }),
      packObject({ engines: Array.from({ length: SELECTOR_PACK_LIMITS.maxEngines + 1 }, (_, i) => ({ ...engine, id: `e${i}`, hosts: [`s${i}.example.com`] })) }),
      packObject({ engines: [engine, { ...engine, hosts: ['other.example.com'] }] }),
      packObject({ engines: [engine, { ...engine, id: 'other' }] }),
      withEngine({ extra: 1 }),
      withEngine({ id: 'Google' }),
      withEngine({ hosts: ['Search.example.com'] }),
      withEngine({ hosts: ['*.example.com'] }),
      withEngine({ hosts: ['search.example.com:443'] }),
      withEngine({ paths: ['search'] }),
      withEngine({ paths: ['/search?q='] }),
      withEngine({ params: { query: [] } }),
      withEngine({ params: { query: ['q'], page: { param: 'start', kind: 'offset' } } }),
      withEngine({ params: { query: ['q'], unknown: ['x'] } }),
      withEngine({ layout: { blocks: layout.blocks } }),
      withEngine({ layout: { ...layout, blocks: [] } }),
      withEngine({ layout: { ...layout, blocks: Array.from({ length: SELECTOR_PACK_LIMITS.maxBlocksPerEngine + 1 }, () => layout.blocks[0]) } }),
      withBlock({ type: 'carousel' }),
      withBlock({ container: '' }),
      withBlock({ container: '   ' }),
      withBlock({ item: 'a'.repeat(SELECTOR_PACK_LIMITS.maxSelectorChars + 1) }),
      withBlock({ title: 'h3\nh2' }),
      withBlock({ required: 'yes' }),
      withBlock({ script: 'alert(1)' }),
    ];
    for (const pack of refused) expect(SelectorPackSchema.safeParse(pack).success, JSON.stringify(pack).slice(0, 200)).toBe(false);
    // Optional parts may be left out; a page-number parameter needs no perPage.
    expect(SelectorPackSchema.safeParse(withEngine({ params: { query: ['q', 'p'], page: { param: 'page', kind: 'page' } } })).success).toBe(true);
    expect(SelectorPackSchema.safeParse(withBlock({ item: undefined, link: undefined, title: undefined, required: undefined })).success).toBe(true);
    expect(SelectorPackSchema.safeParse(withBlock({ item: 'a'.repeat(SELECTOR_PACK_LIMITS.maxSelectorChars) })).success).toBe(true);
  });
});
