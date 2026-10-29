// Spec: specs/serp-selector-pack.spec.ts (trust model: the private key is never in the repo;
// SIGNING_KEY_ENV, SERP_PACK_SIGNATURE_SUFFIX, SERP_PACK_PUBLIC_KEYS)
// Acceptance: specs/serp-selector-pack.feature.md (Signing)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SIGNING_KEY_ENV } from '@app/specs/serp-selector-pack.spec';
import { verifyPack } from '../pack-verify';
import { encode, packObject, testKey } from './pack-keys';

const SCRIPT = fileURLToPath(new URL('../../../../../../scripts/sign-selectors.mjs', import.meta.url));
const KEY = testKey();

let dir = '';
let keyFile = '';
let packFile = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'frost-sign-'));
  keyFile = path.join(dir, 'key.pem');
  packFile = path.join(dir, 'pack.json');
  await writeFile(keyFile, KEY.pem, { mode: 0o600 });
  await writeFile(packFile, encode(packObject()));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs the script with `args`; the signing key's env var set to `key` (or removed). */
function run(args: string[], key: string | null = keyFile) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[SIGNING_KEY_ENV];
  delete env.ELECTRON_RUN_AS_NODE;
  if (key !== null) env[SIGNING_KEY_ENV] = key;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const keyBody = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

describe('sign-selectors script', () => {
  test('sign-script-roundtrip', async () => {
    const signed = run([packFile]);
    expect(signed.status, signed.output).toBe(0);
    // The private key never appears in the output (its public half may).
    expect(signed.output).not.toContain(keyBody(KEY.pem));
    expect(signed.output).not.toContain(keyBody(KEY.pem).slice(20, 50));
    const signature = await readFile(`${packFile}.sig`, 'utf8');
    expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
    expect(verifyPack(new Uint8Array(await readFile(packFile)), signature, [KEY.spki])).toMatchObject({ ok: true });
    const verified = run(['--verify', packFile, '--key', KEY.spki], null);
    expect(verified.status, verified.output).toBe(0);
  });

  test('sign-script-refuses-without-key', async () => {
    for (const key of [null, '']) {
      const result = run([packFile], key);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(SIGNING_KEY_ENV);
      expect(existsSync(`${packFile}.sig`)).toBe(false);
    }
    // A key file that is not there, or not a private key, signs nothing either.
    expect(run([packFile], path.join(dir, 'missing.pem')).status).not.toBe(0);
    await writeFile(path.join(dir, 'public.pem'), `-----BEGIN PUBLIC KEY-----\n${KEY.spki}\n-----END PUBLIC KEY-----\n`);
    expect(run([packFile], path.join(dir, 'public.pem')).status).not.toBe(0);
    expect(existsSync(`${packFile}.sig`)).toBe(false);
    // No pack named: usage, non-zero.
    expect(run([]).status).not.toBe(0);
  });

  test('sign-script-verify-detects-tampering', async () => {
    expect(run([packFile]).status).toBe(0);
    const bytes = await readFile(packFile);
    bytes[12] = bytes[12]! ^ 0x01;
    await writeFile(packFile, bytes);
    expect(run(['--verify', packFile, '--key', KEY.spki], null).status).not.toBe(0);
    bytes[12] = bytes[12]! ^ 0x01;
    await writeFile(packFile, bytes);
    expect(run(['--verify', packFile, '--key', KEY.spki], null).status).toBe(0);
    // The embedded keys did not sign an ephemeral key's pack.
    expect(run(['--verify', packFile], null).status).not.toBe(0);
    // No signature file: not verified.
    await rm(`${packFile}.sig`);
    expect(run(['--verify', packFile, '--key', KEY.spki], null).status).not.toBe(0);
  });

  test('sign-script-refuses-bad-packs', async () => {
    const bad = [Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), encode(packObject())]), encode('not json'), encode(packObject({ format: 2 })), encode(packObject({ version: 0 })), Buffer.of(0xff, 0x7b, 0x7d)];
    for (const bytes of bad) {
      await writeFile(packFile, bytes);
      expect(run([packFile]).status).not.toBe(0);
      expect(existsSync(`${packFile}.sig`)).toBe(false);
    }
  });
});
