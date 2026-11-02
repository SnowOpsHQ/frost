import { AI_CHECKS_COPY as COPY } from '@app/specs/ai-checks.spec';
import type { SettingsSectionId } from '@app/specs/account-settings.spec';
import type { TabState } from '@app/specs/browser.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { knownAiChecks } from './ai-checks-view';
import type { PaletteSource } from './palette/registry';

// AI checks in the command palette (Phase 9 Task 11; acceptance `ai-checks.feature.md`, UI;
// `command-palette.spec.ts`, Registration API): "Check this page with AI" asks main for a check of the
// active tab (`aiChecks.checkNow`) and opens the Overview, whose "AI judgment" card shows it; it is
// offered on a web page unless the tab's mode is known to be `off` (unknown: offered, main decides).
// "AI checks: change mode…" opens Settings on the AI checks section: turning checks on is main's consent
// dialog, reached from there. Registered from `components/seo/AiChecksCard.tsx`; pure (the calls are
// injected) so it is unit tested.

export interface AiChecksPaletteApi {
  /** `aiChecks.checkNow` for the tab: whether a check runs or waits its turn. */
  checkNow(tabId: number): Promise<boolean>;
  openSettings(section: SettingsSectionId): void;
}

const KEYWORDS = ['ai', 'ai checks', 'ai judgment', 'llm', 'model', 'page type', 'intent', 'quality', 'target query', 'seo'];

/** The tab shows an `http(s)` page without an error or crash panel. */
const onWebPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && isWebUrl(tab.url) && tab.error === null && !tab.crashed;

export function aiChecksPaletteSources(api: AiChecksPaletteApi): PaletteSource[] {
  return [
    {
      id: 'ai-checks.check-page',
      label: COPY.palette.check,
      group: 'audit',
      keywords: [...KEYWORDS, 'check', 'judge', 'run'],
      icon: 'panel-overview',
      available: (ctx) => onWebPage(ctx.tab) && knownAiChecks(ctx.tab.id)?.mode !== 'off',
      run: async (ctx) => {
        const started = await api.checkNow(ctx.tab!.id);
        ctx.chrome.openPanel('overview', { focus: false });
        return started ? COPY.palette.started : COPY.palette.notStarted;
      },
    },
    {
      id: 'ai-checks.mode',
      label: COPY.palette.mode,
      group: 'browser',
      keywords: [...KEYWORDS, 'settings', 'mode', 'off', 'automatic', 'on request', 'turn on', 'turn off'],
      focus: 'handler',
      run: () => api.openSettings('ai-checks'),
    },
  ];
}
