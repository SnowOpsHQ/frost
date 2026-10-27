import type { TabState } from '@app/specs/browser.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { readyAudit, type PaletteSource } from './palette/registry';

// The Content panel in the command palette (spec `seo-content.feature.md`, Command palette;
// `command-palette.spec.ts`, Registration API, `FEATURE_PANEL_JUMPS`): "Open Content panel" (the
// panel's jump, owned here), "Set target query…" (the panel, with focus in its query field) and
// "Copy snippet as HTML" (the page's own title and description, through main's
// `content.copySnippetHtml`, as the snippet editor copies them). Registered from
// `components/seo/Content.tsx`; pure (the procedure is injected) so availability is unit tested.

/** The procedure the copy calls (`copySnippetHtml` in `hooks/useContentNotes.ts`; `null`: the page's own). */
export interface ContentPaletteApi {
  copySnippetHtml(tabId: number, audit: { url: string; takenAt: number }, slot: number | null): Promise<boolean>;
}

/** How long a "Set target query…" request waits for the panel's query field to be ready. */
export const TARGET_QUERY_FOCUS_WINDOW_MS = 3_000;

// The one pending "focus the target query field" request, and who listens for it (the panel's field).
let focusRequestedAt: number | null = null;
const focusListeners = new Set<() => void>();

/** Asks the Content panel to focus its target query field (now if it is ready, else once it is). */
export function requestTargetQueryFocus(now: number = Date.now()): void {
  focusRequestedAt = now;
  for (const listener of [...focusListeners]) listener();
}

/**
 * Whether a request is pending (made within `TARGET_QUERY_FOCUS_WINDOW_MS`); taking it clears it, so
 * a request focuses the field once, and a stale one never steals focus later.
 */
export function takeTargetQueryFocus(now: number = Date.now()): boolean {
  const at = focusRequestedAt;
  focusRequestedAt = null;
  return at !== null && now - at <= TARGET_QUERY_FOCUS_WINDOW_MS;
}

/** Calls `listener` on each request; answers a function that stops. */
export function onTargetQueryFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

const KEYWORDS = ['content', 'snippet', 'seo'];

/** The tab shows an `http(s)` page without an error or crash panel. */
const onWebPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && isWebUrl(tab.url) && tab.error === null && !tab.crashed;

/** The palette's Content actions, calling `api`. */
export function contentPaletteSources(api: ContentPaletteApi): PaletteSource[] {
  return [
    {
      id: 'panel.content',
      label: 'Open Content panel',
      group: 'panels',
      keywords: [...KEYWORDS, 'go to', 'show', 'n-grams', 'readability', 'sidebar'],
      icon: 'panel-content',
      focus: 'handler',
      run: (ctx) => ctx.chrome.openPanel('content', { focus: true }),
    },
    {
      id: 'content.target-query',
      label: 'Set target query…',
      group: 'panels',
      keywords: [...KEYWORDS, 'keyword', 'query', 'checklist', 'target'],
      icon: 'panel-content',
      focus: 'handler',
      // The panel's checklist needs the page's ready audit.
      available: (ctx) => onWebPage(ctx.tab) && readyAudit(ctx) !== null,
      run: (ctx) => {
        ctx.chrome.openPanel('content');
        requestTargetQueryFocus();
      },
    },
    {
      id: 'copy.snippet-html',
      label: 'Copy snippet as HTML',
      group: 'copy',
      keywords: [...KEYWORDS, 'title', 'meta description', 'html', 'tags'],
      icon: 'code',
      // Something to copy: the shown audit's title or meta description.
      available: (ctx) => {
        const audit = readyAudit(ctx);
        return onWebPage(ctx.tab) && audit !== null && ((audit.page.title?.text ?? '') !== '' || (audit.page.description?.text ?? '') !== '');
      },
      run: async (ctx) => {
        const audit = readyAudit(ctx)!;
        const ok = await api.copySnippetHtml(ctx.tab!.id, { url: audit.url, takenAt: audit.takenAt }, null);
        return ok ? 'Snippet copied as HTML' : 'Nothing was copied';
      },
    },
  ];
}
