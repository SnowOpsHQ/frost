import { INTENT_LIMITS, type IntentAnswer, type IntentEnableOutcome, type IntentState } from '@app/specs/intent-classifier.spec';
import type { IntentHost } from './host';
import type { ModelStore } from './model-store';

// On-device intent, as the rest of main sees it (spec `intent-classifier.spec.ts`, `INTENT_STATES`,
// `IntentAnswer`, `INTENT_ENABLE_OUTCOMES`; acceptance `intent-classifier.feature.md`, Classifier
// states). The state starts at `model-missing` and becomes `ready` once a quick check finds the
// model's files; `ensureModel()` (the user's "Enable on-device intent", the only thing that
// downloads) goes through `downloading`; `classify()` answers with a result only when `ready`, and
// otherwise with the state. The runtime failing makes the state `unavailable` until the next
// success; a model that no longer verifies when the process loads it is `model-missing` again.

export interface IntentClassifier {
  /** Where on-device intent stands now. */
  state(): IntentState;
  /** The user's "Enable on-device intent": downloads, checks and stores the model if needed. Concurrent calls share one run. Never rejects. */
  ensureModel(): Promise<IntentEnableOutcome>;
  /** Classifies a query (trimmed, cut to `INTENT_LIMITS.maxQueryChars`), or says why not. Never downloads; never rejects. */
  classify(query: string): Promise<IntentAnswer>;
  /** Called with the new state whenever it changes; returns the unsubscribe. */
  onChanged(listener: (state: IntentState) => void): () => void;
  /** Stops the utility process (the app is quitting). */
  dispose(): void;
}

export interface IntentClassifierOptions {
  readonly store: Pick<ModelStore, 'present' | 'download'>;
  readonly host: Pick<IntentHost, 'classify' | 'dispose'>;
  readonly log?: (message: string) => void;
}

export function createIntentClassifier(options: IntentClassifierOptions): IntentClassifier {
  const { store, host } = options;
  const log = options.log ?? (() => {});
  const listeners = new Set<(state: IntentState) => void>();
  let state: IntentState = 'model-missing';

  const setState = (next: IntentState): void => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        log(`intent: a state listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  // The quick check at start (file sizes only; the process's load hashes them).
  const checked = store
    .present()
    .catch(() => false)
    .then((present) => {
      if (present && state === 'model-missing') setState('ready');
    });

  let enabling: Promise<IntentEnableOutcome> | null = null;
  async function enable(): Promise<IntentEnableOutcome> {
    await checked;
    const outcome = await store.download().catch((): IntentEnableOutcome => 'storage');
    setState(outcome === 'ready' ? 'ready' : 'model-missing');
    return outcome;
  }

  return {
    state: () => state,
    ensureModel() {
      if (enabling) return enabling;
      if (state !== 'ready') setState('downloading');
      enabling = enable().finally(() => {
        enabling = null;
      });
      return enabling;
    },
    async classify(query) {
      await checked;
      if (state !== 'ready' && state !== 'unavailable') return { state };
      const text = query.trim().slice(0, INTENT_LIMITS.maxQueryChars);
      if (text === '') return { state: 'no-query' };
      const answer = await host.classify(text).catch((): { ok: false; reason: 'unavailable' } => ({ ok: false, reason: 'unavailable' }));
      if (answer.ok) {
        setState('ready');
        return { state: 'ready', result: answer.result };
      }
      setState(answer.reason);
      return { state: answer.reason };
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispose: () => host.dispose(),
  };
}
