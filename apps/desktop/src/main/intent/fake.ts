import { INTENT_LIMITS, type IntentEnableOutcome, type IntentState } from '@app/specs/intent-classifier.spec';
import { fakeIntent } from '../../workers/intent/fake';
import type { IntentClassifier } from './classifier';

// A deterministic `IntentClassifier` for unit tests of later tasks (spec `intent-classifier.spec.ts`,
// `INTENT_FAKE_MODEL`; acceptance `intent-classifier.feature.md`, Fake): no process, no model, the
// same keyword fake the utility process runs under the e2e switch (`workers/intent/fake.ts`), in a
// state the test chooses. `ensureModel()` makes it `ready` (or answers `enableOutcome`).

export interface FakeIntentClassifier extends IntentClassifier {
  /** Puts the fake in `state` (announced to `onChanged` listeners). */
  setState(state: IntentState): void;
}

export function createFakeIntentClassifier(options: { readonly state?: IntentState; readonly enableOutcome?: IntentEnableOutcome } = {}): FakeIntentClassifier {
  let state: IntentState = options.state ?? 'ready';
  const listeners = new Set<(state: IntentState) => void>();
  const setState = (next: IntentState): void => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener(state);
  };
  return {
    state: () => state,
    async ensureModel() {
      const outcome = options.enableOutcome ?? 'ready';
      if (outcome === 'ready') setState('ready');
      return outcome;
    },
    async classify(query) {
      if (state !== 'ready') return { state };
      const text = query.trim().slice(0, INTENT_LIMITS.maxQueryChars);
      if (text === '') return { state: 'no-query' };
      return { state: 'ready', result: fakeIntent(text) };
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setState,
    dispose: () => undefined,
  };
}
