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
 * Why there is no audit. `no-page`: the tab is empty or shows a non-`http(s)` page; `load-error` /
 * `crashed`: the tab shows its error or crash panel; `timeout`: the extractor did not answer
 * within `EXTRACT_TIMEOUT_MS`; `invalid-snapshot`: what it answered does not parse as a snapshot
 * (wrong shape, or over a cap); `extraction-failed`: running it threw; `no-tab`: no open tab has
 * this id.
 */
export const SEO_UNAVAILABLE_REASONS = ['no-page', 'load-error', 'crashed', 'timeout', 'invalid-snapshot', 'extraction-failed', 'no-tab'] as const;
export type SeoUnavailableReason = (typeof SEO_UNAVAILABLE_REASONS)[number];

/** What the sidebar says for each reason (frost's own strings; page text is never part of them). */
export const SEO_UNAVAILABLE_MESSAGES: Readonly<Record<SeoUnavailableReason, string>> = {
  'no-page': 'Only web pages (http and https) are audited.',
  'load-error': 'This page didn’t load, so there is nothing to audit.',
  crashed: 'This page crashed. Reload it to run the audit again.',
  timeout: 'The page took too long to answer the audit. It may be busy or very large.',
  'invalid-snapshot': 'The page returned data frost could not read safely.',
  'extraction-failed': 'The audit could not read this page.',
  'no-tab': 'This tab is gone.',
};

/**
 * The sidebar's panels, in rail order. Only `available` ones can be opened; the others are shown
 * in the rail as disabled "coming soon" items with no status. Overview covers every rule; a panel
 * with `categories` covers the rules of those categories (`seo-rules.spec.ts`), and its rail dot is
 * `error` if any of them fails with severity `error`, `warn` if any fails with `warning`, else
 * `pass` (info findings never colour a dot).
 */
export const SEO_PANELS = [
  { id: 'overview', label: 'Overview', available: true, categories: SEO_CATEGORIES },
  { id: 'on-page', label: 'On-Page', available: true, categories: SEO_CATEGORIES },
  { id: 'schema', label: 'Schema', available: false, categories: [] },
  { id: 'indexability', label: 'Indexability', available: false, categories: [] },
  { id: 'speed', label: 'Page Speed', available: false, categories: [] },
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
