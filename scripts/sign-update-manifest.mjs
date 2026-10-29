#!/usr/bin/env node
// Signs an update manifest (specs/update-manifest.spec.ts; acceptance:
// specs/update-manifest.feature.md, "Signing"):
//
//   FROST_UPDATE_SIGNING_KEY=<path to PEM> pnpm sign:update-manifest <manifest.json> [--out <envelope.json>] [--force]
//
// The key is an unencrypted PKCS#8 PEM Ed25519 private key, which lives only in the maintainer's
// private key store (`frost-private/keys/`), never in the repo. On POSIX the key file must be a
// regular file owned by the current user with no group or other permission bits (Windows ACLs are
// not checked; the script says so). The manifest is validated (`readJson`: no repeated keys;
// `parseManifest`; `checkFreshness` against this machine's clock), and its exact file bytes are
// signed (after `UPDATE_SIGNATURE_CONTEXT`): nothing is re-serialised, so what the maintainer
// reviewed is what is signed. The key's public half must be one of `UPDATE_PUBLIC_KEYS` (that
// entry's `keyId` goes in the envelope), and the envelope is verified with the app's own
// `verifyEnvelope` before it is written. Before writing, a summary of what is being signed is
// printed for a last look. The envelope (default `<manifest>.signed.json`) is written to a temporary
// file next to it and moved into place; an existing output is kept unless `--force`, and an output
// that is the key or the manifest under any name is refused. Nothing is uploaded or published, and
// neither key material nor the key's path is ever printed.
//
// The specs and `manifest.ts` are erasable TypeScript, loaded with Node's built-in type stripping
// (Node >= 22.18). They import each other without file extensions (as the rest of the TypeScript
// does, for Vite and tsc), so a resolve hook retries a relative import from a `.ts` file that has
// no script extension with `.ts` appended (`./update-manifest.spec` -> `./update-manifest.spec.ts`).
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const { MAX_MANIFEST_BYTES, UPDATE_ENVELOPE_FORMAT, UPDATE_PLATFORMS, UPDATE_PUBLIC_KEYS, UPDATE_SIGNING_KEY_ENV } = await import(
  '../specs/update-manifest.spec.ts'
);
const { checkFreshness, parseManifest, readJson, signatureInput, verifyEnvelope } = await import('../apps/desktop/src/main/update/manifest.ts');

/** A PEM key file is a few hundred bytes; anything this large is not one. */
const MAX_KEY_FILE_BYTES = 16 * 1024;

const USAGE = `usage: ${UPDATE_SIGNING_KEY_ENV}=<key.pem> pnpm sign:update-manifest <manifest.json> [--out <envelope.json>] [--force]`;

/** A refusal: its message is printed (never key material or the key's path), and the script exits 1. */
class SignError extends Error {}

const POSIX = process.platform !== 'win32';

/**
 * Reads at most `max` bytes of a regular file, answering its bytes and (bigint) stat. Opened
 * non-blocking, so a FIFO can't hang the script, and checked with `fstat` on the opened descriptor,
 * so the checks are about the file that is read. With `owner` (POSIX), the file must be owned by
 * that uid and have no group or other permission bits.
 */
function readRegularFile(file, max, { what, owner }) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    throw new SignError(`${what}: cannot open it (${error?.code ?? 'error'})`);
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new SignError(`${what}: not a regular file`);
    if (owner !== undefined) {
      if (stat.uid !== BigInt(owner)) throw new SignError(`${what}: not owned by you (the user running this script)`);
      const mode = Number(stat.mode);
      if ((mode & 0o077) !== 0) {
        throw new SignError(`${what}: readable or writable by group or others (mode ${(mode & 0o777).toString(8)}); chmod 600 it`);
      }
    }
    if (stat.size > BigInt(max)) throw new SignError(`${what}: larger than ${max} bytes`);
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    for (let read; length <= max && (read = readSync(fd, buffer, length, buffer.length - length, null)) > 0; ) length += read;
    if (length > max) throw new SignError(`${what}: larger than ${max} bytes`);
    return { bytes: buffer.subarray(0, length), stat };
  } finally {
    closeSync(fd);
  }
}

/** The Ed25519 private key in `pem` (an unencrypted PEM, PKCS#8). The buffer is zeroed after. */
export function parseSigningKey(pem) {
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
 * Validates `manifestBytes` (fresh at `now`) and signs them as they are with `privateKey`, whose
 * public half must be one of `keys`. Answers the envelope's bytes (pretty JSON), after verifying
 * them with `verifyEnvelope` against `keys` at `now`, with the parsed manifest and the `keyId`.
 */
export function signManifest(manifestBytes, privateKey, { keys = UPDATE_PUBLIC_KEYS, now = Date.now() } = {}) {
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new SignError(`manifest: larger than ${MAX_MANIFEST_BYTES} bytes`);
  const json = readJson(manifestBytes);
  if (!json.ok) {
    throw new SignError(json.reason === 'duplicate-key' ? 'manifest: an object repeats a key (duplicate key)' : 'manifest: not UTF-8 JSON');
  }
  const parsed = parseManifest(json.value);
  if (!parsed.ok) throw new SignError(`manifest: ${parsed.error}`);
  const stale = checkFreshness(parsed.manifest, now);
  if (stale === 'expired') throw new SignError(`manifest: expired (expiresAt ${parsed.manifest.expiresAt} is not in the future)`);
  if (stale === 'not-yet-valid') throw new SignError(`manifest: not yet valid (releasedAt ${parsed.manifest.releasedAt} is more than a day ahead)`);

  const keyId = trustedKeyId(privateKey, keys);
  if (keyId === null) throw new SignError('signing key: its public key is not one the app trusts (UPDATE_PUBLIC_KEYS)');

  const payload = Buffer.from(manifestBytes);
  const envelope = {
    format: UPDATE_ENVELOPE_FORMAT,
    keyId,
    payload: payload.toString('base64'),
    signature: sign(null, signatureInput(payload), privateKey).toString('base64'),
  };
  const envelopeBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`);

  const check = verifyEnvelope(envelopeBytes, { keys, now });
  if (!check.ok || check.keyId !== keyId || !Buffer.from(envelope.payload, 'base64').equals(payload)) {
    throw new SignError(`self-check failed (${check.ok ? 'payload mismatch' : check.reason}); nothing written`);
  }
  return { envelopeBytes, keyId, manifest: check.manifest, payloadSha256: createHash('sha256').update(payload).digest('hex') };
}

/** The lines describing what is about to be written (all of it validated, nothing secret). */
function summary(manifestPath, { manifest, keyId, payloadSha256 }) {
  const lines = [
    `Signing ${manifestPath}`,
    `  version: ${manifest.version}`,
    `  minimum version: ${manifest.minimumVersion ?? 'none'}`,
    `  rollout: ${manifest.rolloutPercent}%`,
    `  released at: ${manifest.releasedAt}`,
    `  expires at: ${manifest.expiresAt}`,
    `  notes: ${manifest.notes.length} characters`,
  ];
  for (const platform of UPDATE_PLATFORMS) {
    const artifact = manifest.artifacts[platform];
    if (artifact === undefined) continue;
    lines.push(`  ${platform}: ${artifact.url}`, `    sha256 ${artifact.sha256}`, `    size ${artifact.size} bytes`);
  }
  lines.push(`  manifest SHA-256 (sha256sum of the file; these bytes are signed, after the context prefix): ${payloadSha256}`, `  keyId: ${keyId}`);
  return lines.join('\n');
}

/** `x.json` -> `x.signed.json`; anything else gets `.signed.json` appended. */
const defaultOut = (manifestPath) => `${manifestPath.replace(/\.json$/i, '')}.signed.json`;

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;

/**
 * Where to write: the output with its directory's symlinks resolved (created if missing). Refuses
 * an output that is the key or the manifest (same device and inode, or the same resolved path),
 * even with `force`, and an existing output without `force`.
 */
function outputTarget(outPath, { key, manifest, force }) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  const target = path.join(realpathSync(path.dirname(outPath)), path.basename(outPath));
  const existing = lstatSync(target, { throwIfNoEntry: false, bigint: true });
  if (existing !== undefined) {
    const resolved = statSync(target, { throwIfNoEntry: false, bigint: true }) ?? existing;
    for (const [what, file] of [['signing key', key], ['manifest', manifest]]) {
      if (sameFile(existing, file.stat) || sameFile(resolved, file.stat)) throw new SignError(`--out: must not be the ${what}`);
    }
    if (!force) throw new SignError(`--out: ${target} exists; pass --force to replace it`);
  }
  return target;
}

/** Writes `bytes` to a temporary file in `target`'s directory, then moves it into place. */
function writeViaTemp(target, bytes, { force }) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o644 });
    if (force) {
      renameSync(temp, target);
    } else {
      // A hard link fails if the target appeared meanwhile, where a rename would replace it.
      try {
        linkSync(temp, target);
      } catch (error) {
        throw new SignError(error?.code === 'EEXIST' ? `--out: ${target} exists; pass --force to replace it` : `--out: cannot write it (${error?.code ?? 'error'})`);
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * The command line. `keys` (the trusted keys) and `getuid` are for tests only; the command line
 * can't change them. Relative paths are taken from `cwd` (by default the directory `pnpm` was run
 * in). Answers the exit code.
 */
export function main(
  argv,
  { env = process.env, keys = UPDATE_PUBLIC_KEYS, cwd, stdout = console.log, stderr = console.error, getuid = () => process.getuid?.() } = {},
) {
  try {
    let args;
    try {
      args = parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: { out: { type: 'string' }, force: { type: 'boolean', default: false } },
      });
    } catch (error) {
      throw new SignError(`${error.message}\n${USAGE}`);
    }
    if (args.positionals.length !== 1) throw new SignError(USAGE);
    const base = cwd ?? env.INIT_CWD ?? process.cwd();
    const manifestPath = path.resolve(base, args.positionals[0]);
    const outPath = path.resolve(base, args.values.out ?? defaultOut(manifestPath));
    if (outPath === manifestPath) throw new SignError('--out: must not be the manifest');

    const keyPath = env[UPDATE_SIGNING_KEY_ENV];
    if (keyPath === undefined || keyPath === '') {
      throw new SignError(`${UPDATE_SIGNING_KEY_ENV} is not set: set it to the path of the Ed25519 signing key (PEM)\n${USAGE}`);
    }
    if (!POSIX) stderr('sign:update-manifest: warning: on Windows the key file\'s ACLs are not checked; make sure only you can read it');
    const keyFile = readRegularFile(path.resolve(base, keyPath), MAX_KEY_FILE_BYTES, { what: 'signing key', owner: POSIX ? getuid() : undefined });
    const privateKey = parseSigningKey(keyFile.bytes);
    const manifestFile = readRegularFile(manifestPath, MAX_MANIFEST_BYTES, { what: 'manifest' });
    const target = outputTarget(outPath, { key: keyFile, manifest: manifestFile, force: args.values.force });

    const signed = signManifest(manifestFile.bytes, privateKey, { keys });
    stdout(summary(manifestPath, signed));
    writeViaTemp(target, signed.envelopeBytes, { force: args.values.force });
    stdout(`Signed frost ${signed.manifest.version} (keyId ${signed.keyId}): ${outPath}`);
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
