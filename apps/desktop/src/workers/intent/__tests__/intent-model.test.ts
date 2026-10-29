// Spec: specs/intent-classifier.spec.ts (INTENT_MODEL; How a query is classified) · Acceptance:
// specs/intent-classifier.feature.md (Real model). Skipped unless the pinned files are cached:
// `FROST_INTENT_MODEL_DIR` (default `~/.cache/frost-models/all-MiniLM-L6-v2`) holding
// `model_qint8_arm64.onnx` and `vocab.txt` with their pinned sha256. The model is never committed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { INTENT_LABELS, INTENT_MODEL, type IntentLabel } from '@app/specs/intent-classifier.spec';
import { IntentResultSchema } from '@app/specs/intent-classifier.schema';
import { createEmbedder, createSession, type OrtLike } from '../embed';
import { buildCentroids, classifyVector } from '../prototypes';
import { createTokenizer, parseVocab } from '../tokenizer';

const DIR = process.env['FROST_INTENT_MODEL_DIR'] ?? path.join(homedir(), '.cache/frost-models', INTENT_MODEL.id);

/** The pinned file's bytes, or `null` when it is not cached or does not match its sha256. */
function pinned(file: (typeof INTENT_MODEL.files)[keyof typeof INTENT_MODEL.files]): Uint8Array | null {
  const location = path.join(DIR, file.name);
  if (!existsSync(location)) return null;
  const bytes = readFileSync(location);
  return bytes.byteLength === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256 ? new Uint8Array(bytes) : null;
}

const model = pinned(INTENT_MODEL.files.model);
const vocab = pinned(INTENT_MODEL.files.vocab);
const cached = model !== null && vocab !== null;

/** The plan's clear queries. */
const CLEAR: readonly (readonly [string, IntentLabel])[] = [
  ['how does photosynthesis work', 'informational'],
  ['facebook login', 'navigational'],
  ['best running shoes for flat feet', 'commercial'],
  ['buy iphone 16 pro max 256gb', 'transactional'],
];

/**
 * Evaluation queries frost wrote for this test (none is a prototype). The temperature and the cue
 * weights (two global numbers, spec `INTENT_TEMPERATURE`) were chosen on a set that overlaps these,
 * so the accuracy reported is an evaluation, not a held-out estimate. The test asserts a floor, not
 * perfection: intent is often ambiguous.
 */
const EVALUATION: readonly (readonly [string, IntentLabel])[] = [
  ['what causes inflation', 'informational'],
  ['why do cats purr', 'informational'],
  ['history of the roman empire', 'informational'],
  ['symptoms of vitamin d deficiency', 'informational'],
  ['how to tie a tie', 'informational'],
  ['what is a 401k', 'informational'],
  ['youtube', 'navigational'],
  ['gmail sign in', 'navigational'],
  ['amazon.com', 'navigational'],
  ['netflix account', 'navigational'],
  ['chase bank online banking login', 'navigational'],
  ['wikipedia', 'navigational'],
  ['best budget laptop 2025', 'commercial'],
  ['iphone 16 vs pixel 9', 'commercial'],
  ['top rated robot vacuums', 'commercial'],
  ['dyson v15 review', 'commercial'],
  ['best crm software for small business', 'commercial'],
  ['notion alternatives', 'commercial'],
  ['order pizza online', 'transactional'],
  ['cheap flights to paris', 'transactional'],
  ['nike air max 90 size 10 sale', 'transactional'],
  ['adobe photoshop subscription price', 'transactional'],
  ['plumber near me', 'transactional'],
  ['book hotel in rome', 'transactional'],
  ['how to make sourdough bread', 'informational'],
  ['what year did the berlin wall fall', 'informational'],
  ['is coffee bad for you', 'informational'],
  ['spanish verb conjugation', 'informational'],
  ['pythagorean theorem', 'informational'],
  ['weather in chicago', 'informational'],
  ['bbc news', 'navigational'],
  ['hulu login', 'navigational'],
  ['apple support', 'navigational'],
  ['espn', 'navigational'],
  ['duolingo', 'navigational'],
  ['best protein powder for women', 'commercial'],
  ['tesla model 3 vs model y', 'commercial'],
  ['best dslr camera for beginners', 'commercial'],
  ['quickbooks reviews', 'commercial'],
  ['best wireless earbuds under 100', 'commercial'],
  ['buy macbook air m3', 'transactional'],
  ['uber eats promo code', 'transactional'],
  ['cheap car rental miami', 'transactional'],
  ['order checks online', 'transactional'],
  ['coffee shop near me', 'transactional'],
];

describe.skipIf(!cached)('intent real model', () => {
  test('intent-real-model-classifies', { timeout: 120_000 }, async () => {
    const ort = (await import('onnxruntime-node')) as unknown as OrtLike;
    const tokenizer = createTokenizer(parseVocab(new TextDecoder('utf-8', { fatal: true }).decode(vocab!)));
    // The tokenizer agrees with the model's own vocabulary on a known sentence.
    expect(tokenizer.encode('Hello, world!')).toEqual([101, 7592, 1010, 2088, 999, 102]);
    const { session } = await createSession(ort, model!);
    const embedder = createEmbedder(ort, session, tokenizer);
    const centroids = await buildCentroids((texts) => embedder.embed(texts));
    for (const label of INTENT_LABELS) expect(centroids[label]).toHaveLength(INTENT_MODEL.dimensions);

    const classify = async (query: string) => classifyVector((await embedder.embed([query]))[0]!, centroids, query, INTENT_MODEL.id);
    const lines: string[] = [];
    for (const [query, expected] of CLEAR) {
      const result = await classify(query);
      expect(IntentResultSchema.safeParse(result).success).toBe(true);
      lines.push(`${result.label === expected ? 'ok ' : 'BAD'} ${query} → ${result.label} ${(result.confidence * 100).toFixed(0)}% (expected ${expected})`);
      expect(result.label, query).toBe(expected);
    }
    let right = 0;
    for (const [query, expected] of EVALUATION) {
      const result = await classify(query);
      if (result.label === expected) right += 1;
      lines.push(`${result.label === expected ? 'ok ' : 'BAD'} ${query} → ${result.label} ${(result.confidence * 100).toFixed(0)}% (expected ${expected})`);
    }
    lines.push(`evaluation accuracy: ${right}/${EVALUATION.length}`);
    console.log(lines.join('\n'));
    expect(right / EVALUATION.length).toBeGreaterThanOrEqual(0.75);
  });
});
