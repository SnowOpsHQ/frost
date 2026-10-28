// Spec: specs/intent-classifier.spec.ts (INTENT_FAKE_MODEL, INTENT_CUES, INTENT_E2E_FAKE_SWITCH) ·
// specs/intent-classifier.schema.ts (IntentResultSchema) · Acceptance:
// specs/intent-classifier.feature.md (Fake)
import { describe, expect, test } from 'vitest';
import { INTENT_FAKE_MODEL } from '@app/specs/intent-classifier.spec';
import { IntentResultSchema } from '@app/specs/intent-classifier.schema';
import { fakeIntent } from '../fake';

describe('intent fake', () => {
  test('intent-fake-is-deterministic', () => {
    const queries = ['buy running shoes', 'best running shoes', 'facebook login', 'how do tides work', 'example.com', 'running shoes', ''];
    for (const query of queries) {
      const first = fakeIntent(query);
      expect(fakeIntent(query), query).toEqual(first);
      expect(IntentResultSchema.safeParse(first).success, query).toBe(true);
      expect(first.model).toBe(INTENT_FAKE_MODEL);
    }
    expect(fakeIntent('buy running shoes').label).toBe('transactional');
    expect(fakeIntent('best running shoes').label).toBe('commercial');
    expect(fakeIntent('facebook login').label).toBe('navigational');
    expect(fakeIntent('example.com').label).toBe('navigational');
    expect(fakeIntent('how do tides work').label).toBe('informational');
    // No cue at all: informational, with a low confidence.
    const plain = fakeIntent('running shoes');
    expect(plain.label).toBe('informational');
    expect(plain.confidence).toBeLessThan(0.5);
  });
});
