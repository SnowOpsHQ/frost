/**
 * Page commands: reload, hard reload, stop, back / forward, zoom, and the page's context menu
 * (Phase 1 usable-browser gaps; acceptance: `page-commands.feature.md`). Plain values with no
 * imports, so the chrome renderer can use them without bundling Zod (whose eval probe the app's
 * strict Trusted Types CSP blocks). Builds on the reserved tab shortcuts in `tabs.spec.ts`.
 * (Phase 11 Task 1: imports of the Zod-free copy keys and export labels only.)
 */
import type { CopyValueKey } from './command-palette.spec';
import { SEO_EXPORT_LABELS, type SeoExportKind } from './seo-exports.spec';

/** What the page commands do; each acts on the **active** tab. */
export const PAGE_COMMANDS = ['reload', 'hard-reload', 'stop', 'back', 'forward', 'zoom-in', 'zoom-out', 'zoom-reset'] as const;
export type PageCommand = (typeof PAGE_COMMANDS)[number];

/**
 * Page shortcuts main reserves, written like `RESERVED_TAB_SHORTCUTS` (`Mod` is Cmd on macOS and
 * Ctrl elsewhere; `mac:` entries only on macOS, `other:` entries only off it; `=` and `-` and
 * digits are physical keys, so `Mod+Shift+=` is `Mod++` on a US layout). Like the tab shortcuts
 * they are menu accelerators **and** taken from every tab's and the chrome's WebContents in
 * `before-input-event`, before the page sees the key, and consumed: a page cannot block or see
 * them, and one press runs once. `hard-reload` reloads ignoring the cache.
 */
export const RESERVED_PAGE_SHORTCUTS = {
  reload: ['Mod+R', 'F5'],
  'hard-reload': ['Mod+Shift+R'],
  back: ['mac:Mod+[', 'other:Alt+Left'],
  forward: ['mac:Mod+]', 'other:Alt+Right'],
  'zoom-in': ['Mod+=', 'Mod+Shift+=', 'Mod+NumpadAdd'],
  'zoom-out': ['Mod+-', 'Mod+NumpadSubtract'],
  'zoom-reset': ['Mod+0', 'Mod+Numpad0'],
} as const satisfies Partial<Record<PageCommand, readonly string[]>>;

/**
 * Page shortcuts that are **not** reserved: application-menu accelerators only, so the page's own
 * handling comes first. Cmd+Left / Cmd+Right are text-editing keys on macOS (start / end of line in
 * a text field), so a page's field keeps them and only an unhandled press goes back / forward.
 * Esc stops loading: taken from a tab's `before-input-event` **without** consuming it (the page
 * still gets its Esc), and only while that tab is loading and not in HTML fullscreen (where Esc
 * leaves fullscreen, `permissions.feature.md`); the menu shows Esc on Stop without registering it
 * as an accelerator, so Esc in the chrome (the address bar, the prompt bar) keeps its own meaning.
 */
export const UNRESERVED_PAGE_SHORTCUTS = {
  back: ['mac:Mod+Left'],
  forward: ['mac:Mod+Right'],
  stop: ['Escape'],
} as const satisfies Partial<Record<PageCommand, readonly string[]>>;

/**
 * Zoom (`zoom-in` / `zoom-out` step through these factors, `zoom-reset` is `1`): clamped to
 * `ZOOM_FACTORS[0]`…the last one, i.e. 25 %…500 % (Chromium's own range). Zoom is **per host**:
 * Chromium's host zoom map (which Electron's `setZoomFactor` uses) applies a tab's zoom to every
 * tab on the same host, now and on later visits, like Chrome (Electron persists it in the browse
 * partition's preferences: a known limit, `page-commands.feature.md`). The status bar shows the
 * active tab's zoom as a percentage while it is not 100 % (`TabState.zoom`).
 */
export const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;
export const DEFAULT_ZOOM = 1;

/** Fixed labels of the page context menu (frost's own strings, never page text). */
export const CONTEXT_MENU_LABELS = {
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  'open-link': 'Open Link in New Tab',
  'copy-link': 'Copy Link Address',
  'open-image': 'Open Image in New Tab',
  'copy-image': 'Copy Image Address',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  'select-all': 'Select All',
  // Phase 11 Task 1 (append-only): the "Copy SEO Data" submenu (`CONTEXT_MENU_COPY_SEO_VALUES`).
  'copy-seo': 'Copy SEO Data',
} as const;
export type ContextMenuItem = keyof typeof CONTEXT_MENU_LABELS | 'search';

/**
 * "Copy SEO Data" (`copy-seo`; Phase 11 Task 1, Decision 1; acceptance `seo-exports.feature.md`,
 * Context menu): a submenu, the menu's last group, shown only when the clicked tab shows an
 * `http(s)` page whose audit is ready. The native menu has no chrome ref, so main builds it from
 * that tab's ready audit at the click and remembers the audit's URL and `takenAt`: an item writes
 * (through main's clipboard, as `seo.copyValue` / `seoExport.copyCsv` would) only if the tab's ready
 * audit is still that one when it is clicked; otherwise nothing is written. It holds the four most
 * used values (`CONTEXT_MENU_COPY_SEO_VALUES`) and the three CSVs (`SEO_EXPORT_KINDS`, images
 * unfiltered); a value the audit lacks (`copyValueOf` is `null`), images when the audit has none,
 * or speed when the audit has no speed report, is shown disabled. Labels are frost's own (`CONTEXT_MENU_COPY_SEO_LABELS`).
 */
export const CONTEXT_MENU_COPY_SEO_VALUES = ['title', 'meta-description', 'h1', 'canonical'] as const satisfies readonly CopyValueKey[];
export type ContextMenuCopySeoValue = (typeof CONTEXT_MENU_COPY_SEO_VALUES)[number];
export const CONTEXT_MENU_COPY_SEO_LABELS: Readonly<Record<ContextMenuCopySeoValue | SeoExportKind, string>> = {
  title: 'Title',
  'meta-description': 'Meta Description',
  h1: 'H1',
  canonical: 'Canonical URL',
  // The CSVs: one spelling, the exports' own labels (`seo-exports.spec.ts`).
  ...SEO_EXPORT_LABELS,
};

/**
 * The one label with page text in it: `Search Google for “<selection>”`. The selection is shown
 * with whitespace runs collapsed to one space, control and bidi-override characters removed, cut
 * to `CONTEXT_MENU_SELECTION_MAX` characters (the last an ellipsis) and `&` doubled (Electron
 * reads a single `&` as a mnemonic off macOS). The search itself uses the whole selection (same
 * clean-up, at most `ADDRESS_INPUT_MAX_LENGTH` characters) only as the query of
 * `SEARCH_URL_TEMPLATE`, in a new background tab.
 */
export const CONTEXT_MENU_SEARCH_LABEL = 'Search Google for “{selection}”' as const;
export const CONTEXT_MENU_SELECTION_MAX = 32;
