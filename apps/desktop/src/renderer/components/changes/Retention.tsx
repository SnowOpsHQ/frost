import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { RETENTION_MODES, type RetentionMode } from '@app/specs/capture-db.spec';
import { RETENTION_LABELS, RETENTION_REFUSAL_MESSAGES, RETENTION_VALUE_BOUNDS, USAGE_NOTE, type PurgeLogEntry, type RetentionPreviewAnswer, type UsageAnswer } from '@app/specs/retention.spec';
import { ipc } from '../../ipc';
import { notifyProjectsChanged } from './projects-sheet';
import {
  UNSAVED_POLICY_PREVIEW,
  compactText,
  previewText,
  purgeLogText,
  purgeNowText,
  retentionFormChanged,
  retentionFormOf,
  retentionFromForm,
  retentionNote,
  usageRows,
  type RetentionForm,
} from '../../projects-view';

// A project's retention and disk usage (acceptance `retention.feature.md`, The project view): the
// policy (a radio group with N, bounded, and Save), the preview of what "Purge now" would remove,
// Purge now (main asks first, with that plan; both follow the saved policy, so while the form shows
// another one the preview says so and Purge now waits for Save), the project's usage with measured file sizes and the
// honest note on the database file, the purge log, and Compact database (main asks first). Outcomes
// go to the sheet's polite status line (`say`). Everything is React text; no inline styles.

/** Default N when a mode is chosen with none typed yet. */
const DEFAULT_VALUE: Readonly<Record<Exclude<RetentionMode, 'forever'>, string>> = { versions: '10', days: '90' };
const VALUE_LABELS: Readonly<Record<Exclude<RetentionMode, 'forever'>, string>> = { versions: 'Versions to keep', days: 'Days to keep' };

export function Retention({
  projectId,
  retention,
  refreshKey,
  busy,
  say,
  onChanged,
}: {
  readonly projectId: string;
  readonly retention: { readonly mode: RetentionMode; readonly value: number | null };
  /** Changes when the project was read again (a run captured, a page was added): the figures are read again. */
  readonly refreshKey: unknown;
  /** A capture run is under way (Purge now and Compact wait). */
  readonly busy: boolean;
  readonly say: (text: string) => void;
  readonly onChanged: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<RetentionForm>(() => retentionFormOf(retention));
  const [preview, setPreview] = useState<RetentionPreviewAnswer | null | undefined>(undefined);
  const [usage, setUsage] = useState<UsageAnswer | null | undefined>(undefined);
  const [entries, setEntries] = useState<PurgeLogEntry[] | null | undefined>(undefined);
  const [compacted, setCompacted] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((n) => n + 1), []);

  // The saved policy, as main answers it.
  useEffect(() => {
    setForm(retentionFormOf({ mode: retention.mode, value: retention.value }));
  }, [retention.mode, retention.value]);

  useEffect(() => {
    let live = true;
    void Promise.all([
      ipc.projects.retentionPreview.query({ projectId }).catch(() => null),
      ipc.projects.usage.query({ projectId }).catch(() => null),
      ipc.projects.purgeLog.query({ projectId }).catch(() => null),
    ]).then(([nextPreview, nextUsage, log]) => {
      if (!live) return;
      setPreview(nextPreview);
      setUsage(nextUsage);
      setEntries(log?.entries ?? null);
    });
    return () => {
      live = false;
    };
  }, [projectId, refreshKey, generation]);

  const choose = (mode: RetentionMode) => setForm((current) => ({ mode, value: mode !== 'forever' && current.value.trim() === '' ? DEFAULT_VALUE[mode] : current.value }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = retentionFromForm(form);
    if ('problem' in parsed) return say(parsed.problem);
    const answer = await ipc.projects.setRetention.mutate({ projectId, policy: parsed.policy }).catch(() => null);
    say(answer === null ? 'The policy could not be saved. Try again.' : answer.status === 'ok' ? 'Retention saved.' : RETENTION_REFUSAL_MESSAGES[answer.reason]);
    onChanged();
    refresh();
  };
  const act = async (run: () => Promise<string>) => {
    setWorking(true);
    try {
      say(await run());
    } finally {
      setWorking(false);
      refresh();
    }
  };
  const purge = () =>
    act(async () => {
      const text = purgeNowText(await ipc.projects.purgeNow.mutate({ projectId }).catch(() => null));
      // The Changes panel reads its history and screenshots again.
      notifyProjectsChanged();
      onChanged();
      return text;
    });
  const compact = () =>
    act(async () => {
      const text = compactText(await ipc.projects.compact.mutate().catch(() => null));
      setCompacted(text);
      return text;
    });

  const bounded = form.mode === 'forever' ? null : RETENTION_VALUE_BOUNDS[form.mode];
  const unsaved = retentionFormChanged(form, retention);
  const nothing = preview?.status === 'ok' && preview.counts.captures + preview.counts.versions + preview.counts.diffs + preview.counts.screenshots === 0;
  const rows = usage?.status === 'ok' ? usageRows(usage.usage) : null;

  return (
    <section className="projects-section projects-retention" data-testid="projects-retention" aria-labelledby={`${id}-title`}>
      <h3 className="projects-section-title" id={`${id}-title`}>
        Retention and disk usage
      </h3>
      {/* noValidate: the app's own message says what to fix (`retentionFromForm`). */}
      <form className="retention-policy" data-testid="retention-policy" noValidate onSubmit={(event) => void save(event)}>
        <fieldset className="retention-modes">
          <legend className="retention-legend">What to keep</legend>
          {RETENTION_MODES.map((mode) => (
            <label key={mode} className="projects-check retention-mode">
              <input type="radio" name={`${id}-mode`} value={mode} data-testid="retention-mode" data-mode={mode} checked={form.mode === mode} onChange={() => choose(mode)} />
              <span>{RETENTION_LABELS[mode]}</span>
            </label>
          ))}
        </fieldset>
        <div className="retention-value-row">
          {bounded !== null && form.mode !== 'forever' ? (
            <label className="projects-field retention-value">
              <span>{VALUE_LABELS[form.mode]}</span>
              <input
                className="projects-input"
                data-testid="retention-value"
                type="number"
                inputMode="numeric"
                min={bounded.min}
                max={bounded.max}
                step={1}
                required
                value={form.value}
                onChange={(event) => setForm((current) => ({ ...current, value: event.target.value }))}
              />
            </label>
          ) : null}
          <button type="submit" className="projects-small-button" data-testid="retention-save">
            Save
          </button>
        </div>
        <p className="projects-note" data-testid="retention-rule">
          {retentionNote(form.mode)}
        </p>
      </form>

      <div className="retention-purge-row">
        <p className="retention-preview" data-testid="retention-preview" data-stale={unsaved ? 'true' : undefined}>
          {unsaved ? UNSAVED_POLICY_PREVIEW : preview === undefined ? 'Reading…' : previewText(preview)}
        </p>
        <button type="button" className="projects-small-button projects-danger" data-testid="retention-purge" disabled={busy || working || unsaved || nothing || preview?.status !== 'ok'} onClick={() => void purge()}>
          Purge now…
        </button>
      </div>

      <h4 className="retention-subtitle">Disk usage</h4>
      {rows === null ? (
        <p className="projects-empty" data-testid="retention-usage-unread">
          {usage === undefined ? 'Reading…' : 'Usage could not be read.'}
        </p>
      ) : (
        <dl className="retention-usage" data-testid="retention-usage">
          {rows.map((row) => (
            <div key={row.id} className="retention-usage-row" data-testid="retention-usage-row" data-row={row.id}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="projects-note" data-testid="retention-usage-note">
        {USAGE_NOTE}
      </p>
      <div className="retention-compact-row">
        <button type="button" className="projects-small-button" data-testid="retention-compact" disabled={busy || working} onClick={() => void compact()}>
          Compact database…
        </button>
        {compacted !== null ? (
          <span className="projects-note" data-testid="retention-compacted">
            {compacted}
          </span>
        ) : null}
      </div>

      <h4 className="retention-subtitle">Purge log</h4>
      {!entries || entries.length === 0 ? (
        <p className="projects-empty" data-testid="retention-log-empty">
          {entries === undefined ? 'Reading…' : entries === null ? 'The purge log could not be read.' : 'No purges yet.'}
        </p>
      ) : (
        <ol className="retention-log" data-testid="retention-log">
          {entries.map((entry) => {
            const text = purgeLogText(entry);
            return (
              <li key={entry.id} className="retention-log-entry" data-testid="retention-log-entry" data-reason={entry.reason}>
                <span className="retention-log-when">{text.when}</span>
                <span className="retention-log-reason">{text.reason}</span>
                <span className="retention-log-what" data-testid="retention-log-what">
                  {text.what}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
