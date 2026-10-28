import { useState } from 'react';
import { UPDATE_BAR_LABELS } from '@app/specs/update-client.spec';
import { knownUpdate, updateActions, useUpdate } from '../hooks/useUpdate';
import { AlertIcon, CloseIcon, FrostMark } from '../icons';
import { registerPaletteActions } from '../palette/registry';
import { updatePaletteSources } from '../update-palette';
import { updateBarView, type UpdateBarView } from '../update-view';

// The update notice of the browser chrome (spec `update-client.spec.ts`, Chrome; acceptance
// `update-client.feature.md`, Chrome): a row under the find bar, shown only for an offer, a
// download in progress, a verified download and an error (`updateBarView`). Every step is a button:
// nothing downloads until Download, nothing is opened at all (Show file asks main to reveal the
// verified file). Release notes are the signed manifest's plain text, rendered as a text node.
// Styling is the bundled styles.css only (strict CSP).

// The command palette's update actions (`update-palette.ts`), registered once at load.
const unregisterPaletteActions = registerPaletteActions(...updatePaletteSources({ check: updateActions.check, setChecks: updateActions.setChecks, known: knownUpdate }));
import.meta.hot?.dispose(unregisterPaletteActions);

/** The always-present slot (empty, 0 high, at rest) and, when there is something to act on, the bar. */
export function UpdateBar() {
  const state = useUpdate();
  const view = updateBarView(state);
  // What Later and Dismiss hid, for this window's session (by `view.key`: an offer or a ready file by
  // its version, an error by the state version it came with, so a later failure shows again).
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const dismiss = (key: string) => setDismissed((keys) => new Set([...keys, key]));
  return (
    <div className="update-slot" data-testid="update-slot" data-update-status={state?.status.kind ?? 'none'} aria-live="polite">
      {view.kind !== 'hidden' && !dismissed.has(view.key) ? <UpdateNotice key={view.key} view={view} onDismiss={() => dismiss(view.key)} /> : null}
    </div>
  );
}

function UpdateNotice({ view, onDismiss }: { readonly view: Exclude<UpdateBarView, { kind: 'hidden' }>; readonly onDismiss: () => void }) {
  const [notesOpen, setNotesOpen] = useState(false);
  // One click per step: a button stays disabled until the state moves on (this notice is keyed by it).
  const [busy, setBusy] = useState(false);
  const act = (run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void run().finally(() => setBusy(false));
  };
  return (
    <section className="update-bar" data-testid="update-bar" data-kind={view.kind} aria-labelledby="update-bar-text">
      <div className="update-row">
        <span className="update-icon" data-tone={view.kind === 'error' ? 'error' : 'info'} aria-hidden="true">
          {view.kind === 'error' ? <AlertIcon /> : <FrostMark />}
        </span>
        <p className="update-text" id="update-bar-text" data-testid="update-text">
          <strong className="update-headline">{view.text}</strong>
          {view.kind === 'available' ? (
            <>
              {' '}
              <span className="update-size" data-testid="update-size">
                ({view.sizeText})
              </span>
            </>
          ) : null}
          {view.kind === 'available' && view.requiredText !== null ? (
            <span className="update-required" data-testid="update-required">
              {' '}
              {view.requiredText}
            </span>
          ) : null}
          {view.kind === 'downloading' ? (
            <span className="update-percent" data-testid="update-percent">
              {' '}
              {view.percent} %
            </span>
          ) : null}
        </p>
        {view.kind === 'downloading' ? <progress className="update-progress" data-testid="update-progress" max={Math.max(1, view.total)} value={Math.min(view.bytes, Math.max(1, view.total))} aria-label={view.text} /> : null}
        <div className="update-actions">
          {view.kind === 'available' ? (
            <>
              {view.notes !== '' ? (
                <button type="button" className="update-button update-quiet" data-testid="update-notes-toggle" aria-expanded={notesOpen} aria-controls="update-notes" onClick={() => setNotesOpen((open) => !open)}>
                  {notesOpen ? UPDATE_BAR_LABELS.hideReleaseNotes : UPDATE_BAR_LABELS.releaseNotes}
                </button>
              ) : null}
              <button type="button" className="update-button update-primary" data-testid="update-download" disabled={busy} onClick={() => act(updateActions.download)}>
                {UPDATE_BAR_LABELS.download}
              </button>
              {view.canSkip ? (
                <button type="button" className="update-button" data-testid="update-skip" disabled={busy} onClick={() => act(updateActions.skip)}>
                  {UPDATE_BAR_LABELS.skip}
                </button>
              ) : null}
              <button type="button" className="update-button update-quiet" data-testid="update-later" onClick={onDismiss}>
                {UPDATE_BAR_LABELS.later}
              </button>
            </>
          ) : null}
          {view.kind === 'ready' && view.canShowFile ? (
            <button type="button" className="update-button update-primary" data-testid="update-show-file" disabled={busy} onClick={() => act(updateActions.install)}>
              {UPDATE_BAR_LABELS.showFile}
            </button>
          ) : null}
        </div>
        {view.kind === 'ready' || view.kind === 'error' ? (
          <button type="button" className="update-dismiss" data-testid="update-dismiss" aria-label={UPDATE_BAR_LABELS.dismiss} title={UPDATE_BAR_LABELS.dismiss} onClick={onDismiss}>
            <CloseIcon />
          </button>
        ) : null}
      </div>
      {view.kind === 'available' && notesOpen ? (
        // Plain text (a text node in a `pre`), never HTML: the signed notes hold no markup frost renders.
        <pre className="update-notes" id="update-notes" data-testid="update-notes">
          {view.notes}
        </pre>
      ) : null}
    </section>
  );
}
