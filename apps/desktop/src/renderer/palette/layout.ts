import { PALETTE_SHEET_MIN_HEIGHT } from '@app/specs/command-palette.spec';
import type { TabState } from '@app/specs/browser.spec';

// When the palette may show (spec `command-palette.spec.ts`): never cut off in a short page column,
// never behind a page in HTML fullscreen. Pure.

/** Whether a page column `height` CSS px tall can hold the palette's sheet. */
export function paletteFits(height: number): boolean {
  return Number.isFinite(height) && height >= PALETTE_SHEET_MIN_HEIGHT;
}

/** Whether the open palette must close: the active tab entered HTML fullscreen (its view now covers the chrome). */
export function closesForFullscreen(tab: Pick<TabState, 'fullscreen'> | undefined): boolean {
  return tab !== undefined && tab.fullscreen !== null;
}
