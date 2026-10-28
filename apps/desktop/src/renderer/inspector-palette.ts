import type { InspectorPickAnswer } from '@app/specs/inspector.spec';
import { canInspect, pickOutcomeText } from './inspector-view';
import type { PaletteSource } from './palette/registry';

// The Inspector in the command palette (spec `inspector.feature.md`, Command palette;
// `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): "Open Inspector" (the panel's
// jump, owned here) and "Pick an element" (opens the panel and starts a pick on the tab's page).
// Registered from `components/changes/Inspector.tsx`; pure (the pick is injected) so availability is
// unit tested.

export interface InspectorPaletteApi {
  /** Starts a pick on the tab through the panel's pick runs (the panel shows it); resolves its answer, `null` on an IPC failure. */
  pick(tabId: number): Promise<InspectorPickAnswer | null>;
}

const KEYWORDS = ['inspector', 'inspect', 'dom', 'element', 'elements', 'tree', 'html', 'node', 'seo'];

/** The palette's Inspector actions, calling `api`. */
export function inspectorPaletteSources(api: InspectorPaletteApi): PaletteSource[] {
  return [
    {
      id: 'panel.inspector',
      label: 'Open Inspector',
      group: 'panels',
      keywords: [...KEYWORDS, 'go to', 'show', 'sidebar', 'panel'],
      icon: 'panel-inspector',
      focus: 'handler',
      run: (ctx) => ctx.chrome.openPanel('inspector', { focus: true }),
    },
    {
      id: 'inspector.pick',
      label: 'Pick an element',
      group: 'page',
      keywords: [...KEYWORDS, 'pick', 'select', 'click', 'choose', 'mouse'],
      icon: 'panel-inspector',
      // A web page in the tab (main still decides: only the active tab).
      available: (ctx) => canInspect(ctx.tab),
      run: async (ctx) => {
        ctx.chrome.openPanel('inspector');
        return pickOutcomeText(await api.pick(ctx.tab!.id));
      },
    },
  ];
}
