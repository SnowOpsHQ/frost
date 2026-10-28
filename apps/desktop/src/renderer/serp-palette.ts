import type { TabState } from '@app/specs/browser.spec';
import { INTENT_ENABLE_MESSAGES, INTENT_ENABLE_PROMPT, type IntentEnableOutcome, type IntentState } from '@app/specs/intent-classifier.spec';
import { PACK_UPDATE_MESSAGES, type PackUpdateOutcome } from '@app/specs/serp-selector-pack.spec';
import type { SerpTabState } from '@app/specs/serp-service.schema';
import { PROBE_DISCLOSURE } from '@app/specs/visibility-probes.spec';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import { isWebUrl } from '@app/specs/web-url.spec';
import type { PaletteContext, PaletteSource } from './palette/registry';

// The SERP and Visibility panels in the command palette (acceptance `serp-panels.feature.md`,
// Command palette; `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): both panels'
// jumps, the outlines, "Check for selector updates", "Enable on-device intent" and the visibility
// probes. Registered from `components/seo/Serp.tsx` with one call; pure (the procedures and what the
// chrome last saw are injected) so availability is unit tested. The two actions that download or
// fetch on the user's behalf ask first, with the same words their panels show.

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
        // The outlines live with the SERP panel's toggle (leaving the panel turns them off).
        ctx.chrome.openPanel('serp');
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
        // The panel shows the run, its disclosure and Stop.
        ctx.chrome.openPanel('visibility');
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
