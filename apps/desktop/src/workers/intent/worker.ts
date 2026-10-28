import { INTENT_FAKE_MODEL, INTENT_MODEL, type IntentResult } from '@app/specs/intent-classifier.spec';
import { IntentRequestSchema, type IntentErrorReason, type IntentRequest, type IntentResponse } from '@app/specs/intent-classifier.schema';
import { createEmbedder, createSession, type OrtLike } from './embed';
import { fakeIntent } from './fake';
import { buildCentroids, classifyVector } from './prototypes';
import { SELFTEST_INPUT, SELFTEST_MODEL, SELFTEST_OUTPUT, SELFTEST_SIZE } from './selftest-model';
import { createTokenizer, parseVocab, type Tokenizer } from './tokenizer';

// The intent utility process's message handling (spec `intent-classifier.spec.ts`, Least
// privilege; protocol `intent-classifier.schema.ts`; acceptance `intent-classifier.feature.md`,
// Utility process; review focus `intent-host-protocol-is-closed`). Every incoming message is
// validated with `IntentRequestSchema`; one that does not parse is dropped unanswered (main times
// the request out). Requests are handled one at a time, in order. All the process ever gets is the
// model's bytes, the vocabulary's text and queries; it answers through `post` only. ONNX Runtime is
// loaded on the first `load` or `selftest`, never for `load-fake`.

export interface IntentWorkerDeps {
  /** Answers main (`process.parentPort.postMessage`). */
  readonly post: (message: IntentResponse) => void;
  /** Loads `onnxruntime-node` (lazily, once). */
  readonly loadOrt: () => Promise<OrtLike>;
  readonly platform: string;
  readonly arch: string;
}

export interface IntentWorker {
  /** Handles one message from main (anything; only valid requests are answered). Resolves once it is answered. */
  handle(raw: unknown): Promise<void>;
}

type Engine = (query: string) => Promise<IntentResult>;

export function createIntentWorker(deps: IntentWorkerDeps): IntentWorker {
  let engine: Engine | null = null;
  let ort: Promise<OrtLike> | null = null;
  let queue: Promise<void> = Promise.resolve();

  const runtime = (): Promise<OrtLike> => {
    ort ??= deps.loadOrt();
    // A failed load is tried again on the next request.
    return ort.catch((error: unknown) => {
      ort = null;
      throw error;
    });
  };

  const fail = (id: number, reason: IntentErrorReason): void => deps.post({ type: 'error', id, reason });

  async function load(id: number, model: Uint8Array, vocabText: string): Promise<void> {
    engine = null;
    let tokenizer: Tokenizer;
    try {
      tokenizer = createTokenizer(parseVocab(vocabText));
    } catch {
      return fail(id, 'bad-vocab');
    }
    try {
      const loaded = await runtime();
      const { session, provider } = await createSession(loaded, model, deps.platform, deps.arch);
      const embedder = createEmbedder(loaded, session, tokenizer);
      const centroids = await buildCentroids((texts) => embedder.embed(texts));
      engine = async (query) => {
        const [vector] = await embedder.embed([query]);
        return classifyVector(vector!, centroids, query, INTENT_MODEL.id);
      };
      deps.post({ type: 'loaded', id, model: INTENT_MODEL.id, provider });
    } catch {
      fail(id, 'load-failed');
    }
  }

  async function selftest(id: number): Promise<void> {
    try {
      const loaded = await runtime();
      const backends = [...new Set(loaded.listSupportedBackends().filter((backend) => backend.bundled !== false).map((backend) => backend.name.toLowerCase()))].filter((name) => /^[a-z0-9_-]{1,32}$/.test(name)).slice(0, 16);
      const { session, provider } = await createSession(loaded, SELFTEST_MODEL, deps.platform, deps.arch);
      const input = Float32Array.from({ length: SELFTEST_SIZE }, (_, index) => index + 1);
      const output = (await session.run({ [SELFTEST_INPUT]: new loaded.Tensor('float32', input, [SELFTEST_SIZE]) }))[SELFTEST_OUTPUT];
      const data = output?.data;
      if (!(data instanceof Float32Array) || data.length !== SELFTEST_SIZE || !input.every((value, index) => data[index] === value * 2) || backends.length === 0) throw new Error('wrong answer');
      deps.post({ type: 'selftest', id, backends, provider });
    } catch {
      fail(id, 'selftest-failed');
    }
  }

  async function answer(request: IntentRequest): Promise<void> {
    switch (request.type) {
      case 'load':
        return load(request.id, request.model, request.vocab);
      case 'load-fake':
        engine = async (query) => fakeIntent(query);
        return deps.post({ type: 'loaded', id: request.id, model: INTENT_FAKE_MODEL, provider: 'fake' });
      case 'classify': {
        if (engine === null) return fail(request.id, 'not-loaded');
        try {
          return deps.post({ type: 'result', id: request.id, result: await engine(request.query) });
        } catch {
          return fail(request.id, 'classify-failed');
        }
      }
      case 'ping':
        return deps.post({ type: 'pong', id: request.id });
      case 'selftest':
        return selftest(request.id);
    }
  }

  return {
    handle(raw) {
      const parsed = IntentRequestSchema.safeParse(raw);
      if (!parsed.success) return queue;
      queue = queue.then(() => answer(parsed.data)).catch(() => undefined);
      return queue;
    },
  };
}
