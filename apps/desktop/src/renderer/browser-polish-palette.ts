import { DEFAULT_SEARCH_ENGINE, FIND_SHORTCUT, HISTORY_SHORTCUT, REOPEN_TAB_SHORTCUT, SEARCH_ENGINE_SET_MESSAGE, SEARCH_ENGINES, type SearchEngineId } from '@app/specs/browser-polish.spec';
import type { PaletteAction, PaletteSource } from './palette/registry';

// Browser polish in the command palette (spec `browser-polish.feature.md`, Palette;
// `command-palette.spec.ts`, Registration API): find in page, reopen closed tab, the History view and
// the search engine setting (the palette is that setting's surface). Registered from
// `components/HistoryView.tsx`; pure (the procedures are injected) so availability is unit tested.

/** The procedures the actions call (a subset of `actions` in `ipc.ts`). */
export interface BrowserPolishPaletteApi {
  openFind(): Promise<unknown>;
  reopenClosedTab(): Promise<number | null>;
  showHistory(): Promise<unknown>;
  setSearchEngine(engine: SearchEngineId): Promise<boolean>;
}

/** What the status line says when nothing was reopened, or the engine was not stored. */
export const REOPEN_NOTHING = 'No closed tab to reopen' as const;
export const SEARCH_ENGINE_NOT_SET = 'The search engine was not changed' as const;

export function browserPolishPaletteSources(api: BrowserPolishPaletteApi): PaletteSource[] {
  const engines = SEARCH_ENGINES.map(
    (engine): PaletteAction => ({
      id: `settings.search-engine.${engine.id}`,
      label: `Search with ${engine.label}`,
      group: 'browser',
      keywords: ['search engine', 'settings', 'default search', 'address bar', `${engine.prefix} prefix`],
      icon: 'external',
      detail: () => `Address bar searches; “${engine.prefix} ” searches ${engine.label} any time`,
      // Every engine but the one in use.
      available: (ctx) => (ctx.state?.searchEngine ?? DEFAULT_SEARCH_ENGINE) !== engine.id,
      run: async () => ((await api.setSearchEngine(engine.id)) ? SEARCH_ENGINE_SET_MESSAGE.replace('{engine}', engine.label) : SEARCH_ENGINE_NOT_SET),
    }),
  );
  return [
    {
      id: 'page.find',
      label: 'Find in page',
      group: 'page',
      keywords: ['search', 'text', 'match', 'find'],
      icon: 'highlight',
      shortcut: FIND_SHORTCUT,
      focus: 'handler',
      // A tab showing a page (not empty, no error or crash panel).
      available: (ctx) => ctx.tab !== undefined && ctx.tab.url !== '' && ctx.tab.error === null && !ctx.tab.crashed,
      run: async () => {
        await api.openFind();
      },
    },
    {
      id: 'tab.reopen-closed',
      label: 'Reopen closed tab',
      group: 'tabs',
      keywords: ['undo close', 'restore', 'closed', 'recent'],
      icon: 'tab-new',
      shortcut: REOPEN_TAB_SHORTCUT,
      focus: 'handler',
      available: (ctx) => (ctx.state?.closedTabCount ?? 0) > 0,
      run: async () => ((await api.reopenClosedTab()) === null ? REOPEN_NOTHING : null),
    },
    {
      id: 'browser.history',
      label: 'Show history',
      group: 'browser',
      keywords: ['history', 'visits', 'recent', 'pages'],
      icon: 'back',
      shortcut: HISTORY_SHORTCUT,
      focus: 'handler',
      run: async () => {
        await api.showHistory();
      },
    },
    ...engines,
  ];
}
