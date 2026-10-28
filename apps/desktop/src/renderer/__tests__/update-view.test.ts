// Spec: specs/update-client.spec.ts (Chrome: UPDATE_BAR_KINDS, UPDATE_ERROR_MESSAGES, UPDATE_PALETTE_LABELS)
// Acceptance: specs/update-client.feature.md (Chrome)
import { describe, expect, test, vi } from 'vitest';
import {
  UPDATE_BAR_KINDS,
  UPDATE_ERROR_MESSAGES,
  UPDATE_ERROR_REASONS,
  UPDATE_PALETTE_LABELS,
  UPDATE_PALETTE_MESSAGES,
  UPDATE_REQUIRED_TEXT,
  UPDATE_STATUS_KINDS,
  type UpdateChecks,
  type UpdateState,
  type UpdateStatus,
} from '@app/specs/update-client.spec';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';
import { updatePaletteSources } from '../update-palette';
import { checkOutcome, downloadPercent, formatBytes, updateBarView } from '../update-view';

const state = (status: UpdateStatus, checks: UpdateChecks = 'on', version = 5): UpdateState => ({ version, currentVersion: '1.2.0', checks, lastCheckedAt: null, status });
const AVAILABLE: UpdateStatus = { kind: 'available', version: '1.3.0', notes: 'frost 1.3.0\n\n- <b>Fixes</b>.', releasedAt: '2026-10-28T00:00:00Z', required: false, size: 84_213_000 };

describe('update bar view', () => {
  test('update-bar-hidden-at-rest', () => {
    expect(updateBarView(null)).toEqual({ kind: 'hidden' });
    for (const kind of ['disabled', 'off', 'idle', 'checking', 'up-to-date'] as const) expect([kind, updateBarView(state({ kind })).kind]).toEqual([kind, 'hidden']);
    // Exactly the spec's kinds get a row.
    const shown = UPDATE_STATUS_KINDS.filter((kind) => {
      const status: UpdateStatus =
        kind === 'available' ? AVAILABLE : kind === 'downloading' ? { kind, version: '1.3.0', bytes: 1, total: 2 } : kind === 'ready' ? { kind, version: '1.3.0', install: 'manual', fileName: 'f' } : kind === 'error' ? { kind, reason: 'internal' } : { kind };
      return updateBarView(state(status)).kind !== 'hidden';
    });
    expect(shown).toEqual([...UPDATE_BAR_KINDS]);
  });

  test('update-bar-available', () => {
    const view = updateBarView(state(AVAILABLE));
    expect(view).toEqual({
      kind: 'available',
      key: 'available:1.3.0',
      version: '1.3.0',
      text: 'frost 1.3.0 is available',
      requiredText: null,
      canSkip: true,
      // The notes as they were signed: plain text (the bar puts them in a text node).
      notes: 'frost 1.3.0\n\n- <b>Fixes</b>.',
      sizeText: '84.2 MB',
    });
    // Required: it says so, and there is no Skip.
    const required = updateBarView(state({ ...AVAILABLE, required: true }));
    expect(required).toMatchObject({ kind: 'available', requiredText: UPDATE_REQUIRED_TEXT, canSkip: false });
    // Later hides this version's offer only (the key is per version).
    expect(updateBarView(state({ ...AVAILABLE, version: '1.3.1' }))).toMatchObject({ key: 'available:1.3.1' });
  });

  test('update-bar-downloading', () => {
    expect(updateBarView(state({ kind: 'downloading', version: '1.3.0', bytes: 21_000, total: 84_000 }))).toEqual({
      kind: 'downloading',
      key: 'downloading:1.3.0',
      text: 'Downloading frost 1.3.0…',
      bytes: 21_000,
      total: 84_000,
      percent: 25,
    });
    expect(downloadPercent(0, 0)).toBe(0);
    expect(downloadPercent(5, 0)).toBe(0);
    expect(downloadPercent(999, 1000)).toBe(99);
    expect(downloadPercent(1000, 1000)).toBe(100);
    expect(downloadPercent(2000, 1000)).toBe(100);
    expect(downloadPercent(Number.NaN, 1000)).toBe(0);
  });

  test('update-bar-ready', () => {
    expect(updateBarView(state({ kind: 'ready', version: '1.3.0', install: 'manual', fileName: 'frost-1.3.0-x64-setup.exe' }))).toEqual({
      kind: 'ready',
      key: 'ready:1.3.0',
      text: "frost 1.3.0 is downloaded and verified. This build can't update itself: install it by hand.",
      canShowFile: true,
    });
    // `restart` (unreachable today): no button that could not act.
    expect(updateBarView(state({ kind: 'ready', version: '1.3.0', install: 'restart', fileName: 'x' }))).toEqual({ kind: 'ready', key: 'ready:1.3.0', text: 'frost 1.3.0 is downloaded and verified.', canShowFile: false });
  });

  test('update-bar-error', () => {
    for (const reason of UPDATE_ERROR_REASONS) {
      const view = updateBarView(state({ kind: 'error', reason }));
      expect(view).toEqual({ kind: 'error', key: `error:${reason}:`, reason, text: UPDATE_ERROR_MESSAGES[reason] });
      // frost's own short line: one sentence, no placeholder left.
      expect(UPDATE_ERROR_MESSAGES[reason]).toMatch(/^[A-Z][^{}<>]{8,100}\.$/);
    }
    expect(updateBarView(state({ kind: 'error', reason: 'hash-mismatch', version: '1.3.0' }))).toMatchObject({ key: 'error:hash-mismatch:1.3.0', text: UPDATE_ERROR_MESSAGES['hash-mismatch'] });
  });

  test('format-bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 KB');
    expect(formatBytes(84_213_000)).toBe('84.2 MB');
    expect(formatBytes(1_073_741_824)).toBe('1.1 GB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('update palette', () => {
  const ctx = { state: null, tab: undefined, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } } as PaletteContext;
  const setup = (known: UpdateState | undefined, answer: UpdateState | null = state({ kind: 'up-to-date' })) => {
    const api = { check: vi.fn(async () => answer), setChecks: vi.fn(async (checks: UpdateChecks) => (answer === null ? null : { ...answer, checks })), known: () => known };
    const registry = createPaletteRegistry();
    registry.register(...updatePaletteSources(api));
    return { api, offered: () => registry.resolve(ctx), labels: () => registry.resolve(ctx).map((action) => action.label) };
  };

  test('update-palette', async () => {
    // No feed, or no state yet: nothing update-related is offered.
    expect(setup(undefined).labels()).toEqual([]);
    expect(setup(state({ kind: 'disabled' })).labels()).toEqual([]);
    expect(setup(state({ kind: 'disabled' }, 'off')).labels()).toEqual([]);
    // With a feed: Check, and the toggle for the current setting.
    expect(setup(state({ kind: 'idle' })).labels()).toEqual([UPDATE_PALETTE_LABELS.check, UPDATE_PALETTE_LABELS.checksOff]);
    expect(setup(state({ kind: 'off' }, 'off')).labels()).toEqual([UPDATE_PALETTE_LABELS.check, UPDATE_PALETTE_LABELS.checksOn]);
    // Check answers what it found.
    const run = async (answer: UpdateState | null) => {
      const { offered } = setup(state({ kind: 'idle' }), answer);
      return offered()[0]!.run(ctx);
    };
    expect(await run(state({ kind: 'up-to-date' }))).toBe(UPDATE_PALETTE_MESSAGES.upToDate);
    expect(await run(state(AVAILABLE))).toBe('frost 1.3.0 is available');
    expect(await run(state({ kind: 'error', reason: 'bad-envelope' }))).toBe(UPDATE_ERROR_MESSAGES['bad-envelope']);
    expect(await run(state({ kind: 'ready', version: '1.3.0', install: 'manual', fileName: 'f' }))).toBe(UPDATE_PALETTE_MESSAGES.busy);
    expect(await run(null)).toBe(UPDATE_PALETTE_MESSAGES.failed);
    // The toggle saves the other setting.
    const on = setup(state({ kind: 'idle' }));
    expect(await on.offered()[1]!.run(ctx)).toBe(UPDATE_PALETTE_MESSAGES.checksOff);
    expect(on.api.setChecks).toHaveBeenCalledWith('off');
    const off = setup(state({ kind: 'off' }, 'off'));
    expect(await off.offered()[1]!.run(ctx)).toBe(UPDATE_PALETTE_MESSAGES.checksOn);
    expect(off.api.setChecks).toHaveBeenCalledWith('on');
    const failing = setup(state({ kind: 'idle' }), null);
    expect(await failing.offered()[1]!.run(ctx)).toBe(UPDATE_PALETTE_MESSAGES.settingFailed);
    expect(checkOutcome(state({ kind: 'checking' }))).toBe(UPDATE_PALETTE_MESSAGES.checking);
  });
});
