/**
 * Tab constants (Phase 1 Task 2; acceptance: `tabs.feature.md`). Plain values with no imports, so
 * the chrome renderer can use them without bundling Zod (whose eval probe the app's strict Trusted
 * Types CSP blocks; e2e `boots-under-strict-csp-without-violations`). The schemas that use them
 * are in `browser.spec.ts`, which re-exports this module.
 */

/**
 * Most tabs the window holds at once (`tabs.feature.md`, `max-tabs-enforced`). A new-tab request
 * at the limit is refused (no tab is opened) and raises the `tab-limit` notice.
 */
export const MAX_TABS = 50;

/**
 * A tab's strip label is its page title (trimmed), else its URL's host (with port), else
 * `NEW_TAB_LABEL` (an empty tab, or a URL without a host). Implemented by `tabLabel` in
 * `apps/desktop/src/renderer/tab-label.ts`. Labels never show a favicon: the chrome fetches no
 * page-supplied images (the strip shows a frost-drawn glyph or the loading indicator instead).
 */
export const NEW_TAB_LABEL = 'New Tab' as const;

/**
 * Status-bar notices main raises for things the user asked for but did not get: the tab limit
 * (Task 2) and a cancelled download (Task 3, `browse-guard.feature.md`). The chrome shows
 * `NOTICE_MESSAGES[kind]` for `NOTICE_DISPLAY_MS` after a notice with a new `seq` arrives.
 */
export const NOTICE_KINDS = ['tab-limit', 'download-blocked'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export const NOTICE_MESSAGES: Readonly<Record<NoticeKind, string>> = {
  'tab-limit': `Tab limit reached: at most ${MAX_TABS} tabs can be open`,
  'download-blocked': 'Downloads aren\u2019t supported yet',
};

/**
 * Status-bar text while the **active** tab's page is unresponsive (`TabState.unresponsive`, Task 3):
 * shown for as long as it lasts (not a timed notice), and gone once the page responds again, its
 * renderer is gone, or another tab is shown.
 */
export const UNRESPONSIVE_STATUS = 'This page isn\u2019t responding' as const;
export const NOTICE_DISPLAY_MS = 6_000;

/** Number keys of the tab-switching shortcuts: Cmd/Ctrl+1…8 select that tab, 9 the last tab. */
export const TAB_SHORTCUT_COUNT = 9;

/**
 * Tab shortcuts main reserves (`tabs.feature.md`, Keyboard shortcuts). `Mod` is Cmd on macOS and
 * Ctrl elsewhere; `Ctrl` is Control everywhere; `mac:` entries exist only on macOS. They are menu
 * accelerators (when the chrome or nothing has focus) **and** are taken from every tab's and the
 * chrome's WebContents in `before-input-event`, before the page sees the key, so a page cannot
 * block them; the key is then consumed (`preventDefault`, which also stops the menu accelerator),
 * so one press runs its command once. `Mod+1`…`Mod+8` select that tab, `Mod+9` the last one.
 * The page commands' reserved keys (reload, back / forward, zoom) are `RESERVED_PAGE_SHORTCUTS` in
 * `page-commands.spec.ts`.
 */
export const RESERVED_TAB_SHORTCUTS = {
  'new-tab': ['Mod+T'],
  'close-tab': ['Mod+W'],
  'focus-address-bar': ['Mod+L'],
  'select-tab': ['Mod+1', 'Mod+2', 'Mod+3', 'Mod+4', 'Mod+5', 'Mod+6', 'Mod+7', 'Mod+8'],
  'select-last-tab': ['Mod+9'],
  'next-tab': ['Ctrl+Tab', 'mac:Mod+Shift+]'],
  'previous-tab': ['Ctrl+Shift+Tab', 'mac:Mod+Shift+['],
} as const;
export type TabCommand = keyof typeof RESERVED_TAB_SHORTCUTS;
