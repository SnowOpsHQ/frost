import { INTENT_FAKE_MODEL, INTENT_LABELS, type IntentLabel, type IntentResult } from '@app/specs/intent-classifier.spec';
import { scoreIntent } from './prototypes';

// The deterministic fake classifier (spec `intent-classifier.spec.ts`, `INTENT_FAKE_MODEL`,
// `INTENT_E2E_FAKE_SWITCH`; acceptance `intent-classifier.feature.md`, Fake). Pure and keyword
// based: no model, only the spec's cues (`INTENT_CUES`, the bare-domain cue) scored like the real
// classifier, over a slight lean towards `informational` so a query with no cue still has an answer
// (with a low confidence). Used by the utility process under the e2e switch and by main's
// `FakeIntentClassifier` for unit tests of later tasks; the same query always gets the same result.

/** The fake's raw scores before the cues: `informational` a little ahead. */
const LEAN: Readonly<Record<IntentLabel, number>> = Object.fromEntries(INTENT_LABELS.map((label) => [label, label === 'informational' ? 0.005 : 0])) as Record<IntentLabel, number>;

export function fakeIntent(query: string): IntentResult {
  return scoreIntent(LEAN, query, INTENT_FAKE_MODEL);
}
