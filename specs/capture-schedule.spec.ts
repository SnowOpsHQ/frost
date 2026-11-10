/**
 * A project's capture cadence (Phase 10 Task 8, plan Decision 10; acceptance `projects.feature.md`,
 * Cadence). Plain values and types with no Zod, so the chrome renderer can use them; storage is
 * `ci_projects.capture_cadence` and `auto_capture` (`workspace-db.spec.ts`, `CAPTURE_CADENCES`).
 *
 * A cadence is a **due notice only**: while frost is open, a project whose cadence is on and whose last
 * run is a cadence old (or that never ran) shows "Due" with Capture now. Missed periods are never
 * back-filled: a project is due once, however long frost was closed or the computer asleep. Starting
 * runs automatically is behind `AUTO_CAPTURE_AVAILABLE`, `false` in this phase: the "Start
 * automatically" switch is not shown, `projects.setAutoCapture` answers `unavailable`, and the
 * scheduler (main's `capture-schedule.ts`) never starts a run. Its gated logic is specified and tested
 * with the flag injected: a due project with auto start on starts (`scope: 'all'`, no screenshots)
 * only when the system has been idle at least `AUTO_CAPTURE_IDLE_S`, a frost window is visible and not
 * minimised and no run is under way; at most one attempt per project per `AUTO_CAPTURE_RETRY_MS`; the
 * run is cancelled as soon as it waits for its tab (the user brought another tab to the front: it
 * yields to the user); and after any run ends `blocked`, automatic starts are suspended
 * (`AUTO_START_SUSPENDED_REASONS`) until frost restarts (memory only in this phase: turning the flag
 * on first requires persisting it). Lead rulings of the Task 8 security review (amending plan
 * Decision 10): the suspension is heard as each run ends (manual or automatic), not sampled at a tick;
 * and an automatic start happens only with the rank run disclosure already accepted on this install,
 * never opening it. No login item, no background process, no server.
 *
 * The cadence itself and "Check rankings" ship only with the owner's written L1 note (plan Decision
 * 10, legal gate): until then `RANK_CHECK_AVAILABLE` is `false` and none of it is offered (below).
 */
import type { CaptureCadence } from './workspace-db.spec';

export type { CaptureCadence } from './workspace-db.spec';

/** Whether frost may ever start a run by itself. A lead decision after open question 1; `false`. */
export const AUTO_CAPTURE_AVAILABLE = false as boolean;

/**
 * Whether "Check rankings" and the cadence / Due notice are offered (plan Decision 10, legal gate L1).
 * While `false`: the Overview's "Check rankings" button, the palette's "Check rankings now", the
 * Settings view's cadence section and the list's "Due" label are not shown; `projects.setCadence`
 * answers `unavailable` in main (nothing stored, whatever the renderer sends); and every
 * `ProjectSummary.due` is `false`, so the scheduler never sees a due project. Capture now on a project
 * with saved searches is unaffected (still disclosed, paced and stopped at a challenge).
 * Flip to `true` only in the same change that adds the owner's written L1 note under `docs/research/`.
 */
export const RANK_CHECK_AVAILABLE = false as boolean;

/** How long after a project's last run its cadence makes it due again (`off`: never). */
export const CAPTURE_CADENCE_MS: Readonly<Record<Exclude<CaptureCadence, 'off'>, number>> = {
  daily: 24 * 60 * 60 * 1_000,
  weekly: 7 * 24 * 60 * 60 * 1_000,
};

/** How often main's scheduler looks (only while frost is open). */
export const SCHEDULE_TICK_MS = 60_000;
/** The least system idle time (seconds, `powerMonitor.getSystemIdleTime`) before an automatic start. */
export const AUTO_CAPTURE_IDLE_S = 300;
/** At most one automatic attempt per project in this window, whatever came of it. */
export const AUTO_CAPTURE_RETRY_MS = 6 * 60 * 60 * 1_000;

/** Why automatic starts are suspended: `blocked`, a run ended at a challenge or consent page (`RUN_BLOCK_REASONS`). */
export const AUTO_START_SUSPENDED_REASONS = ['blocked'] as const;
export type AutoStartSuspendedReason = (typeof AUTO_START_SUSPENDED_REASONS)[number];

/**
 * Whether a project last run at `lastRunAt` (its newest `project` capture; `null`: never) is due at
 * `now` under `cadence` (pure): never for `off`; for a project that never ran, at once; else once a
 * whole cadence passed since its last run. One boolean, however many periods passed: nothing is
 * back-filled. A last run in the future (the clock moved back) is not due.
 */
export function isDue(lastRunAt: number | null, cadence: CaptureCadence, now: number): boolean {
  if (cadence === 'off' || !Object.prototype.hasOwnProperty.call(CAPTURE_CADENCE_MS, cadence)) return false;
  if (lastRunAt === null) return true;
  return now - lastRunAt >= CAPTURE_CADENCE_MS[cadence];
}

/** Each cadence in words (the Settings menu). */
export const CAPTURE_CADENCE_LABELS: Readonly<Record<CaptureCadence, string>> = { off: 'Off', daily: 'Daily', weekly: 'Weekly' };

/** Said under the cadence menu: only while frost is open, a due project waits for you, engines may challenge. */
export const CAPTURE_SCHEDULE_NOTE =
  'A cadence marks the project Due while frost is open; frost never starts a run by itself. A due project waits for you to run Check rankings or Capture now. Search engines may answer a run with a consent page or a challenge.' as const;

/** The Settings view's cadence section (Phase 10 Task 8). */
export const CADENCE_TEXT = {
  title: 'Cadence',
  label: 'Remind me to check',
  saved: 'Cadence saved.',
  /** The disclosure was answered Cancel: nothing changed. */
  declined: 'The cadence was not changed.',
  /** The "Start automatically" switch (shown only when `AUTO_CAPTURE_AVAILABLE`). */
  auto: 'Start automatically when due',
} as const;
