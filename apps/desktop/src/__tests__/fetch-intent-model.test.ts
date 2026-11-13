// Spec: specs/intent-classifier.spec.ts (INTENT_MODEL) · Acceptance: specs/ci-pipeline.feature.md (The intent model)
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { INTENT_MODEL } from '@app/specs/intent-classifier.spec';

const ROOT = path.resolve(import.meta.dirname, '../../../..');

interface PinnedFile {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}
type FetchLike = (url: string, init?: { redirect?: string; signal?: AbortSignal }) => Promise<Response>;

/** The script's exports (it is plain JavaScript; this is the part the tests use). */
interface FetchModule {
  INTENT_MODEL_DIR_ENV: string;
  fetchIntentModel(options: { dir: string; files?: readonly PinnedFile[]; fetch?: FetchLike; log?: (line: string) => void }): Promise<'ready' | 'unreachable' | 'mismatch'>;
  main(
    argv: readonly string[],
    options: {
      env: Readonly<Record<string, string | undefined>>;
      home?: string;
      files?: readonly PinnedFile[];
      fetch?: FetchLike;
      stdout?: (line: string) => void;
      stderr?: (line: string) => void;
      append?: (file: string, text: string) => void;
    },
  ): Promise<number>;
}
const script = (await import(pathToFileURL(path.join(ROOT, 'scripts/fetch-intent-model.mjs')).href)) as FetchModule;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pin = (name: string, text: string): PinnedFile & { readonly body: Buffer } => {
  const body = Buffer.from(text);
  return { name, url: `https://models.example/${name}`, sha256: sha256(body), bytes: body.byteLength, body };
};
const MODEL = pin('model.onnx', 'model bytes '.repeat(400));
const VOCAB = pin('vocab.txt', 'hello\nworld\n');
const FILES = [MODEL, VOCAB];

/** A host serving `bodies` by URL (anything else: 404); what was asked of it. */
function host(bodies: Readonly<Record<string, Uint8Array | number | Error>>): { fetch: FetchLike; asked: { url: string; redirect: string | undefined; timed: boolean }[] } {
  const asked: { url: string; redirect: string | undefined; timed: boolean }[] = [];
  return {
    asked,
    fetch: async (url, init) => {
      asked.push({ url, redirect: init?.redirect, timed: init?.signal instanceof AbortSignal });
      const body = bodies[url];
      if (body instanceof Error) throw body;
      if (typeof body === 'number') return new Response('no', { status: body });
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(new Blob([Buffer.from(body)]), { status: 200 });
    },
  };
}
const serving = (model: Uint8Array | number | Error = MODEL.body, vocab: Uint8Array | number | Error = VOCAB.body) => host({ [MODEL.url]: model, [VOCAB.url]: vocab });

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'frost-intent-fetch-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('fetch-intent-model', () => {
  test('intent-model-fetched', async () => {
    const target = path.join(dir, 'nested', 'model');
    const first = serving();
    const lines: string[] = [];
    expect(await script.fetchIntentModel({ dir: target, files: FILES, fetch: first.fetch, log: (line) => lines.push(line) })).toBe('ready');
    // Each file from its pinned URL, following the host's redirect, with a time limit.
    expect(first.asked).toEqual([
      { url: MODEL.url, redirect: 'follow', timed: true },
      { url: VOCAB.url, redirect: 'follow', timed: true },
    ]);
    expect((await readdir(target)).sort()).toEqual([MODEL.name, VOCAB.name]);
    expect(await readFile(path.join(target, MODEL.name))).toEqual(MODEL.body);
    expect(await readFile(path.join(target, VOCAB.name))).toEqual(VOCAB.body);
    expect(lines).toHaveLength(2);

    // Already there and matching: kept, and the host is not asked (it would fail here).
    const down = serving(new Error('offline'), new Error('offline'));
    expect(await script.fetchIntentModel({ dir: target, files: FILES, fetch: down.fetch })).toBe('ready');
    expect(down.asked).toEqual([]);

    // A file on disk that no longer matches is fetched again; the matching one is left alone.
    await writeFile(path.join(target, VOCAB.name), 'tampered');
    const again = serving();
    expect(await script.fetchIntentModel({ dir: target, files: FILES, fetch: again.fetch })).toBe('ready');
    expect(again.asked.map((request) => request.url)).toEqual([VOCAB.url]);
    expect(await readFile(path.join(target, VOCAB.name))).toEqual(VOCAB.body);
  });

  test('intent-model-mismatch-is-refused', async () => {
    const wrong: [string, Uint8Array][] = [
      ['other bytes of the same length', Buffer.from(MODEL.body.map((byte) => byte ^ 1))],
      ['shorter', MODEL.body.subarray(0, MODEL.bytes - 1)],
      ['longer than pinned', Buffer.concat([MODEL.body, Buffer.from('x')])],
      ['empty', new Uint8Array(0)],
    ];
    for (const [what, body] of wrong) {
      const lines: string[] = [];
      expect(await script.fetchIntentModel({ dir, files: FILES, fetch: serving(body).fetch, log: (line) => lines.push(line) }), what).toBe('mismatch');
      // Nothing written, not even a temporary file, and the next file is not asked for.
      expect(await readdir(dir), what).toEqual([]);
      expect(lines.at(-1), what).toContain('nothing was written');
    }
    // The command fails the step and reports no `available`.
    const appended: string[] = [];
    const err: string[] = [];
    const code = await script.main([], {
      env: { [script.INTENT_MODEL_DIR_ENV]: dir, GITHUB_OUTPUT: 'out' },
      files: FILES,
      fetch: serving(Buffer.from('not the model')).fetch,
      stdout: () => undefined,
      stderr: (line) => err.push(line),
      append: (_file, text) => appended.push(text),
    });
    expect(code).toBe(1);
    expect(appended).toEqual([]);
    expect(err.join('\n')).toContain('does not match its pin');
    expect(await readdir(dir)).toEqual([]);
  });

  test('intent-model-unreachable-skips-the-suite', async () => {
    for (const failure of [new Error('getaddrinfo ENOTFOUND'), 503, 404, 302]) {
      const down = serving(failure, failure);
      expect(await script.fetchIntentModel({ dir, files: FILES, fetch: down.fetch }), String(failure)).toBe('unreachable');
      // Every file was still tried, and nothing was written.
      expect(down.asked).toHaveLength(2);
      expect(await readdir(dir)).toEqual([]);
    }
    // One file fetched, the other not: the fetched one is kept for the next run, the answer is still "not available".
    expect(await script.fetchIntentModel({ dir, files: FILES, fetch: serving(MODEL.body, 503).fetch })).toBe('unreachable');
    expect(await readdir(dir)).toEqual([MODEL.name]);

    // The command: exit 0, `available=false`, and a warning on the run that names the host.
    const out: string[] = [];
    const appended: [string, string][] = [];
    const down = host({});
    const code = await script.main([], { env: { [script.INTENT_MODEL_DIR_ENV]: dir, GITHUB_OUTPUT: 'github-output' }, fetch: down.fetch, stdout: (line) => out.push(line), append: (file, text) => appended.push([file, text]) });
    expect(code).toBe(0);
    expect(appended).toEqual([['github-output', 'available=false\n']]);
    expect(out.at(-1)).toMatch(/^::warning title=Intent model not fetched::huggingface\.co could not be reached/);
    // It asked for the pinned files, at their pinned revision, and nothing else.
    expect(down.asked.map((request) => request.url)).toEqual(Object.values(INTENT_MODEL.files).map((file) => file.url));
    for (const { url } of down.asked) expect(url).toContain(`/resolve/${INTENT_MODEL.revision}/`);
  });

  test('intent-model-fetch-cli', async () => {
    type Run = { code: number; out: string[]; err: string[]; appended: [string, string][] };
    const run = async (argv: readonly string[], env: Record<string, string>, fetch: FetchLike, home = dir): Promise<Run> => {
      const result: Run = { code: -1, out: [], err: [], appended: [] };
      result.code = await script.main(argv, { env, home, files: FILES, fetch, stdout: (line) => result.out.push(line), stderr: (line) => result.err.push(line), append: (file, text) => result.appended.push([file, text]) });
      return result;
    };
    // With no folder named: the suite's default under the home folder. Ready: `available=true`.
    const byDefault = path.join(dir, '.cache/frost-models', INTENT_MODEL.id);
    const fetched = await run([], { GITHUB_OUTPUT: 'github-output' }, serving().fetch);
    expect(fetched).toMatchObject({ code: 0, err: [], appended: [['github-output', 'available=true\n']] });
    expect(fetched.out.at(-1)).toBe(`intent model: ready in ${byDefault}`);
    expect((await readdir(byDefault)).sort()).toEqual([MODEL.name, VOCAB.name]);

    // A named folder wins. No GITHUB_OUTPUT (a developer's run): nothing is appended.
    const named = path.join(dir, 'named');
    const local = await run([], { [script.INTENT_MODEL_DIR_ENV]: named }, serving().fetch);
    expect(local).toMatchObject({ code: 0, appended: [] });
    expect((await readdir(named)).sort()).toEqual([MODEL.name, VOCAB.name]);

    // Arguments are a mistake: usage, nothing asked.
    for (const argv of [['--help'], ['dir'], ['a', 'b']]) {
      const idle = serving();
      const refused = await run(argv, {}, idle.fetch);
      expect(refused.code, argv.join(' ')).toBe(2);
      expect(refused.err.join('\n'), argv.join(' ')).toContain('usage:');
      expect(idle.asked).toEqual([]);
    }
  });
});
