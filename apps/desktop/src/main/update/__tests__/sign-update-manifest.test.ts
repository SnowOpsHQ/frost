// Spec: specs/update-manifest.spec.ts, specs/update-manifest.schema.ts · Acceptance: specs/update-manifest.feature.md (Signing)
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MAX_MANIFEST_BYTES, UPDATE_SIGNING_KEY_ENV } from '@app/specs/update-manifest.spec';
import { verifyEnvelope } from '../manifest';

const ROOT = path.resolve(import.meta.dirname, '../../../../../..');
const SCRIPT = path.join(ROOT, 'scripts/sign-update-manifest.mjs');

/** The script's exports (it is plain JavaScript; this is the part the tests use). */
interface SignerModule {
  main(
    argv: readonly string[],
    options: {
      env: Readonly<Record<string, string | undefined>>;
      keys?: Readonly<Record<string, string>>;
      cwd?: string;
      stdout?: (line: string) => void;
      stderr?: (line: string) => void;
    },
  ): number;
}
const signer = (await import(pathToFileURL(SCRIPT).href)) as SignerModule;

const KEY_ID = 'test-key';
function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}
const TRUSTED = ed25519();
const KEYS = { [KEY_ID]: TRUSTED.spki };

const MANIFEST = {
  format: 1,
  version: '1.2.0',
  releasedAt: '2026-10-28T12:00:00Z',
  notes: 'Fixes.',
  rolloutPercent: 25,
  artifacts: { 'linux-x64': { url: 'https://updates.example.invalid/frost-1.2.0-linux-x64.AppImage', sha256: 'a'.repeat(64), size: 1234 } },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'frost-sign-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const pemOf = (key: KeyObject) => key.export({ format: 'pem', type: 'pkcs8' }).toString();

/** Writes `key` as a PKCS#8 PEM file with `mode` (chmod'ed, so the umask doesn't matter). */
function writeKey(key: KeyObject, mode = 0o600, name = 'signing.pem') {
  const file = path.join(dir, name);
  writeFileSync(file, pemOf(key), { mode });
  if (process.platform !== 'win32') chmodSync(file, mode);
  return file;
}

function writeManifest(content: unknown = MANIFEST, name = 'manifest.json') {
  const file = path.join(dir, name);
  writeFileSync(file, typeof content === 'string' || content instanceof Uint8Array ? content : `${JSON.stringify(content, null, 2)}\n`);
  return file;
}

/** Runs the script in-process with `keys` trusted, capturing its output. */
function run(argv: string[], env: Record<string, string | undefined>, keys: Readonly<Record<string, string>> = KEYS) {
  const out: string[] = [];
  const err: string[] = [];
  const code = signer.main(argv, { env, keys, cwd: dir, stdout: (line) => out.push(line), stderr: (line) => err.push(line) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** No key material in `text`: no PEM armour and none of the key's base64 lines. */
function expectNoKeyMaterial(text: string, key: KeyObject = TRUSTED.privateKey) {
  expect(text).not.toMatch(/PRIVATE KEY|BEGIN /);
  for (const line of pemOf(key).split('\n').filter((l) => l.length > 16 && !l.startsWith('-----'))) {
    expect(text).not.toContain(line);
  }
  const raw = key.export({ format: 'der', type: 'pkcs8' });
  expect(text).not.toContain(raw.subarray(-32).toString('base64').slice(0, 24));
  expect(text).not.toContain(raw.subarray(-32).toString('hex').slice(0, 24));
}

/** The files in the temp dir other than the inputs. */
const written = (...inputs: string[]) => readdirSync(dir).filter((name) => !inputs.map((file) => path.basename(file)).includes(name));

describe('sign:update-manifest', () => {
  test('signs-and-verifies', () => {
    const key = writeKey(TRUSTED.privateKey);
    const manifest = writeManifest();

    // Default output: x.json -> x.signed.json.
    const first = run([manifest], { [UPDATE_SIGNING_KEY_ENV]: key });
    expect(first).toMatchObject({ code: 0, stderr: '' });
    const envelopePath = path.join(dir, 'manifest.signed.json');
    const result = verifyEnvelope(readFileSync(envelopePath), KEYS);
    expect(result).toEqual({ ok: true, manifest: MANIFEST, keyId: KEY_ID });
    expect(first.stdout).toContain('1.2.0');
    expect(first.stdout).toContain(KEY_ID);
    expect(first.stdout).toContain(envelopePath);
    expectNoKeyMaterial(first.stdout);

    // --out, relative to the directory it was run in.
    const second = run([path.basename(manifest), '--out', 'feed/envelope.json'], { [UPDATE_SIGNING_KEY_ENV]: key });
    expect(second.code).toBe(0);
    expect(verifyEnvelope(readFileSync(path.join(dir, 'feed/envelope.json')), KEYS).ok).toBe(true);
    // Not trusted by the app's own (production) keys.
    expect(verifyEnvelope(readFileSync(envelopePath))).toEqual({ ok: false, reason: 'unknown-key' });

    // Usage errors.
    for (const argv of [[], [manifest, manifest], [manifest, '--bogus'], [manifest, '--out'], [manifest, '--out', manifest]]) {
      expect(run(argv, { [UPDATE_SIGNING_KEY_ENV]: key }).code).toBe(1);
    }
  });

  test('signs-exact-bytes', () => {
    const key = writeKey(TRUSTED.privateKey);
    // Odd whitespace, key order and escapes: kept exactly as written.
    const text =
      '{\r\n\t"version" : "1.2.0",   "format":1,\n"artifacts":{"linux-x64":{"size":1234,"sha256":"' +
      'a'.repeat(64) +
      '","url":"https://updates.example.invalid/frost.AppImage"}},\n  "notes": "caf\\u00e9 ❄",\n"releasedAt":"2026-10-28T12:00:00Z","rolloutPercent":25}\n\n';
    const manifest = writeManifest(text);
    expect(run([manifest], { [UPDATE_SIGNING_KEY_ENV]: key }).code).toBe(0);
    const envelope = JSON.parse(readFileSync(path.join(dir, 'manifest.signed.json'), 'utf8')) as { payload: string };
    expect(Buffer.from(envelope.payload, 'base64').equals(readFileSync(manifest))).toBe(true);
    const result = verifyEnvelope(readFileSync(path.join(dir, 'manifest.signed.json')), KEYS);
    expect(result.ok && result.manifest.notes).toBe('café ❄');
  });

  test.skipIf(process.platform === 'win32')('refuses-world-readable-key', () => {
    const manifest = writeManifest();
    for (const mode of [0o644, 0o640, 0o604, 0o620, 0o602, 0o610, 0o601, 0o660, 0o666, 0o700 | 0o004]) {
      const key = writeKey(TRUSTED.privateKey, mode, `key-${mode.toString(8)}.pem`);
      const result = run([manifest], { [UPDATE_SIGNING_KEY_ENV]: key });
      expect([mode.toString(8), result.code]).toEqual([mode.toString(8), 1]);
      expect(result.stderr).toMatch(/group or others/);
      expectNoKeyMaterial(result.stderr + result.stdout);
    }
    expect(readdirSync(dir).filter((name) => name.endsWith('.signed.json'))).toEqual([]);
    // 0400 and 0600 are fine.
    for (const mode of [0o400, 0o600]) {
      const key = writeKey(TRUSTED.privateKey, mode, `ok-${mode.toString(8)}.pem`);
      expect(run([manifest], { [UPDATE_SIGNING_KEY_ENV]: key }).code).toBe(0);
    }
  });

  test('refuses-unusable-key', () => {
    const manifest = writeManifest();
    const cases: Record<string, string | undefined>[] = [{}, { [UPDATE_SIGNING_KEY_ENV]: '' }];

    mkdirSync(path.join(dir, 'a-directory'), { mode: 0o700 });
    cases.push({ [UPDATE_SIGNING_KEY_ENV]: path.join(dir, 'a-directory') });
    cases.push({ [UPDATE_SIGNING_KEY_ENV]: path.join(dir, 'missing.pem') });

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    cases.push({ [UPDATE_SIGNING_KEY_ENV]: writeKey(rsa, 0o600, 'rsa.pem') });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    cases.push({ [UPDATE_SIGNING_KEY_ENV]: writeKey(ec, 0o600, 'ec.pem') });
    const publicOnly = path.join(dir, 'public.pem');
    writeFileSync(publicOnly, TRUSTED.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().replace(/PRIVATE/g, 'PUBLIC'), { mode: 0o600 });
    cases.push({ [UPDATE_SIGNING_KEY_ENV]: publicOnly });
    const garbage = path.join(dir, 'garbage.pem');
    writeFileSync(garbage, 'not a key\n', { mode: 0o600 });
    cases.push({ [UPDATE_SIGNING_KEY_ENV]: garbage });
    const huge = path.join(dir, 'huge.pem');
    writeFileSync(huge, Buffer.alloc(1024 * 1024, 0x41), { mode: 0o600 });
    cases.push({ [UPDATE_SIGNING_KEY_ENV]: huge });
    if (process.platform !== 'win32') for (const file of [publicOnly, garbage, huge]) chmodSync(file, 0o600);

    for (const env of cases) {
      const result = run([manifest], env);
      expect([env[UPDATE_SIGNING_KEY_ENV], result.code]).toEqual([env[UPDATE_SIGNING_KEY_ENV], 1]);
      expect(result.stderr).not.toBe('');
      expectNoKeyMaterial(result.stderr + result.stdout);
      expectNoKeyMaterial(result.stderr + result.stdout, rsa);
    }
    expect(run([manifest], {}).stderr).toContain(UPDATE_SIGNING_KEY_ENV);
    expect(existsSync(path.join(dir, 'manifest.signed.json'))).toBe(false);
  });

  test('refuses-untrusted-key', () => {
    const manifest = writeManifest();
    const other = ed25519();
    const key = writeKey(other.privateKey);
    const result = run([manifest], { [UPDATE_SIGNING_KEY_ENV]: key });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not one the app trusts/);
    expectNoKeyMaterial(result.stderr + result.stdout, other.privateKey);
    expect(written(manifest, key)).toEqual([]);
    // Nor by default (the production keys): no test key is trusted there.
    expect(signer.main([manifest], { env: { [UPDATE_SIGNING_KEY_ENV]: writeKey(TRUSTED.privateKey, 0o600, 'trusted.pem') }, cwd: dir, stdout: () => {}, stderr: () => {} })).toBe(1);
    expect(existsSync(path.join(dir, 'manifest.signed.json'))).toBe(false);
  });

  test('refuses-invalid-manifest', () => {
    const key = writeKey(TRUSTED.privateKey);
    const http = { ...MANIFEST, artifacts: { 'linux-x64': { ...MANIFEST.artifacts['linux-x64'], url: 'http://updates.example.invalid/frost.AppImage' } } };
    const tooBig = `${JSON.stringify(MANIFEST)}${' '.repeat(MAX_MANIFEST_BYTES)}`;
    const cases: unknown[] = ['not json', new Uint8Array([0x7b, 0xff, 0x7d]), http, { ...MANIFEST, extra: 1 }, { ...MANIFEST, minimumVersion: '2.0.0' }, tooBig];
    for (const content of cases) {
      const manifest = writeManifest(content);
      const result = run([manifest], { [UPDATE_SIGNING_KEY_ENV]: key });
      expect(result.code).toBe(1);
      expect(result.stderr).not.toBe('');
      expect(written(manifest, key)).toEqual([]);
    }
    expect(run([writeManifest(http)], { [UPDATE_SIGNING_KEY_ENV]: key }).stderr).toMatch(/artifacts\.linux-x64\.url/);
    expect(run([path.join(dir, 'missing.json')], { [UPDATE_SIGNING_KEY_ENV]: key }).code).toBe(1);
  });

  test('runs-under-node', () => {
    const rootPackage = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(rootPackage.scripts['sign:update-manifest']).toBe('node scripts/sign-update-manifest.mjs');

    const manifest = writeManifest();
    const other = ed25519();
    const key = writeKey(other.privateKey);
    const env = { PATH: process.env.PATH ?? '', [UPDATE_SIGNING_KEY_ENV]: key };
    const child = spawnSync(process.execPath, [SCRIPT, manifest], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toMatch(/not one the app trusts/);
    expect(child.status).toBe(1);
    expectNoKeyMaterial(child.stderr + child.stdout, other.privateKey);
    const unset = spawnSync(process.execPath, [SCRIPT, manifest], { cwd: ROOT, env: { PATH: env.PATH }, encoding: 'utf8', timeout: 60_000 });
    expect(unset.status).toBe(1);
    expect(unset.stderr).toContain(UPDATE_SIGNING_KEY_ENV);
    expect(written(manifest, key)).toEqual([]);
  });
});
