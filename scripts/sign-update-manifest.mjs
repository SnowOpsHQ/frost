#!/usr/bin/env node
// Signs an update manifest (specs/update-manifest.spec.ts; acceptance:
// specs/update-manifest.feature.md, "Signing"):
//
//   FROST_UPDATE_SIGNING_KEY=<path to PEM> pnpm sign:update-manifest <manifest.json> [--out <envelope.json>]
//
// The key is an unencrypted PKCS#8 PEM Ed25519 private key, which lives only in the maintainer's
// private key store (`frost-private/keys/`), never in the repo. The key file must be a regular file
// with no group or other permission bits (POSIX). The manifest is validated (`parseManifest`), and
// its exact file bytes are signed: nothing is re-serialised, so what the maintainer reviewed is what
// is signed. The key's public half must be one of `UPDATE_PUBLIC_KEYS` (that entry's `keyId` goes in
// the envelope), and the envelope is verified with the app's own `verifyEnvelope` before it is
// written (default `<manifest>.signed.json`). Nothing is uploaded or published, and no key material
// is ever printed.
//
// The specs and `manifest.ts` are erasable TypeScript, loaded with Node's built-in type stripping
// (Node >= 22.18). They import each other without file extensions (as the rest of the TypeScript
// does, for Vite and tsc), so a resolve hook retries a relative import from a `.ts` file that has
// no script extension with `.ts` appended (`./update-manifest.spec` -> `./update-manifest.spec.ts`).
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const retry =
        error?.code === 'ERR_MODULE_NOT_FOUND' &&
        /^\.\.?\//.test(specifier) &&
        !/\.[cm]?[jt]s$/.test(specifier) &&
        context.parentURL?.startsWith('file:') &&
        context.parentURL.endsWith('.ts');
      if (!retry) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});

const { MAX_MANIFEST_BYTES, UPDATE_ENVELOPE_FORMAT, UPDATE_PUBLIC_KEYS, UPDATE_SIGNING_KEY_ENV } = await import(
  '../specs/update-manifest.spec.ts'
);
const { parseManifest, verifyEnvelope } = await import('../apps/desktop/src/main/update/manifest.ts');

/** A PEM key file is a few hundred bytes; anything this large is not one. */
const MAX_KEY_FILE_BYTES = 16 * 1024;

const USAGE = `usage: ${UPDATE_SIGNING_KEY_ENV}=<key.pem> pnpm sign:update-manifest <manifest.json> [--out <envelope.json>]`;

/** A refusal: its message is printed (never key material), and the script exits 1. */
class SignError extends Error {}

/**
 * Reads at most `max` bytes of a regular file. `fstat` on the opened descriptor, so the checks are
 * about the file that is read. With `privateKey`, a file with any group or other permission bit is
 * refused (POSIX; Windows has no such bits).
 */
function readRegularFile(file, max, { privateKey = false, what }) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY);
  } catch (error) {
    throw new SignError(`${what}: cannot open it (${error?.code ?? 'error'})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new SignError(`${what}: not a regular file`);
    if (privateKey && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new SignError(`${what}: readable or writable by group or others (mode ${(stat.mode & 0o777).toString(8)}); chmod 600 it`);
    }
    if (stat.size > max) throw new SignError(`${what}: larger than ${max} bytes`);
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    for (let read; length <= max && (read = readSync(fd, buffer, length, buffer.length - length, null)) > 0; ) length += read;
    if (length > max) throw new SignError(`${what}: larger than ${max} bytes`);
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** The Ed25519 private key at `file` (an unencrypted PEM, PKCS#8). */
export function loadSigningKey(file) {
  const pem = readRegularFile(file, MAX_KEY_FILE_BYTES, { privateKey: true, what: 'signing key' });
  let key;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // Node's message can quote the input; say only what went wrong.
    throw new SignError('signing key: not a readable, unencrypted PEM private key');
  } finally {
    pem.fill(0);
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new SignError('signing key: not an Ed25519 private key');
  return key;
}

/** The trusted `keyId` whose SPKI is `privateKey`'s public half, or `null`. */
function trustedKeyId(privateKey, keys) {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  return Object.keys(keys).find((keyId) => keys[keyId] === spki) ?? null;
}

/**
 * Validates `manifestBytes` and signs them as they are with `privateKey`, whose public half must be
 * one of `keys`. Answers the envelope's bytes (pretty JSON), after verifying them with
 * `verifyEnvelope` against `keys`.
 */
export function signManifest(manifestBytes, privateKey, keys = UPDATE_PUBLIC_KEYS) {
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new SignError(`manifest: larger than ${MAX_MANIFEST_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new SignError('manifest: not UTF-8 JSON');
  }
  const parsed = parseManifest(value);
  if (!parsed.ok) throw new SignError(`manifest: ${parsed.error}`);

  const keyId = trustedKeyId(privateKey, keys);
  if (keyId === null) throw new SignError('signing key: its public key is not one the app trusts (UPDATE_PUBLIC_KEYS)');

  const payload = Buffer.from(manifestBytes);
  const envelope = {
    format: UPDATE_ENVELOPE_FORMAT,
    keyId,
    payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64'),
  };
  const envelopeBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);

  const check = verifyEnvelope(envelopeBytes, keys);
  if (!check.ok || check.keyId !== keyId || !Buffer.from(envelope.payload, 'base64').equals(payload)) {
    throw new SignError(`self-check failed (${check.ok ? 'payload mismatch' : check.reason}); nothing written`);
  }
  return { envelopeBytes, keyId, manifest: check.manifest };
}

/** `x.json` → `x.signed.json`; anything else gets `.signed.json` appended. */
const defaultOut = (manifestPath) => `${manifestPath.replace(/\.json$/i, '')}.signed.json`;

/**
 * The command line. `keys` (the trusted keys) is for tests only; the command line can't change it.
 * Relative paths are taken from `cwd` (by default the directory `pnpm` was run in). Answers the exit code.
 */
export function main(argv, { env = process.env, keys = UPDATE_PUBLIC_KEYS, cwd, stdout = console.log, stderr = console.error } = {}) {
  try {
    let args;
    try {
      args = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: { out: { type: 'string' } } });
    } catch (error) {
      throw new SignError(`${error.message}\n${USAGE}`);
    }
    if (args.positionals.length !== 1) throw new SignError(USAGE);
    const base = cwd ?? env.INIT_CWD ?? process.cwd();
    const manifestPath = path.resolve(base, args.positionals[0]);
    const outPath = path.resolve(base, args.values.out ?? defaultOut(manifestPath));
    if (outPath === manifestPath) throw new SignError('--out: must not be the manifest itself');

    const keyPath = env[UPDATE_SIGNING_KEY_ENV];
    if (keyPath === undefined || keyPath === '') {
      throw new SignError(`${UPDATE_SIGNING_KEY_ENV} is not set: set it to the path of the Ed25519 signing key (PEM)\n${USAGE}`);
    }
    const resolvedKeyPath = path.resolve(base, keyPath);
    if (outPath === resolvedKeyPath) throw new SignError('--out: must not be the signing key');
    const privateKey = loadSigningKey(resolvedKeyPath);

    const manifestBytes = readRegularFile(manifestPath, MAX_MANIFEST_BYTES, { what: 'manifest' });
    const { envelopeBytes, keyId, manifest } = signManifest(manifestBytes, privateKey, keys);

    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, envelopeBytes);
    stdout(`Signed frost ${manifest.version} (keyId ${keyId}): ${outPath}`);
    return 0;
  } catch (error) {
    if (!(error instanceof SignError)) {
      // Unexpected: report its kind only (an error from the crypto layer could quote its input).
      stderr(`sign:update-manifest: unexpected ${error?.name ?? 'error'}${error?.code ? ` (${error.code})` : ''}`);
      return 1;
    }
    stderr(`sign:update-manifest: ${error.message}`);
    return 1;
  }
}

// Run as a command (not when a test imports it).
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
