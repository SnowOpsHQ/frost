// Spec: specs/intent-classifier.spec.ts (Least privilege) · specs/intent-classifier.schema.ts
// (IntentRequestSchema, IntentResponseSchema) · Acceptance: specs/intent-classifier.feature.md
// (Utility process); review focus intent-host-protocol-is-closed
import { describe, expect, test, vi } from 'vitest';
import { INTENT_FAKE_MODEL, INTENT_MODEL } from '@app/specs/intent-classifier.spec';
import { IntentResponseSchema, type IntentResponse } from '@app/specs/intent-classifier.schema';
import type { OrtLike, OrtTensor } from '../embed';
import { createIntentWorker } from '../worker';

const VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'buy', 'best', 'how', 'login', 'shoes'].join('\n');
const DIMS = INTENT_MODEL.dimensions;

/** An ONNX Runtime whose model gives each token id its own direction (so queries differ). */
function fakeOrt(options: { createFails?: boolean } = {}): OrtLike {
  return {
    Tensor: class {
      constructor(
        readonly type: string,
        readonly data: unknown,
        readonly dims: readonly number[],
      ) {}
    } as unknown as OrtLike['Tensor'],
    InferenceSession: {
      create: async () => {
        if (options.createFails) throw new Error('bad model');
        return {
          inputNames: [...INTENT_MODEL.inputs],
          outputNames: [INTENT_MODEL.output],
          run: async (feeds): Promise<Record<string, OrtTensor>> => {
            // The self-test's built-in model: y = x + x.
            const x = feeds['x'];
            if (x) return { y: { type: 'float32', data: (x.data as Float32Array).map((value) => value * 2), dims: x.dims } };
            const ids = feeds['input_ids']!;
            const [batch, tokens] = ids.dims as [number, number];
            const data = new Float32Array(batch * tokens * DIMS);
            (ids.data as BigInt64Array).forEach((value, index) => {
              data[index * DIMS + (Number(value) % DIMS)] = 1;
            });
            return { [INTENT_MODEL.output]: { type: 'float32', data, dims: [batch, tokens, DIMS] } };
          },
        };
      },
    },
    listSupportedBackends: () => [{ name: 'cpu' }, { name: 'webgpu', bundled: true }, { name: 'cuda', bundled: false }],
  };
}

function harness(ort: () => Promise<OrtLike> = async () => fakeOrt()) {
  const posted: IntentResponse[] = [];
  const loadOrt = vi.fn(ort);
  const worker = createIntentWorker({ post: (message) => void posted.push(message), loadOrt, platform: 'linux', arch: 'x64' });
  return { posted, loadOrt, worker };
}

const MODEL = new Uint8Array([1, 2, 3]);

describe('intent utility process', () => {
  test('intent-host-protocol-is-closed (malformed requests are dropped)', async () => {
    const { posted, loadOrt, worker } = harness();
    const malformed: unknown[] = [
      null,
      'classify',
      42,
      [],
      {},
      { type: 'classify' },
      { type: 'classify', id: 1, query: '' },
      { type: 'classify', id: 0, query: 'x' },
      { type: 'classify', id: 1.5, query: 'x' },
      { type: 'classify', id: 1, query: 'x'.repeat(257) },
      { type: 'classify', id: 1, query: 'x', extra: true },
      { type: 'load', id: 1, model: 'bytes', vocab: VOCAB },
      { type: 'load', id: 1, model: new Uint8Array(0), vocab: VOCAB },
      { type: 'load', id: 1, model: new Uint8Array(INTENT_MODEL.files.model.bytes + 1), vocab: VOCAB },
      { type: 'load', id: 1, model: MODEL, vocab: '' },
      { type: 'eval', id: 1, code: '1' },
      { type: 'ping' },
    ];
    for (const message of malformed) await worker.handle(message);
    expect(posted).toEqual([]);
    expect(loadOrt).not.toHaveBeenCalled();
  });

  test('intent-worker-answers-each-request', async () => {
    const { posted, worker } = harness();
    await worker.handle({ type: 'ping', id: 1 });
    await worker.handle({ type: 'classify', id: 2, query: 'buy shoes' });
    expect(posted).toEqual([
      { type: 'pong', id: 1 },
      { type: 'error', id: 2, reason: 'not-loaded' },
    ]);
    for (const message of posted) expect(IntentResponseSchema.safeParse(message).success).toBe(true);
  });

  test('intent-worker-fake-never-loads-the-runtime', async () => {
    const { posted, loadOrt, worker } = harness();
    await worker.handle({ type: 'load-fake', id: 1 });
    await worker.handle({ type: 'classify', id: 2, query: 'buy shoes' });
    expect(loadOrt).not.toHaveBeenCalled();
    expect(posted[0]).toEqual({ type: 'loaded', id: 1, model: INTENT_FAKE_MODEL, provider: 'fake' });
    expect(posted[1]).toMatchObject({ type: 'result', id: 2, result: { label: 'transactional', model: INTENT_FAKE_MODEL } });
    for (const message of posted) expect(IntentResponseSchema.safeParse(message).success).toBe(true);
  });

  test('intent-worker-loads-bytes-and-classifies', async () => {
    const { posted, loadOrt, worker } = harness();
    await worker.handle({ type: 'load', id: 1, model: MODEL, vocab: VOCAB });
    expect(loadOrt).toHaveBeenCalledTimes(1);
    expect(posted[0]).toEqual({ type: 'loaded', id: 1, model: INTENT_MODEL.id, provider: 'cpu' });
    await worker.handle({ type: 'classify', id: 2, query: 'best shoes' });
    expect(posted[1]).toMatchObject({ type: 'result', id: 2, result: { model: INTENT_MODEL.id } });
    for (const message of posted) expect(IntentResponseSchema.safeParse(message).success).toBe(true);
  });

  test('intent-worker-load-failures', async () => {
    const badVocab = harness();
    await badVocab.worker.handle({ type: 'load', id: 1, model: MODEL, vocab: 'buy\nshoes' });
    expect(badVocab.posted).toEqual([{ type: 'error', id: 1, reason: 'bad-vocab' }]);

    const noRuntime = harness(async () => {
      throw new Error('cannot dlopen');
    });
    await noRuntime.worker.handle({ type: 'load', id: 1, model: MODEL, vocab: VOCAB });
    await noRuntime.worker.handle({ type: 'classify', id: 2, query: 'buy shoes' });
    expect(noRuntime.posted).toEqual([
      { type: 'error', id: 1, reason: 'load-failed' },
      { type: 'error', id: 2, reason: 'not-loaded' },
    ]);

    const badModel = harness(async () => fakeOrt({ createFails: true }));
    await badModel.worker.handle({ type: 'load', id: 1, model: MODEL, vocab: VOCAB });
    expect(badModel.posted).toEqual([{ type: 'error', id: 1, reason: 'load-failed' }]);
  });

  test('intent-worker-selftest', async () => {
    const { posted, worker } = harness();
    await worker.handle({ type: 'selftest', id: 1 });
    expect(posted).toEqual([{ type: 'selftest', id: 1, backends: ['cpu', 'webgpu'], provider: 'cpu' }]);

    const broken = harness(async () => {
      throw new Error('cannot dlopen');
    });
    await broken.worker.handle({ type: 'selftest', id: 1 });
    expect(broken.posted).toEqual([{ type: 'error', id: 1, reason: 'selftest-failed' }]);
  });

  test('intent-selftest-model-runs (on the installed ONNX Runtime)', { timeout: 30_000 }, async () => {
    // The built-in model, on the real runtime: what the packaged self-test runs in the utility process.
    const { posted, worker } = harness(async () => {
      const ort = (await import('onnxruntime-node')) as unknown as OrtLike & { default?: OrtLike };
      return ort.default ?? ort;
    });
    await worker.handle({ type: 'selftest', id: 7 });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'selftest', id: 7, provider: 'cpu' });
    expect(IntentResponseSchema.safeParse(posted[0]).success).toBe(true);
    expect((posted[0] as { backends: string[] }).backends).toContain('cpu');
  });
});
