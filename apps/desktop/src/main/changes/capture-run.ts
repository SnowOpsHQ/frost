import { uuidv7 as defaultUuidv7 } from '@app/db';
import type { ScreenshotKind } from '@app/specs/capture-db.spec';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import type { CaptureAnswer } from '@app/specs/changes.spec';
import {
  MOBILE_QUERY_PROFILE,
  PROJECT_RUN_LIMITS,
  RUN_RETRY_REFUSALS,
  RUN_SCREENSHOT_KIND,
  type ProjectRunLimits,
  type RunScreenshotOutcome,
  type RunState,
  type RunStateName,
  type RunTarget,
  type RunTargetKind,
  type RunTargetOutcome,
  type StartRunAnswer,
} from '@app/specs/projects.spec';
import { isDefaultRenderProfile, sameRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import type { TakeScreenshotAnswer } from '@app/specs/screenshot.spec';
import { storedPageUrl } from './snapshot';

// A project's capture run (Phase 6 Task 6; spec `projects.spec.ts`, `PROJECT_RUN_LIMITS`; acceptance
// `projects.feature.md`, Capture now). One run at a time, app-wide. It visits its targets in ordinary
// browse tabs opened through the browser controller (no WebContents of its own), captures each into
// the project through the changes service, and closes its tab when it is done.
//
// Render profiles: targets are grouped by the profile they need (the project's, or a mobile query's
// `MOBILE_QUERY_PROFILE`). Each group gets a fresh tab whose profile is set once, before its first
// navigation, with no pin; a group needing frost's default gets no profile set at all. The run never
// sets the default profile on a tab (that is a Reset, which also unpins the site the tab shows) and
// never changes a tab's profile after it has loaded. A site's pin still applies in a run tab (pins are
// the user's choice); the capture records the profile actually in effect (the audit's).
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
}

/** What one run visits: built by the projects service from the project's rows. */
export interface RunPlan {
  readonly projectId: string;
  /** The project's render profile; `null`: frost's default. */
  readonly profile: RenderProfile | null;
  readonly screenshot: boolean;
  readonly targets: readonly RunPlanTarget[];
}

export interface RunPlanTarget {
  readonly kind: RunTargetKind;
  readonly label: string;
  readonly url: string;
  /** A query's search parameters (recorded with its capture); `null` for a page. */
  readonly searchParams: SearchParams | null;
}

export interface CaptureRuns {
  /**
   * Starts a run of `plan`: its targets past `maxRunTargets` are omitted, the rest are visited group
   * by group (`busy` while one is under way; `not-found` when the project went; `no-tab` when no tab opens).
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

/** The profile a target needs (`null`: the default): a mobile query's, else the project's. */
function profileFor(target: RunPlanTarget, project: RenderProfile | null): RenderProfile | null {
  const wanted = target.searchParams?.device === 'mobile' ? MOBILE_QUERY_PROFILE : project;
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
/** A target's result (`null`: it was not reached), and whether the run ends after it. */
type Visit = { readonly result: TargetResult | null; readonly end: Extract<RunStateName, 'cancelled' | 'tab-closed'> | null };

export function createCaptureRuns(deps: CaptureRunDeps): CaptureRuns {
  const { browser } = deps;
  const limits: ProjectRunLimits = { ...PROJECT_RUN_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const uuid = deps.uuidv7 ?? defaultUuidv7;
  const log = (message: string): void => deps.log?.(`projects: ${message}`);

  let current: RunState = { version: 1, runId: null, projectId: null, state: 'idle', current: 0, total: 0, omitted: 0, screenshot: false, targets: [] };
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
   * in front at both (an await of a capture or a screenshot counts so too: an approximation).
   */
  async function visit(run: Run, tabId: number, plan: RunPlan, target: RunPlanTarget, index: number): Promise<Visit> {
    let activeMs = 0;
    let last = now();
    let wasActive = false;
    /** The tab before the run navigated it (`null`: not navigated yet). */
    let before: { readonly seq: number; readonly url: string; readonly error: string | null } | null = null;
    /** The page of the first commit after the navigation (a redirect allowed): the capture must be of it. */
    let landed: string | null = null;
    let sawLoading = false;
    let captured: { readonly captureId: string; readonly changeCount: number | null } | null = null;
    const failed: Visit = { result: { outcome: 'failed', changeCount: null, screenshot: null }, end: null };
    const done = (screenshot: RunScreenshotOutcome | null, end: Visit['end'] = null): Visit => ({ result: { outcome: 'captured', changeCount: captured!.changeCount, screenshot }, end });

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
      if (activeMs >= limits.targetActiveTimeoutMs) return captured ? done('failed') : { result: { outcome: 'timed-out', changeCount: null, screenshot: null }, end: null };

      if (before === null) {
        before = { seq: tab.documentSeq, url: tab.url, error: errorText(tab.error) };
        if (!browser.navigate(target.url)) return failed;
        await pause(run, limits.captureRetryMs);
        continue;
      }
      if (tab.loading) sawLoading = true;
      if (tab.crashed) return captured ? done('failed') : failed;
      // A failed load: an error that is new since the navigation (or came after it loaded).
      const error = errorText(tab.error);
      if (!captured && !tab.loading && error !== null && (sawLoading || error !== before.error || tab.url !== before.url)) {
        log(`target ${index + 1}: the page did not load`);
        return failed;
      }
      // Not landed yet (the old document is still there), or still loading: look again shortly.
      if (tab.documentSeq === before.seq || tab.loading) {
        await pause(run, limits.captureRetryMs);
        continue;
      }
      const page = storedPageUrl(tab.url);
      landed ??= page;
      // Moved on since it landed (the user navigated the run's tab): not the target any more.
      if (page !== landed) {
        log(`target ${index + 1}: its tab moved to another page`);
        return captured ? done('failed') : failed;
      }

      if (captured === null) {
        const answer = await deps.capture(tabId, { projectId: plan.projectId, source: 'project', searchParams: target.searchParams, ...(landed === null ? {} : { pageUrl: landed }) });
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
        captured = { captureId: answer.captureId, changeCount: answer.newVersion ? answer.changeCount : 0 };
        if (!plan.screenshot) return done(null);
        setTarget(index, { outcome: 'running', changeCount: captured.changeCount });
        // Looks at the tab again (cancel, close, in front, still the page) before the screenshot.
        continue;
      }

      let shot: TakeScreenshotAnswer;
      try {
        shot = await deps.screenshot(tabId, { kind: RUN_SCREENSHOT_KIND, projectId: plan.projectId, captureId: captured.captureId, searchParams: target.searchParams });
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
    let index = 0;
    try {
      groups: for (let g = 0; g < groups.length; g++) {
        if (g > 0) {
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
          publish({ current: index + 1 });
          setTarget(index, { outcome: 'running' });
          let visited: Visit;
          try {
            visited = await visit(run, tabId!, plan, target, index);
          } catch (error) {
            log(`target ${index + 1} failed (${error instanceof Error ? error.name : 'unknown error'})`);
            visited = { result: { outcome: 'failed', changeCount: null, screenshot: null }, end: null };
          }
          if (visited.result !== null) setTarget(index, visited.result);
          index += 1;
          // Cancelled meanwhile (a `stop` also closed its tab): the run was cancelled, whatever the visit met.
          const ended = run.cancelled ? 'cancelled' : visited.end;
          if (ended !== null) {
            end = ended;
            break groups;
          }
        }
      }
    } finally {
      cancelRest();
      // Its tab goes (if still open; `stop` may have closed it already).
      closeRunTab(run);
      active = null;
      publish({ state: end });
      log(`run ${end}`);
      deps.afterRun?.(run.projectId);
    }
  }

  return {
    async start(plan) {
      if (active !== null) return { status: 'refused', reason: 'busy' };
      const targets = plan.targets.slice(0, limits.maxRunTargets);
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
      const base = { runId, projectId: plan.projectId, current: 0, total: ordered.length, omitted: plan.targets.length - targets.length, screenshot: plan.screenshot };
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
