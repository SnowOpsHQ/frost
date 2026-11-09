// Spec: specs/capture-schedule.spec.ts (AUTO_CAPTURE_AVAILABLE, CAPTURE_CADENCE_MS, isDue, SCHEDULE_TICK_MS,
// AUTO_CAPTURE_IDLE_S, AUTO_CAPTURE_RETRY_MS, AUTO_START_SUSPENDED_REASONS), specs/projects.spec.ts (ProjectSummary.due,
// PROJECT_REFUSALS `unavailable`), specs/workspace-db.spec.ts (CAPTURE_CADENCES)
// Acceptance: specs/projects.feature.md (Cadence, with the Task 8 security review's rulings; Scenario: cadence)
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChangeIntelRepository, Project, ProjectWorkspace } from '@app/db';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { AUTO_CAPTURE_AVAILABLE, AUTO_CAPTURE_IDLE_S, AUTO_CAPTURE_RETRY_MS, AUTO_START_SUSPENDED_REASONS, CAPTURE_CADENCE_MS, SCHEDULE_TICK_MS, isDue } from '@app/specs/capture-schedule.spec';
import type { RunState, StartRunAnswer } from '@app/specs/projects.spec';
import type { CaptureCadence } from '@app/specs/workspace-db.spec';
import { createCaptureSchedule, stopScheduleOnQuit, type CaptureScheduleDeps, type ScheduleProject } from '../capture-schedule';
import type { CaptureRuns } from '../capture-run';
import { createProjectsService } from '../projects';

const P1 = '01920000-0000-7000-8000-0000000000a1';
const P2 = '01920000-0000-7000-8000-0000000000a2';
const RUN = '01920000-0000-7000-8000-0000000000f1';
const DAY = CAPTURE_CADENCE_MS.daily;
const T0 = Date.UTC(2026, 10, 9, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const IDLE_STATE: RunState = { version: 1, runId: null, projectId: null, state: 'idle', current: 0, total: 0, omitted: 0, screenshot: false, targets: [], blockedReason: null };

/** The run service as the schedule sees it: one run at a time, its state long-polled. */
function fakeRuns() {
  let state = IDLE_STATE;
  const waiters: ((state: RunState) => void)[] = [];
  const set = (change: Partial<RunState>): void => {
    state = { ...state, ...change, version: state.version + 1 };
    for (const waiter of waiters.splice(0)) waiter(state);
  };
  const active = () => state.state === 'running' || state.state === 'waiting-for-tab';
  const runs = {
    running: vi.fn(() => (active() ? state.projectId : null)),
    state: vi.fn(() => state),
    watch: vi.fn((since: number) => (state.version > since ? Promise.resolve(state) : new Promise<RunState>((resolve) => waiters.push(resolve)))),
    cancel: vi.fn(() => {
      if (!active()) return false;
      set({ state: 'cancelled' });
      return true;
    }),
  } satisfies Pick<CaptureRuns, 'running' | 'state' | 'watch' | 'cancel'>;
  return { runs, set, current: () => state };
}

/**
 * A schedule over fakes: projects whose `due` follows `isDue` from their last run (a run that ends sets
 * it), a system idle for a long while, a visible window, and the flag as given.
 */
function setup(options: { autoCaptureAvailable?: boolean; projects?: { id: string; cadence: CaptureCadence; autoCapture: boolean }[] } = {}) {
  const fake = fakeRuns();
  const lastRunAt = new Map<string, number>();
  const rows = options.projects ?? [{ id: P1, cadence: 'daily', autoCapture: true }];
  const env = { idle: AUTO_CAPTURE_IDLE_S * 2, visible: true, accepted: true };
  const projects = vi.fn(async (): Promise<ScheduleProject[]> => rows.map((row) => ({ ...row, due: isDue(lastRunAt.get(row.id) ?? null, row.cadence, Date.now()) })));
  const startRun = vi.fn(async (projectId: string): Promise<StartRunAnswer> => {
    if (fake.runs.running() !== null) return { status: 'refused', reason: 'busy' };
    fake.set({ runId: RUN, projectId, state: 'running', blockedReason: null });
    return { status: 'started', runId: RUN };
  });
  /** Ends the run under way (its project ran now); the run service tells the schedule, as `onEnded` does in main. */
  const end = (state: 'done' | 'blocked' | 'cancelled' = 'done') => {
    const projectId = fake.current().projectId;
    if (projectId !== null && state !== 'cancelled') lastRunAt.set(projectId, Date.now());
    fake.set({ state, blockedReason: state === 'blocked' ? 'not-a-result-page' : null });
    schedule.runEnded(fake.current());
  };
  const log = vi.fn((_message: string) => undefined);
  const deps: CaptureScheduleDeps = {
    projects,
    runs: fake.runs,
    startRun,
    disclosureAccepted: vi.fn(async () => env.accepted),
    powerMonitor: { getSystemIdleTime: () => env.idle },
    windowVisible: () => env.visible,
    log,
    ...(options.autoCaptureAvailable === undefined ? {} : { autoCaptureAvailable: options.autoCaptureAvailable }),
  };
  const schedule = createCaptureSchedule(deps);
  return { schedule, ...fake, projects, startRun, end, env, lastRunAt, log, disclosureAccepted: deps.disclosureAccepted };
}

const tick = (count = 1) => vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * count);

describe('cadence: a due notice only', () => {
  test('due-after-cadence', () => {
    // Never run: due at once.
    expect(isDue(null, 'daily', T0)).toBe(true);
    expect(isDue(null, 'weekly', T0)).toBe(true);
    // Due once a whole cadence passed since the last run.
    expect(isDue(T0, 'daily', T0 + DAY - 1)).toBe(false);
    expect(isDue(T0, 'daily', T0 + DAY)).toBe(true);
    expect(isDue(T0, 'weekly', T0 + DAY * 6)).toBe(false);
    expect(isDue(T0, 'weekly', T0 + CAPTURE_CADENCE_MS.weekly)).toBe(true);
    expect(CAPTURE_CADENCE_MS).toEqual({ daily: 86_400_000, weekly: 604_800_000 });
    // A last run in the future (the clock moved back) is not due.
    expect(isDue(T0 + DAY, 'daily', T0)).toBe(false);
  });

  test('off-is-never-due', () => {
    expect(isDue(null, 'off', T0)).toBe(false);
    expect(isDue(0, 'off', T0 + CAPTURE_CADENCE_MS.weekly * 100)).toBe(false);
    // Anything that is not a cadence is never due either.
    expect(isDue(null, 'hourly' as CaptureCadence, T0)).toBe(false);
    expect(isDue(null, '__proto__' as CaptureCadence, T0)).toBe(false);
  });

  test('no-backfill-after-sleep', async () => {
    // Asleep for a month: one notice, not thirty.
    expect(isDue(T0, 'daily', T0 + DAY * 30)).toBe(true);
    // With automatic starts injected: waking up starts one run, and the next is a whole cadence after it.
    const { schedule, startRun, end } = setup({ autoCaptureAvailable: true });
    schedule.start();
    await tick();
    expect(startRun).toHaveBeenCalledOnce();
    end();
    vi.setSystemTime(Date.now() + DAY * 30);
    await tick(5);
    expect(startRun).toHaveBeenCalledTimes(2);
    end();
    await tick(10);
    expect(startRun).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  test('defaults-never-start-a-run', async () => {
    expect(AUTO_CAPTURE_AVAILABLE).toBe(false);
    // The schedule with the shipped flag: a due project with auto start stored on (a tampered row), the
    // system idle and the window in front: it never starts a run, nor even reads the projects.
    const { schedule, startRun, projects, runs } = setup({ projects: [{ id: P1, cadence: 'daily', autoCapture: true }] });
    schedule.start();
    await tick(60 * 24 * 2);
    expect(startRun).not.toHaveBeenCalled();
    expect(projects).not.toHaveBeenCalled();
    expect(runs.cancel).not.toHaveBeenCalled();
    schedule.stop();

    // The projects service: a due project shows "due"; `setAutoCapture` is `unavailable` and stores nothing.
    const project: Project = { id: P1, name: 'Guides', renderProfileJson: null, retention: { mode: 'forever', value: null }, createdAt: 1, updatedAt: 1 };
    const unfiled = { ...project, id: UNFILED_PROJECT_ID, name: 'Unfiled', createdAt: 0 } as Project;
    const workspace = (projectId: string, cadence: CaptureCadence): ProjectWorkspace => ({ projectId, favorite: false, siteDomain: null, siteSubdomains: true, cadence, autoCapture: false });
    const setProjectAutoCapture = vi.fn(async () => true);
    const store = {
      projects: async () => [unfiled, project],
      project: async (id: string) => (id === P1 ? project : null),
      // Unfiled's row says daily (tampered): Unfiled is never due.
      projectWorkspaces: async () => [workspace(UNFILED_PROJECT_ID, 'daily'), workspace(P1, 'daily')],
      projectsLastCapturedAt: async () => new Map<string, number>(),
      lastProjectRunAt: async (id: string) => (id === P1 ? T0 - DAY * 3 : null),
      setProjectAutoCapture,
    } as unknown as ChangeIntelRepository;
    const service = createProjectsService({
      store,
      files: { unlink: async () => true, lock: async () => () => undefined, fileFor: () => '' },
      confirmDelete: async () => false,
      confirmRankRun: async () => true,
      settings: { rankRunDisclosureAccepted: async () => true, setRankRunDisclosureAccepted: async () => true },
      activeUrl: () => null,
      runs: { ...fakeRuns().runs, start: vi.fn(), stop: vi.fn() } as unknown as CaptureRuns,
    });
    const listed = (await service.list()).projects;
    expect(listed.find((p) => p.id === P1)).toMatchObject({ cadence: 'daily', autoCapture: false, due: true });
    expect(listed.find((p) => p.id === UNFILED_PROJECT_ID)).toMatchObject({ cadence: 'off', due: false });
    expect(await service.setAutoCapture(P1, true)).toEqual({ status: 'refused', reason: 'unavailable' });
    expect(await service.setAutoCapture(P1, false)).toEqual({ status: 'refused', reason: 'unavailable' });
    expect(setProjectAutoCapture).not.toHaveBeenCalled();
  });
});

describe('automatic starts (the flag injected; never shipped on)', () => {
  test('auto-start-needs-idle-visible-and-free', async () => {
    const { schedule, startRun, env, set, end } = setup({ autoCaptureAvailable: true });
    schedule.start();
    // The user is at the computer: not idle long enough.
    env.idle = AUTO_CAPTURE_IDLE_S - 1;
    await tick(3);
    expect(startRun).not.toHaveBeenCalled();
    // Idle, but no visible window (hidden or minimised).
    env.idle = AUTO_CAPTURE_IDLE_S;
    env.visible = false;
    await tick(3);
    expect(startRun).not.toHaveBeenCalled();
    // Idle and visible, but a run is under way (the user's).
    env.visible = true;
    set({ runId: RUN, projectId: P2, state: 'running' });
    await tick(3);
    expect(startRun).not.toHaveBeenCalled();
    // All three: the due project starts, once, as frost would start it.
    set({ state: 'done' });
    await tick();
    expect(startRun).toHaveBeenCalledExactlyOnceWith(P1);
    end();
    // A project that is not due, or whose auto start is off, never starts.
    const other = setup({ autoCaptureAvailable: true, projects: [{ id: P1, cadence: 'off', autoCapture: true }, { id: P2, cadence: 'daily', autoCapture: false }] });
    other.schedule.start();
    await tick(10);
    expect(other.startRun).not.toHaveBeenCalled();
    other.schedule.stop();
    schedule.stop();
  });

  test('one-auto-attempt-per-retry-window', async () => {
    const { schedule, startRun, end } = setup({ autoCaptureAvailable: true });
    // The first attempt does not start (no tab could be opened).
    startRun.mockResolvedValueOnce({ status: 'refused', reason: 'no-tab' });
    schedule.start();
    await tick();
    expect(startRun).toHaveBeenCalledOnce();
    // Still due, still idle: no second attempt within the window.
    await tick(Math.floor(AUTO_CAPTURE_RETRY_MS / SCHEDULE_TICK_MS) - 2);
    expect(startRun).toHaveBeenCalledOnce();
    await tick(2);
    expect(startRun).toHaveBeenCalledTimes(2);
    // A run cancelled by the user counts as its attempt too.
    end('cancelled');
    await tick(10);
    expect(startRun).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  test('auto-run-yields-to-the-user', async () => {
    const { schedule, startRun, runs, set, current } = setup({ autoCaptureAvailable: true });
    schedule.start();
    await tick();
    expect(startRun).toHaveBeenCalledOnce();
    // The user brings another tab to the front: the run waits for its tab, and is cancelled at once.
    set({ state: 'waiting-for-tab' });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.cancel).toHaveBeenCalledOnce();
    expect(current().state).toBe('cancelled');
    // A run the user started is never cancelled by the schedule.
    set({ runId: '01920000-0000-7000-8000-0000000000f2', projectId: P2, state: 'running' });
    set({ state: 'waiting-for-tab' });
    await tick(3);
    expect(runs.cancel).toHaveBeenCalledOnce();
    schedule.stop();
  });

  test('auto-start-suspended-after-blocked', async () => {
    expect(AUTO_START_SUSPENDED_REASONS).toEqual(['blocked']);
    const { schedule, startRun, end } = setup({ autoCaptureAvailable: true, projects: [{ id: P1, cadence: 'daily', autoCapture: true }, { id: P2, cadence: 'daily', autoCapture: true }] });
    schedule.start();
    expect(schedule.suspended()).toBeNull();
    await tick();
    expect(startRun).toHaveBeenCalledExactlyOnceWith(P1);
    // The run met a challenge: suspended at its end, not at a later tick; no more automatic starts (until frost restarts), though P2 is due.
    end('blocked');
    expect(schedule.suspended()).toBe('blocked');
    await tick(Math.ceil((AUTO_CAPTURE_RETRY_MS * 2) / SCHEDULE_TICK_MS));
    expect(startRun).toHaveBeenCalledOnce();
    schedule.stop();
    // A run the user started that ends blocked suspends them too, as it ends (heard from the run service).
    const other = setup({ autoCaptureAvailable: true });
    other.schedule.start();
    other.set({ runId: RUN, projectId: P2, state: 'running' });
    other.set({ state: 'blocked', blockedReason: 'unreadable' });
    other.schedule.runEnded(other.current());
    expect(other.schedule.suspended()).toBe('blocked');
    await tick(3);
    expect(other.startRun).not.toHaveBeenCalled();
    // A run that ends otherwise suspends nothing.
    const fine = setup({ autoCaptureAvailable: true });
    fine.schedule.runEnded({ ...fine.current(), state: 'cancelled' });
    fine.schedule.runEnded({ ...fine.current(), state: 'done' });
    expect(fine.schedule.suspended()).toBeNull();
    other.schedule.stop();
  });

  // Task 8 security review ruling: an automatic start never opens the disclosure; without a Continue given, nothing starts.
  test('auto-start-needs-the-disclosure-accepted', async () => {
    const { schedule, startRun, env, disclosureAccepted } = setup({ autoCaptureAvailable: true });
    env.accepted = false;
    schedule.start();
    await tick(5);
    expect(disclosureAccepted).toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
    env.accepted = true;
    await tick();
    expect(startRun).toHaveBeenCalledExactlyOnceWith(P1);
    schedule.stop();
  });

  test('schedule-stops-on-quit', async () => {
    const app = new EventEmitter();
    const { schedule, startRun, end, projects } = setup({ autoCaptureAvailable: true });
    stopScheduleOnQuit(app as never, schedule);
    schedule.start();
    // Starting twice keeps one timer.
    schedule.start();
    await tick();
    expect(startRun).toHaveBeenCalledOnce();
    end();
    vi.setSystemTime(Date.now() + DAY * 2);
    app.emit('before-quit');
    const reads = projects.mock.calls.length;
    await tick(10);
    // Stopped: no look, no start, and it never starts again.
    expect(projects).toHaveBeenCalledTimes(reads);
    expect(startRun).toHaveBeenCalledOnce();
    schedule.start();
    await tick(3);
    expect(startRun).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
