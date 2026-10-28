import { INTENT_MODEL } from '@app/specs/intent-classifier.spec';
import type { Tokenizer } from './tokenizer';

// Sentence embeddings for the intent classifier (spec `intent-classifier.spec.ts`, How a query is
// classified: Embed; acceptance `intent-classifier.feature.md`, Embedding). The pooling is pure: the
// model's per-token hidden states averaged over the attention mask, then L2-normalised. The session
// wrapper takes ONNX Runtime as a parameter (the utility process loads `onnxruntime-node` lazily; the
// tests pass a fake, the real-model test the real one) and creates the session from the model's
// bytes, never a path: Core ML first on macOS arm64 with CPU as its fallback, CPU elsewhere.

/** The parts of an ONNX Runtime tensor used here. */
export interface OrtTensor {
  readonly type: string;
  readonly data: unknown;
  readonly dims: readonly number[];
}

/** The parts of an `InferenceSession` used here. */
export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

/** The session options frost sets. */
export interface OrtSessionOptions {
  readonly executionProviders: readonly string[];
  readonly graphOptimizationLevel: 'all';
  readonly intraOpNumThreads: number;
  readonly interOpNumThreads: number;
}

/** The parts of the `onnxruntime-node` module used here. */
export interface OrtLike {
  readonly Tensor: new (type: 'int64' | 'float32', data: BigInt64Array | Float32Array, dims: readonly number[]) => OrtTensor;
  readonly InferenceSession: { create(model: Uint8Array, options: OrtSessionOptions): Promise<OrtSession> };
  /** The runtime's backends; `bundled: false` ones (CUDA, TensorRT) need libraries frost does not ship. */
  listSupportedBackends(): readonly { readonly name: string; readonly bundled?: boolean }[];
}

/**
 * The execution-provider lists to try, in order: Core ML (with CPU for what it does not cover) then
 * CPU alone on macOS arm64; CPU alone elsewhere.
 */
export function executionProviders(platform: string, arch: string): string[][] {
  return platform === 'darwin' && arch === 'arm64' ? [['coreml', 'cpu'], ['cpu']] : [['cpu']];
}

/**
 * A session over `model` (its bytes) on the first provider list that works; `provider` names the
 * first provider of that list. Small thread pools: a query is a few dozen tokens, and the process
 * should not take every core from the browser.
 */
export async function createSession(ort: OrtLike, model: Uint8Array, platform: string, arch: string): Promise<{ session: OrtSession; provider: string }> {
  let failure: unknown = new Error('no execution provider');
  for (const providers of executionProviders(platform, arch)) {
    try {
      const session = await ort.InferenceSession.create(model, { executionProviders: providers, graphOptimizationLevel: 'all', intraOpNumThreads: 2, interOpNumThreads: 1 });
      return { session, provider: providers[0]! };
    } catch (error) {
      failure = error;
    }
  }
  throw failure instanceof Error ? failure : new Error(String(failure));
}

/** Mean of each row's hidden states over its unmasked tokens (`hidden` is `[batch, tokens, dims]`, `mask` `[batch, tokens]`). */
export function meanPool(hidden: Float32Array, shape: readonly [number, number, number], mask: ArrayLike<number | bigint>): Float32Array[] {
  const [batch, tokens, dims] = shape;
  if (hidden.length !== batch * tokens * dims || mask.length !== batch * tokens) throw new Error('hidden states and mask do not match their shape');
  const rows: Float32Array[] = [];
  for (let row = 0; row < batch; row += 1) {
    const sum = new Float32Array(dims);
    let count = 0;
    for (let token = 0; token < tokens; token += 1) {
      if (Number(mask[row * tokens + token]) === 0) continue;
      count += 1;
      const offset = (row * tokens + token) * dims;
      for (let d = 0; d < dims; d += 1) sum[d]! += hidden[offset + d]!;
    }
    if (count > 0) for (let d = 0; d < dims; d += 1) sum[d]! /= count;
    rows.push(sum);
  }
  return rows;
}

/** `vector` scaled to length 1 (a zero vector stays zero). */
export function l2Normalise(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  return norm === 0 ? new Float32Array(vector.length) : vector.map((value) => value / norm);
}

export interface Embedder {
  /** One normalised sentence embedding per text, in order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** Texts embedded per model run (the prototypes are embedded in batches at load). */
const BATCH = 16;

export function createEmbedder(ort: OrtLike, session: OrtSession, tokenizer: Tokenizer): Embedder {
  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const rows = texts.map((text) => tokenizer.encode(text));
    const tokens = Math.max(...rows.map((row) => row.length));
    const ids = new BigInt64Array(rows.length * tokens);
    const mask = new BigInt64Array(rows.length * tokens);
    rows.forEach((row, index) =>
      row.forEach((id, position) => {
        ids[index * tokens + position] = BigInt(id);
        mask[index * tokens + position] = 1n;
      }),
    );
    const dims = [rows.length, tokens];
    const [inputIds, attentionMask, tokenTypeIds] = INTENT_MODEL.inputs;
    const output = (await session.run({
      [inputIds]: new ort.Tensor('int64', ids, dims),
      [attentionMask]: new ort.Tensor('int64', mask, dims),
      [tokenTypeIds]: new ort.Tensor('int64', new BigInt64Array(rows.length * tokens), dims),
    }))[INTENT_MODEL.output];
    if (!output) throw new Error(`the model gave no ${INTENT_MODEL.output}`);
    const [outBatch, outTokens, hidden] = output.dims;
    if (output.dims.length !== 3 || outBatch !== rows.length || outTokens !== tokens || !(output.data instanceof Float32Array) || hidden === undefined) {
      throw new Error(`unexpected ${INTENT_MODEL.output} shape [${output.dims.join(', ')}]`);
    }
    return meanPool(output.data, [rows.length, tokens, hidden], mask).map(l2Normalise);
  }

  return {
    async embed(texts) {
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += BATCH) vectors.push(...(await embedBatch(texts.slice(start, start + BATCH))));
      return vectors;
    },
  };
}
