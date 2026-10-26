// Spec: specs/page-commands.spec.ts (ZOOM_FACTORS) · Acceptance: specs/page-commands.feature.md (Renderer)
import { describe, expect, test } from 'vitest';
import { DEFAULT_ZOOM, ZOOM_FACTORS } from '@app/specs/page-commands.spec';
import { zoomLabel } from '../zoom-label';

describe('zoom label', () => {
  test('status-bar-shows-zoom', () => {
    expect(zoomLabel(DEFAULT_ZOOM)).toBeNull();
    expect(zoomLabel(1.1)).toBe('110%');
    expect(zoomLabel(0.33)).toBe('33%');
    expect(zoomLabel(0.67)).toBe('67%');
    expect(zoomLabel(5)).toBe('500%');
    expect(zoomLabel(0.25)).toBe('25%');
    // Chromium reports a float close to the factor set: never a stray "100%".
    expect(zoomLabel(1.0000000001)).toBeNull();
    for (const factor of ZOOM_FACTORS) expect(zoomLabel(factor) === null, String(factor)).toBe(factor === DEFAULT_ZOOM);
  });
});
