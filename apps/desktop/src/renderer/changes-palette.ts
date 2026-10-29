import type { ScreenshotKind } from '@app/specs/capture-db.spec';
import type { CaptureAnswer } from '@app/specs/changes.spec';
import type { TakeScreenshotAnswer } from '@app/specs/screenshot.spec';
import { canCapture, canScreenshot, captureOutcomeText, screenshotOutcomeText } from './changes-view';
import type { PaletteSource } from './palette/registry';

// The Changes panel in the command palette (spec `changes-panel.feature.md`, Command palette;
// `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): "Open Changes panel" (the
// panel's jump, owned here) and "Capture this page" (main's `changes.capture`, into Unfiled); and the
// screenshots (`screenshot.feature.md`): "Screenshot viewport", "Screenshot full page" and
// "Screenshot an area" (main's `screenshots.take`).
// Registered from `components/changes/Changes.tsx`; pure (the procedure is injected) so
// availability is unit tested.

export interface ChangesPaletteApi {
  /** `changes.capture` of the tab, into the panel's chosen project (one seam: `components/changes/capture-project.ts`); resolves its answer, `null` on an IPC failure. */
  capture(tabId: number): Promise<CaptureAnswer | null>;
  /** `screenshots.take` of the tab, into the same project, as the tab's run (the panel shows it); resolves its answer, `null` on an IPC failure. */
  screenshot(tabId: number, kind: ScreenshotKind): Promise<TakeScreenshotAnswer | null>;
}

// Who wants to know that a page was captured from the palette (the panel, to read its history again).
const capturedListeners = new Set<(answer: CaptureAnswer | null) => void>();

/** Calls `listener` with each palette capture's answer; answers a function that stops. */
export function onPageCaptured(listener: (answer: CaptureAnswer | null) => void): () => void {
  capturedListeners.add(listener);
  return () => {
    capturedListeners.delete(listener);
  };
}

const KEYWORDS = ['changes', 'capture', 'history', 'versions', 'diff', 'snapshot', 'seo'];
const SHOT_KEYWORDS = ['screenshot', 'capture', 'image', 'picture', 'png', 'evidence'];

const SCREENSHOT_ACTIONS: readonly { readonly kind: ScreenshotKind; readonly label: string; readonly keywords: readonly string[] }[] = [
  { kind: 'viewport', label: 'Screenshot viewport', keywords: ['visible', 'screen', 'window'] },
  { kind: 'full', label: 'Screenshot full page', keywords: ['whole', 'entire', 'scroll', 'long', 'stitched'] },
  { kind: 'area', label: 'Screenshot an area', keywords: ['select', 'region', 'part', 'crop', 'drag'] },
];

/** The palette's Changes actions, calling `api`. */
export function changesPaletteSources(api: ChangesPaletteApi): PaletteSource[] {
  return [
    {
      id: 'panel.changes',
      label: 'Open Changes panel',
      group: 'panels',
      keywords: [...KEYWORDS, 'go to', 'show', 'compare', 'sidebar'],
      icon: 'panel-changes',
      focus: 'handler',
      run: (ctx) => ctx.chrome.openPanel('changes', { focus: true }),
    },
    {
      id: 'changes.capture',
      label: 'Capture this page',
      group: 'page',
      keywords: [...KEYWORDS, 'save', 'record', 'track', 'now'],
      icon: 'panel-changes',
      // As Capture now: a loaded web page with a settled ready audit (main still decides).
      available: (ctx) => canCapture(ctx.tab, ctx.audit),
      run: async (ctx) => {
        const answer = await api.capture(ctx.tab!.id);
        for (const listener of [...capturedListeners]) listener(answer);
        return captureOutcomeText(answer);
      },
    },
    ...SCREENSHOT_ACTIONS.map(
      ({ kind, label, keywords }): PaletteSource => ({
        id: `changes.screenshot-${kind}`,
        label,
        group: 'page',
        keywords: [...SHOT_KEYWORDS, ...keywords],
        icon: 'panel-changes',
        // A web page in the tab (main still decides: only the active tab).
        available: (ctx) => canScreenshot(ctx.tab),
        // Through the tab's run (`components/changes/screenshot-runs.ts`), so an open panel shows it.
        run: async (ctx) => screenshotOutcomeText(await api.screenshot(ctx.tab!.id, kind)),
      }),
    ),
  ];
}
