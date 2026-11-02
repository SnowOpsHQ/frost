import { copyValueOf, type SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import {
  COPY_VALUE_KEYS,
  COPY_VALUE_LABELS,
  FEATURE_PANEL_JUMPS,
  OPEN_IN_CONFIRM_LABEL,
  OPEN_IN_CONSENT_MESSAGE,
  OPEN_IN_QUERY_NOTE,
  OPEN_IN_TEMPLATES,
  OPEN_TOOL_REFUSAL_MESSAGES,
  openInLabel,
  PALETTE_DETAIL_MAX_CHARS,
  SITE_FILES,
  type CopyValueKey,
  type OpenInTemplateId,
  type OpenToolResult,
} from '@app/specs/command-palette.spec';
import { DEFAULT_ZOOM, ZOOM_FACTORS, type PageCommand } from '@app/specs/page-commands.spec';
import { HIGHLIGHT_PANELS, SEO_PANELS, type HighlightMode, type SeoUnavailableReason } from '@app/specs/seo-sidebar.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { zoomLabel } from '../zoom-label';
import { createConsentStore, type ConsentStore } from './consent';
import { openInUrl, sendsQuery, siteFileUrl, templateHost } from './open-in';
import { readyAudit, type PaletteAction, type PaletteContext, type PaletteSource } from './registry';

// The palette's built-in actions (spec `command-palette.spec.ts`; acceptance
// `command-palette.feature.md`, Built-in actions). Registered like any feature's
// (`builtinPaletteSources(actions)` in `CommandPalette.tsx`). Every handler calls an existing
// procedure through `api` (the chrome's `actions` in `ipc.ts`, injected so this stays pure) or a
// chrome-side command (`ctx.chrome`). Labels are frost's own; page text appears only in a copy
// action's value preview, rendered as inert text.

/** The procedures the built-ins call (a subset of `actions` in `ipc.ts`). */
export interface PaletteApi {
  newTab(): Promise<unknown>;
  closeTab(tabId: number): Promise<unknown>;
  activateTab(tabId: number): Promise<unknown>;
  back(): Promise<unknown>;
  forward(): Promise<unknown>;
  reload(): Promise<unknown>;
  stop(): Promise<unknown>;
  pageCommand(command: PageCommand): Promise<unknown>;
  rerunAudit(tabId: number): Promise<unknown>;
  runAccessibility(tabId: number): Promise<boolean>;
  setHighlight(tabId: number, mode: HighlightMode): Promise<boolean>;
  copyValue(tabId: number, audit: { url: string; takenAt: number }, key: CopyValueKey): Promise<boolean>;
  copySchemaJson(tabId: number, audit: { url: string; takenAt: number }, block: number): Promise<boolean>;
  openBackgroundTab(url: string): Promise<number | null>;
  /** Main builds the tool's URL from the table and the active tab, and may refuse (`null`: IPC failure). */
  openTool(tool: OpenInTemplateId): Promise<OpenToolResult | null>;
  clearBrowsingData(): Promise<unknown>;
}

/** Reasons a fresh audit run may fix (as the sidebar's Retry: the page was slow or answered garbage). */
const RERUNNABLE: ReadonlySet<SeoUnavailableReason> = new Set(['timeout', 'invalid-snapshot', 'extraction-failed', 'analysis-timeout', 'analysis-failed']);

/** `value` cut to `PALETTE_DETAIL_MAX_CHARS` code points (the last an ellipsis). */
export function cutDetail(value: string): string {
  const chars = Array.from(value);
  return chars.length <= PALETTE_DETAIL_MAX_CHARS ? value : `${chars.slice(0, PALETTE_DETAIL_MAX_CHARS - 1).join('')}…`;
}

/** The tab shows a page (not empty, not an error or crash panel). */
const showsPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && tab.url !== '' && tab.error === null && !tab.crashed;
/** The tab shows an `http(s)` page. */
const showsWebPage = (tab: TabState | undefined): tab is TabState => showsPage(tab) && isWebUrl(tab.url);
/** The tab shows a web page and its audit is ready. */
const auditReady = (ctx: PaletteContext): boolean => showsWebPage(ctx.tab) && readyAudit(ctx) !== null;
const ref = (audit: SeoAudit) => ({ url: audit.url, takenAt: audit.takenAt });
const ZOOM_MIN = ZOOM_FACTORS[0];
const ZOOM_MAX = ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!;

/** Panels whose feature registers its own jump (`FEATURE_PANEL_JUMPS`). */
const OWN_JUMPS: ReadonlySet<string> = new Set(FEATURE_PANEL_JUMPS);

function panelActions(): PaletteAction[] {
  const panels = SEO_PANELS.filter((panel) => !OWN_JUMPS.has(panel.id)).map(
    (panel): PaletteAction => ({
      id: `panel.${panel.id}`,
      label: `${panel.label} panel`,
      group: 'panels',
      keywords: ['seo', 'sidebar', 'go to', 'show'],
      icon: `panel-${panel.id}`,
      focus: 'handler',
      run: (ctx) => ctx.chrome.openPanel(panel.id, { focus: true }),
    }),
  );
  return [
    ...panels,
    {
      id: 'sidebar.show',
      label: 'Show the SEO sidebar',
      group: 'panels',
      keywords: ['open', 'expand', 'panel'],
      icon: 'sidebar',
      shortcut: 'Mod+Shift+S',
      available: (ctx) => !ctx.sidebarOpen,
      run: (ctx) => ctx.chrome.setSidebarOpen(true),
    },
    {
      id: 'sidebar.hide',
      label: 'Hide the SEO sidebar',
      group: 'panels',
      keywords: ['close', 'collapse', 'panel'],
      icon: 'sidebar',
      shortcut: 'Mod+Shift+S',
      available: (ctx) => ctx.sidebarOpen,
      run: (ctx) => ctx.chrome.setSidebarOpen(false),
    },
  ];
}

function highlight(api: PaletteApi, mode: Exclude<HighlightMode, 'off'>, label: string, keywords: readonly string[]): PaletteAction {
  return {
    id: `highlight.${mode}`,
    label,
    group: 'audit',
    keywords: ['highlight', 'outline', 'overlay', 'show on page', ...keywords],
    icon: 'highlight',
    available: (ctx) => auditReady(ctx) && ctx.tab?.highlight !== mode,
    run: async (ctx) => {
      // The overlay belongs to its panel's toggle: open that panel first, or the chrome turns it off again.
      ctx.chrome.openPanel(HIGHLIGHT_PANELS[mode], { focus: false });
      return (await api.setHighlight(ctx.tab!.id, mode)) ? null : 'Couldn’t highlight this page';
    },
  };
}

function auditActions(api: PaletteApi): PaletteAction[] {
  return [
    {
      id: 'audit.rerun',
      label: 'Run the audit again',
      group: 'audit',
      keywords: ['re-audit', 'refresh', 'rescan', 'score'],
      icon: 'audit',
      available: (ctx) =>
        showsWebPage(ctx.tab) && ctx.audit !== null && (ctx.audit.status === 'ready' || (ctx.audit.status === 'unavailable' && RERUNNABLE.has(ctx.audit.reason))),
      run: async (ctx) => {
        await api.rerunAudit(ctx.tab!.id);
        return 'Auditing the page again';
      },
    },
    {
      id: 'audit.accessibility',
      label: 'Run the accessibility check',
      group: 'audit',
      keywords: ['a11y', 'wcag', 'compliance', 'contrast', 'aria'],
      icon: 'accessibility',
      available: (ctx) => auditReady(ctx) && (ctx.audit?.status !== 'ready' || ctx.audit.accessibilityRun?.status !== 'running'),
      run: async (ctx) => {
        ctx.chrome.openPanel('compliance', { focus: false });
        return (await api.runAccessibility(ctx.tab!.id)) ? 'Accessibility check running' : 'The accessibility check couldn’t start';
      },
    },
    highlight(api, 'links', 'Highlight links on the page', ['links', 'internal', 'external', 'nofollow']),
    highlight(api, 'headings', 'Highlight headings on the page', ['headings', 'h1', 'outline']),
    highlight(api, 'sentences', 'Highlight difficult sentences', ['sentences', 'readability', 'long', 'complex', 'content']),
    {
      id: 'highlight.off',
      label: 'Remove the page highlights',
      group: 'audit',
      keywords: ['highlight', 'overlay', 'clear', 'hide'],
      icon: 'highlight',
      available: (ctx) => ctx.tab !== undefined && ctx.tab.highlight !== 'off',
      run: async (ctx) => {
        await api.setHighlight(ctx.tab!.id, 'off');
      },
    },
  ];
}

function copyActions(api: PaletteApi): PaletteSource[] {
  const values = COPY_VALUE_KEYS.map(
    (key): PaletteAction => ({
      id: `copy.${key}`,
      label: `Copy the ${COPY_VALUE_LABELS[key]}`,
      group: 'copy',
      keywords: ['clipboard', ...key.split('-')],
      icon: 'copy',
      available: (ctx) => {
        const audit = readyAudit(ctx);
        return auditReady(ctx) && audit !== null && copyValueOf(audit, key) !== null;
      },
      detail: (ctx) => {
        const audit = readyAudit(ctx);
        const value = audit ? copyValueOf(audit, key) : null;
        return value === null ? null : cutDetail(value);
      },
      run: async (ctx) => {
        const audit = readyAudit(ctx)!;
        return (await api.copyValue(ctx.tab!.id, ref(audit), key)) ? `Copied the ${COPY_VALUE_LABELS[key]}` : 'Nothing copied: the audit changed';
      },
    }),
  );
  // One per JSON-LD block of the shown audit (the Schema panel's own Copy JSON).
  const blocks = (ctx: PaletteContext): PaletteAction[] => {
    const audit = readyAudit(ctx);
    if (!audit || !auditReady(ctx)) return [];
    return audit.schema.blocks
      .filter((block) => block.text !== '')
      .map((block) => ({
        id: `copy.json-ld.${block.index}`,
        label: `Copy JSON-LD block ${block.index + 1}`,
        group: 'copy',
        keywords: ['clipboard', 'schema', 'structured data', 'json'],
        icon: 'code',
        detail: () => {
          const types = audit.schema.entities.filter((entity) => entity.block === block.index && entity.topLevel).flatMap((entity) => entity.types);
          const kind = block.status === 'valid' ? 'JSON' : block.status === 'cut' ? 'cut short' : 'invalid JSON';
          return cutDetail(types.length > 0 ? `${[...new Set(types)].slice(0, 4).join(', ')} · ${kind}` : kind);
        },
        run: async (c: PaletteContext) => ((await api.copySchemaJson(c.tab!.id, ref(audit), block.index)) ? `Copied JSON-LD block ${block.index + 1}` : 'Nothing copied: the audit changed'),
      }));
  };
  return [...values, blocks];
}

function openInActions(api: PaletteApi, consent: ConsentStore): PaletteAction[] {
  const opened = (id: number | null, where: string) => (id === null ? 'Couldn’t open a tab' : `Opened ${where} in a background tab`);
  const tools = OPEN_IN_TEMPLATES.map((template): PaletteAction => {
    const host = templateHost(template);
    return {
      id: `open-in.${template.id}`,
      // The destination host is part of the label: matched, highlighted and read out.
      label: openInLabel(template),
      group: 'open-in',
      keywords: ['open in', 'external', 'tool', ...template.keywords],
      icon: 'external',
      detail: (ctx) => (ctx.tab && sendsQuery(ctx.tab.url) ? 'Sends this page’s address, query string included' : 'Sends this page’s address'),
      available: (ctx) => showsPage(ctx.tab) && openInUrl(template, ctx.tab.url) !== null,
      // The first use of each destination host asks (inline); the answer is kept as a preference.
      confirm: (ctx) =>
        consent.has(host)
          ? null
          : {
              message: OPEN_IN_CONSENT_MESSAGE.replace('{host}', host),
              note: ctx.tab && sendsQuery(ctx.tab.url) ? OPEN_IN_QUERY_NOTE : null,
              confirmLabel: OPEN_IN_CONFIRM_LABEL,
              accept: () => consent.grant(host),
            },
      run: async () => {
        // Main builds the URL from the table and the active tab's own URL, and checks where the page came from.
        const result = await api.openTool(template.id);
        if (result === null) return 'Couldn’t open a tab';
        return result.status === 'opened' ? opened(result.tabId, host) : OPEN_TOOL_REFUSAL_MESSAGES[result.reason];
      },
    };
  });
  const files = SITE_FILES.map(
    (file): PaletteAction => ({
      id: `open-in.${file.id}`,
      label: file.label,
      group: 'open-in',
      keywords: ['open', 'site', ...file.keywords],
      icon: file.id === 'robots-txt' ? 'robot' : 'sitemap',
      detail: (ctx) => (ctx.tab ? siteFileUrl(file, ctx.tab.url) : null),
      available: (ctx) => ctx.tab !== undefined && siteFileUrl(file, ctx.tab.url) !== null,
      run: async (ctx) => {
        const url = siteFileUrl(file, ctx.tab!.url);
        if (url === null) return 'Couldn’t open a tab';
        return opened(await api.openBackgroundTab(url), file.path.slice(1));
      },
    }),
  );
  return [...tools, ...files];
}

function pageActions(api: PaletteApi): PaletteAction[] {
  const pageCommand = (command: PageCommand) => async () => {
    await api.pageCommand(command);
  };
  const zoomDetail = (ctx: PaletteContext) => (ctx.tab ? `Now ${zoomLabel(ctx.tab.zoom) ?? '100%'}` : null);
  return [
    {
      id: 'page.reload',
      label: 'Reload the page',
      group: 'page',
      keywords: ['refresh'],
      icon: 'reload',
      shortcut: 'Mod+R',
      available: (ctx) => ctx.tab !== undefined && ctx.tab.url !== '',
      run: async (ctx) => {
        await api.reload();
      },
    },
    {
      id: 'page.hard-reload',
      label: 'Reload, ignoring the cache',
      group: 'page',
      keywords: ['hard', 'refresh', 'cache', 'force'],
      icon: 'reload',
      shortcut: 'Mod+Shift+R',
      available: (ctx) => showsPage(ctx.tab),
      run: pageCommand('hard-reload'),
    },
    {
      id: 'page.stop',
      label: 'Stop loading',
      group: 'page',
      keywords: ['cancel', 'abort'],
      icon: 'stop',
      shortcut: 'Escape',
      available: (ctx) => ctx.tab?.loading === true,
      run: async (ctx) => {
        await api.stop();
      },
    },
    {
      id: 'page.back',
      label: 'Go back',
      group: 'page',
      keywords: ['back', 'previous page', 'history'],
      icon: 'back',
      shortcut: { mac: 'Mod+[', other: 'Alt+Left' },
      available: (ctx) => ctx.tab?.canGoBack === true,
      run: async (ctx) => {
        await api.back();
      },
    },
    {
      id: 'page.forward',
      label: 'Go forward',
      group: 'page',
      keywords: ['forward', 'next page', 'history'],
      icon: 'forward',
      shortcut: { mac: 'Mod+]', other: 'Alt+Right' },
      available: (ctx) => ctx.tab?.canGoForward === true,
      run: async (ctx) => {
        await api.forward();
      },
    },
    {
      id: 'page.zoom-in',
      label: 'Zoom in',
      group: 'page',
      keywords: ['bigger', 'larger', 'magnify'],
      icon: 'zoom-in',
      shortcut: 'Mod+=',
      detail: zoomDetail,
      available: (ctx) => showsPage(ctx.tab) && ctx.tab.zoom < ZOOM_MAX,
      run: pageCommand('zoom-in'),
    },
    {
      id: 'page.zoom-out',
      label: 'Zoom out',
      group: 'page',
      keywords: ['smaller'],
      icon: 'zoom-out',
      shortcut: 'Mod+-',
      detail: zoomDetail,
      available: (ctx) => showsPage(ctx.tab) && ctx.tab.zoom > ZOOM_MIN,
      run: pageCommand('zoom-out'),
    },
    {
      id: 'page.zoom-reset',
      label: 'Reset the zoom',
      group: 'page',
      keywords: ['actual size', '100', 'zoom'],
      icon: 'zoom-reset',
      shortcut: 'Mod+0',
      detail: zoomDetail,
      available: (ctx) => showsPage(ctx.tab) && ctx.tab.zoom !== DEFAULT_ZOOM,
      run: pageCommand('zoom-reset'),
    },
  ];
}

/** The tab `step` places from the active one in the strip, wrapping. */
function neighbour(ctx: PaletteContext, step: 1 | -1): number | null {
  const tabs = ctx.state?.tabs ?? [];
  const at = tabs.findIndex((t) => t.id === ctx.tab?.id);
  if (at < 0 || tabs.length < 2) return null;
  return tabs[(at + step + tabs.length) % tabs.length]!.id;
}

function tabActions(api: PaletteApi): PaletteAction[] {
  const switchTo = (step: 1 | -1) => async (ctx: PaletteContext) => {
    const id = neighbour(ctx, step);
    if (id !== null) await api.activateTab(id);
  };
  return [
    {
      id: 'tab.new',
      label: 'New tab',
      group: 'tabs',
      keywords: ['open', 'blank'],
      icon: 'tab-new',
      shortcut: 'Mod+T',
      focus: 'handler',
      run: async (ctx) => {
        await api.newTab();
      },
    },
    {
      id: 'tab.close',
      label: 'Close this tab',
      group: 'tabs',
      keywords: ['close', 'remove'],
      icon: 'tab-close',
      shortcut: 'Mod+W',
      focus: 'handler',
      available: (ctx) => ctx.tab !== undefined,
      run: async (ctx) => {
        await api.closeTab(ctx.tab!.id);
      },
    },
    {
      id: 'tab.next',
      label: 'Next tab',
      group: 'tabs',
      keywords: ['switch', 'right'],
      icon: 'tab-switch',
      shortcut: 'Ctrl+Tab',
      focus: 'handler',
      available: (ctx) => neighbour(ctx, 1) !== null,
      run: switchTo(1),
    },
    {
      id: 'tab.previous',
      label: 'Previous tab',
      group: 'tabs',
      keywords: ['switch', 'left'],
      icon: 'tab-switch',
      shortcut: 'Ctrl+Shift+Tab',
      focus: 'handler',
      available: (ctx) => neighbour(ctx, -1) !== null,
      run: switchTo(-1),
    },
  ];
}

function browserActions(api: PaletteApi): PaletteAction[] {
  return [
    {
      id: 'browser.clear-data',
      label: 'Clear browsing data…',
      group: 'browser',
      keywords: ['history', 'cookies', 'cache', 'storage', 'privacy', 'reset'],
      icon: 'clear',
      run: async (ctx) => {
        await api.clearBrowsingData();
      },
    },
  ];
}

/**
 * The built-in sources, calling `procedures`. Copy and audit actions read only the audit the
 * chrome shows; "Open in" builds only from the fixed tables. Registering them twice in one registry
 * throws (duplicate ids).
 */
export function builtinPaletteSources(procedures: PaletteApi, consent: ConsentStore = createConsentStore(null)): PaletteSource[] {
  return [...panelActions(), ...auditActions(procedures), ...copyActions(procedures), ...openInActions(procedures, consent), ...pageActions(procedures), ...tabActions(procedures), ...browserActions(procedures)];
}
