import { uuidv7 as defaultUuidv7 } from '@app/db';
import type { ScreenshotKind } from '@app/specs/capture-db.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { CaptureAnswer } from '@app/specs/changes.spec';
import {
  PROJECT_RUN_LIMITS,
  QUERY_DEVICE_PROFILES,
  RUN_RETRY_REFUSALS,
  RUN_SCREENSHOT_KIND,
  type ProjectRunLimits,
  type RunBlockReason,
  type RunScope,
  type RunScreenshotOutcome,
  type RunState,
  type RunStateName,
  type RunTarget,
  type RunTargetKind,
  type RunTargetOutcome,
  type StartRunAnswer,
} from '@app/specs/projects.spec';
import { sameRunSearch, serpFiltersOf } from '@app/specs/rankings-url.spec';
import { sortedJson, type SerpRunVerdict } from '@app/specs/rankings.spec';
import { isDefaultRenderProfile, sameRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import { SERP_DEVICE_OF_PRESET } from '@app/specs/serp.spec';
import type { TakeScreenshotAnswer } from '@app/specs/screenshot.spec';
import { isEngineResultPath, searchParamsForUrl, type SearchParamsOf, type SerpVerdictOf } from './serp-params';
import { storedPageUrl } from './snapshot';

// A project's capture run (Phase 6 Task 6; spec `projects.spec.ts`, `PROJECT_RUN_LIMITS`; acceptance
// `projects.feature.md`, Capture now). One run at a time, app-wide. It visits its targets in ordinary
// browse tabs opened through the browser controller (no WebContents of its own), captures each into
// the project through the changes service, and closes its tab when it is done.
//
// Render profiles: targets are grouped by the profile they need (a page the project's, a mobile or tablet
// query `QUERY_DEVICE_PROFILES`, a desktop query the default). Each group gets a fresh tab whose profile is set once, before its first
// navigation, with no pin; a group needing frost's default gets no profile set at all. The run never
// sets the default profile on a tab (that is a Reset, which also unpins the site the tab shows) and
// never changes a tab's profile after it has loaded. A site's pin still applies in a run tab (pins are
// the user's choice); the capture records the profile actually in effect (the audit's), and the search
// parameters the run tab actually shows: Phase 3's SERP service's for the landed page
// (`searchParamsOf`) for a page, else none; a search target is captured only on a matching ready
// reading.
//
// Search targets (Phase 10 Task 8, plan Decision 10; `projects.feature.md`, Searches in a run). Once a
// search target has landed, before anything is captured: (1) the landed URL must be a result page of
// the target's engine (`searchParamsForUrl` with the bundled pack: a consent page on another host or a
// `/sorry/` challenge path is not), else the run is `blocked` at once (`not-a-result-page`); (2) it
// waits while Phase 3's verdict (`serpVerdictOf`, that tab and page) is `pending`, for up to
// `serpSettleWaitMs` of active time, counted in the target's `targetActiveTimeoutMs`; (3) it captures
// only on `ready` with the tab's own parameters (`searchParamsOf`) for the target's search
// (`sameRunSearch`: engine, host, query, `gl`, `hl`, device, page) with the target URL's filters
// (`serpFiltersOf`), so its reading is filed under the target's search key; (4) anything else blocks
// the run without calling `capture` or `screenshot`: `unreadable`, `not-serp`, `disabled` (`serp-off`),
// another search (`mismatch`), no reading or no parameters (`no-reading`), the target's time running
// out first (`timed-out`), or its tab leaving the landed page before a capture (`not-a-result-page`: a
// consent page put there by script). A blocked run ends `blocked` with its `blockedReason`, the target
// `blocked`, the rest `cancelled`.
// Lead rulings of the Task 8 security review (amending plan Decision 10):
// - a search target whose load fails (an error, a crash: never landed) blocks the run (`load-failed`);
//   a navigation the browse guard refused (never sent) only fails the target;
// - spacing follows **every search navigation that was sent** (`navigate` answered `true`), landed or
//   not, and is kept by the run service across runs (`lastSearchAt`): a run started right after another
//   (Cancel then Check rankings, a rerun after a blocked run) still waits; Cancel and `stop` end the wait
//   at once; it is between targets, outside any target's active time;
// - a **page target whose URL is a result page** (`runSearchOf`: `searchParamsForUrl` reads it) is a
//   search target for the gate and the spacing (its own parameters are what `sameRunSearch` compares),
//   and for the disclosure (`projects.ts`);
// - the landed document (`documentSeq`) is recorded when a search target lands: any other document
//   before its capture or screenshot (a same-URL reload too) stops the run (`not-a-result-page`); the
//   check is not made again.
// Whole-branch review rulings: a **page target on an engine's result path** that is not a result page
// (the pack's `reject` rules: Google `udm=50`, `tbm=isch`, DuckDuckGo `ia=images`) still queries the
// engine (`queriesAnEngine`): disclosed, paced and gated, so it blocks as it lands (`not-a-result-page`);
// a page on an engine's host off its result paths (Google Maps, DuckDuckGo `/about`) is a page; and a
// URL change **within the landed document** (`pushState` / `replaceState`) stops the run only when the
// new URL is not a result page of the target's search (`searchParamsForUrl` + `sameRunSearch`), else
// the target goes on at the new URL (its reading and parameters read again before a capture).
// Page targets that are not result pages keep Phase 6's behaviour: no verdict, no wait, and one that
// times out is `timed-out` while the run goes on.
//
// A run's scope (Phase 10, `projects.feature.md`, Run scope): `searches` visits only the plan's saved
// searches ("Check rankings"); its pages are neither visited nor counted as omitted.
//
// It only acts on its own tab while that tab is the active one: `navigate` acts on the active tab, and
// a capture or a screenshot needs it in front. While the user has another tab in front the run waits,
// and that time does not count against the target. Progress goes out as `RunState`, long-polled.
// Quitting, or a window closing, stops a run with its tab closed at once (`stopRunOnQuit`): the
// session saved then never holds it.

/** A tab as the run reads it (`BrowserState.tabs`). */
export interface RunTab {
  readonly id: number;
  /** The last committed URL. */
  readonly url: string;
  readonly loading: boolean;
  /** Grows with each main-frame document that commits: the run's navigation has landed once it moved. */
  readonly documentSeq: number;
  /** The last main-frame load's failure (`null` once a page commits). */
  readonly error: unknown;
  readonly crashed: boolean;
}

/** What the run needs of the browser controller (`BrowserService`). */
export interface RunBrowser {
  getState(): { readonly activeTabId: number | null; readonly tabs: readonly RunTab[] };
  /** Opens an empty tab and activates it; `null` at the tab limit. */
  newTab(): number | null;
  /** Loads `input` in the **active** tab. */
  navigate(input: string): boolean;
  activateTab(tabId: number): boolean;
  closeTab(tabId: number): boolean;
  /** The tab's own profile; the run calls it only with a non-default profile, on a fresh tab, without `pin`. */
  setRenderProfile(tabId: number, profile: RenderProfile): boolean;
}

/** `changes.capture`'s main-only options a run uses (`pageUrl`: the capture must be of that page). */
export interface RunCaptureOptions {
  readonly projectId: string;
  readonly source: 'project';
  readonly searchParams: SearchParams | null;
  readonly pageUrl?: string;
}

export interface CaptureRunDeps {
  readonly browser: RunBrowser;
  /** `changes.capture` (main's service). */
  readonly capture: (tabId: number, options: RunCaptureOptions) => Promise<CaptureAnswer>;
  /** `screenshots.take` (main's service: `captureId` and `searchParams` link the screenshot to the capture). */
  readonly screenshot: (tabId: number, options: { readonly kind: ScreenshotKind; readonly projectId: string; readonly captureId: string; readonly searchParams: SearchParams | null }) => Promise<TakeScreenshotAnswer>;
  /** Whether the project is still live (checked again as a run starts). */
  readonly isLive?: (projectId: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly uuidv7?: (now?: number) => string;
  /** One line per run event worth keeping (never page text). */
  readonly log?: (message: string) => void;
  readonly limits?: Partial<ProjectRunLimits>;
  /** Called once a run has ended, with its project (retention enforces the project's policy; `retention.ts`). */
  readonly afterRun?: (projectId: string) => void;
  /** Called once a run has ended, with its end state (the capture schedule suspends automatic starts after `blocked`). */
  readonly onEnded?: (ended: RunState) => void;
  /**
   * The run tab's search parameters for the landed page from Phase 3's SERP service (`serp-params.ts`):
   * a page target's capture records them (none: no parameters); a search target needs them (none: `no-reading`).
   */
  readonly searchParamsOf?: SearchParamsOf;
  /**
   * Phase 3's verdict on the run tab's landed page (`serp-params.ts`, `lateSearchParams().verdictOf`:
   * `pending` until it is bound). Required: every caller says how a search target's page is read.
   */
  readonly serpVerdictOf: SerpVerdictOf;
}

/** What one run visits: built by the projects service from the project's rows. */
export interface RunPlan {
  readonly projectId: string;
  /** The project's render profile; `null`: frost's default. */
  readonly profile: RenderProfile | null;
  readonly screenshot: boolean;
  /** Which targets it visits (`RUN_SCOPES`): `all` (the default) or only the `searches`. */
  readonly scope?: RunScope;
  readonly targets: readonly RunPlanTarget[];
}

/** Whether a run of `scope` visits `target`: every target in `all`, only the saved searches in `searches`. */
export function inRunScope(target: Pick<RunPlanTarget, 'kind'>, scope: RunScope): boolean {
  return scope === 'all' || target.kind === 'query';
}

/**
 * The search a target's page is (Task 8 review ruling): a query's saved search; for a page, the
 * search parameters Phase 3 reads from its URL when it is an engine's result page (`searchParamsForUrl`
 * with the bundled pack; the device does not change whether or which engine reads it); else `null`.
 * A target with a search is gated, spaced and needs the disclosure. Never throws.
 */
export function runSearchOf(target: Pick<RunPlanTarget, 'kind' | 'url' | 'searchParams'>): SearchParams | null {
  if (target.kind === 'query') return target.searchParams;
  try {
    return searchParamsForUrl(target.url, 'desktop');
  } catch {
    return null;
  }
}

/**
 * Whether a run loading `target` queries a search engine (whole-branch review ruling, narrowed by the
 * council review): a target with a search (`runSearchOf`), or a page target on one of the bundled pack's
 * engine result paths whatever the pack makes of its parameters (`isEngineResultPath`: e.g. Google
 * `udm=50` or `tbm=isch`, DuckDuckGo `ia=images`, which the pack's `reject` rules refuse as result
 * pages). Such a target is disclosed (`projects.ts`), paced and gated; one without a search is then
 * blocked at once (`not-a-result-page`). Another page on an engine's host is a page. Never throws.
 */
export function queriesAnEngine(target: Pick<RunPlanTarget, 'kind' | 'url' | 'searchParams'>): boolean {
  if (runSearchOf(target) !== null) return true;
  try {
    return target.kind === 'page' && isEngineResultPath(target.url);
  } catch {
    return false;
  }
}

export interface RunPlanTarget {
  readonly kind: RunTargetKind;
  readonly label: string;
  readonly url: string;
  /** A query's saved search parameters (what the landed page's search must be, `sameRunSearch`); `null` for a page. */
  readonly searchParams: SearchParams | null;
}

export interface CaptureRuns {
  /**
   * Starts a run of `plan`: its targets in its scope, those past `maxRunTargets` omitted, the rest
   * visited group by group (`busy` while one is under way; `no-targets` when none is in scope;
   * `not-found` when the project went; `no-tab` when no tab opens).
   */
  start(plan: RunPlan): Promise<StartRunAnswer>;
  /** Cancels the run under way; whether there was one. */
  cancel(): boolean;
  /**
   * Cancels the run under way and closes its tab now, not when its loop next looks (the tab in front
   * before comes back, as at its end): quitting never leaves the run's tab in the saved session.
   */
  stop(): void;
  /** The project of the run under way, else `null`. */
  running(): string | null;
  state(): RunState;
  /**
   * The state once its version exceeds `sinceVersion` (at once if it already does), else the state
   * after `runStateWatchTimeoutMs`. At most `maxPendingRunWatches` wait; one more answers the oldest.
   */
  watch(sinceVersion: number): Promise<RunState>;
}

/** Targets that need one profile (`null`: frost's default, so none is set), in the order they are visited. */
interface RunGroup {
  readonly profile: RenderProfile | null;
  readonly targets: readonly RunPlanTarget[];
}

/**
 * The profile a target needs (`null`: the default): a query's for its own device (a mobile or tablet
 * query's `QUERY_DEVICE_PROFILES`, a desktop query the default, never the project's: Phase 3 reads the
 * device from the profile, and the reading must be of the saved search's device); a page the project's.
 */
function profileFor(target: RunPlanTarget, project: RenderProfile | null): RenderProfile | null {
  const device = target.kind === 'query' ? target.searchParams?.device : undefined;
  const wanted = device === 'mobile' || device === 'tablet' ? QUERY_DEVICE_PROFILES[device] : target.kind === 'query' ? null : project;
  return wanted === null || isDefaultRenderProfile(wanted) ? null : wanted;
}

/** The targets grouped by the profile they need, groups in the order their first target comes. */
export function groupByProfile(targets: readonly RunPlanTarget[], project: RenderProfile | null): RunGroup[] {
  const groups: { profile: RenderProfile | null; targets: RunPlanTarget[] }[] = [];
  for (const target of targets) {
    const profile = profileFor(target, project);
    const group = groups.find((candidate) => (candidate.profile === null ? profile === null : profile !== null && sameRenderProfile(candidate.profile, profile)));
    if (group) group.targets.push(target);
    else groups.push({ profile, targets: [target] });
  }
  return groups;
}

const RETRY: ReadonlySet<string> = new Set(RUN_RETRY_REFUSALS);
/** A load error's identity (the controller hands out fresh objects; compare their text). */
const errorText = (error: unknown): string | null => (error === null || error === undefined ? null : JSON.stringify(error));

type TargetResult = { readonly outcome: RunTargetOutcome; readonly changeCount: number | null; readonly screenshot: RunScreenshotOutcome | null };
/** A target's result (`null`: it was not reached), whether the run ends after it, and why it stopped (`blocked`). */
type Visit = { readonly result: TargetResult | null; readonly end: Extract<RunStateName, 'cancelled' | 'tab-closed' | 'blocked'> | null; readonly blockedReason?: RunBlockReason };
/** What a visit did of its navigation: whether one was sent (`navigate` answered `true`). */
type VisitTrace = { sent: boolean };

export function createCaptureRuns(deps: CaptureRunDeps): CaptureRuns {
  const { browser } = deps;
  const limits: ProjectRunLimits = { ...PROJECT_RUN_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const uuid = deps.uuidv7 ?? defaultUuidv7;
  const log = (message: string): void => deps.log?.(`projects: ${message}`);

  let current: RunState = { version: 1, runId: null, projectId: null, state: 'idle', current: 0, total: 0, omitted: 0, screenshot: false, targets: [], blockedReason: null };
  const waiters: { readonly resolve: (state: RunState) => void; readonly timer: ReturnType<typeof setTimeout> }[] = [];

  /** Publishes a change: a new version, and every waiting poll answered. */
  const publish = (change: Partial<Omit<RunState, 'version'>>): void => {
    current = { ...current, ...change, version: current.version + 1 };
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(current);
    }
  };
  const setTarget = (index: number, change: Partial<RunTarget>): void => {
    publish({ targets: current.targets.map((target, at) => (at === index ? { ...target, ...change } : target)) });
  };
  /** Every target not done yet is `cancelled`. */
  const cancelRest = (): void => {
    publish({ targets: current.targets.map((target) => (target.outcome === 'pending' || target.outcome === 'running' ? { ...target, outcome: 'cancelled' } : target)) });
  };

  type Run = { readonly projectId: string; cancelled: boolean; wake: (() => void) | null; tabId: number | null; readonly previous: number | null };
  /** When the last search navigation was sent, in any run (`null`: none since frost started): the next search waits `querySpacingMs` from it. */
  let lastSearchAt: number | null = null;
  /** The run under way (reserved as soon as one starts): its cancel flag and the wake-up of its current wait. */
  let active: Run | null = null;

  /**
   * Closes the run's tab if it is still open; the tab in front before comes back, but only if the
   * run's tab was the one in front (else the user chose another, and keeps it).
   */
  const closeRunTab = (run: Run): void => {
    const tabId = run.tabId;
    run.tabId = null;
    if (tabId === null) return;
    try {
      const state = browser.getState();
      const open = state.tabs.some((tab) => tab.id === tabId);
      const inFront = state.activeTabId === tabId;
      if (open) browser.closeTab(tabId);
      if (inFront && run.previous !== null && browser.getState().tabs.some((tab) => tab.id === run.previous)) browser.activateTab(run.previous);
    } catch {
      log('the run’s tab could not be closed');
    }
  };

  /** Waits `ms`, or until the run is cancelled. */
  const pause = (run: Run, ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (run.cancelled) return resolve();
      const timer = setTimeout(() => {
        run.wake = null;
        resolve();
      }, ms);
      run.wake = () => {
        clearTimeout(timer);
        run.wake = null;
        resolve();
      };
    });

  /** The run's tab, if it is open, and whether it is the active one. */
  const tabOf = (tabId: number): { tab: RunTab | null; isActive: boolean } => {
    const state = browser.getState();
    return { tab: state.tabs.find((tab) => tab.id === tabId) ?? null, isActive: state.activeTabId === tabId };
  };

  /** Publishes `waiting-for-tab` / `running` as the tab's place changes. */
  const showActive = (isActive: boolean): void => {
    const state: RunStateName = isActive ? 'running' : 'waiting-for-tab';
    if (current.state !== state) publish({ state });
  };

  /** Opens a fresh tab (it becomes the active one) with the group's profile set before anything loads; `null` when none opens. */
  const openTab = (profile: RenderProfile | null): number | null => {
    let tabId: number | null;
    try {
      tabId = browser.newTab();
    } catch {
      return null;
    }
    if (tabId !== null && profile !== null && !browser.setRenderProfile(tabId, profile)) log('a run tab’s render profile could not be set');
    return tabId;
  };

  /** The verdict on the run tab's landed page; `pending` when it cannot be asked. */
  const verdictOf = (tabId: number, landed: string): SerpRunVerdict => {
    try {
      return deps.serpVerdictOf(tabId, landed);
    } catch {
      return 'pending';
    }
  };

  /** The run tab's own search parameters for its landed page (`null`: none, or `landed` is not a storable page). */
  const tabParamsOf = (tabId: number, landed: string | null): SearchParams | null => {
    if (landed === null || deps.searchParamsOf === undefined) return null;
    try {
      return deps.searchParamsOf(tabId, landed);
    } catch {
      return null;
    }
  };

  /** Whether the landed page's URL is a result page of the target's engine (the bundled pack; never throws). */
  const isEngineResultPage = (landed: string | null, target: SearchParams): boolean => {
    if (landed === null) return false;
    try {
      return searchParamsForUrl(landed, target.device)?.engine === target.engine;
    } catch {
      return false;
    }
  };

  /** A verdict other than `ready` or `pending`, as the reason the run stops. */
  const BLOCKED_BY: Readonly<Record<Exclude<SerpRunVerdict, 'ready' | 'pending'>, RunBlockReason>> = { unreadable: 'unreadable', 'not-serp': 'not-a-result-page', disabled: 'serp-off' };

  /** Waits until the run's tab is in front again (`null`), or why it will not be. */
  async function untilActive(run: Run, tabId: number): Promise<Visit['end']> {
    for (;;) {
      if (run.cancelled) return 'cancelled';
      const { tab, isActive } = tabOf(tabId);
      if (tab === null) return 'tab-closed';
      showActive(isActive);
      if (isActive) return null;
      await pause(run, limits.captureRetryMs);
    }
  }

  /**
   * Visits one target in the run's tab. Time counts only from one look at the tab to the next with it
   * in front at both (an await of a capture or a screenshot counts so too: an approximation). A search
   * target is captured only once its landed page passed the gate (the header comment); `trace` says
   * whether its navigation landed.
   */
  async function visit(run: Run, tabId: number, plan: RunPlan, target: RunPlanTarget, index: number, trace: VisitTrace): Promise<Visit> {
    let activeMs = 0;
    let last = now();
    let wasActive = false;
    /** The tab before the run navigated it (`null`: not navigated yet). */
    let before: { readonly seq: number; readonly url: string; readonly error: string | null } | null = null;
    /** The page of the first commit after the navigation (a redirect allowed): the capture must be of it. */
    let landed: string | null = null;
    let sawLoading = false;
    /**
     * The target's search (a query's, or a result page's own on the device of its profile, the project's):
     * `null` for a page that is not one.
     */
    const own = runSearchOf(target);
    const search = own === null || target.kind === 'query' ? own : { ...own, device: SERP_DEVICE_OF_PRESET[profileFor(target, plan.profile)?.device ?? 'none'] };
    /** The target URL's filters (none for a saved search): the landed page must carry the same. */
    const filtersOf = (url: string | null): string => (url === null || search === null ? '' : sortedJson(serpFiltersOf(url, search.engine)));
    /** Gated: a query, a result page, or any page on an engine's result path (one without a search blocks as it lands). */
    const gated = target.kind === 'query' || queriesAnEngine(target);
    /** A search target's document when it landed: another one before its capture or screenshot stops the run. */
    let landedSeq: number | null = null;
    /** A search target's wait for its reading: the active time it started at (`null`: not yet). */
    let settleFrom: number | null = null;
    /** A search target's parameters once its landed page passed the gate (`null`: not yet). */
    let passed: SearchParams | null = null;
    let captured: { readonly captureId: string; readonly changeCount: number | null; readonly searchParams: SearchParams | null } | null = null;
    const failed: Visit = { result: { outcome: 'failed', changeCount: null, screenshot: null }, end: null };
    const done = (screenshot: RunScreenshotOutcome | null, end: Visit['end'] = null): Visit => ({ result: { outcome: 'captured', changeCount: captured!.changeCount, screenshot }, end });
    /** The run stops at this search target, with nothing of its page captured. */
    const blocked = (reason: RunBlockReason): Visit => {
      log(`target ${index + 1}: the run stopped at this search (${reason})`);
      return { result: { outcome: 'blocked', changeCount: null, screenshot: null }, end: 'blocked', blockedReason: reason };
    };
    /**
     * A search target's tab left the document that landed (another URL, or a reload): the run stops
     * (a consent page put there by script). A capture already made of the checked document stays,
     * without its screenshot.
     */
    const movedOn = (): Visit => {
      if (captured === null) return blocked('not-a-result-page');
      log(`target ${index + 1}: the run stopped at this search (not-a-result-page)`);
      return { result: { outcome: 'captured', changeCount: captured.changeCount, screenshot: 'failed' }, end: 'blocked', blockedReason: 'not-a-result-page' };
    };
    /** Whether `page` (the landed document's URL after a same-document change) is still a result page of the target's search. */
    const sameSearchAt = (page: string | null, wanted: SearchParams | null): boolean => {
      if (page === null || wanted === null) return false;
      try {
        const at = searchParamsForUrl(page, wanted.device);
        return at !== null && sameRunSearch(at, wanted);
      } catch {
        return false;
      }
    };
    /** Whether the run's tab still shows the search target's landed document, looked at now (just before a capture or screenshot). */
    const stillLanded = (): boolean => !gated || tabOf(tabId).tab?.documentSeq === landedSeq;

    for (;;) {
      // Cancelled: the run ends here; a capture already made stays, without its screenshot.
      if (run.cancelled) return captured ? done(null, 'cancelled') : { result: null, end: 'cancelled' };
      const { tab, isActive } = tabOf(tabId);
      if (tab === null) return captured ? done('failed', 'tab-closed') : { result: null, end: 'tab-closed' };
      const at = now();
      if (isActive && wasActive) activeMs += Math.max(0, at - last);
      last = at;
      wasActive = isActive;
      showActive(isActive);
      if (!isActive) {
        await pause(run, limits.captureRetryMs);
        continue;
      }
      if (activeMs >= limits.targetActiveTimeoutMs) {
        if (captured) return done('failed');
        // A search target whose time ran out before a capture stops the run; a page target moves on.
        return gated ? blocked('timed-out') : { result: { outcome: 'timed-out', changeCount: null, screenshot: null }, end: null };
      }

      if (before === null) {
        before = { seq: tab.documentSeq, url: tab.url, error: errorText(tab.error) };
        // A navigation the browse guard refuses is never sent: the target fails, and nothing is spaced.
        if (!browser.navigate(target.url)) return failed;
        trace.sent = true;
        await pause(run, limits.captureRetryMs);
        continue;
      }
      if (tab.loading) sawLoading = true;
      // A crash, or a failed load (an error that is new since the navigation, or came after it loaded):
      // a search target's stops the run (a redirect loop, a reset, offline: never a reading).
      if (tab.crashed) return captured ? done('failed') : gated ? blocked('load-failed') : failed;
      const error = errorText(tab.error);
      if (!captured && !tab.loading && error !== null && (sawLoading || error !== before.error || tab.url !== before.url)) {
        log(`target ${index + 1}: the page did not load`);
        return gated ? blocked('load-failed') : failed;
      }
      // Not landed yet (the old document is still there), or still loading: look again shortly.
      if (tab.documentSeq === before.seq || tab.loading) {
        await pause(run, limits.captureRetryMs);
        continue;
      }
      const page = storedPageUrl(tab.url);
      if (landed === null) {
        landed = page;
        landedSeq = tab.documentSeq;
        // 1. A search target's landed URL must be a result page of its engine: at once, before any verdict.
        if (gated && (search === null || !isEngineResultPage(landed, search))) return blocked('not-a-result-page');
      }
      // A search target's page is the document that landed, and only that one (a same-URL reload too): never checked again.
      if (gated && tab.documentSeq !== landedSeq) return movedOn();
      // Moved on since it landed (the user navigated the run's tab, or a page did by script).
      if (page !== landed) {
        if (!gated) {
          log(`target ${index + 1}: its tab moved to another page`);
          return captured ? done('failed') : failed;
        }
        // The same document under another URL (`pushState` / `replaceState`, whole-branch review ruling):
        // still the target's search goes on at the new URL, else the run stops.
        if (!sameSearchAt(page, search)) return movedOn();
        landed = page;
        // Not captured yet: the reading and the tab's parameters are read again for the new URL.
        passed = null;
      }

      if (captured === null && gated && passed === null) {
        // 2. Waits while Phase 3's reading of the landed page is pending (active time, counted in the target's timeout).
        settleFrom ??= activeMs;
        const verdict = verdictOf(tabId, landed!);
        if (verdict === 'pending') {
          if (activeMs - settleFrom < limits.serpSettleWaitMs) {
            await pause(run, limits.captureRetryMs);
            continue;
          }
          return blocked('no-reading');
        }
        if (verdict !== 'ready') return blocked(BLOCKED_BY[verdict]);
        // 3. Only a ready reading of the target's own search, with the tab's own parameters.
        const tabParams = tabParamsOf(tabId, landed);
        if (tabParams === null) return blocked('no-reading');
        // Another device (a pin, a profile not set) or other filters would file the reading under another key.
        if (!sameRunSearch(tabParams, search!) || filtersOf(landed) !== filtersOf(target.url)) return blocked('mismatch');
        passed = tabParams;
      }

      if (captured === null) {
        // A search target: the parameters its gate passed; a page target: the tab's own, else none.
        const searchParams = gated ? passed : tabParamsOf(tabId, landed);
        // The check's reads may take a while: still the document they read, or the run stops.
        if (!stillLanded()) return movedOn();
        const answer = await deps.capture(tabId, { projectId: plan.projectId, source: 'project', searchParams, ...(landed === null ? {} : { pageUrl: landed }) });
        if (answer.status === 'refused') {
          if (answer.reason === 'no-tab') return { result: null, end: 'tab-closed' };
          // The project went while the run was under way: nothing more can be filed in it.
          if (answer.reason === 'no-project') return { result: { outcome: 'failed', changeCount: null, screenshot: null }, end: 'cancelled' };
          if (RETRY.has(answer.reason) || answer.reason === 'not-active') {
            await pause(run, limits.captureRetryMs);
            continue;
          }
          log(`target ${index + 1}: capture refused (${answer.reason})`);
          return failed;
        }
        captured = { captureId: answer.captureId, changeCount: answer.newVersion ? answer.changeCount : 0, searchParams };
        if (!plan.screenshot) return done(null);
        setTarget(index, { outcome: 'running', changeCount: captured.changeCount });
        // Looks at the tab again (cancel, close, in front, still the page) before the screenshot.
        continue;
      }

      if (!stillLanded()) return movedOn();
      let shot: TakeScreenshotAnswer;
      try {
        shot = await deps.screenshot(tabId, { kind: RUN_SCREENSHOT_KIND, projectId: plan.projectId, captureId: captured.captureId, searchParams: captured.searchParams });
      } catch {
        shot = { status: 'refused', reason: 'capture-failed' };
      }
      if (shot.status === 'saved') return done('saved');
      // Cancelled (or stopped, its tab closed) meanwhile: the capture stays, without its screenshot.
      if (run.cancelled) return done(null, 'cancelled');
      // Another tab came to the front meanwhile, or another screenshot of the tab is under way: asked
      // again while the target's time lasts.
      if (shot.reason === 'not-active' || shot.reason === 'busy') {
        await pause(run, limits.captureRetryMs);
        continue;
      }
      log(`target ${index + 1}: screenshot refused (${shot.reason})`);
      return done('failed', shot.reason === 'no-tab' ? 'tab-closed' : null);
    }
  }

  async function execute(run: Run, plan: RunPlan, groups: readonly RunGroup[]): Promise<void> {
    let tabId: number | null = run.tabId;
    let end: RunStateName = 'done';
    let blockedReason: RunBlockReason | null = null;
    let index = 0;
    /**
     * Before a search target, the rest of `querySpacingMs` since the last search navigation sent, in
     * this run or an earlier one (between targets: no target's active time). Whether the run was
     * cancelled meanwhile.
     */
    const spaceBefore = async (target: RunPlanTarget): Promise<boolean> => {
      if (queriesAnEngine(target) && lastSearchAt !== null) {
        const wait = lastSearchAt + limits.querySpacingMs - now();
        if (wait > 0) await pause(run, wait);
      }
      return run.cancelled;
    };
    try {
      groups: for (let g = 0; g < groups.length; g++) {
        if (g > 0) {
          // A search that comes next waits its spacing before the new tab opens (not in front of the user empty).
          if (await spaceBefore(groups[g]!.targets[0]!)) {
            end = 'cancelled';
            break;
          }
          // The last group's tab gives way to the next group's: only with it in front, so a new tab
          // never takes the front from the user.
          const ready = await untilActive(run, tabId!);
          if (ready !== null) {
            end = ready;
            break;
          }
          browser.closeTab(tabId!);
          tabId = openTab(groups[g]!.profile);
          run.tabId = tabId;
          if (tabId === null) {
            log('no tab could be opened for the run');
            end = 'failed';
            break;
          }
        }
        for (const target of groups[g]!.targets) {
          if (await spaceBefore(target)) {
            end = 'cancelled';
            break groups;
          }
          publish({ current: index + 1 });
          setTarget(index, { outcome: 'running' });
          const trace: VisitTrace = { sent: false };
          let visited: Visit;
          try {
            visited = await visit(run, tabId!, plan, target, index, trace);
          } catch (error) {
            log(`target ${index + 1} failed (${error instanceof Error ? error.name : 'unknown error'})`);
            // A browser or capture failure (the gate's own reads never throw): the target failed, as in Phase 6.
            visited = { result: { outcome: 'failed', changeCount: null, screenshot: null }, end: null };
          }
          if (visited.result !== null) setTarget(index, visited.result);
          index += 1;
          // Every search navigation sent spaces the next one, landed or not (one the guard refused does not).
          if (trace.sent && queriesAnEngine(target)) lastSearchAt = now();
          // Cancelled meanwhile (a `stop` also closed its tab): the run was cancelled, whatever the visit met.
          const ended = run.cancelled ? 'cancelled' : visited.end;
          if (ended !== null) {
            end = ended;
            if (ended === 'blocked') blockedReason = visited.blockedReason ?? 'no-reading';
            break groups;
          }
        }
      }
    } finally {
      cancelRest();
      // Its tab goes (if still open; `stop` may have closed it already).
      closeRunTab(run);
      active = null;
      publish({ state: end, blockedReason: end === 'blocked' ? blockedReason : null });
      log(`run ${end}`);
      deps.afterRun?.(run.projectId);
      deps.onEnded?.(current);
    }
  }

  return {
    async start(plan) {
      if (active !== null) return { status: 'refused', reason: 'busy' };
      const inScope = plan.targets.filter((target) => inRunScope(target, plan.scope ?? 'all'));
      const targets = inScope.slice(0, limits.maxRunTargets);
      if (targets.length === 0) return { status: 'refused', reason: 'no-targets' };
      // Reserved at once: one run at a time, while the project is checked again.
      let previous: number | null = null;
      try {
        previous = browser.getState().activeTabId;
      } catch {
        previous = null;
      }
      const run: Run = { projectId: plan.projectId, cancelled: false, wake: null, tabId: null, previous };
      active = run;
      let live = true;
      try {
        live = deps.isLive ? await deps.isLive(plan.projectId) : true;
      } catch {
        live = false;
      }
      if (!live) {
        active = null;
        return { status: 'refused', reason: 'not-found' };
      }
      // Stopped (the app quitting) while the project was checked: no tab is opened for it.
      if (run.cancelled) {
        active = null;
        return { status: 'refused', reason: 'no-tab' };
      }
      const groups = groupByProfile(targets, plan.profile);
      const ordered = groups.flatMap((group) => group.targets);
      const tabId = openTab(groups[0]!.profile);
      run.tabId = tabId;
      const runId = uuid(now());
      const base = { runId, projectId: plan.projectId, current: 0, total: ordered.length, omitted: inScope.length - targets.length, screenshot: plan.screenshot, blockedReason: null };
      const initial = ordered.map((target): RunTarget => ({ kind: target.kind, label: target.label, outcome: 'pending', changeCount: null, screenshot: null }));
      if (tabId === null) {
        active = null;
        publish({ ...base, state: 'failed', targets: initial.map((target) => ({ ...target, outcome: 'cancelled' })) });
        return { status: 'refused', reason: 'no-tab' };
      }
      publish({ ...base, state: 'running', targets: initial });
      void execute(run, plan, groups);
      return { status: 'started', runId };
    },

    cancel() {
      if (active === null) return false;
      active.cancelled = true;
      active.wake?.();
      return true;
    },

    stop() {
      const run = active;
      if (run === null) return;
      run.cancelled = true;
      run.wake?.();
      closeRunTab(run);
    },

    running: () => active?.projectId ?? null,

    state: () => current,

    watch(sinceVersion) {
      if (current.version > sinceVersion || !Number.isSafeInteger(sinceVersion)) return Promise.resolve(current);
      return new Promise((resolve) => {
        // One more than the cap answers the oldest early (the chrome re-polls).
        if (waiters.length >= limits.maxPendingRunWatches) {
          const oldest = waiters.shift()!;
          clearTimeout(oldest.timer);
          oldest.resolve(current);
        }
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            resolve(current);
          }, limits.runStateWatchTimeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

/** What `stopRunOnQuit` needs of Electron's `app` (and of each window it creates). */
export interface QuitEvents {
  on(event: 'before-quit', listener: () => void): unknown;
  on(event: 'browser-window-created', listener: (event: unknown, window: { on(event: 'close', listener: () => void): unknown }) => void): unknown;
}

/**
 * Stops the run under way (its tab closed at once) as the app quits or a window closes, before the
 * session store saves the strip a last time and flushes it (`projects.feature.md`, Quit): on
 * `before-quit`, and on each window's `close`, registered as the window is created so it runs before
 * the browser controller's own `close` listener (which saves the strip).
 */
export function stopRunOnQuit(app: QuitEvents, runs: Pick<CaptureRuns, 'stop'>): void {
  app.on('before-quit', () => runs.stop());
  app.on('browser-window-created', (_event, window) => {
    window.on('close', () => runs.stop());
  });
}
