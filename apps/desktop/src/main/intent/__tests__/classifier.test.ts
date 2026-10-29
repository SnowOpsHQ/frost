// Spec: specs/intent-classifier.spec.ts (INTENT_STATES, IntentAnswer, INTENT_ENABLE_OUTCOMES,
// INTENT_LIMITS.maxQueryChars) · Acceptance: specs/intent-classifier.feature.md (Classifier states,
// Fake)
import { describe, expect, test, vi } from 'vitest';
import { INTENT_FAKE_MODEL, INTENT_LIMITS, INTENT_MODEL, INTENT_STATES, type IntentEnableOutcome, type IntentResult, type IntentState } from '@app/specs/intent-classifier.spec';
import { IntentResultSchema } from '@app/specs/intent-classifier.schema';
import { createIntentClassifier } from '../classifier';
import { createFakeIntentClassifier } from '../fake';
import type { HostAnswer } from '../host';

const RESULT: IntentResult = { label: 'informational', confidence: 0.6, scores: { informational: 0.6, navigational: 0.2, commercial: 0.1, transactional: 0.1 }, model: INTENT_MODEL.id };

function harness(options: { present?: boolean; download?: () => Promise<IntentEnableOutcome>; answer?: (query: string) => Promise<HostAnswer> } = {}) {
  let present = options.present ?? false;
  const download = vi.fn(
    options.download ??
      (async (): Promise<IntentEnableOutcome> => {
        present = true;
        return 'ready';
      }),
  );
  const classify = vi.fn(options.answer ?? (async (): Promise<HostAnswer> => ({ ok: true, result: RESULT })));
  const dispose = vi.fn();
  const classifier = createIntentClassifier({ store: { present: async () => present, download }, host: { classify, dispose } });
  const states: IntentState[] = [];
  classifier.onChanged((state) => states.push(state));
  return { classifier, download, classify, dispose, states };
}

describe('intent classifier', () => {
  test('intent-classifier-states (enable, then classify)', async () => {
    const { classifier, download, classify, states } = harness();
    expect(classifier.state()).toBe('model-missing');
    // Classifying never downloads.
    expect(await classifier.classify('how do tides work')).toEqual({ state: 'model-missing' });
    expect(download).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    // Enabling downloads, through `downloading`, to `ready`.
    const enabling = classifier.ensureModel();
    expect(classifier.state()).toBe('downloading');
    expect(await classifier.classify('x')).toEqual({ state: 'downloading' });
    expect(await enabling).toBe('ready');
    expect(classifier.state()).toBe('ready');
    expect(states).toEqual(['downloading', 'ready']);
    expect(await classifier.classify('how do tides work')).toEqual({ state: 'ready', result: RESULT });
    expect(INTENT_STATES).toEqual(['model-missing', 'downloading', 'ready', 'unavailable']);
  });

  test('intent-classifier-states (present at start, blank and long queries)', async () => {
    const { classifier, classify, download } = harness({ present: true });
    expect(await classifier.classify('  ')).toEqual({ state: 'no-query' });
    expect(classifier.state()).toBe('ready');
    expect(classify).not.toHaveBeenCalled();
    await classifier.classify(`  ${'q'.repeat(INTENT_LIMITS.maxQueryChars + 50)}  `);
    expect(classify).toHaveBeenCalledWith('q'.repeat(INTENT_LIMITS.maxQueryChars));
    // Already there: enabling downloads nothing new (the store re-checks the files).
    expect(await classifier.ensureModel()).toBe('ready');
    expect(download).toHaveBeenCalledTimes(1);
  });

  test('intent-classifier-states (failures)', async () => {
    // A failed download leaves the model missing, with the reason.
    const failed = harness({ download: async () => 'integrity' });
    expect(await failed.classifier.ensureModel()).toBe('integrity');
    expect(failed.classifier.state()).toBe('model-missing');
    expect(failed.states).toEqual(['downloading', 'model-missing']);

    // Concurrent enables share one download.
    const shared = harness();
    await Promise.all([shared.classifier.ensureModel(), shared.classifier.ensureModel()]);
    expect(shared.download).toHaveBeenCalledTimes(1);

    // The runtime failing makes it unavailable until the next success.
    let next: HostAnswer = { ok: false, reason: 'unavailable' };
    const flaky = harness({ present: true, answer: async () => next });
    expect(await flaky.classifier.classify('x')).toEqual({ state: 'unavailable' });
    expect(flaky.classifier.state()).toBe('unavailable');
    next = { ok: true, result: RESULT };
    expect(await flaky.classifier.classify('x')).toEqual({ state: 'ready', result: RESULT });
    expect(flaky.classifier.state()).toBe('ready');
    expect(flaky.states).toEqual(['ready', 'unavailable', 'ready']);

    // A model that no longer verifies on load is missing again.
    next = { ok: false, reason: 'model-missing' };
    expect(await flaky.classifier.classify('x')).toEqual({ state: 'model-missing' });
    expect(flaky.classifier.state()).toBe('model-missing');

    // A throwing store is a failed check, never a rejection.
    const broken = createIntentClassifier({
      store: {
        present: async () => {
          throw new Error('EIO');
        },
        download: async () => {
          throw new Error('EIO');
        },
      },
      host: { classify: async () => ({ ok: true, result: RESULT }), dispose: () => {} },
    });
    expect(await broken.classify('x')).toEqual({ state: 'model-missing' });
    expect(await broken.ensureModel()).toBe('storage');
  });

  test('intent-fake-is-deterministic (the fake classifier)', async () => {
    const fake = createFakeIntentClassifier();
    expect(fake.state()).toBe('ready');
    const first = await fake.classify('buy running shoes');
    expect(first).toEqual(await fake.classify('buy running shoes'));
    if (first.state !== 'ready') throw new Error('not ready');
    expect(IntentResultSchema.safeParse(first.result).success).toBe(true);
    expect(first.result).toMatchObject({ label: 'transactional', model: INTENT_FAKE_MODEL });
    expect(await fake.classify('')).toEqual({ state: 'no-query' });
    // Later tasks can put it in any state.
    const missing = createFakeIntentClassifier({ state: 'model-missing' });
    const seen: IntentState[] = [];
    missing.onChanged((state) => seen.push(state));
    expect(await missing.classify('x')).toEqual({ state: 'model-missing' });
    expect(await missing.ensureModel()).toBe('ready');
    expect(missing.state()).toBe('ready');
    expect(seen).toEqual(['ready']);
    missing.setState('unavailable');
    expect(await missing.classify('x')).toEqual({ state: 'unavailable' });
  });
});
