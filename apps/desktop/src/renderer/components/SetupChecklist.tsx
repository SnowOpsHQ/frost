import { useEffect, useState, useSyncExternalStore } from 'react';
import { SETUP_CHECKLIST_ITEMS, SETUP_CHECKLIST_STORAGE_KEY, SETUP_CHECKLIST_TEXT, type SetupChecklistItemId } from '@app/specs/help.spec';
import { requestAgentPanel } from '../agent-palette';
import { requestHelpSheet } from '../help-palette';
import { actions, ipc } from '../ipc';
import { onSettingsRequest, requestSettings } from '../settings-open';
import { useGscStatus } from '../settings-hooks';
import { openProjects } from './changes/projects-sheet';
import '../help.css';

// The new-tab page's setup checklist (Phase 11 Task 11, SL-005 / SL-126, Decision 15; acceptance
// `help.feature.md`, Chrome). Each item is derived from state the chrome already reads, nothing remote:
// the agent's setup (`agent.watch`, read once per empty tab shown), the Search Console connection (the
// shared `gsc.watch` store), the projects (`projects.list`, once per empty tab), and the chrome's own
// marks in `localStorage` (`SETUP_CHECKLIST_STORAGE_KEY`) that the Telemetry settings and the shortcuts
// screen were opened. Each item's button opens where it is done. "Hide this checklist" hides it for
// good; it is gone too once every item is done.

export interface SetupMarks {
  readonly dismissed: boolean;
  readonly privacy: boolean;
  readonly shortcuts: boolean;
}

const NO_MARKS: SetupMarks = Object.freeze({ dismissed: false, privacy: false, shortcuts: false });

/** The marks as `raw` (the stored JSON) holds them: anything but a boolean `true` reads as `false`. */
export function parseSetupMarks(raw: string | null): SetupMarks {
  if (raw === null) return NO_MARKS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NO_MARKS;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return NO_MARKS;
  const record = value as Record<string, unknown>;
  return { dismissed: record['dismissed'] === true, privacy: record['privacy'] === true, shortcuts: record['shortcuts'] === true };
}

/** The stored marks, or `null` if storage cannot be read. */
function storedMarks(): SetupMarks | null {
  try {
    return parseSetupMarks(window.localStorage.getItem(SETUP_CHECKLIST_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** The stored marks (nothing marked if storage cannot be read). */
export function readSetupMarks(): SetupMarks {
  return storedMarks() ?? NO_MARKS;
}

// One snapshot for `useSyncExternalStore`, replaced when the marks change.
let marks: SetupMarks | null = null;
const listeners = new Set<() => void>();
const currentMarks = (): SetupMarks => (marks ??= readSetupMarks());
const subscribeMarks = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const sameMarks = (a: SetupMarks, b: SetupMarks) => a.dismissed === b.dismissed && a.privacy === b.privacy && a.shortcuts === b.shortcuts;
function setMarks(next: SetupMarks): void {
  if (sameMarks(next, currentMarks())) return;
  marks = next;
  for (const listener of [...listeners]) listener();
}

/** Reads the marks again (another window may have changed them); unreadable storage keeps what this window knows. */
function refreshMarks(): void {
  const read = storedMarks();
  if (read !== null) setMarks(read);
}

/** Marks a step done (`privacy`, `shortcuts`) or the checklist hidden (`dismissed`); kept for later runs. */
export function markSetupStep(step: keyof SetupMarks): void {
  const stored = storedMarks() ?? NO_MARKS;
  const known = currentMarks();
  const next: SetupMarks = { dismissed: stored.dismissed || known.dismissed, privacy: stored.privacy || known.privacy, shortcuts: stored.shortcuts || known.shortcuts, [step]: true };
  try {
    window.localStorage.setItem(SETUP_CHECKLIST_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not kept past this run.
  }
  setMarks(next);
}

// Opening the Telemetry settings, from anywhere (the palette, this checklist), is "Review your privacy settings".
const stopPrivacy = onSettingsRequest((section) => {
  if (section === 'telemetry') markSetupStep('privacy');
});
import.meta.hot?.dispose(stopPrivacy);

/** Which items are done, from main's state and the marks. */
export function setupDone(state: { readonly agentReady: boolean; readonly gscConnected: boolean; readonly hasProject: boolean; readonly marks: SetupMarks }): Record<SetupChecklistItemId, boolean> {
  return { agent: state.agentReady, 'search-console': state.gscConnected, project: state.hasProject, privacy: state.marks.privacy, shortcuts: state.marks.shortcuts };
}

const OPEN: Record<SetupChecklistItemId, () => void> = {
  agent: () => requestAgentPanel({ kind: 'settings' }),
  'search-console': () => void requestSettings('search-console'),
  project: () => openProjects(),
  privacy: () => {
    markSetupStep('privacy');
    requestSettings('telemetry');
  },
  // The sheet marks the step when it opens (`ShortcutsSheet`): it stays shut while a sign-in waits in Settings.
  shortcuts: () => void requestHelpSheet('shortcuts'),
};

/** The checklist on an empty tab's start view (`tabId`: read again for each empty tab shown). */
export function SetupChecklist({ tabId }: { readonly tabId?: number | undefined }) {
  const stored = useSyncExternalStore(subscribeMarks, currentMarks);
  const gsc = useGscStatus();
  const [main, setMain] = useState<{ agentReady: boolean; hasProject: boolean } | null>(null);
  useEffect(() => {
    refreshMarks();
    let live = true;
    void Promise.all([
      // Answers at once (the agent's state version starts above 0).
      ipc.agent.watch.query({ sinceVersion: 0 }).then(
        (state) => state.setup.ready === true,
        () => false,
      ),
      actions.listProjects().then((projects) => projects.some((project) => !project.unfiled)),
    ]).then(([agentReady, hasProject]) => {
      if (live) setMain({ agentReady, hasProject });
    });
    return () => {
      live = false;
    };
  }, [tabId]);
  if (stored.dismissed) return null;
  const done = setupDone({ agentReady: main?.agentReady ?? false, gscConnected: gsc?.connected === true, hasProject: main?.hasProject ?? false, marks: stored });
  const count = SETUP_CHECKLIST_ITEMS.filter((item) => done[item.id]).length;
  if (count === SETUP_CHECKLIST_ITEMS.length) return null;
  return (
    <section className="setup" data-testid="setup-checklist" aria-labelledby="setup-title">
      <header className="setup-header">
        <h2 className="setup-title" id="setup-title">
          {SETUP_CHECKLIST_TEXT.title}
        </h2>
        <span className="setup-progress">{SETUP_CHECKLIST_TEXT.progress(count, SETUP_CHECKLIST_ITEMS.length)}</span>
        <button type="button" className="setup-dismiss" data-testid="setup-dismiss" onClick={() => markSetupStep('dismissed')}>
          {SETUP_CHECKLIST_TEXT.dismiss}
        </button>
      </header>
      <ul className="setup-items">
        {SETUP_CHECKLIST_ITEMS.map((item) => (
          <li key={item.id} className="setup-item" data-testid="setup-item" data-item={item.id} data-done={done[item.id] ? 'true' : 'false'}>
            <span className="setup-check" aria-hidden="true" />
            <span className="setup-label">{item.label}</span>
            {done[item.id] ? (
              <span className="setup-done">{SETUP_CHECKLIST_TEXT.done}</span>
            ) : (
              <button type="button" className="setup-action" data-testid="setup-action" onClick={OPEN[item.id]}>
                {item.action}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
