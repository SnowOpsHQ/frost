import { AI_DESTINATION_NOTE, AI_SEARCH_DESTINATIONS, aiDestinationHost, aiDestinationLabel, openDestinationMessage, type AiDestinationId, type OpenDestinationResult } from '@app/specs/ai-destinations.spec';
import type { TabState } from '@app/specs/browser.spec';
import { INTENT_ENABLE_MESSAGES, INTENT_ENABLE_PROMPT, type IntentEnableOutcome, type IntentState } from '@app/specs/intent-classifier.spec';
import { PACK_UPDATE_MESSAGES, type PackUpdateOutcome } from '@app/specs/serp-selector-pack.spec';
import type { SerpTabState } from '@app/specs/serp-service.schema';
import { PROBE_DISCLOSURE } from '@app/specs/visibility-probes.spec';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import { isWebUrl } from '@app/specs/web-url.spec';
import type { PaletteContext, PaletteSource } from './palette/registry';
import { serpEditorModel, trackView, type SerpEditorMode } from './serp-editor-view';
import { serpParams } from './serp-view';

// The SERP and Visibility panels in the command palette (acceptance `serp-panels.feature.md`,
// Command palette; `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): both panels'
// jumps, the outlines, "Check for selector updates", "Enable on-device intent" and the visibility
// probes, and (Phase 10 Task 9) "Edit search…" and "Track this search…", which open the SERP panel's
// editor or project picker (`serp-panels.feature.md`, Edit search), and (Task 10) "Open search in …"
// an AI engine (`serp-panels.feature.md`, Open in an AI engine): the tab id and a table id go to main,
// which builds the URL from the tab's own search. Registered from
// `components/seo/Serp.tsx` with one call; pure (the procedures and what the chrome last saw are
// injected) so availability is unit tested. The two actions that download or fetch on the user's
// behalf ask first, with the same words their panels show.

export interface SerpPaletteApi {
  /** `serp.setOutlines`; resolves whether the outlines are drawn now. */
  setOutlines(tabId: number, on: boolean): Promise<boolean>;
  /** `serp.checkPackUpdate`; `null` on an IPC failure. */
  checkPackUpdate(): Promise<PackUpdateOutcome | null>;
  /** `serp.enableIntent`; `null` on an IPC failure. */
  enableIntent(): Promise<IntentEnableOutcome | null>;
  /** Asks main where intent stands now and remembers it (`knownIntent`). */
  refreshIntent(): Promise<unknown>;
  runProbes(tabId: number): Promise<boolean>;
  stopProbes(tabId: number): Promise<boolean>;
  /** Asks the SERP panel of the tab to open its editor or its project picker (`requestSerpEditor`). */
  openEditor(tabId: number, mode: SerpEditorMode): void;
  /** `serp.openDestination`: the tab and a table id only; `null` on an IPC failure. */
  openDestination(tabId: number, destination: AiDestinationId): Promise<OpenDestinationResult | null>;
  /** The last SERP state the chrome saw for a tab (`undefined`: none yet). */
  knownSerp(tabId: number): SerpTabState | undefined;
  /** The last probes state the chrome saw for a tab. */
  knownProbes(tabId: number): ProbesState | undefined;
  /** Where on-device intent stood when the chrome last asked. */
  knownIntent(): IntentState | undefined;
}

const SERP_KEYWORDS = ['serp', 'search results', 'result page', 'google', 'bing', 'rankings', 'seo'];
const VISIBILITY_KEYWORDS = ['visibility', 'crawler', 'bot', 'googlebot', 'gptbot', 'ai', 'indexability', 'robots', 'seo'];

/** The tab shows an `http(s)` page without an error or crash panel. */
const onWebPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && isWebUrl(tab.url) && tab.error === null && !tab.crashed;

export function serpPaletteSources(api: SerpPaletteApi): PaletteSource[] {
  /** The active tab's last known SERP state (only its own). */
  const serpOf = (ctx: PaletteContext): SerpTabState | undefined => {
    if (!ctx.tab) return undefined;
    const known = api.knownSerp(ctx.tab.id);
    return known?.tabId === ctx.tab.id ? known : undefined;
  };
  return [
    {
      id: 'panel.serp',
      label: 'Open SERP panel',
      group: 'panels',
      keywords: [...SERP_KEYWORDS, 'go to', 'show', 'composition', 'ownership', 'intent', 'sidebar'],
      icon: 'panel-serp',
      focus: 'handler',
      run: (ctx) => ctx.chrome.openPanel('serp', { focus: true }),
    },
    {
      id: 'panel.visibility',
      label: 'Open Visibility panel',
      group: 'panels',
      keywords: [...VISIBILITY_KEYWORDS, 'go to', 'show', 'probes', 'sidebar'],
      icon: 'panel-visibility',
      focus: 'handler',
      run: (ctx) => ctx.chrome.openPanel('visibility', { focus: true }),
    },
    {
      id: 'serp.outline',
      label: 'Outline SERP features',
      group: 'panels',
      keywords: [...SERP_KEYWORDS, 'outline', 'highlight', 'features', 'overlay', 'boxes'],
      icon: 'highlight',
      focus: 'handler',
      // Main draws only for a ready reading; before the chrome has seen one, it decides.
      available: (ctx) => {
        if (!onWebPage(ctx.tab)) return false;
        const known = serpOf(ctx);
        return known === undefined || (known.serp.status === 'ready' && !known.outlines);
      },
      run: async (ctx) => {
        // The outlines live with the SERP panel's toggle (leaving the panel turns them off); the
        // palette restores no focus, so the panel takes it.
        ctx.chrome.openPanel('serp', { focus: true });
        return (await api.setOutlines(ctx.tab!.id, true)) ? 'Outlining SERP features' : 'Nothing to outline on this page';
      },
    },
    {
      id: 'serp.outline-hide',
      label: 'Hide SERP outlines',
      group: 'panels',
      keywords: [...SERP_KEYWORDS, 'outline', 'highlight', 'remove', 'off'],
      icon: 'highlight',
      available: (ctx) => serpOf(ctx)?.outlines === true,
      run: async (ctx) => {
        await api.setOutlines(ctx.tab!.id, false);
        return 'SERP outlines hidden';
      },
    },
    {
      id: 'serp.edit',
      label: 'Edit search…',
      group: 'panels',
      keywords: [...SERP_KEYWORDS, 'edit', 'parameters', 'country', 'language', 'domain', 'time', 'safesearch', 'region'],
      icon: 'panel-serp',
      focus: 'handler',
      // Only on a result page the chrome has seen, of an engine whose settings the editor knows.
      available: (ctx) => {
        const known = serpOf(ctx);
        if (!onWebPage(ctx.tab) || known === undefined) return false;
        const model = serpEditorModel(known);
        return model !== null && model.fields.length > 0;
      },
      run: (ctx) => {
        ctx.chrome.openPanel('serp');
        api.openEditor(ctx.tab!.id, 'edit');
      },
    },
    {
      id: 'serp.track',
      label: 'Track this search…',
      group: 'panels',
      keywords: [...SERP_KEYWORDS, 'track', 'project', 'save', 'saved search', 'rank tracking'],
      icon: 'panel-serp',
      focus: 'handler',
      available: (ctx) => {
        const known = serpOf(ctx);
        return onWebPage(ctx.tab) && known !== undefined && serpEditorModel(known) !== null;
      },
      // A search a saved search cannot be answers why; otherwise the panel's project picker opens.
      run: (ctx) => {
        const model = serpEditorModel(serpOf(ctx)!);
        const view = model === null ? null : trackView(model);
        if (view === null || view.search === null) return view?.reason ?? null;
        ctx.chrome.openPanel('serp');
        api.openEditor(ctx.tab!.id, 'track');
        return undefined;
      },
    },
    // "Open search in …" an AI engine: on a result page the chrome has seen, asking first with the note.
    ...AI_SEARCH_DESTINATIONS.map(
      (destination): PaletteSource => ({
        id: `serp.open-in-${destination.id}`,
        label: aiDestinationLabel(destination),
        group: 'open-in',
        keywords: [...SERP_KEYWORDS, 'open in', 'ai', 'ai search', 'answer engine', destination.label.toLowerCase()],
        icon: 'external',
        detail: () => `Sends this search’s query to ${aiDestinationHost(destination)}`,
        available: (ctx) => {
          const known = serpOf(ctx);
          return onWebPage(ctx.tab) && known !== undefined && serpParams(known.serp)?.query != null;
        },
        confirm: () => ({ message: `Open this search in ${destination.label}?`, note: AI_DESTINATION_NOTE, confirmLabel: 'Open', accept: () => undefined }),
        // Main reads the tab's own query and builds the URL from the table.
        run: async (ctx) => openDestinationMessage(destination, await api.openDestination(ctx.tab!.id, destination.id)),
      }),
    ),
    {
      id: 'serp.check-pack-update',
      label: 'Check for selector updates',
      group: 'panels',
      keywords: [...SERP_KEYWORDS, 'selectors', 'update', 'pack', 'layout'],
      icon: 'reload',
      available: (ctx) => {
        const pack = serpOf(ctx)?.pack;
        return pack === undefined || (pack.state === 'ready' && !pack.checking);
      },
      run: async () => PACK_UPDATE_MESSAGES[(await api.checkPackUpdate()) ?? 'unreachable'],
    },
    {
      id: 'serp.enable-intent',
      label: 'Enable on-device intent',
      group: 'panels',
      keywords: [...SERP_KEYWORDS, 'intent', 'model', 'download', 'classifier', 'on-device'],
      icon: 'audit',
      available: () => {
        const state = api.knownIntent();
        return state === undefined || state === 'model-missing';
      },
      confirm: () => ({ message: INTENT_ENABLE_PROMPT, confirmLabel: 'Download and enable', accept: () => undefined }),
      run: async () => {
        const outcome = (await api.enableIntent()) ?? 'unreachable';
        // So the palette stops offering it once the model is there.
        await api.refreshIntent();
        return INTENT_ENABLE_MESSAGES[outcome];
      },
    },
    {
      id: 'probes.run',
      label: 'Run visibility probes',
      group: 'panels',
      keywords: [...VISIBILITY_KEYWORDS, 'probe', 'fetch as', 'user agent', 'claudebot', 'bingbot'],
      icon: 'robot',
      focus: 'handler',
      available: (ctx) => onWebPage(ctx.tab) && api.knownProbes(ctx.tab.id)?.status !== 'running',
      confirm: () => ({ message: 'Fetch this page once as each crawler and as frost?', note: PROBE_DISCLOSURE, confirmLabel: 'Run probes', accept: () => undefined }),
      run: async (ctx) => {
        // The panel shows the run, its disclosure and Stop (and takes focus).
        ctx.chrome.openPanel('visibility', { focus: true });
        return (await api.runProbes(ctx.tab!.id)) ? 'Running visibility probes' : 'The probes could not start';
      },
    },
    {
      id: 'probes.stop',
      label: 'Stop visibility probes',
      group: 'panels',
      keywords: [...VISIBILITY_KEYWORDS, 'stop', 'cancel', 'probes'],
      icon: 'stop',
      available: (ctx) => onWebPage(ctx.tab) && api.knownProbes(ctx.tab.id)?.status === 'running',
      run: async (ctx) => ((await api.stopProbes(ctx.tab!.id)) ? 'Visibility probes stopped' : 'No probe run was going'),
    },
  ];
}
