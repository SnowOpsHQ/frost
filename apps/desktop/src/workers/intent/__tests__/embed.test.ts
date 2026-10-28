// Spec: specs/intent-classifier.spec.ts (How a query is classified: Embed; INTENT_MODEL inputs,
// output, dimensions) · Acceptance: specs/intent-classifier.feature.md (Embedding)
import { describe, expect, test } from 'vitest';
import { INTENT_MODEL } from '@app/specs/intent-classifier.spec';
import { createEmbedder, createSession, EXECUTION_PROVIDERS, l2Normalise, meanPool, type OrtLike, type OrtSession, type OrtTensor } from '../embed';

const close = (actual: ArrayLike<number>, expected: readonly number[]) => {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 6));
};

/** A minimal ONNX Runtime: records sessions created, and runs `run` on the feeds. */
function fakeOrt(options: { refuse?: (providers: readonly string[]) => boolean; run?: OrtSession['run'] } = {}) {
  const created: (readonly string[])[] = [];
  const ort: OrtLike = {
    Tensor: class {
      constructor(
        readonly type: string,
        readonly data: unknown,
        readonly dims: readonly number[],
      ) {}
    } as unknown as OrtLike['Tensor'],
    InferenceSession: {
      create: async (_bytes, sessionOptions) => {
        const providers = sessionOptions.executionProviders;
        created.push(providers);
        if (options.refuse?.(providers)) throw new Error('provider not available');
        return { inputNames: [...INTENT_MODEL.inputs], outputNames: [INTENT_MODEL.output], run: options.run ?? (async () => ({})) };
      },
    },
    listSupportedBackends: () => [{ name: 'cpu' }],
  };
  return { ort, created };
}

describe('intent embedding', () => {
  test('intent-pooling-and-normalisation', () => {
    // [batch 2, tokens 3, dims 2]; row 0 averages tokens 0 and 1, row 1 only token 0.
    const hidden = Float32Array.from([1, 2, 3, 4, 100, 100, 5, 6, 100, 100, 100, 100]);
    const pooled = meanPool(hidden, [2, 3, 2], [1, 1, 0, 1, 0, 0]);
    close(pooled[0]!, [2, 3]);
    close(pooled[1]!, [5, 6]);
    // A row with no unmasked token pools to zeros, never NaN.
    close(meanPool(Float32Array.from([1, 2]), [1, 1, 2], [0])[0]!, [0, 0]);
    close(l2Normalise(Float32Array.from([3, 4])), [0.6, 0.8]);
    close(l2Normalise(Float32Array.from([0, 0])), [0, 0]);
    expect(() => meanPool(new Float32Array(3), [1, 2, 2], [1, 1])).toThrow(/shape/);
  });

  test('intent-session-is-cpu-only', async () => {
    // The CPU execution provider on every platform (spec, Decisions: CPU only), from the model's bytes.
    expect(EXECUTION_PROVIDERS).toEqual(['cpu']);
    const cpu = fakeOrt();
    expect((await createSession(cpu.ort, new Uint8Array(1))).provider).toBe('cpu');
    expect(cpu.created).toEqual([['cpu']]);
    // A session that cannot be created is an error (the worker answers load-failed).
    const none = fakeOrt({ refuse: () => true });
    await expect(createSession(none.ort, new Uint8Array(1))).rejects.toThrow(/provider/);
  });

  test('intent-embedder-feeds-the-model', async () => {
    const feeds: Record<string, OrtTensor>[] = [];
    const dims = 4;
    // Each token's hidden state is [id, 1, 0, 0]: pooling then gives the mean id of the row.
    const { ort } = fakeOrt({
      run: async (input) => {
        feeds.push(input);
        const ids = input['input_ids']!;
        const [batch, tokens] = ids.dims as [number, number];
        const data = new Float32Array(batch * tokens * dims);
        (ids.data as BigInt64Array).forEach((value, index) => {
          data[index * dims] = Number(value);
          data[index * dims + 1] = 1;
        });
        return { [INTENT_MODEL.output]: { type: 'float32', data, dims: [batch, tokens, dims] } };
      },
    });
    const { session } = await createSession(ort, new Uint8Array(1));
    const tokenizer = { encode: (text: string) => (text === 'a' ? [2, 7, 3] : [2, 3]) };
    const vectors = await createEmbedder(ort, session, tokenizer).embed(['a', 'b']);
    // One batch, padded to the longest row with id 0 and mask 0; token types all 0; int64 tensors.
    expect(feeds).toHaveLength(1);
    const feed = feeds[0]!;
    expect(Object.keys(feed).sort()).toEqual([...INTENT_MODEL.inputs].sort());
    for (const name of INTENT_MODEL.inputs) {
      expect(feed[name]!.type).toBe('int64');
      expect(feed[name]!.dims).toEqual([2, 3]);
    }
    expect([...(feed['input_ids']!.data as BigInt64Array)]).toEqual([2n, 7n, 3n, 2n, 3n, 0n]);
    expect([...(feed['attention_mask']!.data as BigInt64Array)]).toEqual([1n, 1n, 1n, 1n, 1n, 0n]);
    expect([...(feed['token_type_ids']!.data as BigInt64Array)]).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
    // Mean of [2,1],[7,1],[3,1] = [4,1]; of [2,1],[3,1] = [2.5,1]; each normalised.
    close(vectors[0]!, [4 / Math.hypot(4, 1), 1 / Math.hypot(4, 1), 0, 0]);
    close(vectors[1]!, [2.5 / Math.hypot(2.5, 1), 1 / Math.hypot(2.5, 1), 0, 0]);
    expect(await createEmbedder(ort, session, tokenizer).embed([])).toEqual([]);
  });

  test('intent-embedder-refuses-a-wrong-output', async () => {
    const { ort } = fakeOrt({ run: async () => ({ [INTENT_MODEL.output]: { type: 'float32', data: new Float32Array(2), dims: [1, 2] } }) });
    const { session } = await createSession(ort, new Uint8Array(1));
    await expect(createEmbedder(ort, session, { encode: () => [2, 3] }).embed(['a'])).rejects.toThrow(/shape/);
    const { ort: missing } = fakeOrt({ run: async () => ({}) });
    const { session: empty } = await createSession(missing, new Uint8Array(1));
    await expect(createEmbedder(missing, empty, { encode: () => [2, 3] }).embed(['a'])).rejects.toThrow(INTENT_MODEL.output);
  });
});
