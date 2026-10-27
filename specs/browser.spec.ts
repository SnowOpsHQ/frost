/**
 * Browser-core contract (design doc §3 "Security model" and §4 Phase 1; Phase 1 Task 1).
 *
 * The app window keeps the chrome (the React UI on `app://app`); each tab is a `WebContentsView`
 * created by the allowlisted factory `createTabView()` (`apps/desktop/src/main/window.ts`) on its
 * own session partition, with no preload. Main owns the browser state (`BrowserController`); the
 * chrome drives it only through the sender-guarded `browser.*` tRPC procedures and long-polls
 * `browser.watch` for changes. Implemented by `apps/desktop/src/main/browser/*` and
 * `packages/ipc-contract/src/router.ts`; acceptance lists: `address-bar.feature.md`,
 * `browser-chrome.feature.md`, `tabs.feature.md` (Task 2), `browse-guard.feature.md` (Task 3).
 */
import { z } from 'zod';
import { MAX_TABS, NOTICE_KINDS } from './tabs.spec';
import { MEDIA_TYPES, PERMISSION_DECISIONS, PROMPTABLE_PERMISSIONS } from './permissions.spec';
import { HIGHLIGHT_MODES } from './seo-sidebar.spec';
import { PALETTE_RETURN_FOCUS } from './command-palette.spec';
import { TabRenderProfileSchema } from './render-profile.schema.spec';
import { BrowserPolishStateShape } from './browser-polish.schema';
import { DEFAULT_SEARCH_ENGINE, searchEngine } from './browser-polish.spec';

/**
 * Session partition of every tab view. Separate from the app UI's default session: it has no
 * `app:` protocol handler (so browsed content cannot load `app://`), its own cookies/storage, and
 * deny-by-default permissions with per-origin prompts (`permissions.spec.ts`, Task 4).
 */
export const BROWSE_PARTITION = 'persist:frost-browser' as const;

// Schemes a tab may load or navigate to, and the shared `http(s)` checks: Zod-free in `web-url.spec.ts`.
export { BROWSABLE_SCHEMES, type BrowsableScheme } from './web-url.spec';

/**
 * Besides `BROWSABLE_SCHEMES`, the only URL a tab may navigate (or be redirected) to: the empty
 * document. Never a typed address-bar result (`about:` input becomes a search).
 */
export const BROWSE_BLANK_URL = 'about:blank' as const;

/**
 * Address-bar input that is not a web address becomes a search: `{q}` is replaced by the trimmed
 * input, `encodeURIComponent`-encoded. The engine is the user's choice from the typed table
 * `SEARCH_ENGINES` (`browser-polish.spec.ts`, Phase 2.5 Task 6); this is the default engine's template.
 */
export const SEARCH_URL_TEMPLATE: string = searchEngine(DEFAULT_SEARCH_ENGINE).template;

/** Longest address-bar input `browser.navigate` accepts (longer input is rejected, not truncated). */
export const ADDRESS_INPUT_MAX_LENGTH = 8_192;

/**
 * Typed hosts loaded over plain `http:` when no scheme is given: `localhost`, the IPv4 loopback
 * block `127.0.0.0/8` (strict dotted quad), `[::1]` and the unspecified address `0.0.0.0`. Every
 * other scheme-less host gets `https:`.
 *
 * Scheme-less hosts are judged **as typed**, before WHATWG parsing (which would expand shorthand
 * IPv4 such as `42` → `0.0.0.42` or `3.14` → `3.0.0.14`): an IPv4 address must be a strict dotted
 * quad (four decimal octets, each ≤ 255, no leading zeros); a domain needs at least two DNS labels
 * and a letter (or punycode) TLD; one trailing dot is allowed. A scheme-less authority containing
 * `@` (userinfo, e.g. `paypal.com@evil.com`) is a search. Port `0` is never accepted. With an
 * explicit `http://` / `https://` any non-empty host is kept (intranet names such as `http://nas/`
 * are never sent to the search engine).
 */
export const LOOPBACK_HTTP_HOSTS = ['localhost', '[::1]', '0.0.0.0'] as const;
export const LOOPBACK_IPV4_PATTERN = /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * `browser.watch({ sinceVersion })` resolves as soon as the controller's state `version` exceeds
 * `sinceVersion`, or after this long with the current state (so a long-poll never hangs forever).
 * The IPC transport imposes no shorter timeout (`ipcRenderer.invoke` has none).
 */
export const WATCH_TIMEOUT_MS = 25_000;

/**
 * At most this many `browser.watch` calls wait at once (there is one chrome page; a reload may
 * briefly leave an old poll behind). A new watch beyond the cap resolves the **oldest** pending one
 * early with the current state. A `sinceVersion` above the current version is clamped to it, so a
 * watch never waits for a version that may never come (the timeout bounds it as well).
 */
export const MAX_PENDING_WATCHES = 4;

/**
 * webPreferences of every tab view, set **explicitly** by `createTabView()`: the four hardened
 * values of `HARDENED_WEB_PREFERENCES` plus the browse partition, **no `preload`** (browsed
 * content never gets the IPC bridge), and `disableDialogs` (a page's `alert` / `confirm` /
 * `prompt` never open a native dialog owned by frost with no origin on it; a deliberate Phase 1
 * limit, `browse-guard.feature.md`). Exactly these keys: nothing that loosens the view
 * (`webviewTag`, `nodeIntegrationInSubFrames`, `allowRunningInsecureContent` …) may be added
 * without changing this spec.
 */
export const TAB_VIEW_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  partition: BROWSE_PARTITION,
  disableDialogs: true,
} as const;

/**
 * Why the tab's last main-frame load failed (`did-fail-load`, `browse-guard.feature.md`): Chromium's
 * net error `code` (negative; never `IGNORED_LOAD_ERROR_CODES`), its short `description`
 * (`ERR_CONNECTION_REFUSED` …) and the URL that failed, without userinfo. Set until a main-frame
 * page commits; while set, the tab's view is hidden and the chrome shows its error panel.
 */
export const LoadErrorSchema = z.strictObject({
  code: z.int().negative(),
  description: z.string(),
  url: z.string(),
});
export type LoadError = z.infer<typeof LoadErrorSchema>;

/**
 * The permission prompt a tab shows (`permissions.feature.md`): the head of that tab's queue.
 * `id` is an opaque, unguessable, single-use UUID (`crypto.randomUUID`); `origin` is the
 * **requesting** frame's serialized origin (`https://example.com`, never the top-level page's when
 * a subframe asked); `topLevelOrigin` the top-level page's origin when it differs (the requester
 * is embedded; the decision is scoped to that pair), else `null`; `mediaTypes` (only for `media`)
 * the devices still to decide, camera first.
 */
export const PermissionPromptSchema = z.strictObject({
  id: z.uuid(),
  origin: z.string(),
  topLevelOrigin: z.string().nullable(),
  permission: z.enum(PROMPTABLE_PERMISSIONS),
  mediaTypes: z.array(z.enum(MEDIA_TYPES)).min(1).max(MEDIA_TYPES.length).optional(),
});
export type PermissionPrompt = z.infer<typeof PermissionPromptSchema>;

/**
 * `browser.answerPermission` input. Answers the prompt the **active** tab shows; an id that is not
 * that prompt's (another tab's, a queued one, an answered, timed-out or unknown one) is a no-op
 * answering `false`. A malformed id or decision is rejected (`BAD_REQUEST`).
 */
export const AnswerPermissionInputSchema = z.strictObject({
  promptId: z.uuid(),
  decision: z.enum(PERMISSION_DECISIONS),
});
export type AnswerPermissionInput = z.infer<typeof AnswerPermissionInputSchema>;

/** One tab as the chrome sees it. An empty tab (nothing loaded yet) has `url === ''`. */
export const TabStateSchema = z.strictObject({
  id: z.int().positive(),
  /** Last committed URL, without userinfo (`user:pass@` is never shown); `''` while the tab is empty. */
  url: z.string(),
  /**
   * Page title (`''` while empty, and for a page without a <title>: Chromium's URL-derived display
   * title is not reported as one).
   */
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  /** The last main-frame load failed (error panel); `null` once a page commits. */
  error: LoadErrorSchema.nullable(),
  /**
   * The tab's renderer is gone (`render-process-gone`): the view is hidden and the chrome shows the
   * crash panel until the next load starts (Reload).
   */
  crashed: z.boolean(),
  /**
   * The page stopped responding (`unresponsive`) and has not responded since (`responsive`); the
   * status bar says so while this tab is active (`UNRESPONSIVE_STATUS`).
   */
  unresponsive: z.boolean(),
  /**
   * The permission prompt this tab shows (the head of its queue), or `null`. The chrome shows it
   * only while the tab is active; a background tab with one gets an indicator in the strip.
   */
  permissionPrompt: PermissionPromptSchema.nullable(),
  /**
   * HTML fullscreen (`permissions.spec.ts`, `fullscreen`): `notice` while the chrome's notice
   * banner shows above the page (`FULLSCREEN_NOTICE_MS`), then `full` (the view covers the whole
   * window); `null` when not fullscreen.
   */
  fullscreen: z.enum(['notice', 'full']).nullable(),
  /**
   * The page's zoom factor (`page-commands.spec.ts`, `ZOOM_FACTORS`; `1` is 100 %, also for an
   * empty tab). Per host in Chromium: tabs on the same host share it.
   */
  zoom: z.number().min(0.25).max(5),
  /**
   * Increases each time the tab's SEO audit changes (`seo-sidebar.spec.ts`: it became pending,
   * ready or unavailable); `0` before its first. The chrome asks `seo.getAudit` again whenever the
   * active tab's `auditVersion` (or URL) changes, so `browser.watch` is what wakes the sidebar.
   */
  auditVersion: z.int().nonnegative(),
  /**
   * Increases by one each time a new main-frame document commits in the tab (`did-navigate`: a
   * navigation, back / forward to another document, and a reload, also of the same URL); `0` before
   * its first. An in-page navigation (`did-navigate-in-page`) does not change it. The chrome uses it
   * as a document's identity where the URL is not one (the Speed panel's poll session).
   */
  documentSeq: z.int().nonnegative(),
  /**
   * The SEO highlight overlay shown on the tab's page (`seo-sidebar.spec.ts`, `HIGHLIGHT_MODES`):
   * `off` unless `seo.setHighlight` turned it on, and `off` again once the page changes or the tab
   * is no longer the active one.
   */
  highlight: z.enum(HIGHLIGHT_MODES),
  /**
   * The tab's render profile (`render-profile.spec.ts`, `TabRenderProfile`): its own, or its site's
   * pin; `null` while it renders as frost does by default. Always shown on the tab, in the status bar
   * and around the page area (`render-profile.feature.md`).
   */
  renderProfile: TabRenderProfileSchema.nullable(),
});
export type TabState = z.infer<typeof TabStateSchema>;

// Tab constants the chrome renderer needs at runtime live in the Zod-free `tabs.spec.ts` (Zod in the
// renderer bundle would trip the app's strict Trusted Types CSP); re-exported here for main.
export * from './tabs.spec';

export const NoticeSchema = z.strictObject({
  /** Increases by one with every notice raised (so the same kind twice is two notices). */
  seq: z.int().positive(),
  kind: z.enum(NOTICE_KINDS),
});
export type Notice = z.infer<typeof NoticeSchema>;

/**
 * The whole browser state of the app window. `version` starts at 1 and increases by one on every
 * change, so `watch({ sinceVersion: 0 })` returns the current state at once. `tabs` is in strip
 * order (left to right) and never empty; `activeTabId` is one of their ids.
 *
 * Main cannot focus a renderer input, so it asks the chrome to: `focusAddressBarSeq` increases by
 * one each time the address bar should take focus (new tab, Cmd/Ctrl+L, switching to an empty tab)
 * and the chrome focuses it whenever the value it last saw changes. `notice` is the latest
 * status-bar notice (`null` until one is raised).
 */
export const BrowserStateSchema = z.strictObject({
  version: z.int().positive(),
  tabs: z.array(TabStateSchema).max(MAX_TABS),
  activeTabId: z.int().positive().nullable(),
  focusAddressBarSeq: z.int().nonnegative(),
  /**
   * Increases by one each time the SEO sidebar should be toggled from main (its menu item and
   * reserved shortcut, `seo-sidebar.spec.ts` `SIDEBAR_TOGGLE_SHORTCUT`); the chrome, which owns
   * whether the sidebar is open, toggles whenever the value it last saw changes.
   */
  toggleSidebarSeq: z.int().nonnegative(),
  /**
   * The SEO devtools drawer (`devtools.spec.ts`, `DEVTOOLS_TOGGLE_SHORTCUT`): increases by one each
   * time main is asked to toggle it (its menu item and reserved shortcut); the chrome, which owns
   * open / closed, toggles whenever the value it last saw changes. Main always sends it; optional
   * only so that states built before the drawer existed (test fixtures) stay valid.
   */
  devtoolsToggleSeq: z.int().nonnegative().optional(),
  /**
   * The command palette (`command-palette.spec.ts`): `seq` increases by one each time main is asked
   * to open it (its menu item and reserved shortcut); the chrome opens it whenever the value it last
   * saw changes (or closes it, if open). `returnFocus` is where keyboard focus was at that request
   * (`PALETTE_RETURN_FOCUS`), so closing the palette can put it back.
   */
  commandPalette: z.strictObject({ seq: z.int().nonnegative(), returnFocus: z.enum(PALETTE_RETURN_FOCUS) }),
  notice: NoticeSchema.nullable(),
  /**
   * The content notes' generation (`seo-content.feature.md`): main raises it by one each time every
   * target query and snippet draft is deleted (Clear Browsing Data with its box ticked, or "Delete
   * all notes"); an open Content panel drops its pending edits and reads its notes again whenever it
   * changes. Main always sends it; optional so that older state fixtures stay valid.
   */
  contentNotesGeneration: z.int().nonnegative().optional(),
  // Browser polish (Phase 2.5 Task 6, `browser-polish.schema.ts`): the active tab's find bar, the
  // History view request, the closed-tab count and the search engine.
  ...BrowserPolishStateShape,
});
export type BrowserState = z.infer<typeof BrowserStateSchema>;

/**
 * `browser.closeTab` / `browser.activateTab` input: an existing tab's id (a positive safe integer;
 * an id that names no open tab is a no-op answering `false`, never an error).
 */
export const TabIdInputSchema = z.strictObject({ tabId: z.int().positive() });
export type TabIdInput = z.infer<typeof TabIdInputSchema>;


/**
 * `browser.setPageBounds` input: the chrome's page area in window content (CSS = DIP) pixels.
 * Finite numbers only (Zod 4's `z.number()` rejects `NaN`/`Infinity`); main rounds them to integers
 * and clamps the rectangle to the window's content size before applying it to the tab view.
 */
export const PageBoundsSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type PageBounds = z.infer<typeof PageBoundsSchema>;

/**
 * `browser.openBackgroundTab` input (Phase 2 Task 2: a link or image in the SEO sidebar): an
 * `http(s)` URL, opened in a new background tab right of the active tab (after the tabs it already
 * opened), the active tab staying active. Any other scheme, an unparsable URL, no window, or
 * `MAX_TABS` (which raises the `tab-limit` notice) opens nothing and answers `null`; otherwise
 * the new tab's id. The URL is loaded as is (no address-bar resolution, no referrer).
 */
export const OpenBackgroundTabInputSchema = z.strictObject({
  url: z.string().min(1).max(ADDRESS_INPUT_MAX_LENGTH),
  /**
   * Whether the new tab starts with the active tab's own render profile (`render-profile.feature.md`,
   * Popups): only for a page of the audited site; tools, help pages, robots.txt and sitemaps leave it
   * out (no profile).
   */
  inherit: z.boolean().optional(),
});
export type OpenBackgroundTabInput = z.infer<typeof OpenBackgroundTabInputSchema>;

/** Window title while a page is shown: `<page title> — frost`; an empty tab shows `APP_WINDOW_TITLE`. */
export const APP_WINDOW_TITLE = 'frost' as const;
export const WINDOW_TITLE_SEPARATOR = ' — ' as const;
/** A longer page title is cut to this many characters (the last one an ellipsis `…`) in the window title. */
export const WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH = 200;

/**
 * `browser.navigate` input: what the user typed (resolved in main by `resolveAddressInput`). The
 * procedure answers `true` if a navigation started, `false` for a no-op (empty input, no tab).
 */
export const NavigateInputSchema = z.strictObject({ input: z.string().max(ADDRESS_INPUT_MAX_LENGTH) });
export type NavigateInput = z.infer<typeof NavigateInputSchema>;

/** `browser.watch` input: the last `version` the chrome has seen (`0` before the first call). */
export const WatchInputSchema = z.strictObject({ sinceVersion: z.int().nonnegative() });
export type WatchInput = z.infer<typeof WatchInputSchema>;
