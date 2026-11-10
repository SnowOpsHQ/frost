import { useEffect, useState } from 'react';
import { DIAGNOSTICS_TEXT, type DiagnosticsResult } from '@app/specs/diagnostics.spec';
// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { DiagnosticsReport } from '@app/specs/whats-new.schema';
import { ipc } from '../ipc';
import { HelpSheetFrame, useHelpSheet, type HelpSheetProps } from './ShortcutsView';

// Export Diagnostics (Phase 11 Task 12, SL-125; acceptance `diagnostics.feature.md`): main builds a
// scrubbed report each time the sheet opens (`help.diagnostics`) and the sheet shows it as React text
// for review. Save… asks main to save its own copy by id (`help.saveDiagnostics`): main opens its
// save dialog and writes exactly the text shown here. The chrome never sends the text, and nothing is
// sent anywhere. A Help sheet: one at a time with the others, Settings, Projects and History.

const diagnosticsActions = {
  report: (): Promise<DiagnosticsReport | null> => ipc.help.diagnostics.mutate().catch(() => null),
  save: (reportId: string): Promise<DiagnosticsResult> => ipc.help.saveDiagnostics.mutate({ reportId }).catch(() => 'failed' as const),
};

type Loaded = { readonly state: 'loading' } | { readonly state: 'unavailable' } | { readonly state: 'ready'; readonly report: DiagnosticsReport };

/** The App slot: the diagnostics report while the sheet is open. */
export function DiagnosticsSheet(props: HelpSheetProps) {
  const { open, focusSeq, close } = useHelpSheet('diagnostics', props);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // A fresh report every time the sheet opens (or is asked for again).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoaded({ state: 'loading' });
    setNote(null);
    void diagnosticsActions.report().then((report) => {
      if (live) setLoaded(report ? { state: 'ready', report } : { state: 'unavailable' });
    });
    return () => {
      live = false;
    };
  }, [open, focusSeq]);
  if (!open) return null;
  const save = () => {
    if (loaded.state !== 'ready' || saving) return;
    setSaving(true);
    setNote(null);
    void diagnosticsActions.save(loaded.report.reportId).then((result) => {
      setSaving(false);
      setNote(result === 'cancelled' ? null : DIAGNOSTICS_TEXT.notes[result]);
    });
  };
  return (
    <HelpSheetFrame testId="diagnostics-view" title={DIAGNOSTICS_TEXT.title} closeLabel={DIAGNOSTICS_TEXT.close} focusSeq={focusSeq} onClose={close}>
      <p className="help-note">{DIAGNOSTICS_TEXT.intro}</p>
      <div className="diagnostics-actions">
        {/* While saving, Save stays focusable (`aria-disabled`; `save` ignores it): a focused button that
            turns `disabled` loses focus to the body, where Esc no longer reaches the sheet. */}
        <button
          type="button"
          className="diagnostics-save"
          data-testid="diagnostics-save"
          disabled={loaded.state !== 'ready'}
          aria-disabled={saving || undefined}
          onClick={save}
        >
          {saving ? DIAGNOSTICS_TEXT.saving : DIAGNOSTICS_TEXT.save}
        </button>
        <p className="help-note diagnostics-note" role="status" data-testid="diagnostics-note">
          {note}
        </p>
      </div>
      {loaded.state === 'loading' ? <p className="help-note">{DIAGNOSTICS_TEXT.loading}</p> : null}
      {loaded.state === 'unavailable' ? <p className="help-note">{DIAGNOSTICS_TEXT.unavailable}</p> : null}
      {loaded.state === 'ready' ? (
        // Plain React text in a <pre>: the report is shown exactly as main will write it.
        <pre className="diagnostics-text" data-testid="diagnostics-text" tabIndex={0} aria-label={DIAGNOSTICS_TEXT.title}>
          {loaded.report.text}
        </pre>
      ) : null}
    </HelpSheetFrame>
  );
}
