// Spec: specs/command-palette.spec.ts (PALETTE_SHEET_HEIGHT, PALETTE_PAGE_MIN_VISIBLE, PALETTE_SHEET_MIN_HEIGHT)
// Acceptance: specs/command-palette.feature.md (sheet-sizes-match-styles)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { PALETTE_PAGE_MIN_VISIBLE, PALETTE_SHEET_HEIGHT, PALETTE_SHEET_MIN_HEIGHT } from '@app/specs/command-palette.spec';

const CSS = readFileSync(fileURLToPath(new URL('../renderer/styles.css', import.meta.url)), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`));
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const open = CSS.indexOf('{', at);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

test('sheet-sizes-match-styles', () => {
  expect(CSS).toContain(`--palette-sheet-height: ${PALETTE_SHEET_HEIGHT}px;`);
  expect(CSS).toContain(`--palette-page-min-visible: ${PALETTE_PAGE_MIN_VISIBLE}px;`);
  expect(CSS).toContain(`--palette-sheet-min-height: ${PALETTE_SHEET_MIN_HEIGHT}px;`);
  // The sheet's height is built from exactly those three.
  expect(rule('.palette-sheet')).toMatch(/height:\s*max\(\s*min\(\s*var\(--palette-sheet-height\),\s*calc\(100% - var\(--palette-page-min-visible\)\)\s*\),\s*var\(--palette-sheet-min-height\)\s*\);/);
  expect(PALETTE_SHEET_MIN_HEIGHT).toBeLessThan(PALETTE_SHEET_HEIGHT);
});
