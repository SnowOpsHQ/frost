import { uuidv7 as defaultUuidv7 } from '@app/db';
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
import { DEFAULT_RENDER_PROFILE, sameRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import type { TakeScreenshotAnswer } from '@app/specs/screenshot.spec';
import type { ScreenshotKind } from '@app/specs/capture-db.spec';

// A project's capture run (Phase 6 Task 6; spec `projects.spec.ts`, `PROJECT_RUN_LIMITS`; acceptance
// `projects.feature.md`, Capture now). One run at a time, app-wide. It opens an ordinary browse tab
// through the browser controller (no WebContents of its own), visits each target there, captures it
// into the project through the changes service, and closes the tab when it is done. It only ever acts
// on its own tab while that tab is the active one: `navigate` acts on the active tab, and a capture or
// a screenshot needs it in front. While the user has another tab in front the run waits, and that
// time does not count against the target. Progress goes out as `RunState`, long-polled.

/** A tab as the run reads it (`BrowserState.tabs`). */
export interface RunTab {
  readonly id: number;
  readonly loading: boolean;
  /** Grows with each main-frame document that commits: the run's navigation has landed once it moved. */
  readonly documentSeq: number;
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
  /** The tab's own profile (never a site pin); the default profile clears it. */
  setRenderProfile(tabId: number, profile: RenderProfile): boolean;
}

export interface CaptureRunDeps {
  readonly browser: RunBrowser;
  /** `changes.capture` (main's service: `source` and `searchParams` are main-only options). */
  readonly capture: (tabId: number, options: { readonly projectId: string; readonly source: 'project'; readonly searchParams: SearchParams | null }) => Promise<CaptureAnswer>;
  /** `screenshots.take` (main's service: `captureId` and `searchParams` link the screenshot to the capture). */
  readonly screenshot: (tabId: number, options: { readonly kind: ScreenshotKind; readonly projectId: string; readonly captureId: string; readonly searchParams: SearchParams | null }) => Promise<TakeScreenshotAnswer>;
  readonly now?: () => number;
  readonly uuidv7?: (now?: number) => string;
  /** One line per run event worth keeping (never page text). */
  readonly log?: (message: string) => void;
  readonly limits?: Partial<ProjectRunLimits>;
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
  /** Starts a run of `plan` (its targets past `maxRunTargets` are omitted); `busy` while one is under way, `no-tab` when no tab opens. */
  start(plan: RunPlan): StartRunAnswer;
  /** Cancels the run under way; whether there was one. */
  cancel(): boolean;
  /** The project of the run under way, else `null`. */
  running(): string | null;
  state(): RunState;
  /**
   * The state once its version exceeds `sinceVersion` (at once if it already does), else the state
   * after `runStateWatchTimeoutMs`. At most `maxPendingRunWatches` wait; one more answers the oldest.
   */
  watch(sinceVersion: number): Promise<RunState>;
}

const RETRY: ReadonlySet<string> = new Set(RUN_RETRY_REFUSALS);

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

  /** The run under way: its cancel flag and the wake-up of its current wait. */
  let active: { readonly projectId: string; cancelled: boolean; wake: (() => void) | null } | null = null;

  /** Waits `ms`, or until the run is cancelled. */
  const pause = (run: NonNullable<typeof active>, ms: number): Promise<void> =>
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

  /** The run's tab, if it is open. */
  const tabOf = (tabId: number): { tab: RunTab | null; isActive: boolean } => {
    const state = browser.getState();
    return { tab: state.tabs.find((tab) => tab.id === tabId) ?? null, isActive: state.activeTabId === tabId };
  };

  type Visit = { readonly outcome: RunTargetOutcome; readonly changeCount: number | null; readonly screenshot: RunScreenshotOutcome | null } | 'tab-closed' | 'cancelled';

  async function visit(run: NonNullable<typeof active>, tabId: number, plan: RunPlan, target: RunPlanTarget, index: number, applied: { profile: RenderProfile }): Promise<Visit> {
    const wanted = target.searchParams?.device === 'mobile' ? MOBILE_QUERY_PROFILE : (plan.profile ?? DEFAULT_RENDER_PROFILE);
    let activeMs = 0;
    let last = now();
    let wasActive = false;
    /** The tab's document before the run navigated it (`null`: not navigated yet). */
    let before: number | null = null;
    let sawLoading = false;
    for (;;) {
      if (run.cancelled) return 'cancelled';
      const { tab, isActive } = tabOf(tabId);
      if (tab === null) return 'tab-closed';
      const at = now();
      // Only time with the run's tab in front counts (from one look to the next, in front at both).
      if (isActive && wasActive) activeMs += Math.max(0, at - last);
      last = at;
      wasActive = isActive;
      if (!isActive) {
        if (current.state !== 'waiting-for-tab') publish({ state: 'waiting-for-tab' });
        await pause(run, limits.captureRetryMs);
        continue;
      }
      if (current.state !== 'running') publish({ state: 'running' });
      if (activeMs >= limits.targetActiveTimeoutMs) return { outcome: 'timed-out', changeCount: null, screenshot: null };

      if (before === null) {
        // Its profile first (tab-scoped), then the page: both only while the run's tab is the active one.
        if (!sameRenderProfile(applied.profile, wanted)) {
          if (!browser.setRenderProfile(tabId, wanted)) log(`target ${index + 1}: its render profile could not be set`);
          applied.profile = wanted;
        }
        before = tab.documentSeq;
        if (!browser.navigate(target.url)) return { outcome: 'failed', changeCount: null, screenshot: null };
        await pause(run, limits.captureRetryMs);
        continue;
      }
      if (tab.loading) sawLoading = true;
      if (tab.crashed || (sawLoading && !tab.loading && tab.error !== null && tab.error !== undefined)) return { outcome: 'failed', changeCount: null, screenshot: null };
      // Not landed yet (the old document is still there), or still loading: look again shortly.
      if (tab.documentSeq === before || tab.loading) {
        await pause(run, limits.captureRetryMs);
        continue;
      }
      const answer = await deps.capture(tabId, { projectId: plan.projectId, source: 'project', searchParams: target.searchParams });
      if (answer.status === 'refused') {
        if (RETRY.has(answer.reason) || answer.reason === 'not-active') {
          await pause(run, limits.captureRetryMs);
          continue;
        }
        log(`target ${index + 1}: capture refused (${answer.reason})`);
        return { outcome: 'failed', changeCount: null, screenshot: null };
      }
      const changeCount = answer.newVersion ? answer.changeCount : 0;
      if (!plan.screenshot) return { outcome: 'captured', changeCount, screenshot: null };
      setTarget(index, { outcome: 'running', changeCount });
      let shot: TakeScreenshotAnswer;
      try {
        shot = await deps.screenshot(tabId, { kind: RUN_SCREENSHOT_KIND, projectId: plan.projectId, captureId: answer.captureId, searchParams: target.searchParams });
      } catch {
        shot = { status: 'refused', reason: 'capture-failed' };
      }
      if (shot.status === 'refused') log(`target ${index + 1}: screenshot refused (${shot.reason})`);
      return { outcome: 'captured', changeCount, screenshot: shot.status === 'saved' ? 'saved' : 'failed' };
    }
  }

  async function execute(run: NonNullable<typeof active>, plan: RunPlan, tabId: number, previous: number | null): Promise<void> {
    const applied = { profile: DEFAULT_RENDER_PROFILE };
    let end: RunStateName = 'done';
    try {
      for (let index = 0; index < plan.targets.length; index++) {
        publish({ current: index + 1 });
        setTarget(index, { outcome: 'running' });
        let result: Visit;
        try {
          result = await visit(run, tabId, plan, plan.targets[index]!, index, applied);
        } catch (error) {
          log(`target ${index + 1} failed (${error instanceof Error ? error.name : 'unknown error'})`);
          result = { outcome: 'failed', changeCount: null, screenshot: null };
        }
        if (result === 'cancelled' || result === 'tab-closed') {
          end = result === 'tab-closed' ? 'tab-closed' : 'cancelled';
          publish({ targets: current.targets.map((target, at) => (at >= index ? { ...target, outcome: 'cancelled' } : target)) });
          break;
        }
        setTarget(index, result);
      }
    } finally {
      // Its tab goes (if still open), and the tab in front before the run comes back (if still open).
      try {
        const state = browser.getState();
        if (state.tabs.some((tab) => tab.id === tabId)) browser.closeTab(tabId);
        if (previous !== null && browser.getState().tabs.some((tab) => tab.id === previous)) browser.activateTab(previous);
      } catch {
        log('the run’s tab could not be closed');
      }
      active = null;
      publish({ state: end });
      log(`run ${end}`);
    }
  }

  return {
    start(plan) {
      if (active !== null) return { status: 'refused', reason: 'busy' };
      const targets = plan.targets.slice(0, limits.maxRunTargets);
      if (targets.length === 0) return { status: 'refused', reason: 'no-targets' };
      let previous: number | null;
      let tabId: number | null;
      try {
        previous = browser.getState().activeTabId;
        tabId = browser.newTab();
      } catch {
        tabId = null;
        previous = null;
      }
      const runId = uuid(now());
      const base = { runId, projectId: plan.projectId, current: 0, total: targets.length, omitted: plan.targets.length - targets.length, screenshot: plan.screenshot };
      const initial = targets.map((target): RunTarget => ({ kind: target.kind, label: target.label, outcome: 'pending', changeCount: null, screenshot: null }));
      if (tabId === null) {
        publish({ ...base, state: 'failed', targets: initial.map((target) => ({ ...target, outcome: 'cancelled' })) });
        return { status: 'refused', reason: 'no-tab' };
      }
      const run = { projectId: plan.projectId, cancelled: false, wake: null as (() => void) | null };
      active = run;
      publish({ ...base, state: 'running', targets: initial });
      void execute(run, { ...plan, targets }, tabId, previous);
      return { status: 'started', runId };
    },

    cancel() {
      if (active === null) return false;
      active.cancelled = true;
      active.wake?.();
      return true;
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
