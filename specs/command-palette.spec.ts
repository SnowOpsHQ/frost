/**
 * The command palette (Phase 2.5 Task 4; acceptance: `command-palette.feature.md`). Plain values
 * with no Zod, so the chrome renderer can import them (Zod's eval probe trips the app's strict
 * Trusted Types CSP). The `seo.copyValue` / `browser.pageCommand` input schemas are in
 * `command-palette.schema.ts`.
 *
 * ## Registration API (for other features)
 * The palette searches one **action registry** (`apps/desktop/src/renderer/palette/registry.ts`).
 * A feature adds its own actions with one call in its own file, at module load:
 *
 * ```ts
 * import { registerPaletteActions } from '../palette/registry';
 * registerPaletteActions({
 *   id: 'render.reset',                       // PALETTE_ACTION_ID_PATTERN, unique, stable (recents keep it)
 *   label: 'Reset the render profile',        // frost's own words, never page text
 *   group: 'page',                            // a PALETTE_GROUPS id
 *   keywords: ['emulation', 'device'],        // extra words the search matches
 *   available: (ctx) => ctx.tab?.url !== '',  // from ctx.tab / ctx.state / ctx.audit / ctx.sidebarOpen
 *   run: (ctx) => actions.clearRenderProfile(ctx.tab!.id).then(() => 'Render profile reset'),
 * });
 * ```
 *
 * `registerPaletteActions` takes any number of actions, or functions `(ctx) => actions[]` for
 * actions that depend on the state (e.g. one per JSON-LD block), and answers a function that
 * unregisters them. Handlers call existing tRPC procedures (the chrome's `actions` in `ipc.ts`) or
 * chrome-side commands (`ctx.chrome`); a string they resolve is shown briefly as a status line. A new
 * group is one more entry in `PALETTE_GROUPS`. A predicate or handler that throws never breaks the
 * palette: that action is left out, or reports `PALETTE_FAILED_MESSAGE`.
 */
import type { SeoPanelId } from './seo-sidebar.spec';

/**
 * Opening: `Mod+K` (Cmd on macOS, Ctrl elsewhere). It is `RESERVED_TAB_SHORTCUTS['command-palette']`
 * (`tabs.spec.ts`): taken from every tab's and the chrome's `before-input-event` and consumed, so a
 * page can neither see nor block it, and the View menu's item (`COMMAND_PALETTE_MENU_ID`) has it as
 * its accelerator. Main bumps `BrowserState.commandPalette.seq`; the chrome opens the palette whenever
 * that changes, or closes it if it is open. A key held down toggles once: auto-repeated key-downs
 * (`input.isAutoRepeat`) are consumed and ignored. While the active tab is in HTML fullscreen (its
 * view covers the whole window) the shortcut is consumed and nothing opens; and when the active tab
 * enters HTML fullscreen while the palette is open, the palette closes without restoring focus (the
 * chrome is hidden behind the page).
 */
export const COMMAND_PALETTE_SHORTCUT = 'Mod+K' as const;
export const COMMAND_PALETTE_MENU_ID = 'command-palette' as const;
export const COMMAND_PALETTE_MENU_LABEL = 'Command Palette…' as const;

/**
 * Where keyboard focus was when the palette was asked for (`BrowserState.commandPalette.returnFocus`):
 * `page` when the active tab's page had it, else `chrome`. Closing the palette without running a
 * command that moves focus itself puts it back there: `page` through `browser.focusPage`, `chrome`
 * on the element that had it.
 */
export const PALETTE_RETURN_FOCUS = ['page', 'chrome'] as const;
export type PaletteReturnFocus = (typeof PALETTE_RETURN_FOCUS)[number];

/**
 * Not covered by the page. Tab views are native `WebContentsView`s drawn above the chrome's DOM, so
 * a DOM overlay would be hidden behind the page. The palette instead takes a band of the page area
 * itself: while it is open it is a sheet `PALETTE_SHEET_HEIGHT` CSS px high (less in a short
 * window, so at least `PALETTE_PAGE_MIN_VISIBLE` px of the page stays in view) at the top of the
 * page column, and the page area below it shrinks. The chrome reports the smaller page area through
 * the existing `browser.setPageBounds` (as the SEO sidebar does sideways), so main lays the view
 * out below the sheet: no second view, no page capture, no z-order trick. Its height is fixed while
 * it is open, so typing never resizes the page. It is never shorter than `PALETTE_SHEET_MIN_HEIGHT`
 * (the page then keeps less than `PALETTE_PAGE_MIN_VISIBLE`); in a page column shorter than that
 * the palette does not open (it would be cut off) and says so in the status line
 * (`PALETTE_TOO_SHORT_MESSAGE`). Keep these equal to `styles.css` (a unit test reads it).
 */
export const PALETTE_SHEET_HEIGHT = 404;
export const PALETTE_PAGE_MIN_VISIBLE = 96;
export const PALETTE_SHEET_MIN_HEIGHT = 180;
export const PALETTE_TOO_SHORT_MESSAGE = 'The window is too short for the command palette' as const;

/** Groups, in the order the palette lists them with an empty query. */
export const PALETTE_GROUPS = [
  { id: 'panels', label: 'SEO panels' },
  { id: 'audit', label: 'Audit' },
  { id: 'copy', label: 'Copy from this audit' },
  { id: 'open-in', label: 'Open in' },
  { id: 'page', label: 'Page' },
  { id: 'tabs', label: 'Tabs' },
  { id: 'browser', label: 'Browser' },
] as const satisfies readonly { id: string; label: string }[];
export type PaletteGroupId = (typeof PALETTE_GROUPS)[number]['id'];
/** The heading of the recently run actions, listed first with an empty query. */
export const PALETTE_RECENT_LABEL = 'Recent' as const;

/** An action id: lowercase words joined by `.` or `-`, at most `PALETTE_ACTION_ID_MAX` characters. */
export const PALETTE_ACTION_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const PALETTE_ACTION_ID_MAX = 64;

/** The longest query the search box takes (longer input is cut). */
export const PALETTE_QUERY_MAX_CHARS = 100;

/**
 * Recently run actions, most recent first, kept in the chrome's own `localStorage` (`app://app`,
 * the app's default session, never the browse partition) under this key as a JSON array of action
 * ids: at most `PALETTE_RECENT_MAX`, unknown or malformed entries dropped when read. With an empty
 * query they are listed first (those available now); with a query a recent action gets
 * `PALETTE_RECENT_BOOST` on its match score (a better match still wins).
 */
export const PALETTE_RECENT_STORAGE_KEY = 'frost.command-palette.recent' as const;
export const PALETTE_RECENT_MAX = 6;
export const PALETTE_RECENT_BOOST = 12;

/** A value preview (page text) in a copy action's row is cut to this many characters. */
export const PALETTE_DETAIL_MAX_CHARS = 120;

/** How long a handler's status line shows after the palette closed. */
export const PALETTE_STATUS_MS = 2_400;
/** What the status line says when a handler threw or its IPC failed. */
export const PALETTE_FAILED_MESSAGE = 'That command didn’t run' as const;

/** What the list says when nothing matches the query. */
export const PALETTE_EMPTY_MESSAGE = 'No matching commands' as const;

/** The panels the palette jumps to: every `SEO_PANELS` entry (`seo-sidebar.spec.ts`). */
export type PalettePanel = SeoPanelId;

/**
 * Panels whose feature registers its own jump (same id, `panel.<id>`) next to its other actions, so
 * the built-ins leave theirs out: one row per panel. `content`: "Open Content panel", with "Set
 * target query…" and "Copy snippet as HTML" (`seo-content.feature.md`, Command palette); `javascript`:
 * "Open JavaScript panel", with "Fetch served HTML again" (`seo-javascript.feature.md`); `serp` and
 * `visibility`: "Open SERP panel" and "Open Visibility panel", with the SERP actions (`serp-panels.feature.md`);
 * `search-console`: "Open Search Console panel", with its scope actions (`gsc-panel.feature.md`). One entry
 * per line, append-only: each phase adds its own line.
 */
export const FEATURE_PANEL_JUMPS = [
  'content',
  'javascript',
  'serp',
  'visibility',
  'search-console',
] as const satisfies readonly PalettePanel[];

/**
 * Copy actions (`seo.copyValue({ tabId, audit, key })`): main writes, with Electron's `clipboard`,
 * one value of the tab's **ready** audit, and only if that audit is the one the chrome shows
 * (`SeoAuditRefSchema`), as the Phase 2 copy actions do. The chrome never touches the clipboard.
 * What each key writes (`copyValueOf` in `@app/seo-core`):
 * - `url`: the audited URL;
 * - `title`: the first `<title>`, as the snapshot kept it (whitespace collapsed, capped);
 * - `meta-description`: the first meta description with text, as kept;
 * - `canonical`: the canonical search engines read (the HTML one, else the HTTP `Link` header's), resolved;
 * - `h1`: the first visible H1's text;
 * - `robots-meta`: every robots meta as `name: content`, joined with ` · `;
 * - `status-code`: the main-frame HTTP status, as digits.
 * A key without a value (no H1, no recorded status …) writes nothing and answers `false`; its action
 * is not offered. Each JSON-LD block is copied by the Schema panel's own `seo.copySchemaJson`.
 */
export const COPY_VALUE_KEYS = ['url', 'title', 'meta-description', 'canonical', 'h1', 'robots-meta', 'status-code'] as const;
export type CopyValueKey = (typeof COPY_VALUE_KEYS)[number];
export const COPY_VALUE_LABELS: Readonly<Record<CopyValueKey, string>> = {
  url: 'page URL',
  title: 'title',
  'meta-description': 'meta description',
  canonical: 'canonical URL',
  h1: 'H1',
  'robots-meta': 'robots meta tags',
  'status-code': 'HTTP status code',
};

/**
 * "Open in" external tools: a fixed, reviewed table. Each URL is the template's own `https:` origin
 * and path, its fixed `params`, and the page URL as the value of `urlParam`, URL-encoded
 * (`URLSearchParams`). The page URL goes nowhere else: never into the host or the path, and the
 * host is never page-controlled. The page URL sent is the active tab's URL with any user name,
 * password and fragment removed. Offered only for an `http(s)` page on a public host
 * (`isPublicHost` in `open-in.spec.ts`: never `localhost`, a non-public IP literal, a single-label
 * name or a name under a reserved or local-only suffix: those URLs mean nothing to a public tool and
 * would leak an internal address), and only if the result fits `browser.openBackgroundTab`. Labels are frost's own
 * descriptions of what the tool does, followed by the host the URL goes to (`openInLabel`: `Rich
 * results test — search.google.com`), so the destination is matched, highlighted and read out.
 *
 * Main builds and opens it (`browser.openTool({ tool })`, `enforceSender` first): from the table and
 * the active tab's own URL, never a URL the chrome sends. Main refuses (`OPEN_TOOL_REFUSALS`) when
 * the active tab shows no web page (`no-page`), its URL cannot be sent (`not-public`), its
 * main-frame response came from a private, loopback or otherwise non-public IP address
 * (`private-address`: the webRequest `ip` main recorded for the document; a public name can resolve
 * to a LAN address), or no tab opened (`not-opened`: the tab limit). With no recorded address (a
 * back/forward cache restore, a response main never saw, after Clear Browsing Data) the name check
 * alone decides. Otherwise it opens the URL in a background tab right of the active one.
 *
 * Before the first use of each destination host the palette asks, as an inline step (never a
 * native dialog): `OPEN_IN_CONSENT_MESSAGE`, plus `OPEN_IN_QUERY_NOTE` when the page URL has a
 * query string. Confirming remembers the host in the chrome's own `localStorage`
 * (`OPEN_IN_CONSENT_STORAGE_KEY`, a JSON array of hosts, at most `OPEN_IN_CONSENT_MAX`); it is a
 * preference, so Clear Browsing Data (which clears the browse partition) leaves it. Going back
 * (Esc, "Back") returns to the list and sends nothing. A row whose page URL has a query string says
 * so in its detail line every time.
 */
export const OPEN_IN_TEMPLATES = [
  {
    id: 'rich-results',
    label: 'Rich results test',
    keywords: ['structured data', 'schema', 'json-ld', 'snippet', 'validate'],
    origin: 'https://search.google.com',
    path: '/test/rich-results',
    urlParam: 'url',
    params: {},
  },
  {
    id: 'mobile-rendering',
    label: 'Mobile rendering and speed test',
    keywords: ['mobile', 'phone', 'render', 'screenshot', 'responsive'],
    origin: 'https://pagespeed.web.dev',
    path: '/analysis',
    urlParam: 'url',
    params: { form_factor: 'mobile' },
  },
  {
    id: 'page-speed',
    label: 'Page speed test (desktop)',
    keywords: ['performance', 'vitals', 'lab', 'speed'],
    origin: 'https://pagespeed.web.dev',
    path: '/analysis',
    urlParam: 'url',
    params: { form_factor: 'desktop' },
  },
  {
    id: 'html-validator',
    label: 'HTML markup validator',
    keywords: ['markup', 'validate', 'html', 'standards'],
    origin: 'https://validator.w3.org',
    path: '/nu/',
    urlParam: 'doc',
    params: {},
  },
  {
    // The archive's capture index: the page's latest 50 captures (timestamp, status, URL), as text.
    // Its calendar view takes the page URL in the path, which this table never does.
    id: 'archive',
    label: 'Archived copies of this page',
    keywords: ['archive', 'history', 'snapshot', 'captures'],
    origin: 'https://web.archive.org',
    path: '/cdx/search/cdx',
    urlParam: 'url',
    params: { fl: 'timestamp,statuscode,original', limit: '-50' },
  },
] as const satisfies readonly OpenInTemplate[];
export interface OpenInTemplate {
  readonly id: string;
  readonly label: string;
  readonly keywords: readonly string[];
  /** `https://` + a fixed host: no port, path, query or fragment. */
  readonly origin: string;
  readonly path: string;
  readonly urlParam: string;
  readonly params: Readonly<Record<string, string>>;
}
export type OpenInTemplateId = (typeof OPEN_IN_TEMPLATES)[number]['id'];
export const OPEN_IN_TEMPLATE_IDS = OPEN_IN_TEMPLATES.map((t) => t.id) as [OpenInTemplateId, ...OpenInTemplateId[]];

/** A tool's row label: its description, then the host the page URL goes to. */
export function openInLabel(template: OpenInTemplate): string {
  return `${template.label} — ${new URL(template.origin).host}`;
}

export const OPEN_IN_CONSENT_STORAGE_KEY = 'frost.command-palette.open-in-hosts' as const;
export const OPEN_IN_CONSENT_MAX = 32;
/** The first-use question (`{host}`: the destination host). */
export const OPEN_IN_CONSENT_MESSAGE = 'frost will send this page’s address to {host}.' as const;
export const OPEN_IN_QUERY_NOTE = 'The address includes its query string (the part after “?”), which is sent too.' as const;
export const OPEN_IN_CONFIRM_LABEL = 'Send and open' as const;
export const OPEN_IN_BACK_LABEL = 'Back' as const;

/** Why main did not open a tool (`browser.openTool`), and what the status line says. */
export const OPEN_TOOL_REFUSALS = ['no-page', 'not-public', 'private-address', 'not-opened'] as const;
export type OpenToolRefusal = (typeof OPEN_TOOL_REFUSALS)[number];
export const OPEN_TOOL_REFUSAL_MESSAGES: Readonly<Record<OpenToolRefusal, string>> = {
  'no-page': 'Nothing sent: this tab shows no web page',
  'not-public': 'Nothing sent: this page’s address isn’t public',
  'private-address': 'Nothing sent: this page came from a private network address',
  'not-opened': 'Couldn’t open a tab',
};
/** `browser.openTool`'s answer. */
export type OpenToolResult = { readonly status: 'opened'; readonly tabId: number } | { readonly status: 'refused'; readonly reason: OpenToolRefusal };
/**
 * The longest "Open in" URL offered: `browser.openBackgroundTab`'s cap (equal to
 * `ADDRESS_INPUT_MAX_LENGTH` in `browser.spec.ts`, which the renderer cannot import: Zod).
 */
export const OPEN_IN_URL_MAX_LENGTH = 8_192;

/**
 * The site's own files, opened in a background tab: `path` on the active tab's own origin (scheme,
 * host and port of its `http(s)` URL; never a host from the audit or the page, such as a robots.txt
 * `Sitemap:` line). These are the site itself, not an external tool, so they keep the page's scheme.
 */
export const SITE_FILES = [
  { id: 'robots-txt', label: 'This site’s robots.txt', keywords: ['robots', 'crawl', 'disallow'], path: '/robots.txt' },
  { id: 'sitemap', label: 'This site’s sitemap.xml', keywords: ['sitemap', 'xml', 'urls'], path: '/sitemap.xml' },
] as const satisfies readonly { id: string; label: string; keywords: readonly string[]; path: string }[];
export type SiteFileId = (typeof SITE_FILES)[number]['id'];

/**
 * The palette never makes a network request of its own: no web suggestions, no remote icons, no
 * prefetching of "Open in" targets (`no-remote-calls-from-chrome`, Global Constraints).
 */
export const PALETTE_WEB_SUGGESTIONS = false;
