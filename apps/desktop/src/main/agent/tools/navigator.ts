import { NAVIGATE_SETTLE_TIMEOUT_MS, PAGE_TITLE_MAX_CHARS } from '@app/specs/agent-page-tools.spec';
import { AGENT_TOOL_INPUT_LIMITS } from '@app/specs/agent-tools.spec';
import { parseWebUrl, webOrigin } from '@app/specs/web-url.spec';
import { resolveAddressInput } from '../../browser/address';
import { clip } from './audit-summary';

// `navigate`'s way into the tab (Phase 5 Task 5; acceptance `specs/agent-page-tools.feature.md`,
// Navigate): the controller's own navigation (`browser.navigate`, the address bar's path, so the
// render profile, the restored-tab bookkeeping and the browse guards on the tab's WebContents all
// apply), then a wait for the load to settle.
//
// The controller navigates only the active tab, so the chat's tab must be the one shown (else
// `not-shown`: nothing loads). With `allowedOrigin` (a standing grant), a main-frame server redirect
// of this navigation that leaves that origin is cancelled (`will-redirect`, `preventDefault()`):
// the tab stays on the page it showed. The watch on redirects starts before the load and ends with
// this navigation (its commit, failure, stop, or the next main-frame navigation), never later, so it
// never touches a navigation the user starts afterwards. Electron 45, checked: a cancelled redirect
// fires no `did-fail-load`, only `did-stop-loading`, and the tab keeps its previous URL.
//
// The cancel is a partial exfiltration guard, not a boundary: a granted site can't bounce the tab
// (and what its URL carries) to another site through a server redirect of the agent's navigation,
// but its own scripts can still send data anywhere.

/** What `navigate` hears from the tab's WebContents (Electron's `WebContents`; tests use an emitter). */
export interface NavigableContents {
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  /** Whether the tab is still loading (Electron's `isLoading()`). */
  isLoading?(): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface NavigateOptions {
  readonly signal: AbortSignal;
  /** A standing grant's origin: a main-frame redirect of this navigation off it is cancelled. */
  readonly allowedOrigin?: string;
}

export type TabNavigation =
  | {
      readonly status: 'done';
      /** What the tab shows now. */
      readonly url: string;
      readonly title: string;
      /** The main frame's HTTP status, when it committed one. */
      readonly httpStatus: number | null;
      /** `false`: the settle timeout passed first. */
      readonly settled: boolean;
      /** The origin a cancelled redirect pointed to (`allowedOrigin` only), else `null`. */
      readonly blockedRedirectTo: string | null;
    }
  /** The chat's tab isn't the one shown, so the controller can't load it there. */
  | { readonly status: 'not-shown' }
  | { readonly status: 'no-tab' }
  /** The controller didn't start it (the URL wouldn't load as itself, no window). */
  | { readonly status: 'refused' }
  | { readonly status: 'aborted' };

export type TabNavigator = (tabId: number, href: string, options: NavigateOptions) => Promise<TabNavigation>;

export interface TabNavigatorDeps {
  /** The controller's active tab and address-bar navigation. */
  readonly browser: { getState(): { readonly activeTabId: number | null }; navigate(input: string): boolean };
  readonly contentsOf: (tabId: number) => NavigableContents | null;
  /** Default `NAVIGATE_SETTLE_TIMEOUT_MS`. */
  readonly settleMs?: number;
}

interface NavigationDetails {
  readonly url?: unknown;
  readonly isMainFrame?: unknown;
  readonly isSameDocument?: unknown;
  preventDefault?(): void;
}

export function createTabNavigator(deps: TabNavigatorDeps): TabNavigator {
  const settleMs = deps.settleMs ?? NAVIGATE_SETTLE_TIMEOUT_MS;
  return async (tabId, href, options) => {
    if (options.signal.aborted) return { status: 'aborted' };
    // The address bar would load exactly this URL (not a search, not a rewritten one).
    const resolved = resolveAddressInput(href);
    if (parseWebUrl(href)?.href !== href || resolved === null || resolved.kind !== 'url' || resolved.url !== href) return { status: 'refused' };
    if (deps.browser.getState().activeTabId !== tabId) return { status: 'not-shown' };

    const allowed = options.allowedOrigin ?? null;
    let contents = deps.contentsOf(tabId);
    if (contents !== null && contents.isDestroyed()) contents = null;

    // ---- The watch on this navigation (attached before the load where the tab has a page) ----
    // `phase`: ours hasn't started (`waiting`), is in flight (`running`: redirects are watched), or
    // has committed, failed, stopped or been replaced (`over`). The listeners go once both it is
    // over and the wait has ended, so a timeout or an abort never lifts the redirect watch early.
    // Electron 45, checked: `did-start-navigation` fires synchronously inside `loadURL`, before it
    // returns, so the listeners must be on before `browser.navigate`; a fragment-only load starts a
    // same-document navigation (`isSameDocument`) and ends with `did-navigate-in-page`.
    let watched: NavigableContents | null = null;
    let phase: 'waiting' | 'running' | 'over' = 'waiting';
    /** Ours is a same-document navigation (only the fragment changes): it ends at `did-navigate-in-page`. */
    let sameDocument = false;
    /** A fresh WebContents was watched only after the load began: ours may not have announced its start yet. */
    let startUnseen = false;
    let waitOver = false;
    let settledEarly = false;
    let httpStatus: number | null = null;
    let blockedRedirectTo: string | null = null;
    let settle: (() => void) | null = null;
    const detachIfDone = () => {
      if (watched === null || !waitOver || phase === 'running') return;
      const from = watched;
      watched = null;
      for (const [event, listener] of listeners) from.removeListener(event, listener);
    };
    /** Ours is over (`phase`); `settled` also ends the wait. */
    const ended = (settled: boolean) => {
      phase = 'over';
      if (settled) {
        if (settle !== null) settle();
        else settledEarly = true;
      }
      detachIfDone();
    };
    const listeners: [string, (...args: any[]) => void][] = [
      [
        'did-start-navigation',
        (details: NavigationDetails) => {
          if (details?.isMainFrame !== true) return;
          if (details.isSameDocument === true) {
            // Ours, if it only moves to `href`'s fragment; the old page's own `pushState` or fragment
            // change while ours is pending is not ours and changes nothing here.
            if (phase === 'waiting' && details.url === href) {
              phase = 'running';
              sameDocument = true;
            }
            return;
          }
          if (phase === 'waiting') phase = 'running';
          else if (phase === 'running' && startUnseen && details.url === href) startUnseen = false;
          else if (phase === 'running') ended(true); // Another main-frame navigation replaced ours.
        },
      ],
      [
        'will-redirect',
        (details: NavigationDetails) => {
          if (allowed === null || phase !== 'running' || sameDocument || details?.isMainFrame !== true) return;
          const target = webOrigin(details.url);
          if (target === allowed) return;
          details.preventDefault?.();
          blockedRedirectTo ??= target ?? 'a non-web address';
        },
      ],
      [
        'did-navigate',
        (_event: unknown, _url: unknown, code: unknown) => {
          if (phase !== 'running' || sameDocument) return;
          httpStatus = typeof code === 'number' && Number.isInteger(code) && code > 0 ? code : null;
          ended(false); // Committed: no redirect can follow; the wait goes on to the load's end.
        },
      ],
      [
        'did-fail-load',
        (_event: unknown, _code: unknown, _description: unknown, _url: unknown, isMainFrame: unknown) => {
          if (phase === 'running' && !sameDocument && isMainFrame === true) ended(false);
        },
      ],
      [
        'did-navigate-in-page',
        (_event: unknown, _url: unknown, isMainFrame: unknown) => {
          // Only ours: an in-page move of the old page while ours is pending ends nothing.
          if (phase === 'running' && sameDocument && isMainFrame === true) ended(true);
        },
      ],
      [
        'did-stop-loading',
        () => {
          // A load that stopped before ours started is the previous one's; while ours is still
          // pending (the tab still loading) a stop is some other load's.
          if (phase === 'waiting') return;
          if (phase === 'running' && !sameDocument && watched?.isLoading?.() === true) return;
          ended(true);
        },
      ],
      ['destroyed', () => ended(true)],
    ];
    const attach = (to: NavigableContents) => {
      watched = to;
      for (const [event, listener] of listeners) to.on(event, listener);
    };

    if (contents !== null) attach(contents);
    let started: boolean;
    try {
      started = deps.browser.navigate(href);
    } catch {
      started = false;
    }
    if (!started) {
      waitOver = true;
      phase = 'over';
      detachIfDone();
      return { status: 'refused' };
    }
    // A tab without a page yet gets its WebContents from the navigation, whose start has already
    // fired inside `loadURL` (or, should an Electron emit it later, is still to come): ours is
    // running from here, and a start for `href` still to come is taken as ours, not as a replacement.
    if (contents === null) {
      contents = deps.contentsOf(tabId);
      if (contents === null || contents.isDestroyed()) return { status: 'no-tab' };
      phase = 'running';
      startUnseen = true;
      attach(contents);
    }
    const live = contents;

    const outcome = await new Promise<'settled' | 'timeout' | 'aborted'>((resolve) => {
      const finish = (how: 'settled' | 'timeout' | 'aborted') => {
        if (waitOver) return;
        waitOver = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        settle = null;
        resolve(how);
        detachIfDone();
      };
      const onAbort = () => finish('aborted');
      const timer = setTimeout(() => finish('timeout'), settleMs);
      settle = () => finish('settled');
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (settledEarly) finish('settled');
    });
    if (outcome === 'aborted') return { status: 'aborted' };
    if (live.isDestroyed()) return { status: 'no-tab' };
    return {
      status: 'done',
      url: clip(live.getURL(), AGENT_TOOL_INPUT_LIMITS.maxUrlChars),
      title: clip(live.getTitle(), PAGE_TITLE_MAX_CHARS),
      httpStatus,
      settled: outcome === 'settled',
      blockedRedirectTo,
    };
  };
}
