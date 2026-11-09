import { AUTO_CAPTURE_AVAILABLE, AUTO_CAPTURE_IDLE_S, AUTO_CAPTURE_RETRY_MS, SCHEDULE_TICK_MS, type AutoStartSuspendedReason } from '@app/specs/capture-schedule.spec';
import type { RunState, StartRunAnswer } from '@app/specs/projects.spec';
import type { CaptureCadence } from '@app/specs/workspace-db.spec';
import type { CaptureRuns } from './capture-run';

// The capture schedule (Phase 10 Task 8, plan Decision 10; spec `capture-schedule.spec.ts`; acceptance
// `projects.feature.md`, Cadence). A cadence is a due notice only: `ProjectSummary.due` (projects.ts)
// is what the list shows. This timer, started by `projects-main.ts` and stopped on quit, is where
// automatic starts would live: with `AUTO_CAPTURE_AVAILABLE` `false` (as shipped) every tick returns at
// once — it reads nothing and never starts a run. With the flag injected (tests only), a tick starts
// the first due project with auto start on (`startRun`: `all`, no screenshots) only when the system has
// been idle `AUTO_CAPTURE_IDLE_S`, a frost window is visible and not minimised, and no run is under way;
// one attempt per project per `AUTO_CAPTURE_RETRY_MS`, whatever came of it; the run is cancelled as soon
// as it waits for its tab (it yields to the user); and once any run ends `blocked`, automatic starts
// are suspended until frost restarts (memory only: persisting it comes before the flag may turn on).
// Task 8 security review rulings: the suspension hooks each run's end (`runEnded`, called by the run
// service as any run ends, manual or automatic), not a sample at a tick; and an automatic start happens
// only when the rank run disclosure was already accepted on this install (`disclosureAccepted`) and
// never opens it (`startRun` is main's `startAutomaticRun`, which answers `declined` instead of asking).

/** A project as the schedule reads it (`projects.list`'s summaries). */
export interface ScheduleProject {
  readonly id: string;
  readonly cadence: CaptureCadence;
  readonly autoCapture: boolean;
  readonly due: boolean;
}

export interface CaptureScheduleDeps {
  /** The live projects with their cadence, auto start and due (`projects.list`). */
  readonly projects: () => Promise<readonly ScheduleProject[]>;
  /** The run service: the run under way, its state (long-polled) and Cancel. */
  readonly runs: Pick<CaptureRuns, 'running' | 'state' | 'watch' | 'cancel'>;
  /** Starts a project's run as frost would start it by itself, never asking (`projects.startAutomaticRun`). */
  readonly startRun: (projectId: string) => Promise<StartRunAnswer>;
  /** Whether the rank run disclosure was already answered Continue on this install (settings; `false` when unreadable). */
  readonly disclosureAccepted: () => Promise<boolean>;
  /** Electron's `powerMonitor` (system idle seconds). */
  readonly powerMonitor: { getSystemIdleTime(): number };
  /** Whether a frost window is visible and not minimised. */
  readonly windowVisible: () => boolean;
  /** Whether automatic starts are offered (default `AUTO_CAPTURE_AVAILABLE`, `false`). */
  readonly autoCaptureAvailable?: boolean;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface CaptureSchedule {
  /** Starts the `SCHEDULE_TICK_MS` timer (once; never again after `stop`). */
  start(): void;
  /** Stops the timer for good (quit): no look and no start after it. */
  stop(): void;
  /** One look (the timer's). Never rejects. */
  tick(): Promise<void>;
  /** Why automatic starts are suspended (`AUTO_START_SUSPENDED_REASONS`), or `null`. */
  suspended(): AutoStartSuspendedReason | null;
  /** Hears every run's end (the run service's `onEnded`): a `blocked` one suspends automatic starts at once. */
  runEnded(ended: RunState): void;
}

const RUNNING: ReadonlySet<RunState['state']> = new Set(['running', 'waiting-for-tab']);

export function createCaptureSchedule(deps: CaptureScheduleDeps): CaptureSchedule {
  const available = deps.autoCaptureAvailable ?? AUTO_CAPTURE_AVAILABLE;
  const now = deps.now ?? Date.now;
  const log = (message: string): void => deps.log?.(`projects: ${message}`);
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let ticking = false;
  let suspended: AutoStartSuspendedReason | null = null;
  /** When each project was last tried automatically. */
  const attempts = new Map<string, number>();

  /** A run that ended `blocked` (anyone's) suspends automatic starts. */
  const runEnded = (state: RunState): void => {
    if (state.state === 'blocked' && suspended === null) {
      suspended = 'blocked';
      log('automatic starts suspended: a run stopped at a search engine’s page');
    }
  };

  /** Follows the automatic run `runId` to its end: cancelled as soon as it waits for its tab (its end is heard by `runEnded`). */
  const follow = async (runId: string): Promise<void> => {
    let state = deps.runs.state();
    while (!stopped && state.runId === runId && RUNNING.has(state.state)) {
      if (state.state === 'waiting-for-tab') {
        log('an automatic run gave way to the user');
        deps.runs.cancel();
      }
      state = await deps.runs.watch(state.version);
    }
  };

  const idleSeconds = (): number => {
    try {
      const idle = deps.powerMonitor.getSystemIdleTime();
      return Number.isFinite(idle) ? idle : 0;
    } catch {
      return 0;
    }
  };

  /** Whether frost may start a run by itself right now (not which one). */
  const free = (): boolean => {
    try {
      return !stopped && suspended === null && deps.runs.running() === null && deps.windowVisible() && idleSeconds() >= AUTO_CAPTURE_IDLE_S;
    } catch {
      return false;
    }
  };

  const tick = async (): Promise<void> => {
    // As shipped: nothing is read and nothing starts.
    if (!available || stopped || ticking) return;
    ticking = true;
    try {
      if (!free()) return;
      // Never asks: without a Continue already given on this install, nothing starts.
      if (!(await deps.disclosureAccepted())) return;
      const at = now();
      const due = (await deps.projects()).find((project) => project.due && project.autoCapture && project.cadence !== 'off' && at - (attempts.get(project.id) ?? Number.NEGATIVE_INFINITY) >= AUTO_CAPTURE_RETRY_MS);
      // Looked again after the read: the user may have started a run, or frost be quitting.
      if (due === undefined || !free()) return;
      attempts.set(due.id, at);
      const answer = await deps.startRun(due.id);
      if (answer.status !== 'started') {
        log(`an automatic run did not start (${answer.reason})`);
        return;
      }
      log('an automatic run started');
      void follow(answer.runId).catch(() => undefined);
    } catch (error) {
      log(`the capture schedule failed (${error instanceof Error ? error.name : 'unknown error'})`);
    } finally {
      ticking = false;
    }
  };

  return {
    start() {
      if (stopped || timer !== null) return;
      timer = setInterval(() => void tick(), SCHEDULE_TICK_MS);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
    suspended: () => suspended,
    runEnded,
  };
}

/** Stops the schedule as the app quits (`before-quit`), with the run under way (`stopRunOnQuit`). */
export function stopScheduleOnQuit(app: { on(event: 'before-quit', listener: () => void): unknown }, schedule: Pick<CaptureSchedule, 'stop'>): void {
  app.on('before-quit', () => schedule.stop());
}
