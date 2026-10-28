#!/usr/bin/env node
// Signs a selector pack (`pnpm sign:selectors <pack.json>`; spec specs/serp-selector-pack.spec.ts,
// trust model; acceptance specs/serp-selector-pack.feature.md, Signing).
//
//   pnpm sign:selectors <pack.json>
//       writes <pack.json>.sig: the base64 Ed25519 signature of the file's exact bytes, made with
//       the PKCS8 PEM private key whose path is in $FROST_SERP_SIGNING_KEY (kept in the
//       maintainers' private key store, never in the repo: a key file inside the repo is refused).
//       The new signature is checked before it is written, and the script says whether its key is
//       one the app embeds (SERP_PACK_PUBLIC_KEYS); the private key is never printed.
//   pnpm sign:selectors --verify <pack.json> [--key <SPKI base64>]
//       checks <pack.json>.sig against the embedded keys, or the one given (an ephemeral test key).
//
// Only a pack the app could use is signed: at most SELECTOR_PACK_LIMITS.maxPackBytes, UTF-8 without
// a BOM (the app imports the bundled pack as text, which must give the signed bytes back), JSON with
// `format: 1` and a positive integer `version`. The full schema (SelectorPackSchema) is checked by
// the app and the tests (`bundled-pack-is-signed`), not here: the script needs nothing installed.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELECTOR_PACK_LIMITS, SERP_PACK_PUBLIC_KEYS, SERP_PACK_SIGNATURE_SUFFIX, SIGNING_KEY_ENV } from '../specs/serp-selector-pack.spec.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: pnpm sign:selectors <pack.json>\n       pnpm sign:selectors --verify <pack.json> [--key <SPKI base64>]';
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

function fail(message) {
  console.error(`sign-selectors: ${message}`);
  process.exit(1);
}

/** The pack's bytes, refused unless the app could use them (see the header). */
function readPack(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    fail(`cannot read ${file}`);
  }
  if (bytes.byteLength > SELECTOR_PACK_LIMITS.maxPackBytes) fail(`${file} is ${bytes.byteLength} bytes; a pack is at most ${SELECTOR_PACK_LIMITS.maxPackBytes}`);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail(`${file} starts with a byte order mark; save it as UTF-8 without one`);
  let pack;
  try {
    pack = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(`${file} is not UTF-8 JSON`);
  }
  if (pack === null || typeof pack !== 'object' || pack.format !== 1) fail(`${file} is not a format 1 selector pack`);
  if (!Number.isSafeInteger(pack.version) || pack.version < 1) fail(`${file} has no positive integer version`);
  return { bytes, version: pack.version };
}

const spkiOf = (key) => createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');

/** Whether `signatureText` is a canonical signature of `bytes` by `spki`. */
function verifies(bytes, signatureText, spki) {
  const text = signatureText.trim();
  if (!SIGNATURE_BASE64.test(text)) return false;
  const signature = Buffer.from(text, 'base64');
  if (signature.byteLength !== SELECTOR_PACK_LIMITS.signatureBytes || signature.toString('base64') !== text) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && verify(null, bytes, key, signature);
  } catch {
    return false;
  }
}

function signPack(file) {
  const keyPath = process.env[SIGNING_KEY_ENV];
  if (!keyPath) fail(`${SIGNING_KEY_ENV} is not set: set it to the path of the PKCS8 PEM private key (kept outside the repo). Nothing was signed.`);
  let realKeyPath;
  try {
    realKeyPath = realpathSync(keyPath);
  } catch {
    fail(`cannot read the key file ${SIGNING_KEY_ENV} names. Nothing was signed.`);
  }
  const inRepo = path.relative(realpathSync(ROOT), realKeyPath);
  if (inRepo !== '..' && !inRepo.startsWith(`..${path.sep}`) && !path.isAbsolute(inRepo)) fail(`the signing key must live outside the repo, never in it. Nothing was signed.`);
  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(realKeyPath));
  } catch {
    fail(`the file ${SIGNING_KEY_ENV} names is not a readable private key. Nothing was signed.`);
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') fail(`the key ${SIGNING_KEY_ENV} names is not an Ed25519 private key. Nothing was signed.`);

  const { bytes, version } = readPack(file);
  const signature = sign(null, bytes, privateKey).toString('base64');
  const spki = spkiOf(privateKey);
  if (!verifies(bytes, signature, spki)) fail('the new signature does not verify. Nothing was written.');

  const out = `${file}${SERP_PACK_SIGNATURE_SUFFIX}`;
  const temp = `${out}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${signature}\n`);
    renameSync(temp, out);
  } catch {
    rmSync(temp, { force: true });
    fail(`cannot write ${out}`);
  }
  console.log(`signed ${file} (version ${version}, ${bytes.byteLength} bytes) -> ${out}`);
  console.log(`public key: ${spki}`);
  if (!SERP_PACK_PUBLIC_KEYS.includes(spki)) console.log('note: this key is not one of SERP_PACK_PUBLIC_KEYS; the app will refuse this pack.');
}

function verifyPackFile(file, key) {
  const { bytes, version } = readPack(file);
  let signatureText;
  try {
    signatureText = readFileSync(`${file}${SERP_PACK_SIGNATURE_SUFFIX}`, 'utf8');
  } catch {
    fail(`cannot read ${file}${SERP_PACK_SIGNATURE_SUFFIX}`);
  }
  const keys = key === undefined ? SERP_PACK_PUBLIC_KEYS : [key];
  const by = keys.find((spki) => verifies(bytes, signatureText, spki));
  if (by === undefined) fail(`${file} is NOT signed by ${key === undefined ? 'any of SERP_PACK_PUBLIC_KEYS' : 'the given key'}`);
  console.log(`verified ${file} (version ${version}) with ${by}`);
}

const args = process.argv.slice(2);
if (args[0] === '--verify') {
  const [, file, flag, key, ...rest] = args;
  if (!file || rest.length > 0 || (flag !== undefined && (flag !== '--key' || !key))) fail(USAGE);
  verifyPackFile(file, key);
} else {
  if (args.length !== 1 || args[0].startsWith('-')) fail(USAGE);
  signPack(args[0]);
}
