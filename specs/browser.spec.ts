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

/**
 * Session partition of every tab view. Separate from the app UI's default session: it has no
 * `app:` protocol handler (so browsed content cannot load `app://`), its own cookies/storage, and
 * deny-by-default permissions until per-origin prompts arrive (Task 4).
 */
export const BROWSE_PARTITION = 'persist:frost-browser' as const;

/** Schemes a tab may load or navigate to (parsed, lowercased `URL.protocol`). */
export const BROWSABLE_SCHEMES = ['http:', 'https:'] as const;
export type BrowsableScheme = (typeof BROWSABLE_SCHEMES)[number];

/**
 * Besides `BROWSABLE_SCHEMES`, the only URL a tab may navigate (or be redirected) to: the empty
 * document. Never a typed address-bar result (`about:` input becomes a search).
 */
export const BROWSE_BLANK_URL = 'about:blank' as const;

/**
 * Address-bar input that is not a web address becomes a search: `{q}` is replaced by the trimmed
 * input, `encodeURIComponent`-encoded.
 */
export const SEARCH_URL_TEMPLATE = 'https://www.google.com/search?q={q}' as const;

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
 * values of `HARDENED_WEB_PREFERENCES` plus the browse partition, and **no `preload`** (browsed
 * content never gets the IPC bridge). Exactly these keys: nothing that loosens the view
 * (`webviewTag`, `nodeIntegrationInSubFrames`, `allowRunningInsecureContent` …) may be added
 * without changing this spec.
 */
export const TAB_VIEW_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  partition: BROWSE_PARTITION,
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
  notice: NoticeSchema.nullable(),
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
