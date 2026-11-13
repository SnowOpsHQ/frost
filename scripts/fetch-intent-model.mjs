#!/usr/bin/env node
// Puts the on-device intent model's pinned files (specs/intent-classifier.spec.ts, INTENT_MODEL)
// where the real-model suite looks for them (apps/desktop/src/workers/intent/__tests__/
// intent-model.test.ts), so CI's Linux unit jobs can run that suite instead of skipping it
// (acceptance: specs/ci-pipeline.feature.md, intent-model-fetched):
//
//   node scripts/fetch-intent-model.mjs
//
// The folder is FROST_INTENT_MODEL_DIR, else `~/.cache/frost-models/<model id>` (the suite's own
// default). A file already there with the pinned size and sha256 is kept. Any other is downloaded
// from its pinned URL, never more than its pinned size, and written only when its sha256 matches.
//
// It appends `available=true` or `available=false` to the file named by GITHUB_OUTPUT and exits:
//   0, available=true   every file is in place;
//   0, available=false  the host could not be reached or did not answer 200 (a warning says so):
//                       the suite then skips itself, and a download host's bad day fails no run;
//   1                   a file came back with another size or sha256 than pinned: never written.
//
// The spec is erasable TypeScript with no imports, loaded with Node's built-in type stripping
// (Node >= 22.18).
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { INTENT_MODEL } = await import('../specs/intent-classifier.spec.ts');

/** How long one file's download may take. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** The variable naming the folder (as the suite reads it). */
export const INTENT_MODEL_DIR_ENV = 'FROST_INTENT_MODEL_DIR';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {{ bytes: number, sha256: string }} file */
const matches = (file, bytes) => bytes.byteLength === file.bytes && sha256(bytes) === file.sha256;

/**
 * The body of `response`, or `null` once it is longer than `maxBytes` (the rest is not read).
 * @param {Response} response
 * @param {number} maxBytes
 */
async function readCapped(response, maxBytes) {
  if (response.body === null) return new Uint8Array(0);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {{
 *   dir: string,
 *   files?: readonly { name: string, url: string, sha256: string, bytes: number }[],
 *   fetch?: typeof globalThis.fetch,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<'ready' | 'unreachable' | 'mismatch'>}
 */
export async function fetchIntentModel(options) {
  const files = options.files ?? Object.values(INTENT_MODEL.files);
  const fetch = options.fetch ?? globalThis.fetch;
  const log = options.log ?? (() => undefined);
  let unreachable = false;
  for (const file of files) {
    const target = path.join(options.dir, file.name);
    const onDisk = await readFile(target).catch(() => null);
    if (onDisk !== null && matches(file, onDisk)) {
      log(`${file.name}: already there`);
      continue;
    }
    let bytes;
    try {
      const response = await fetch(file.url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        log(`${file.name}: the host answered ${response.status}`);
        unreachable = true;
        continue;
      }
      bytes = await readCapped(response, file.bytes);
    } catch (error) {
      log(`${file.name}: could not be downloaded (${error instanceof Error ? error.message : String(error)})`);
      unreachable = true;
      continue;
    }
    if (bytes === null || !matches(file, bytes)) {
      log(`${file.name}: what came back is not the pinned file (${bytes === null ? `more than ${file.bytes} bytes` : `${bytes.byteLength} bytes, sha256 ${sha256(bytes)}`}); nothing was written`);
      return 'mismatch';
    }
    await mkdir(options.dir, { recursive: true });
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    log(`${file.name}: downloaded (${bytes.byteLength} bytes, sha256 matches)`);
  }
  return unreachable ? 'unreachable' : 'ready';
}

/**
 * @param {readonly string[]} argv
 * @param {{
 *   env: Readonly<Record<string, string | undefined>>,
 *   home?: string,
 *   files?: readonly { name: string, url: string, sha256: string, bytes: number }[],
 *   fetch?: typeof globalThis.fetch,
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   append?: (file: string, text: string) => void,
 * }} options
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, options) {
  const stdout = options.stdout ?? ((line) => console.log(line));
  const stderr = options.stderr ?? ((line) => console.error(line));
  const append = options.append ?? ((file, text) => appendFileSync(file, text));
  if (argv.length > 0) {
    stderr('usage: node scripts/fetch-intent-model.mjs');
    return 2;
  }
  const dir = options.env[INTENT_MODEL_DIR_ENV] || path.join(options.home ?? homedir(), '.cache/frost-models', INTENT_MODEL.id);
  const state = await fetchIntentModel({
    dir,
    log: (line) => stdout(`intent model: ${line}`),
    ...(options.files ? { files: options.files } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (state === 'mismatch') {
    stderr('intent model: a downloaded file does not match its pin (specs/intent-classifier.spec.ts, INTENT_MODEL)');
    return 1;
  }
  const output = options.env['GITHUB_OUTPUT'];
  if (output) append(output, `available=${state === 'ready'}\n`);
  if (state === 'unreachable') {
    stdout(`::warning title=Intent model not fetched::${INTENT_MODEL.host} could not be reached, so the real-model intent suite is skipped in this job.`);
  } else {
    stdout(`intent model: ready in ${dir}`);
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), { env: process.env });
}
