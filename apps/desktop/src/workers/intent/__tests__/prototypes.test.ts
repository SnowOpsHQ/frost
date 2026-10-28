// Spec: specs/intent-classifier.spec.ts (How a query is classified: Compare, Nudge, Confidence;
// INTENT_CUES, INTENT_BARE_DOMAIN_WEIGHT, INTENT_TEMPERATURE) · specs/intent-classifier.schema.ts
// (IntentResultSchema) · Acceptance: specs/intent-classifier.feature.md (Classifier)
import { describe, expect, test } from 'vitest';
import { INTENT_BARE_DOMAIN_WEIGHT, INTENT_CUES, INTENT_LABELS, INTENT_LIMITS, INTENT_MODEL, INTENT_TEMPERATURE, type IntentLabel } from '@app/specs/intent-classifier.spec';
import { IntentResultSchema } from '@app/specs/intent-classifier.schema';
import { buildCentroids, centroid, classifyVector, cosine, cueNudges, INTENT_PROTOTYPES, isBareDomain, softmax } from '../prototypes';

const basis = (index: number, dims = 4): Float32Array => {
  const vector = new Float32Array(dims);
  vector[index] = 1;
  return vector;
};
const CENTROIDS = Object.fromEntries(INTENT_LABELS.map((label, index) => [label, basis(index)])) as Record<IntentLabel, Float32Array>;

describe('intent prototypes', () => {
  test('intent-prototypes-are-frost-own', () => {
    const all: string[] = [];
    for (const label of INTENT_LABELS) {
      const queries = INTENT_PROTOTYPES[label];
      expect(queries.length, label).toBeGreaterThanOrEqual(20);
      expect(queries.length, label).toBeLessThanOrEqual(40);
      for (const query of queries) {
        expect(query, label).toBe(query.trim().toLowerCase());
        expect(query.length).toBeGreaterThan(0);
        expect(query.length).toBeLessThanOrEqual(INTENT_LIMITS.maxQueryChars);
      }
      all.push(...queries);
    }
    // No query stands for two labels (or twice for one).
    expect(new Set(all).size).toBe(all.length);
  });

  test('intent-centroids-and-cosine', async () => {
    // A centroid is the normalised mean of its prototypes' vectors.
    const mean = centroid([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    expect(mean[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mean[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 1]))).toBeCloseTo(Math.SQRT1_2, 6);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
    // buildCentroids embeds every label's prototypes once.
    const seen: string[] = [];
    const centroids = await buildCentroids(async (texts) => {
      seen.push(...texts);
      return texts.map((text) => basis(INTENT_LABELS.findIndex((label) => INTENT_PROTOTYPES[label].includes(text))));
    });
    expect(seen.sort()).toEqual(INTENT_LABELS.flatMap((label) => INTENT_PROTOTYPES[label]).sort());
    INTENT_LABELS.forEach((label, index) => expect([...centroids[label]]).toEqual([...basis(index)]));
  });

  test('intent-softmax-temperature', () => {
    const probabilities = softmax([0.5, 0.4, 0.4, 0.4], INTENT_TEMPERATURE);
    expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
    const odds = Math.exp(0.1 / INTENT_TEMPERATURE);
    expect(probabilities[0]! / probabilities[1]!).toBeCloseTo(odds, 6);
    // Large inputs stay finite.
    expect(softmax([1_000, 0], 0.001).every(Number.isFinite)).toBe(true);
    expect(softmax([1, 1], 1)).toEqual([0.5, 0.5]);
  });

  test('intent-cue-nudges', () => {
    const none = { informational: 0, navigational: 0, commercial: 0, transactional: 0 };
    expect(cueNudges('quantum entanglement')).toEqual(none);
    expect(cueNudges('Buy iPhone 16')).toEqual({ ...none, transactional: INTENT_CUES.transactional.weight });
    // A label is nudged once, however many of its terms match.
    expect(cueNudges('best laptops vs top tablets review')).toEqual({ ...none, commercial: INTENT_CUES.commercial.weight });
    // Phrases match as whole words, in order; parts of words never match.
    expect(cueNudges('pizza near me')).toEqual({ ...none, transactional: INTENT_CUES.transactional.weight });
    expect(cueNudges('me near pizza')).toEqual(none);
    expect(cueNudges('shopping history of rome').transactional).toBe(0);
    expect(cueNudges('how to sign in')).toEqual({ ...none, informational: INTENT_CUES.informational.weight, navigational: INTENT_CUES.navigational.weight });
    // Punctuation and accents do not hide a cue.
    expect(cueNudges('iPhone vs. Pixel').commercial).toBe(INTENT_CUES.commercial.weight);
    // A bare domain is navigational.
    for (const domain of ['example.com', 'www.example.org', 'https://news.example.co.uk/', 'EXAMPLE.COM']) {
      expect(isBareDomain(domain), domain).toBe(true);
      expect(cueNudges(domain).navigational, domain).toBe(INTENT_BARE_DOMAIN_WEIGHT);
    }
    for (const query of ['example', 'node.js tutorial', '1.5 litres', 'example.com login page']) expect(isBareDomain(query), query).toBe(false);
  });

  test('intent-classifies-fixed-vectors', () => {
    // Closest to the commercial centroid.
    const query = Float32Array.from([0.1, 0.1, 0.9, 0.1]);
    const result = classifyVector(query, CENTROIDS, 'quantum entanglement', INTENT_MODEL.id);
    expect(IntentResultSchema.safeParse(result).success).toBe(true);
    expect(result.label).toBe('commercial');
    expect(result.model).toBe(INTENT_MODEL.id);
    expect(result.confidence).toBe(result.scores.commercial);
    const expected = softmax(INTENT_LABELS.map((label) => cosine(query, CENTROIDS[label])), INTENT_TEMPERATURE);
    INTENT_LABELS.forEach((label, index) => expect(result.scores[label]).toBeCloseTo(expected[index]!, 9));

    // A cue nudges a near tie over, but does not overturn a clear answer.
    const tie = Float32Array.from([0.5, 0, 0, 0.49]);
    expect(classifyVector(tie, CENTROIDS, 'water', INTENT_MODEL.id).label).toBe('informational');
    expect(classifyVector(tie, CENTROIDS, 'buy water', INTENT_MODEL.id).label).toBe('transactional');
    const clear = Float32Array.from([0.9, 0, 0, 0.3]);
    expect(classifyVector(clear, CENTROIDS, 'buy water', INTENT_MODEL.id).label).toBe('informational');
  });
});
