// Spec: specs/command-palette.spec.ts (registration API, PALETTE_ACTION_ID_PATTERN, PALETTE_ACTION_ID_MAX, PALETTE_GROUPS)
// Acceptance: specs/command-palette.feature.md (Registry, matcher and recents)
import { describe, expect, test, vi } from 'vitest';
import { PALETTE_ACTION_ID_MAX } from '@app/specs/command-palette.spec';
import { createPaletteRegistry, type PaletteAction, type PaletteContext } from '../registry';

function ctx(changes: Partial<PaletteContext> = {}): PaletteContext {
  return {
    state: null,
    tab: undefined,
    audit: null,
    sidebarOpen: true,
    chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() },
    ...changes,
  };
}

function action(id: string, changes: Partial<PaletteAction> = {}): PaletteAction {
  return { id, label: `Label ${id}`, group: 'page', run: () => undefined, ...changes };
}

describe('palette registry', () => {
  test('registry-registers-and-unregisters', () => {
    const registry = createPaletteRegistry();
    const off = registry.register(action('a.one'), action('a.two'));
    registry.register(action('b.three'));
    expect(registry.resolve(ctx()).map((a) => a.id)).toEqual(['a.one', 'a.two', 'b.three']);
    off();
    expect(registry.resolve(ctx()).map((a) => a.id)).toEqual(['b.three']);
    // Unregistering twice is harmless; the id can be registered again.
    off();
    registry.register(action('a.one'));
    expect(registry.resolve(ctx()).map((a) => a.id)).toEqual(['b.three', 'a.one']);
  });

  test('registry-rejects-bad-or-duplicate-ids', () => {
    const registry = createPaletteRegistry();
    registry.register(action('ok.id'));
    for (const id of ['', 'Upper.case', 'has space', '.lead', 'trail.', 'a..b', 'a_b', 'x'.repeat(PALETTE_ACTION_ID_MAX + 1)]) {
      expect(() => registry.register(action(id)), JSON.stringify(id)).toThrow();
    }
    expect(() => registry.register(action('ok.id'))).toThrow(/ok\.id/);
    // Two of the same id in one call: neither is registered.
    expect(() => registry.register(action('dup'), action('dup'))).toThrow();
    expect(() => registry.register(action('bad.group', { group: 'nope' as PaletteAction['group'] }))).toThrow();
    expect(() => registry.register(action('no.label', { label: '  ' }))).toThrow();
    expect(registry.resolve(ctx()).map((a) => a.id)).toEqual(['ok.id']);
    expect(PALETTE_ACTION_ID_MAX).toBeGreaterThan(8);

    // A dynamic source's bad ids, and ids another action already has, are dropped (never thrown).
    registry.register(() => [action('dyn.ok'), action('Bad Id'), action('ok.id'), action('dyn.ok'), action('dyn.label', { label: '' })]);
    expect(registry.resolve(ctx()).map((a) => a.id)).toEqual(['ok.id', 'dyn.ok']);
  });

  test('registry-resolves-dynamic-sources', () => {
    const registry = createPaletteRegistry();
    const source = vi.fn((c: PaletteContext) => (c.sidebarOpen ? [action('dyn.open')] : [action('dyn.closed'), action('dyn.other')]));
    registry.register(action('static.first'), source, action('static.last'));
    expect(registry.resolve(ctx()).map((a) => a.id)).toEqual(['static.first', 'dyn.open', 'static.last']);
    const closed = ctx({ sidebarOpen: false });
    expect(registry.resolve(closed).map((a) => a.id)).toEqual(['static.first', 'dyn.closed', 'dyn.other', 'static.last']);
    expect(source).toHaveBeenLastCalledWith(closed);
  });

  test('availability-filters-and-never-throws', () => {
    const registry = createPaletteRegistry();
    registry.register(
      action('shown'),
      action('hidden', { available: () => false }),
      action('throws', {
        available: () => {
          throw new Error('boom');
        },
      }),
      () => {
        throw new Error('source boom');
      },
      action('by.state', { available: (c) => c.sidebarOpen }),
    );
    expect(registry.resolve(ctx()).map((a) => a.id)).toEqual(['shown', 'by.state']);
    expect(registry.resolve(ctx({ sidebarOpen: false })).map((a) => a.id)).toEqual(['shown']);
    // `all` lists every registered static action, available or not (for the id checks).
    expect(registry.ids()).toEqual(['shown', 'hidden', 'throws', 'by.state']);
  });
});

describe('palette registry change signal', () => {
  test('registry-signals-changes-in-availability-inputs', () => {
    const registry = createPaletteRegistry();
    const heard = vi.fn();
    const off = registry.subscribe(heard);
    const before = registry.version();
    registry.invalidate();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(registry.version()).not.toBe(before);
    off();
    registry.invalidate();
    expect(heard).toHaveBeenCalledTimes(1);
    // A watched input is started with the first listener and stopped with the last.
    const stop = vi.fn();
    const start = vi.fn((_invalidate: () => void) => stop);
    const unwatch = registry.watch(start);
    expect(start).not.toHaveBeenCalled();
    const offA = registry.subscribe(() => undefined);
    const offB = registry.subscribe(() => undefined);
    expect(start).toHaveBeenCalledTimes(1);
    offA();
    expect(stop).not.toHaveBeenCalled();
    offB();
    expect(stop).toHaveBeenCalledTimes(1);
    // Watching while a listener is subscribed starts at once; unwatching stops it.
    const offC = registry.subscribe(() => undefined);
    expect(start).toHaveBeenCalledTimes(2);
    unwatch();
    expect(stop).toHaveBeenCalledTimes(2);
    offC();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  test('availability-filters-and-never-throws: a watcher that throws, or is registered twice, never breaks the registry', () => {
    const registry = createPaletteRegistry();
    // A start that throws registers nothing to stop; the other watchers still start.
    const badStart = vi.fn((): (() => void) => {
      throw new Error('start failed');
    });
    const badStop = vi.fn(() => {
      throw new Error('stop failed');
    });
    const goodStop = vi.fn();
    const goodStart = vi.fn((_invalidate: () => void) => goodStop);
    registry.watch(badStart);
    registry.watch(() => badStop);
    registry.watch(goodStart);
    let off = () => undefined as void;
    expect(() => (off = registry.subscribe(() => undefined))).not.toThrow();
    expect(goodStart).toHaveBeenCalledTimes(1);
    // A stop that throws leaves the later watchers stopped.
    expect(() => off()).not.toThrow();
    expect(badStop).toHaveBeenCalledTimes(1);
    expect(goodStop).toHaveBeenCalledTimes(1);
    // Starting again after a failed start is still contained.
    expect(() => registry.subscribe(() => undefined)()).not.toThrow();
    // Registering the same start twice is refused and leaves the first registration intact.
    const stop = vi.fn();
    const start = vi.fn((_invalidate: () => void) => stop);
    const unwatch = registry.watch(start);
    const offLive = registry.subscribe(() => undefined);
    expect(() => registry.watch(start)).toThrow();
    expect(start).toHaveBeenCalledTimes(1);
    unwatch();
    expect(stop).toHaveBeenCalledTimes(1);
    offLive();
    // Each watcher gets its own invalidate, so one subscribing it to a shared store never stands for another.
    const given: Array<() => void> = [];
    registry.watch((invalidate) => (given.push(invalidate), () => undefined));
    registry.watch((invalidate) => (given.push(invalidate), () => undefined));
    registry.subscribe(() => undefined);
    expect(given).toHaveLength(2);
    expect(given[0]).not.toBe(given[1]);
    const before = registry.version();
    given[0]!();
    expect(registry.version()).not.toBe(before);
  });
});
