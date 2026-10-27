// Spec: specs/page-commands.spec.ts (ZOOM_FACTORS, DEFAULT_ZOOM) · Acceptance: specs/page-commands.feature.md (Zoom)
import { describe, expect, test } from 'vitest';
import { DEFAULT_ZOOM, ZOOM_FACTORS } from '@app/specs/page-commands.spec';
import { stepZoom } from '../zoom';

describe('zoom', () => {
  test('zoom-steps-through-factors', () => {
    expect(ZOOM_FACTORS[0]).toBe(0.25);
    expect(ZOOM_FACTORS.at(-1)).toBe(5);
    expect(DEFAULT_ZOOM).toBe(1);
    // Neighbouring entries, both ways.
    ZOOM_FACTORS.forEach((factor, i) => {
      expect(stepZoom(factor, 'in'), `${factor} in`).toBe(ZOOM_FACTORS[Math.min(i + 1, ZOOM_FACTORS.length - 1)]);
      expect(stepZoom(factor, 'out'), `${factor} out`).toBe(ZOOM_FACTORS[Math.max(i - 1, 0)]);
      expect(stepZoom(factor, 'reset')).toBe(DEFAULT_ZOOM);
    });
    // Between entries (e.g. Chromium's float), to the next one in that direction.
    expect(stepZoom(1.05, 'in')).toBe(1.1);
    expect(stepZoom(1.05, 'out')).toBe(1);
    expect(stepZoom(1.0000001, 'in')).toBe(1.1);
    expect(stepZoom(0.9999999, 'out')).toBe(0.9);
    // Clamped at both ends, also from outside the range.
    expect(stepZoom(5, 'in')).toBe(5);
    expect(stepZoom(0.25, 'out')).toBe(0.25);
    expect(stepZoom(9, 'in')).toBe(5);
    expect(stepZoom(9, 'out')).toBe(5);
    expect(stepZoom(0.1, 'out')).toBe(0.25);
    expect(stepZoom(0.1, 'in')).toBe(0.25);
    expect(stepZoom(Number.NaN, 'in')).toBe(DEFAULT_ZOOM);
  });
});
