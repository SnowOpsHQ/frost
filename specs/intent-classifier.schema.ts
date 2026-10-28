/**
 * The Zod side of the on-device intent classifier (Phase 3 Task 2; plain values in
 * `intent-classifier.spec.ts`; acceptance `intent-classifier.feature.md`; review focus
 * `intent-host-protocol-is-closed`): a classification (`IntentResultSchema`) and the closed message
 * protocol between main (`apps/desktop/src/main/intent/host.ts`) and the utility process
 * (`apps/desktop/src/workers/intent/worker.ts`). The process validates every request with
 * `IntentRequestSchema` and main every response with `IntentResponseSchema`; anything that does not
 * parse is dropped. Every object is strict and every string, list and byte array is capped. Not for
 * the chrome renderer (no Zod there).
 */
import { z } from 'zod';
import { INTENT_FAKE_MODEL, INTENT_LABELS, INTENT_LIMITS, INTENT_MODEL, type IntentLabel } from './intent-classifier.spec';

/** How far a result's probabilities may sum from 1 (float rounding). */
export const INTENT_SCORE_TOLERANCE = 1e-3;

const probability = z.number().min(0).max(1);

/** A request id: main numbers its requests 1, 2, 3 … per process. */
const RequestIdSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * A classification: the most probable label, its probability, every label's probability (summing to
 * 1) and the model that gave it (the pinned model's id, or `fake`).
 */
export const IntentResultSchema = z
  .strictObject({
    label: z.enum(INTENT_LABELS),
    confidence: probability,
    scores: z.strictObject(Object.fromEntries(INTENT_LABELS.map((label) => [label, probability])) as Record<IntentLabel, typeof probability>),
    model: z.union([z.literal(INTENT_MODEL.id), z.literal(INTENT_FAKE_MODEL)]),
  })
  .refine((result) => Math.abs(INTENT_LABELS.reduce((sum, label) => sum + result.scores[label], 0) - 1) <= INTENT_SCORE_TOLERANCE, {
    message: 'scores do not sum to 1',
    path: ['scores'],
  })
  .refine((result) => INTENT_LABELS.every((label) => result.scores[label] <= result.scores[result.label]), { message: 'label is not the most probable', path: ['label'] })
  .refine((result) => Math.abs(result.confidence - result.scores[result.label]) <= INTENT_SCORE_TOLERANCE, { message: 'confidence is not the label’s score', path: ['confidence'] });
export type IntentResultParsed = z.infer<typeof IntentResultSchema>;

/**
 * Main → utility process.
 * - `load`: the pinned model's bytes and its vocabulary's text, already read and sha256-checked by
 *   main (the process never opens a file); the process loads ONNX Runtime, the model and embeds its
 *   prototypes, then answers `loaded` (or `error`). Capped at the pinned sizes.
 * - `load-fake`: run the deterministic fake instead (the e2e seam; ONNX Runtime is never loaded).
 * - `classify`: one query (trimmed and cut by main), answered `result` (or `error`).
 * - `ping`: answered `pong` (liveness).
 * - `selftest`: load ONNX Runtime, run a tiny built-in model on it, answer `selftest` with the
 *   runtime's backends (the packaged self-test; no model needed).
 */
export const IntentRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('load'),
    id: RequestIdSchema,
    model: z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= INTENT_MODEL.files.model.bytes, { message: 'not the model’s bytes' }),
    vocab: z.string().min(1).max(INTENT_MODEL.files.vocab.bytes),
  }),
  z.strictObject({ type: z.literal('load-fake'), id: RequestIdSchema }),
  z.strictObject({ type: z.literal('classify'), id: RequestIdSchema, query: z.string().min(1).max(INTENT_LIMITS.maxQueryChars) }),
  z.strictObject({ type: z.literal('ping'), id: RequestIdSchema }),
  z.strictObject({ type: z.literal('selftest'), id: RequestIdSchema }),
]);
export type IntentRequest = z.infer<typeof IntentRequestSchema>;

/**
 * Why the process could not answer a request:
 * - `load-failed`: ONNX Runtime or the model could not be loaded (or the prototypes embedded);
 * - `bad-vocab`: the vocabulary lacks the special tokens the tokenizer needs;
 * - `not-loaded`: a `classify` before a successful `load`;
 * - `classify-failed`: the model failed on the query;
 * - `selftest-failed`: the runtime did not load or run the built-in model;
 * - `crashed`: an uncaught error in the process (no request id; it exits next).
 */
export const INTENT_ERROR_REASONS = ['load-failed', 'bad-vocab', 'not-loaded', 'classify-failed', 'selftest-failed', 'crashed'] as const;
export type IntentErrorReason = (typeof INTENT_ERROR_REASONS)[number];

/** An ONNX Runtime backend or execution provider name (`cpu`, `coreml`, `webgpu` …). */
const BackendNameSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/);

/**
 * Utility process → main.
 * - `loaded`: the model (or the fake) is loaded; `provider` is the execution provider the session
 *   runs on (`coreml`, `cpu`), or `fake`;
 * - `result`: a classification for request `id`;
 * - `error`: request `id` (if any) failed, for `reason`;
 * - `pong`: request `id`'s answer;
 * - `selftest`: ONNX Runtime loaded and ran the built-in model; `backends` are its backends and
 *   `provider` the execution provider that ran it.
 */
export const IntentResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('loaded'), id: RequestIdSchema, model: z.union([z.literal(INTENT_MODEL.id), z.literal(INTENT_FAKE_MODEL)]), provider: BackendNameSchema }),
  z.strictObject({ type: z.literal('result'), id: RequestIdSchema, result: IntentResultSchema }),
  z.strictObject({ type: z.literal('error'), id: RequestIdSchema.optional(), reason: z.enum(INTENT_ERROR_REASONS) }),
  z.strictObject({ type: z.literal('pong'), id: RequestIdSchema }),
  z.strictObject({ type: z.literal('selftest'), id: RequestIdSchema, backends: z.array(BackendNameSchema).min(1).max(16), provider: BackendNameSchema }),
]);
export type IntentResponse = z.infer<typeof IntentResponseSchema>;
