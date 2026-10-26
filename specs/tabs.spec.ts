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
 * Status-bar notices main raises for things the user asked for but did not get (Task 2: the tab
 * limit). The chrome shows `NOTICE_MESSAGES[kind]` for `NOTICE_DISPLAY_MS` after a notice with a
 * new `seq` arrives.
 */
export const NOTICE_KINDS = ['tab-limit'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export const NOTICE_MESSAGES: Readonly<Record<NoticeKind, string>> = {
  'tab-limit': `Tab limit reached: at most ${MAX_TABS} tabs can be open`,
};
export const NOTICE_DISPLAY_MS = 6_000;

/** Number keys of the tab-switching shortcuts: Cmd/Ctrl+1…8 select that tab, 9 the last tab. */
export const TAB_SHORTCUT_COUNT = 9;
