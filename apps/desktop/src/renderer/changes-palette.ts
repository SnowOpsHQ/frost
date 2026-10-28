import type { TabState } from '@app/specs/browser.spec';
import type { CaptureAnswer } from '@app/specs/changes.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { captureOutcomeText } from './changes-view';
import { readyAudit, type PaletteSource } from './palette/registry';

// The Changes panel in the command palette (spec `changes-panel.feature.md`, Command palette;
// `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): "Open Changes panel" (the
// panel's jump, owned here) and "Capture this page" (main's `changes.capture`, into Unfiled).
// Registered from `components/changes/Changes.tsx`; pure (the procedure is injected) so
// availability is unit tested.

export interface ChangesPaletteApi {
  /** `changes.capture` of the tab; resolves its answer, `null` on an IPC failure. */
  capture(tabId: number): Promise<CaptureAnswer | null>;
}

// Who wants to know that a page was captured from the palette (the panel, to read its history again).
const capturedListeners = new Set<() => void>();

/** Calls `listener` after each palette capture; answers a function that stops. */
export function onPageCaptured(listener: () => void): () => void {
  capturedListeners.add(listener);
  return () => {
    capturedListeners.delete(listener);
  };
}

const KEYWORDS = ['changes', 'capture', 'history', 'versions', 'diff', 'snapshot', 'seo'];

/** The tab shows an `http(s)` page without an error or crash panel. */
const onWebPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && isWebUrl(tab.url) && tab.error === null && !tab.crashed;

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
      // Main captures only the active tab's ready audit.
      available: (ctx) => onWebPage(ctx.tab) && readyAudit(ctx) !== null,
      run: async (ctx) => {
        const answer = await api.capture(ctx.tab!.id);
        for (const listener of [...capturedListeners]) listener();
        return captureOutcomeText(answer);
      },
    },
  ];
}
