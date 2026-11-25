// Spec: specs/seo-speed.feature.md (byte-sizes-read-the-same-everywhere)
// One byte count reads the same in every panel: decimal SI units, one decimal from kB up.
import { describe, expect, test } from 'vitest';
import { formatBytes as seoCore } from '@app/seo-core';
import { runSizeText } from '../crawl-view';
import { formatBytes as devtools } from '../devtools-view';
import { formatBytes as indexability } from '../indexability-view';
import { formatBytes as update } from '../update-view';
import { formatBytes as visibility } from '../visibility-view';

const SIZES: readonly [number, string][] = [
  [0, '0 B'],
  [900, '900 B'],
  [1_536, '1.5 kB'],
  [12_800, '12.8 kB'],
  [123_456, '123.5 kB'],
  [512_000, '512.0 kB'],
  [5 * 1024 * 1024, '5.2 MB'],
  [84_213_000, '84.2 MB'],
  [1_250_000_000, '1.3 GB'],
];

describe('byte sizes (byte-sizes-read-the-same-everywhere)', () => {
  test.each(SIZES)('%i bytes reads %s in every panel', (bytes, text) => {
    expect(seoCore(bytes)).toBe(text);
    expect(devtools(bytes)).toBe(text);
    expect(indexability(bytes)).toBe(text);
    expect(update(bytes)).toBe(text);
    expect(visibility(bytes)).toBe(text);
    expect(runSizeText({ pages: 1, queued: 0, refused: 0, failed: 0, bytes })).toBe(`${text} fetched`);
  });

  test('a panel keeps its own words for a size that is not a number', () => {
    expect(devtools(null)).toBe('—');
    expect(update(Number.NaN)).toBe('0 B');
  });
});
