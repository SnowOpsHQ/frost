// Spec: specs/update-manifest.spec.ts, specs/update-manifest.schema.ts · Acceptance: specs/update-manifest.feature.md (Verifying the envelope, Deciding)
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  MAX_ENVELOPE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_NOTES_CHARS,
  MAX_VERSION_CHARS,
  ROLLOUT_BUCKETS,
  UPDATE_PUBLIC_KEYS,
  type UpdateDecideInput,
  type UpdateManifest,
} from '@app/specs/update-manifest.spec';
import { compareVersions, decide, isVersion, rolloutBucket, verifyEnvelope } from '../manifest';

const KEY_ID = 'test-key';

/** A fresh Ed25519 key pair and its SPKI DER base64 (the form `UPDATE_PUBLIC_KEYS` holds). */
function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

const TRUSTED = ed25519();
const KEYS = { [KEY_ID]: TRUSTED.spki };

const ARTIFACT = {
  url: 'https://updates.example.invalid/frost-1.2.0-linux-x64.AppImage',
  sha256: 'a'.repeat(64),
  size: 123_456_789,
};

const MANIFEST = {
  format: 1,
  version: '1.2.0',
  releasedAt: '2026-10-28T12:00:00Z',
  notes: 'Fixes.\n\n- One thing\n- Another',
  rolloutPercent: 100,
  artifacts: {
    'darwin-arm64': { url: 'https://updates.example.invalid/frost-darwin-arm64-1.2.0.zip', sha256: 'b'.repeat(64), size: 1000 },
    'linux-x64': ARTIFACT,
    'win32-x64': { url: 'https://updates.example.invalid/frost-1.2.0-x64-setup.exe', sha256: 'c'.repeat(64), size: 2000 },
  },
} as const;

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** An envelope (as an object) over `payload` bytes, signed by `key`. */
function envelopeOf(payload: Uint8Array, key: KeyObject = TRUSTED.privateKey, keyId = KEY_ID) {
  return { format: 1, keyId, payload: b64(payload), signature: b64(sign(null, payload, key)) };
}
const bytesOf = (envelope: unknown) => encode(envelope);
const signed = (manifest: unknown, key?: KeyObject, keyId?: string) => bytesOf(envelopeOf(encode(manifest), key, keyId));

const reasonOf = (bytes: Uint8Array, keys: Readonly<Record<string, string>> = KEYS) => {
  const result = verifyEnvelope(bytes, keys);
  return result.ok ? 'ok' : result.reason;
};

/** Flips the low bit of byte `index` of base64 `text`'s bytes, re-encoded canonically. */
function flipByte(text: string, index: number) {
  const bytes = Buffer.from(text, 'base64');
  bytes[index] = bytes[index]! ^ 1;
  return bytes.toString('base64');
}

/** The same bytes, encoded with a non-zero unused bit in the last base64 character (needs padding). */
function nonZeroTrailingBits(text: string) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = text.replace(/=+$/, '').length - 1;
  const char = ALPHABET[ALPHABET.indexOf(text[last]!) | 1]!;
  return text.slice(0, last) + char + text.slice(last + 1);
}

/** A manifest whose payload's base64 satisfies `predicate` (by shifting non-ASCII notes along). */
function payloadWhere(predicate: (base64: string) => boolean) {
  for (let i = 0; i < 64; i++) {
    const payload = encode({ ...MANIFEST, notes: `Notes${'.'.repeat(i)} ÿÿÿ~~~???` });
    if (predicate(b64(payload))) return payload;
  }
  throw new Error('no such payload');
}

describe('verifyEnvelope', () => {
  test('accepts-signed-manifest', () => {
    const result = verifyEnvelope(signed(MANIFEST), KEYS);
    expect(result).toEqual({ ok: true, manifest: MANIFEST, keyId: KEY_ID });
    // Whitespace around the envelope's JSON and a minimum version are fine too.
    const withMinimum = { ...MANIFEST, minimumVersion: '1.0.0-beta.2' };
    const pretty = new TextEncoder().encode(`${JSON.stringify(envelopeOf(encode(withMinimum)), null, 2)}\n`);
    expect(verifyEnvelope(pretty, KEYS)).toEqual({ ok: true, manifest: withMinimum, keyId: KEY_ID });
  });

  test('rejects-bad-signature', () => {
    const good = envelopeOf(encode(MANIFEST));
    expect(reasonOf(bytesOf(good))).toBe('ok');

    // Any change to the signed bytes, or to the signature.
    expect(reasonOf(bytesOf({ ...good, payload: flipByte(good.payload, 10) }))).toBe('bad-signature');
    expect(reasonOf(bytesOf({ ...good, payload: flipByte(good.payload, encode(MANIFEST).length - 1) }))).toBe('bad-signature');
    expect(reasonOf(bytesOf({ ...good, signature: flipByte(good.signature, 0) }))).toBe('bad-signature');
    expect(reasonOf(bytesOf({ ...good, signature: flipByte(good.signature, 63) }))).toBe('bad-signature');

    // Another key, claiming the trusted keyId; and a keyId nobody trusts.
    expect(reasonOf(signed(MANIFEST, ed25519().privateKey))).toBe('bad-signature');
    expect(reasonOf(signed(MANIFEST, TRUSTED.privateKey, 'other-key'))).toBe('unknown-key');
    expect(reasonOf(signed(MANIFEST, TRUSTED.privateKey, 'constructor'))).toBe('unknown-key');
    expect(reasonOf(signed(MANIFEST, TRUSTED.privateKey, 'hasownproperty'))).toBe('unknown-key');

    // A trusted entry that is not an Ed25519 SPKI key.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const x25519 = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    for (const spki of [rsa, ec, x25519, 'AAAA', '', 'not base64!', ` ${TRUSTED.spki}`]) {
      expect(reasonOf(bytesOf(good), { [KEY_ID]: spki })).toBe('bad-key');
    }

    // Signatures that are not exactly 64 bytes of strict base64.
    const sig = Buffer.from(good.signature, 'base64');
    for (const signature of ['', b64(sig.subarray(0, 63)), b64(Buffer.concat([sig, Buffer.from([0])])), b64(Buffer.alloc(0))]) {
      expect(reasonOf(bytesOf({ ...good, signature }))).toBe('bad-envelope');
    }

    // Non-canonical base64 of the very same bytes: whitespace, URL-safe alphabet, missing padding,
    // non-zero unused bits. (Each would decode to bytes the signature covers; all are refused.)
    expect(reasonOf(bytesOf({ ...good, signature: `${good.signature.slice(0, 8)}\n${good.signature.slice(8)}` }))).toBe('bad-envelope');
    expect(reasonOf(bytesOf({ ...good, payload: ` ${good.payload}` }))).toBe('bad-envelope');
    expect(reasonOf(bytesOf({ ...good, signature: nonZeroTrailingBits(good.signature) }))).toBe('bad-envelope');
    expect(Buffer.from(nonZeroTrailingBits(good.signature), 'base64').equals(sig)).toBe(true);

    const urlSafe = payloadWhere((text) => /[+/]/.test(text));
    const urlSafeEnvelope = envelopeOf(urlSafe);
    expect(reasonOf(bytesOf(urlSafeEnvelope))).toBe('ok');
    expect(reasonOf(bytesOf({ ...urlSafeEnvelope, payload: urlSafeEnvelope.payload.replaceAll('+', '-').replaceAll('/', '_') }))).toBe('bad-envelope');

    const padded = payloadWhere((text) => text.endsWith('='));
    const paddedEnvelope = envelopeOf(padded);
    expect(reasonOf(bytesOf(paddedEnvelope))).toBe('ok');
    expect(reasonOf(bytesOf({ ...paddedEnvelope, payload: paddedEnvelope.payload.replace(/=+$/, '') }))).toBe('bad-envelope');
    expect(reasonOf(bytesOf({ ...paddedEnvelope, payload: nonZeroTrailingBits(paddedEnvelope.payload) }))).toBe('bad-envelope');
  });

  test('rejects-malformed', () => {
    // Over the cap: refused on its length alone, before any parsing.
    expect(reasonOf(new Uint8Array(MAX_ENVELOPE_BYTES + 1).fill(0x20))).toBe('too-large');
    const padded = new Uint8Array(MAX_ENVELOPE_BYTES + 1).fill(0x20);
    padded.set(signed(MANIFEST));
    expect(reasonOf(padded)).toBe('too-large');

    // Not UTF-8 JSON; not an envelope.
    expect(reasonOf(new TextEncoder().encode('not json'))).toBe('not-json');
    expect(reasonOf(new Uint8Array([0x7b, 0xff, 0x7d]))).toBe('not-json');
    expect(reasonOf(new Uint8Array(0))).toBe('not-json');
    const good = envelopeOf(encode(MANIFEST));
    expect(reasonOf(bytesOf({ ...good, extra: 1 }))).toBe('bad-envelope');
    expect(reasonOf(bytesOf({ ...good, format: 2 }))).toBe('bad-envelope');
    expect(reasonOf(bytesOf({ ...good, keyId: 'Test Key' }))).toBe('bad-envelope');
    expect(reasonOf(bytesOf([good]))).toBe('bad-envelope');
    expect(reasonOf(bytesOf(null))).toBe('bad-envelope');
    expect(reasonOf(new TextEncoder().encode(`{"__proto__":{},${JSON.stringify(good).slice(1)}`))).toBe('bad-envelope');

    // Signed, but the signed bytes are not UTF-8 JSON, or are over MAX_MANIFEST_BYTES.
    expect(reasonOf(bytesOf(envelopeOf(new TextEncoder().encode('{"format":1'))))).toBe('bad-payload');
    expect(reasonOf(bytesOf(envelopeOf(new Uint8Array([0x22, 0xc3, 0x28, 0x22]))))).toBe('bad-payload');
    const tooBig = new Uint8Array(MAX_MANIFEST_BYTES + 1).fill(0x20);
    tooBig.set(encode(MANIFEST));
    expect(bytesOf(envelopeOf(tooBig)).length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    expect(reasonOf(bytesOf(envelopeOf(tooBig)))).toBe('too-large');
    const atCap = new Uint8Array(MAX_MANIFEST_BYTES).fill(0x20);
    atCap.set(encode(MANIFEST));
    expect(reasonOf(bytesOf(envelopeOf(atCap)))).toBe('ok');

    // Signed, but not a manifest.
    const linux = MANIFEST.artifacts['linux-x64'];
    const withLinux = (artifact: Record<string, unknown>) => ({ ...MANIFEST, artifacts: { 'linux-x64': { ...linux, ...artifact } } });
    const bad: unknown[] = [
      { ...MANIFEST, extra: true },
      { ...MANIFEST, format: 2 },
      withLinux({ extra: true }),
      withLinux({ url: 'http://updates.example.invalid/frost.AppImage' }),
      withLinux({ url: 'https://user:pass@updates.example.invalid/frost.AppImage' }),
      withLinux({ url: 'https://user@updates.example.invalid/frost.AppImage' }),
      withLinux({ url: 'https://updates.example.invalid/a b' }),
      withLinux({ url: 'file:///etc/passwd' }),
      withLinux({ url: `https://updates.example.invalid/${'a'.repeat(2048)}` }),
      withLinux({ sha256: 'A'.repeat(64) }),
      withLinux({ sha256: 'a'.repeat(63) }),
      withLinux({ sha256: 'g'.repeat(64) }),
      withLinux({ size: 0 }),
      withLinux({ size: 1.5 }),
      withLinux({ size: 1024 ** 3 + 1 }),
      withLinux({ size: '100' }),
      { ...MANIFEST, version: '1.02.0' },
      { ...MANIFEST, version: '1.2' },
      { ...MANIFEST, version: 'v1.2.0' },
      { ...MANIFEST, version: '1.2.0+build.5' },
      { ...MANIFEST, version: '1.2.0-01' },
      { ...MANIFEST, version: `1.2.0-${'a'.repeat(MAX_VERSION_CHARS)}` },
      { ...MANIFEST, minimumVersion: '1.0' },
      { ...MANIFEST, minimumVersion: '1.3.0' },
      { ...MANIFEST, minimumVersion: '1.2.1-rc.1' },
      { ...MANIFEST, releasedAt: 'yesterday' },
      { ...MANIFEST, releasedAt: '2026-13-01T00:00:00Z' },
      { ...MANIFEST, rolloutPercent: 101 },
      { ...MANIFEST, rolloutPercent: -1 },
      { ...MANIFEST, rolloutPercent: 50.5 },
      { ...MANIFEST, notes: 'x'.repeat(MAX_NOTES_CHARS + 1) },
      { ...MANIFEST, notes: 'bell\u0007' },
      { ...MANIFEST, notes: 'escape\u001b[31m' },
      { ...MANIFEST, artifacts: {} },
      { ...MANIFEST, artifacts: [] },
      { ...MANIFEST, artifacts: { 'linux-arm64': linux } },
      { ...MANIFEST, artifacts: { 'darwin-x64': linux, 'linux-x64': linux } },
      { ...MANIFEST, artifacts: JSON.parse(`{"__proto__":${JSON.stringify(linux)},"linux-x64":${JSON.stringify(linux)}}`) },
      (({ notes: _notes, ...rest }) => rest)(MANIFEST),
      (({ rolloutPercent: _rollout, ...rest }) => rest)(MANIFEST),
    ];
    for (const manifest of bad) {
      expect([JSON.stringify(manifest).slice(0, 200), reasonOf(signed(manifest))]).toEqual([JSON.stringify(manifest).slice(0, 200), 'bad-manifest']);
    }
    expect(reasonOf(bytesOf(envelopeOf(new TextEncoder().encode(`{"__proto__":{},${JSON.stringify(MANIFEST).slice(1)}`))))).toBe('bad-manifest');

    // The boundaries themselves are fine.
    for (const manifest of [
      { ...MANIFEST, notes: 'x'.repeat(MAX_NOTES_CHARS) },
      { ...MANIFEST, notes: '' },
      { ...MANIFEST, notes: 'tab\tand\r\nlines, ünïcödé ❄' },
      { ...MANIFEST, rolloutPercent: 0 },
      { ...MANIFEST, minimumVersion: '1.2.0' },
      withLinux({ size: 1024 ** 3 }),
      withLinux({ size: 1 }),
      withLinux({ url: 'https://updates.example.invalid:8443/frost.AppImage?x=1' }),
    ]) {
      expect(reasonOf(signed(manifest))).toBe('ok');
    }
  });
});

describe('decide', () => {
  const INSTALL: UpdateDecideInput = { currentVersion: '1.1.0', platformKey: 'linux-x64', installId: randomUUID() };
  const manifest = (overrides: Partial<UpdateManifest> = {}): UpdateManifest => ({ ...structuredClone(MANIFEST), ...overrides }) as UpdateManifest;

  /** An install ID whose bucket for `version` matches. */
  function installInBucket(version: string, matches: (bucket: number) => boolean) {
    for (let i = 0; i < 10_000; i++) {
      const id = `install-${i}`;
      if (matches(rolloutBucket(id, version))) return id;
    }
    throw new Error('no such install');
  }

  test('rejects-downgrade', () => {
    for (const version of ['1.1.0', '1.0.9', '1.1.0-rc.1', '0.9.0', '1.0.0']) {
      // Whatever else it says: even a minimum version above the running one (which `parseManifest`
      // would refuse) or a full rollout does not make an older manifest an update.
      for (const overrides of [{}, { minimumVersion: '9.9.9' }, { rolloutPercent: 0 }]) {
        expect(decide(manifest({ version, ...overrides }), INSTALL)).toEqual({ kind: 'up-to-date', version });
      }
    }
    // Same version, and a newer pre-release of the running version's own line is still older.
    expect(decide(manifest({ version: '1.1.0' }), INSTALL).kind).toBe('up-to-date');
    expect(decide(manifest({ version: '1.1.0-beta' }), { ...INSTALL, currentVersion: '1.1.0' }).kind).toBe('up-to-date');
    // Something genuinely newer is offered.
    expect(decide(manifest({ version: '1.1.1' }), INSTALL).kind).toBe('available');
    expect(decide(manifest({ version: '1.1.0' }), { ...INSTALL, currentVersion: '1.1.0-rc.2' }).kind).toBe('available');
  });

  test('decide-eligibility', () => {
    expect(decide(manifest(), INSTALL)).toEqual({
      kind: 'available',
      version: '1.2.0',
      releasedAt: MANIFEST.releasedAt,
      notes: MANIFEST.notes,
      artifact: ARTIFACT,
    });
    const darwinOnly = manifest({ artifacts: { 'darwin-arm64': MANIFEST.artifacts['darwin-arm64'] } });
    expect(decide(darwinOnly, INSTALL)).toEqual({ kind: 'no-artifact', version: '1.2.0' });
    expect(decide(darwinOnly, { ...INSTALL, platformKey: 'darwin-arm64' }).kind).toBe('available');
    expect(decide(manifest(), { ...INSTALL, skippedVersion: '1.2.0' })).toEqual({ kind: 'skipped', version: '1.2.0' });
    expect(decide(manifest(), { ...INSTALL, skippedVersion: '1.1.5' }).kind).toBe('available');
    // An install outside the rollout.
    const id = installInBucket('1.2.0', (bucket) => bucket >= 50);
    expect(decide(manifest({ rolloutPercent: 50 }), { ...INSTALL, installId: id })).toEqual({
      kind: 'staged-out',
      version: '1.2.0',
      bucket: rolloutBucket(id, '1.2.0'),
    });
  });

  test('rollout-is-deterministic', () => {
    // SHA-256(installId:version), first 4 bytes big-endian, mod 100.
    expect(rolloutBucket('00000000-0000-4000-8000-000000000000', '1.2.3')).toBe(0xbf2b5816 % 100);
    expect(rolloutBucket('install-a', '0.1.0')).toBe(0xda74d652 % 100);
    const digest = createHash('sha256').update('some-id:2.0.0').digest();
    expect(rolloutBucket('some-id', '2.0.0')).toBe(digest.readUInt32BE(0) % ROLLOUT_BUCKETS);

    const counts = Array.from({ length: ROLLOUT_BUCKETS }, () => 0);
    for (let i = 0; i < 10_000; i++) {
      const id = randomUUID();
      const bucket = rolloutBucket(id, '1.2.0');
      expect(Number.isInteger(bucket) && bucket >= 0 && bucket < ROLLOUT_BUCKETS).toBe(true);
      expect(rolloutBucket(id, '1.2.0')).toBe(bucket);
      counts[bucket]! += 1;
      if (i < 500) {
        const install = { ...INSTALL, installId: id };
        expect(decide(manifest({ rolloutPercent: 0 }), install).kind).toBe('staged-out');
        expect(decide(manifest({ rolloutPercent: 100 }), install).kind).toBe('available');
        expect(decide(manifest({ rolloutPercent: 37 }), install).kind).toBe(bucket < 37 ? 'available' : 'staged-out');
      }
    }
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(50);
      expect(count).toBeLessThanOrEqual(150);
    }
  });

  test('minimum-version-required', () => {
    const skippedAndStagedOut = { ...INSTALL, skippedVersion: '1.2.0' };
    const required = decide(manifest({ minimumVersion: '1.1.1', rolloutPercent: 0 }), skippedAndStagedOut);
    expect(required).toEqual({ kind: 'required', version: '1.2.0', releasedAt: MANIFEST.releasedAt, notes: MANIFEST.notes, artifact: ARTIFACT });
    expect(decide(manifest({ minimumVersion: '1.2.0', rolloutPercent: 0 }), { ...INSTALL, currentVersion: '1.2.0-rc.1' }).kind).toBe('required');
    // At or above the minimum, the usual rules apply.
    expect(decide(manifest({ minimumVersion: '1.1.0', rolloutPercent: 0 }), INSTALL).kind).toBe('staged-out');
    expect(decide(manifest({ minimumVersion: '1.0.0' }), skippedAndStagedOut).kind).toBe('skipped');
    expect(decide(manifest({ minimumVersion: '1.0.0' }), INSTALL).kind).toBe('available');
    // A required update still needs an artifact for this platform.
    expect(decide(manifest({ minimumVersion: '1.2.0' }), { ...INSTALL, platformKey: 'win32-x64' }).kind).toBe('required');
    expect(
      decide(manifest({ minimumVersion: '1.2.0', artifacts: { 'linux-x64': ARTIFACT } }), { ...INSTALL, platformKey: 'win32-x64' }).kind,
    ).toBe('no-artifact');
  });
});

describe('versions', () => {
  test('compare-versions', () => {
    // Each row is strictly below the next (semver §11's own example, plus more).
    const ascending = [
      '0.0.0',
      '0.0.1',
      '0.1.0',
      '0.9.9',
      '1.0.0-0',
      '1.0.0-1',
      '1.0.0-2',
      '1.0.0-10',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.9.0',
      '1.10.0',
      '1.10.1',
      '2.0.0-Z',
      '2.0.0-a',
      '2.0.0',
      '10.0.0',
      '99999999999999999999.0.0',
      '100000000000000000000.0.0',
    ];
    for (let i = 0; i < ascending.length; i++) {
      for (let j = 0; j < ascending.length; j++) {
        expect([ascending[i], ascending[j], compareVersions(ascending[i]!, ascending[j]!)]).toEqual([ascending[i], ascending[j], Math.sign(i - j)]);
      }
    }
    expect(compareVersions('1.0.0-alpha-1', '1.0.0-alpha-1')).toBe(0);
    expect(compareVersions('1.0.0-a.b.c', '1.0.0-a.b')).toBe(1);

    for (const version of ['1.2.3', '0.0.0', '1.2.3-rc.1', '1.2.3-0a', '1.2.3--', '1.2.3-x-y.0']) {
      expect([version, isVersion(version)]).toEqual([version, true]);
    }
    const invalid = ['', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3-01', '1.2.3-a..b', '1.2.3+build', 'v1.2.3', ' 1.2.3', '1.2.3\n', '1.2.3-ä', `1.2.3-${'a'.repeat(MAX_VERSION_CHARS - 5)}`];
    for (const version of invalid) {
      expect([version, isVersion(version)]).toEqual([version, false]);
      expect(() => compareVersions(version, '1.0.0')).toThrow(TypeError);
      expect(() => compareVersions('1.0.0', version)).toThrow(TypeError);
    }
    expect(isVersion(`1.2.3-${'a'.repeat(MAX_VERSION_CHARS - 6)}`)).toBe(true);
    expect(isVersion(123 as unknown as string)).toBe(false);
  });

  test('production-key-is-ed25519', async () => {
    const { createPublicKey } = await import('node:crypto');
    expect(Object.keys(UPDATE_PUBLIC_KEYS)).toEqual(['frost-update-2026-10']);
    expect(Object.isFrozen(UPDATE_PUBLIC_KEYS)).toBe(true);
    const spki = UPDATE_PUBLIC_KEYS['frost-update-2026-10']!;
    const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    expect(key.type).toBe('public');
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(key.export({ format: 'der', type: 'spki' }).toString('base64')).toBe(spki);
    // The default trusted keys are the production ones: a test key's envelope is refused by them.
    expect(reasonOf(signed(MANIFEST), UPDATE_PUBLIC_KEYS)).toBe('unknown-key');
    expect(verifyEnvelope(signed(MANIFEST, TRUSTED.privateKey, 'frost-update-2026-10'))).toEqual({ ok: false, reason: 'bad-signature' });
  });
});
