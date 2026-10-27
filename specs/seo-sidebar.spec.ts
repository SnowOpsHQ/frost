/**
 * The SEO sidebar and its audit states (Phase 2 Task 1; acceptance: `seo-sidebar.feature.md`).
 * Plain values with no imports, so the chrome renderer can use them without bundling Zod (whose eval
 * probe the app's strict Trusted Types CSP blocks). The rule catalog is `seo-rules.spec.ts`; the
 * snapshot and its caps are `seo-snapshot.spec.ts` / `seo-limits.spec.ts`.
 */
import { SEO_CATEGORIES, type SeoCategory } from './seo-rules.spec';

/**
 * `seo.getAudit` answers one of these for a tab:
 * - `pending`: an audit of the tab's current URL is scheduled or running (or the tab is in the
 *   background and will be audited when it is shown);
 * - `ready`: `audit` holds the latest audit of exactly the tab's current URL;
 * - `unavailable`: no audit can be shown; `reason` says why (`SEO_UNAVAILABLE_REASONS`).
 *
 * `url` is the tab's current URL as the chrome shows it (`TabState.url`). An audit is only ever
 * answered for the URL it was taken for (`audit-matches-current-url`).
 */
export const SEO_AUDIT_STATUSES = ['pending', 'ready', 'unavailable'] as const;
export type SeoAuditStatus = (typeof SEO_AUDIT_STATUSES)[number];

/**
 * `seo.rerun` audits a tab again only while it is the **active** tab of the window (background tabs
 * are never audited); for any other tab it answers `false` and does nothing. A run already in flight
 * in the tab is never doubled: the rerun waits for it and then runs once (`audit-runs-coalesce`).
 */
export const RERUN_ACTIVE_TAB_ONLY = true;

/**
 * Why there is no audit. `no-page`: the tab is empty or shows a non-`http(s)` page; `load-error` /
 * `crashed`: the tab shows its error or crash panel; `timeout`: the extractor did not answer
 * within `EXTRACT_TIMEOUT_MS`; `invalid-snapshot`: what it answered does not parse as a snapshot
 * (wrong shape, or over a cap); `extraction-failed`: running it threw; `analysis-timeout`: the
 * analysis worker did not answer within `ANALYSIS_TIMEOUT_MS` (it was terminated); `analysis-failed`:
 * the worker failed (it crashed or could not start); `no-tab`: no open tab has this id.
 */
export const SEO_UNAVAILABLE_REASONS = ['no-page', 'load-error', 'crashed', 'timeout', 'invalid-snapshot', 'extraction-failed', 'analysis-timeout', 'analysis-failed', 'no-tab'] as const;
export type SeoUnavailableReason = (typeof SEO_UNAVAILABLE_REASONS)[number];

/** What the sidebar says for each reason (frost's own strings; page text is never part of them). */
export const SEO_UNAVAILABLE_MESSAGES: Readonly<Record<SeoUnavailableReason, string>> = {
  'no-page': 'Only web pages (http and https) are audited.',
  'load-error': 'This page didn’t load, so there is nothing to audit.',
  crashed: 'This page crashed. Reload it to run the audit again.',
  timeout: 'The page took too long to answer the audit. It may be busy or very large.',
  'invalid-snapshot': 'The page returned data frost could not read safely.',
  'extraction-failed': 'The audit could not read this page.',
  'analysis-timeout': 'This page’s data took too long to analyse. It may hold very large or tangled structured data.',
  'analysis-failed': 'The audit could not analyse this page’s data.',
  'no-tab': 'This tab is gone.',
};

/**
 * The sidebar's panels, in rail order. Only `available` ones can be opened; the others are shown
 * in the rail as disabled "coming soon" items with no status. Overview covers every rule; a panel
 * with `categories` covers the rules of those categories (`seo-rules.spec.ts`), and its rail dot is
 * `error` if any of them fails with severity `error`, `warn` if any fails with `warning`, else
 * `pass` (info findings never colour a dot).
 */
/**
 * On-Page covers every category except the ones with a panel of their own beyond it (Social, Schema, Page Speed,
 * and Indexability's HTTP / robots.txt / hreflang checks). Indexability also covers `indexing` (the
 * robots meta tags), which On-Page shows too.
 */
const OWN_PANEL_CATEGORIES: readonly SeoCategory[] = ['social', 'schema', 'indexability', 'hreflang', 'performance'];
const ON_PAGE_CATEGORIES = SEO_CATEGORIES.filter((category) => !OWN_PANEL_CATEGORIES.includes(category));

export const SEO_PANELS = [
  { id: 'overview', label: 'Overview', available: true, categories: SEO_CATEGORIES },
  { id: 'on-page', label: 'On-Page', available: true, categories: ON_PAGE_CATEGORIES },
  { id: 'links', label: 'Links', available: true, categories: ['links'] },
  { id: 'images', label: 'Images', available: true, categories: ['images'] },
  { id: 'social', label: 'Social', available: true, categories: ['social'] },
  { id: 'schema', label: 'Schema', available: true, categories: ['schema'] },
  { id: 'indexability', label: 'Indexability', available: true, categories: ['indexing', 'indexability', 'hreflang'] },
  { id: 'speed', label: 'Page Speed', available: true, categories: ['performance'] },
  { id: 'compliance', label: 'Compliance', available: false, categories: [] },
] as const satisfies readonly { id: string; label: string; available: boolean; categories: readonly SeoCategory[] }[];
export type SeoPanelId = (typeof SEO_PANELS)[number]['id'];
export const DEFAULT_SEO_PANEL: SeoPanelId = 'overview';

export const PANEL_STATUSES = ['pass', 'warn', 'error'] as const;
export type PanelStatus = (typeof PANEL_STATUSES)[number];

/** Label of an unavailable panel's rail item (also its tooltip, after the panel's name). */
export const COMING_SOON_LABEL = 'Coming soon' as const;

/** How many ranked issues Overview lists before "Show all". */
export const OVERVIEW_TOP_ISSUES = 5;

/**
 * The sidebar docks right of the page area: the panel (`SIDEBAR_PANEL_WIDTH` CSS px) and, at the
 * window's right edge, the rail (`SIDEBAR_RAIL_WIDTH`). Collapsing hides the panel only: the rail
 * stays, with its status dots, and opening a panel from it expands the sidebar again. The page area
 * (and the tab's view laid over it) shrinks and grows to match. In a window too narrow for both,
 * the page area keeps `PAGE_MIN_WIDTH` and the panel gives way (it narrows, its content clipped);
 * the rail always stays. Keep these equal to `styles.css`.
 */
export const SIDEBAR_PANEL_WIDTH = 360;
export const SIDEBAR_RAIL_WIDTH = 48;
export const PAGE_MIN_WIDTH = 320;

/**
 * Toggling: the toolbar's sidebar button, the View menu's "SEO Sidebar" item and its accelerator
 * `Mod+Shift+S` (Cmd on macOS, Ctrl elsewhere). Like the tab shortcuts (`tabs.spec.ts`) the key is
 * also taken from every tab's and the chrome's `before-input-event` and consumed, so a page can
 * neither see nor block it, and one press toggles once. Main cannot reach the chrome's state, so it
 * bumps `BrowserState.toggleSidebarSeq` and the chrome toggles whenever that changes.
 */
export const SIDEBAR_TOGGLE_SHORTCUT = 'Mod+Shift+S' as const;
export const SIDEBAR_TOGGLE_MENU_ID = 'toggle-seo-sidebar' as const;

/**
 * Open / closed persists across launches in the chrome's own `localStorage` (on `app://app`, in the
 * app's default session, never the browse partition), under this key: `'1'` open, `'0'` closed. No
 * value (a fresh profile) means open.
 */
export const SIDEBAR_STORAGE_KEY = 'frost.seo-sidebar.open' as const;
export const SIDEBAR_DEFAULT_OPEN = true;

// ---- Links, Images and Social panels (Phase 2 Task 2; acceptance `seo-panels.feature.md`) -----

/**
 * The Links panel's type filter: every link, or one `LinkKind` (`internal`, `external`, `other`:
 * `seo-snapshot.spec.ts`).
 */
export const LINK_TYPE_FILTERS = ['all', 'internal', 'external', 'other'] as const;
export type LinkTypeFilter = (typeof LINK_TYPE_FILTERS)[number];

/**
 * The `rel` tokens the Links panel flags: each says the link should not pass ranking credit (paid,
 * user-generated, or not vouched for).
 */
export const LINK_REL_FLAGS = ['nofollow', 'sponsored', 'ugc'] as const;
export type LinkRelFlag = (typeof LINK_REL_FLAGS)[number];

/**
 * The rel filter: every link, the links whose `rel` has that token, or `followed`: none of
 * `LINK_REL_FLAGS`.
 */
export const LINK_REL_FILTERS = ['all', ...LINK_REL_FLAGS, 'followed'] as const;
export type LinkRelFilter = (typeof LINK_REL_FILTERS)[number];

/** The longest text search the Links panel sends (longer input is cut in the chrome). */
export const LINK_FILTER_QUERY_MAX_CHARS = 200;

/**
 * Copy as CSV (`seo.copyLinksCsv`): main formats the rows the filter selects from the tab's ready
 * audit (the panel's rows) and writes them with Electron's `clipboard` in main; the chrome never
 * touches the system clipboard (it has no clipboard permission). Columns, in order (header row
 * first), with `\r\n` line ends (RFC 4180):
 * - `URL`: the resolved `href`;
 * - `Anchor text`;
 * - `Type`: `internal`, `external` or `other`;
 * - `Rel`: the `rel` value as read;
 * - `nofollow`, `sponsored`, `ugc`: `yes` or `no`;
 * - `Target`: the `target` attribute (empty when absent).
 *
 * A cell holding `"`, `,`, `\r` or `\n` is quoted, its `"` doubled. A cell starting with one of
 * `CSV_FORMULA_PREFIXES` gets a leading `'` (before quoting), so a spreadsheet opening the file
 * never evaluates page text as a formula.
 */
export const LINKS_CSV_COLUMNS = ['URL', 'Anchor text', 'Type', 'Rel', 'nofollow', 'sponsored', 'ugc', 'Target'] as const;
export const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;

/** The Images panel's filter. */
export const IMAGE_FILTERS = ['all', 'missing-alt', 'no-dimensions', 'oversized', 'lazy-first-viewport'] as const;
export type ImageFilter = (typeof IMAGE_FILTERS)[number];

/**
 * Social previews are drawn by frost from the tags' text, one fallback chain per card, as the apps
 * that draw them read the tags: the large-image card from Open Graph, then the page (`og:title` →
 * `<title>`, `og:description` → meta description, `og:image`); the summary card from the Twitter
 * card tags, then Open Graph, then the page (`twitter:title` → `og:title` → `<title>` …,
 * `twitter:image` → `og:image`). Remote images are never loaded into the
 * chrome (its CSP stays `img-src 'self' data:`): the preview shows a neutral placeholder graphic,
 * and the image's URL and declared size (`og:image:width` × `og:image:height`) as text. A proxied
 * thumbnail (fetched by main through the browse session, size-capped, re-encoded) could come later.
 */
export const SOCIAL_REMOTE_IMAGES = false;

/**
 * Highlight mode (`seo.setHighlight`): `links` outlines every link by type, `headings` every
 * heading by level, `off` removes the overlay. One mode at a time per tab; it is part of the tab's
 * state (`TabState.highlight`) and goes back to `off` when the tab's page changes (a new document,
 * an in-page navigation to another URL, a load error, a crash) and when another tab becomes active.
 * Only the active tab showing a web page can be highlighted.
 */
export const HIGHLIGHT_MODES = ['off', 'links', 'headings'] as const;
export type HighlightMode = (typeof HIGHLIGHT_MODES)[number];

/**
 * The panel whose toggle owns each mode. The chrome turns the overlay off when the sidebar
 * collapses and when the user leaves that panel, so an overlay never stays on the page without the
 * toggle that removes it in view. If the page removes the overlay's host itself, the overlay stops
 * and the tab's mode goes back to `off` too.
 */
export const HIGHLIGHT_PANELS: Readonly<Record<Exclude<HighlightMode, 'off'>, SeoPanelId>> = { links: 'links', headings: 'on-page' };

/**
 * What the overlay draws (frost's own palette): a link's box by kind (a link whose `rel` has
 * `nofollow` is `nofollow` whatever its kind), a heading's by level, each with a small label.
 */
export const HIGHLIGHT_STYLES = {
  internal: { color: '#1f6feb', label: 'int' },
  external: { color: '#d4670c', label: 'ext' },
  nofollow: { color: '#c42b5c', label: 'nofollow' },
  other: { color: '#6b7280', label: 'other' },
  h1: { color: '#7c3aed', label: 'H1' },
  h2: { color: '#2563eb', label: 'H2' },
  h3: { color: '#0d9488', label: 'H3' },
  h4: { color: '#65a30d', label: 'H4' },
  h5: { color: '#ca8a04', label: 'H5' },
  h6: { color: '#9a3412', label: 'H6' },
} as const;
export type HighlightKind = keyof typeof HIGHLIGHT_STYLES;
