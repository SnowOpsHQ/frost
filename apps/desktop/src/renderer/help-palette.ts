import { HELP_LINK_NOTES, HELP_PALETTE_ACTIONS, SHORTCUTS_SHORTCUT, type HelpOpenResult, type HelpSheet } from '@app/specs/help.spec';
import type { PaletteAction, PaletteSource } from './palette/registry';

// Help in the command palette, and the chrome's Help sheet requests (Phase 11 Task 11; acceptance
// `help.feature.md`; `command-palette.spec.ts`, Registration API): "Keyboard shortcuts", "What's
// new in frost" and "Export diagnostics…" (Task 12, `diagnostics.feature.md`) open their sheet, "frost Help" and "Report an issue" ask main to open the page (main
// opens only on the live click or key that ran the action). Pure: the IPC call is injected; registered
// from `components/ShortcutsView.tsx`. The request bus is how the palette and the setup checklist open
// a sheet (main's menu requests arrive over `help.watch`).

type Listener = (sheet: HelpSheet) => void;
const listeners = new Set<Listener>();

/** Asks the mounted Help sheets to show `sheet` (the other one closes); answers whether one listened. */
export function requestHelpSheet(sheet: HelpSheet): boolean {
  for (const listener of [...listeners]) listener(sheet);
  return listeners.size > 0;
}

/** Subscribes to requests; answers the unsubscribe. */
export function onHelpSheetRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface HelpPaletteApi {
  openSheet(sheet: HelpSheet): unknown;
  /** `help.openLink` (`unavailable` on an IPC failure). */
  openLink(link: 'help' | 'issue'): Promise<HelpOpenResult>;
}

const ACTION = Object.fromEntries(HELP_PALETTE_ACTIONS.map((action) => [action.id, action])) as Record<(typeof HELP_PALETTE_ACTIONS)[number]['id'], (typeof HELP_PALETTE_ACTIONS)[number]>;

export function helpPaletteSources(api: HelpPaletteApi): PaletteSource[] {
  const sheet = (id: 'help.shortcuts' | 'help.whats-new' | 'help.diagnostics', which: HelpSheet, extra: Partial<PaletteAction> = {}): PaletteAction => ({
    id,
    label: ACTION[id].label,
    group: 'browser',
    keywords: [...ACTION[id].keywords],
    // The sheet moves focus itself.
    focus: 'handler',
    ...extra,
    run: () => {
      api.openSheet(which);
    },
  });
  const link = (id: 'help.open-help' | 'help.report-issue', which: 'help' | 'issue'): PaletteAction => ({
    id,
    label: ACTION[id].label,
    group: 'browser',
    keywords: [...ACTION[id].keywords],
    icon: 'external',
    run: async () => {
      const result = await api.openLink(which);
      return result === 'opened' ? null : HELP_LINK_NOTES[result];
    },
  });
  return [
    sheet('help.shortcuts', 'shortcuts', { shortcut: SHORTCUTS_SHORTCUT }),
    sheet('help.whats-new', 'whats-new'),
    link('help.open-help', 'help'),
    link('help.report-issue', 'issue'),
    sheet('help.diagnostics', 'diagnostics'),
  ];
}
