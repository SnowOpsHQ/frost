import { DEFAULT_ZOOM } from '@app/specs/page-commands.spec';

// The status bar's zoom indicator (spec `page-commands.feature.md`, Renderer). Pure.

/** The active tab's zoom as the status bar shows it (`'110%'`), or `null` at 100 %. */
export function zoomLabel(factor: number): string | null {
  const percent = Math.round(factor * 100);
  return percent === Math.round(DEFAULT_ZOOM * 100) ? null : `${percent}%`;
}
