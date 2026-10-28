import { SEARCH_INTENTS, unavailable, type IntentClassification, type IntentPort, type PortAnswer } from '@app/ai-skills';

// The `IntentPort` over Phase 3's on-device intent classifier (Phase 5 Task 8 and its review;
// acceptance `specs/agent-search-tools.feature.md`, Wiring). Written against
// `SerpReadApi.classifyIntent(query)` (and `SerpService.classify(query)`, the same shape) answering
// `IntentAnswer` (`specs/intent-classifier.spec.ts`) on `phase-3/serp-intent` at 45e8cf7: `ready`
// with `{ label, confidence, scores }` (the labels are `SEARCH_INTENTS`), or the classifier's state.
// It never downloads the model (only the user enables it), so a missing model is explained, not
// fixed. The type below is a minimal structural copy; Phase 3's `SerpReadApi` is assignable to it.

/** What classifying answers (`IntentAnswer`), as far as the adapter reads it. */
export type IntentAnswerLike =
  | { readonly state: 'ready'; readonly result: { readonly label: string; readonly confidence: number; readonly scores: { readonly [label: string]: number } } }
  | { readonly state: 'model-missing' | 'downloading' | 'unavailable' | 'no-query' };

/** Phase 3's `SerpReadApi`, the member this adapter calls. */
export interface IntentReadApiLike {
  classifyIntent(query: string): Promise<IntentAnswerLike>;
}

/** Why there is no classification, per classifier state (frost's own words). */
export const INTENT_ADAPTER_REASONS = {
  'model-missing': 'On-device search intent is off. The user can turn it on in frost (it downloads a small model once).',
  downloading: 'The on-device search intent model is still downloading. Try again shortly.',
  unavailable: "On-device search intent isn't available on this computer.",
  'no-query': 'There was no query to classify.',
  failed: 'The search intent could not be read.',
  unknownLabel: 'The search intent answer was not understood.',
} as const;

const isIntent = (label: string): label is (typeof SEARCH_INTENTS)[number] => (SEARCH_INTENTS as readonly string[]).includes(label);

/** `readApi` as an `IntentPort`, or `null` without one. */
export function intentAdapter(readApi: IntentReadApiLike | null | undefined): IntentPort | null {
  if (!readApi) return null;
  return {
    async classify(query, options): Promise<PortAnswer<IntentClassification>> {
      let answer: IntentAnswerLike;
      try {
        answer = await readApi.classifyIntent(query.query);
      } catch {
        return unavailable(INTENT_ADAPTER_REASONS.failed);
      }
      options?.signal?.throwIfAborted();
      if (answer.state !== 'ready') return unavailable(INTENT_ADAPTER_REASONS[answer.state] ?? INTENT_ADAPTER_REASONS.failed);
      const { label, scores } = answer.result;
      if (!isIntent(label)) return unavailable(INTENT_ADAPTER_REASONS.unknownLabel);
      const intents = SEARCH_INTENTS.map((intent) => ({ intent, confidence: typeof scores[intent] === 'number' ? scores[intent]! : 0 })).sort((a, b) => b.confidence - a.confidence);
      return { status: 'ok', data: { query: query.query, primary: label, intents } };
    },
  };
}
