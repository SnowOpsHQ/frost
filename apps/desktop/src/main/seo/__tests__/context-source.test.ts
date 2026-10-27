// Spec: specs/seo-indexability.feature.md (the record travels with the snapshot; the audit never waits),
// specs/seo-speed.feature.md (Two measurements: audit-does-not-wait-for-the-measurement)
import { describe, expect, test } from 'vitest';
import { contextSource, knownInput, laterInput } from '../context-source';

/** A promise the test settles. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('context source', () => {
  test('known-inputs-are-final-at-once', () => {
    const source = contextSource({ response: knownInput('r'), robots: knownInput(null) });
    expect(source.now()).toEqual({ context: { response: 'r', robots: null }, final: true });
    expect(source.later).toBeNull();
    // A peeked (cached) value is known too.
    expect(contextSource({ robots: laterInput(new Promise(() => undefined), 'pending', 'cached') }).later).toBeNull();
  });

  test('pending-inputs-stand-in-until-all-settle', async () => {
    const robots = deferred<unknown>();
    const speed = deferred<unknown>();
    const source = contextSource({ response: knownInput('r'), robots: laterInput(robots.promise, 'robots-pending'), performance: laterInput(speed.promise) });
    // A stand-in for robots.txt; no measurement at all (the key is left out).
    expect(source.now()).toEqual({ context: { response: 'r', robots: 'robots-pending' }, final: false });
    let later: unknown = 'unsettled';
    void source.later!.then((context) => (later = context));
    robots.resolve('robots');
    await tick();
    // One input settled: `now` has it, but `later` waits for every input.
    expect(source.now()).toEqual({ context: { response: 'r', robots: 'robots' }, final: false });
    expect(later).toBe('unsettled');
    speed.resolve('measured');
    await tick();
    expect(later).toEqual({ response: 'r', robots: 'robots', performance: 'measured' });
    expect(source.now()).toEqual({ context: later, final: true });
  });

  test('a-rejected-input-is-nothing-collected', async () => {
    const speed = deferred<unknown>();
    const source = contextSource({ robots: knownInput(null), performance: laterInput(speed.promise) });
    speed.reject(new Error('boom'));
    await expect(source.later).resolves.toEqual({ robots: null, performance: null });
    expect(source.now().final).toBe(true);
  });
});
