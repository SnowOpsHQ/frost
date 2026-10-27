import type { ContextSource } from './auditor';

// What main collects about a page beside the extractor's snapshot (its `PageContext`, analysed with
// it in the worker; acceptance `seo-indexability.feature.md`, `seo-speed.feature.md`), as named
// inputs. Some are known when a run starts (the recorded response), others arrive later (robots.txt,
// the speed measurement). The audit never waits for them: `contextSource` turns the inputs into the
// auditor's `ContextSource`, whose `now()` has each input that has not settled yet replaced by its
// stand-in (robots.txt `pending`; no speed measurement), and whose `later` is the whole context once
// every input has settled, so a page is analysed at once and then once more with everything known.
// No input is special: adding one is adding a key.

/** One input of the context: known now, or a promise of it with what stands in for it meanwhile. */
export type ContextInput = { readonly known: true; readonly value: unknown } | { readonly known: false; readonly settles: Promise<unknown>; readonly pending: unknown };

/** An input whose value is known now. */
export function knownInput(value: unknown): ContextInput {
  return { known: true, value };
}

/**
 * An input that settles with `settles` (a rejection counts as `null`: nothing collected). Until then
 * the context holds `pending` in its place (`undefined`: the key is left out). `peek` is its value if
 * already known (`undefined`: not yet), e.g. a cached answer.
 */
export function laterInput(settles: Promise<unknown>, pending?: unknown, peek?: unknown): ContextInput {
  return peek === undefined ? { known: false, settles, pending } : knownInput(peek);
}

/**
 * The run's `ContextSource` from its inputs: `now()` has every settled input's value and every other
 * input's stand-in (`final` once all have settled); `later` (`null` when every input was known at the
 * start) resolves the whole context once every input has settled, and never rejects.
 */
export function contextSource(inputs: Readonly<Record<string, ContextInput>>): ContextSource {
  const entries = Object.entries(inputs);
  const settled = new Map<string, unknown>();
  const waiting: Promise<void>[] = [];
  for (const [key, input] of entries) {
    if (input.known) {
      settled.set(key, input.value);
      continue;
    }
    waiting.push(
      Promise.resolve(input.settles).then(
        (value) => void settled.set(key, value),
        () => void settled.set(key, null),
      ),
    );
  }
  const build = (): { readonly context: Record<string, unknown>; readonly final: boolean } => {
    const context: Record<string, unknown> = {};
    let final = true;
    for (const [key, input] of entries) {
      if (settled.has(key)) context[key] = settled.get(key);
      else {
        final = false;
        if (!input.known && input.pending !== undefined) context[key] = input.pending;
      }
    }
    return { context, final };
  };
  return {
    now: build,
    later: waiting.length === 0 ? null : Promise.all(waiting).then(() => build().context),
  };
}
