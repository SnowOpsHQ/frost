// Spec: specs/command-palette.spec.ts (PALETTE_SHEET_MIN_HEIGHT, fullscreen)
// Acceptance: specs/command-palette.feature.md (palette-fits-and-closes-for-fullscreen; the CSS sizes:
// src/__tests__/palette-styles.test.ts, sheet-sizes-match-styles)
import { describe, expect, test } from 'vitest';
import { PALETTE_SHEET_MIN_HEIGHT } from '@app/specs/command-palette.spec';
import { closesForFullscreen, paletteFits } from '../layout';

describe('palette layout', () => {
  test('palette-fits-and-closes-for-fullscreen', () => {
    // Never open invisible: a column shorter than the minimum sheet does not open it.
    expect(paletteFits(PALETTE_SHEET_MIN_HEIGHT)).toBe(true);
    expect(paletteFits(PALETTE_SHEET_MIN_HEIGHT - 1)).toBe(false);
    expect(paletteFits(0)).toBe(false);
    expect(paletteFits(Number.NaN)).toBe(false);
    expect(paletteFits(900)).toBe(true);
    // A tab entering HTML fullscreen (either phase) closes it.
    expect(closesForFullscreen(undefined)).toBe(false);
    expect(closesForFullscreen({ fullscreen: null })).toBe(false);
    expect(closesForFullscreen({ fullscreen: 'notice' })).toBe(true);
    expect(closesForFullscreen({ fullscreen: 'full' })).toBe(true);
  });
});
