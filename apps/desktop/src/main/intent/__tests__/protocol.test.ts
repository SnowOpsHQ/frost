// Spec: specs/intent-classifier.schema.ts (IntentResultSchema, IntentRequestSchema,
// IntentResponseSchema) · Acceptance: specs/intent-classifier.feature.md (Protocol); review focus
// intent-host-protocol-is-closed
import { describe, expect, test } from 'vitest';
import { INTENT_FAKE_MODEL, INTENT_LIMITS, INTENT_MODEL } from '@app/specs/intent-classifier.spec';
import { IntentRequestSchema, IntentResponseSchema, IntentResultSchema } from '@app/specs/intent-classifier.schema';

const RESULT = { label: 'navigational', confidence: 0.55, scores: { informational: 0.15, navigational: 0.55, commercial: 0.15, transactional: 0.15 }, model: INTENT_MODEL.id };

describe('intent protocol', () => {
  test('intent-protocol-schemas (results)', () => {
    expect(IntentResultSchema.safeParse(RESULT).success).toBe(true);
    expect(IntentResultSchema.safeParse({ ...RESULT, model: INTENT_FAKE_MODEL }).success).toBe(true);
    const refused: unknown[] = [
      { ...RESULT, model: 'other-model' },
      { ...RESULT, label: 'local' },
      { ...RESULT, confidence: 1.2 },
      { ...RESULT, confidence: 0.15 }, // not the label's score
      { ...RESULT, label: 'commercial', confidence: 0.15 }, // not the most probable
      { ...RESULT, scores: { ...RESULT.scores, informational: 0.5 } }, // sums to 1.35
      { ...RESULT, scores: { ...RESULT.scores, local: 0 } },
      { ...RESULT, scores: { informational: 0.45, navigational: 0.55 } },
      { ...RESULT, extra: true },
      { ...RESULT, confidence: Number.NaN },
    ];
    for (const value of refused) expect(IntentResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  test('intent-protocol-schemas (requests)', () => {
    const valid: unknown[] = [
      { type: 'load', id: 1, model: new Uint8Array(3), vocab: '[CLS]' },
      { type: 'load', id: 1, model: new Uint8Array(INTENT_MODEL.files.model.bytes), vocab: 'x'.repeat(INTENT_MODEL.files.vocab.bytes) },
      { type: 'load-fake', id: 1 },
      { type: 'classify', id: 2, query: 'x'.repeat(INTENT_LIMITS.maxQueryChars) },
      { type: 'ping', id: 3 },
      { type: 'selftest', id: 4 },
    ];
    for (const value of valid) expect(IntentRequestSchema.safeParse(value).success).toBe(true);
    const refused: unknown[] = [
      { type: 'load', id: 1, model: [1, 2, 3], vocab: '[CLS]' },
      { type: 'load', id: 1, model: new Uint8Array(INTENT_MODEL.files.model.bytes + 1), vocab: '[CLS]' },
      { type: 'load', id: 1, model: new Uint8Array(3), vocab: 'x'.repeat(INTENT_MODEL.files.vocab.bytes + 1) },
      { type: 'load', id: 1, model: new Uint8Array(3), vocab: '[CLS]', path: '/etc/passwd' },
      { type: 'classify', id: 2, query: 'x'.repeat(INTENT_LIMITS.maxQueryChars + 1) },
      { type: 'classify', id: -1, query: 'x' },
      { type: 'classify', query: 'x' },
      { type: 'fetch', id: 1, url: 'https://example.com' },
      { type: 'ping', id: 1, extra: 1 },
    ];
    for (const value of refused) expect(IntentRequestSchema.safeParse(value).success).toBe(false);
  });

  test('intent-protocol-schemas (responses)', () => {
    const valid: unknown[] = [
      { type: 'loaded', id: 1, model: INTENT_MODEL.id, provider: 'coreml' },
      { type: 'loaded', id: 1, model: INTENT_FAKE_MODEL, provider: 'fake' },
      { type: 'result', id: 2, result: RESULT },
      { type: 'error', id: 2, reason: 'classify-failed' },
      { type: 'error', reason: 'crashed' },
      { type: 'pong', id: 3 },
      { type: 'selftest', id: 4, backends: ['cpu', 'webgpu'], provider: 'cpu' },
    ];
    for (const value of valid) expect(IntentResponseSchema.safeParse(value).success).toBe(true);
    const refused: unknown[] = [
      { type: 'loaded', id: 1, model: 'other', provider: 'cpu' },
      { type: 'loaded', id: 1, model: INTENT_MODEL.id, provider: 'CPU <script>' },
      { type: 'result', id: 2, result: { ...RESULT, confidence: 3 } },
      { type: 'error', id: 2, reason: 'something else' },
      { type: 'selftest', id: 4, backends: [], provider: 'cpu' },
      { type: 'selftest', id: 4, backends: Array.from({ length: 17 }, () => 'cpu'), provider: 'cpu' },
      { type: 'log', id: 5, line: 'x' },
    ];
    for (const value of refused) expect(IntentResponseSchema.safeParse(value).success).toBe(false);
  });
});
