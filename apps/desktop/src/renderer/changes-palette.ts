import type { CaptureAnswer } from '@app/specs/changes.spec';
import { canCapture, captureOutcomeText } from './changes-view';
import type { PaletteSource } from './palette/registry';

// The Changes panel in the command palette (spec `changes-panel.feature.md`, Command palette;
// `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): "Open Changes panel" (the
// panel's jump, owned here) and "Capture this page" (main's `changes.capture`, into Unfiled).
// Registered from `components/changes/Changes.tsx`; pure (the procedure is injected) so
// availability is unit tested.

export interface ChangesPaletteApi {
  /** `changes.capture` of the tab, into the panel's chosen project (one seam: `components/changes/capture-project.ts`); resolves its answer, `null` on an IPC failure. */
  capture(tabId: number): Promise<CaptureAnswer | null>;
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
  ];
}
