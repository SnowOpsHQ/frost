import { useCallback, useEffect, useState } from 'react';
import type { HistoryRetentionAnswer } from '@app/ipc-contract';
import { HISTORY_RETENTIONS, HISTORY_SETTINGS_TEXT as TEXT, type HistoryRetention } from '@app/specs/browser-polish.spec';
import { actions } from './ipc';

// The Settings view's History section (Phase 11 Task 10, Decision 13; acceptance
// `browser-polish.feature.md`, History retention): how long visits are kept (a radio group) and
// "Keep visits to project pages". Both live in main (`app_settings`); a click asks main
// (`history.setRetention`), which asks in its own dialog first when visits would go, then stores them
// and prunes at once. What is checked is main's settings read back, never the click's guess (a
// cancelled change reverts, with a note). While a call runs the controls are `aria-disabled`. A
// failed first read shows an error with "Try again".

export function HistorySettings() {
  const [settings, setSettings] = useState<HistoryRetentionAnswer | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const read = useCallback((isLive: () => boolean = () => true) => {
    setReadFailed(false);
    void actions.historyRetention().then((answer) => {
      if (!isLive()) return;
      if (answer === null) setReadFailed(true);
      else setSettings(answer);
    });
  }, []);
  useEffect(() => {
    let live = true;
    read(() => live);
    return () => {
      live = false;
    };
  }, [read]);

  if (settings === null) {
    if (!readFailed) return <p className="settings-muted">{TEXT.loading}</p>;
    return (
      <div className="settings-history" data-testid="history-settings" data-state="read-failed">
        <p className="settings-muted" role="status" data-testid="history-settings-read-failed">
          {TEXT.readFailed}
        </p>
        <div className="settings-actions">
          <button type="button" className="settings-button" data-testid="history-settings-retry" onClick={() => read()}>
            {TEXT.retry}
          </button>
        </div>
      </div>
    );
  }

  const store = (next: HistoryRetentionAnswer) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    void actions.setHistoryRetention(next).then(async (result) => {
      // Main's settings as they now are (unchanged when cancelled or failed).
      const answer = await actions.historyRetention();
      setBusy(false);
      if (answer !== null) setSettings(answer);
      if (result === 'cancelled') setNote(TEXT.cancelled);
      else if (result === 'failed') setNote(TEXT.failed);
    });
  };
  const choose = (retention: HistoryRetention) => {
    if (retention !== settings.retention) store({ ...settings, retention });
  };

  return (
    <div className="settings-history" data-testid="history-settings" data-retention={settings.retention}>
      <p className="settings-text">{TEXT.intro}</p>
      <ul className="settings-toggles settings-history-retention" role="radiogroup" aria-label={TEXT.retentionLabel}>
        {HISTORY_RETENTIONS.map((entry) => (
          <li key={entry.id} className="settings-toggle">
            <button
              type="button"
              role="radio"
              className="settings-choice"
              data-testid="history-retention"
              data-retention={entry.id}
              aria-checked={entry.id === settings.retention}
              aria-disabled={busy ? 'true' : undefined}
              onClick={() => choose(entry.id)}
            >
              <span className="settings-choice-mark" aria-hidden="true" />
              <span className="settings-toggle-text">
                <span className="settings-toggle-label">{entry.label}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <ul className="settings-toggles">
        <li className="settings-toggle">
          <div className="settings-toggle-text">
            <span className="settings-toggle-label" id="history-keep-project-pages-label">
              {TEXT.keepProjectPages}
            </span>
            <span className="settings-muted" id="history-keep-project-pages-hint">
              {TEXT.keepProjectPagesHint}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            className="settings-switch"
            data-testid="history-keep-project-pages"
            aria-checked={settings.keepProjectPages}
            aria-labelledby="history-keep-project-pages-label"
            aria-describedby="history-keep-project-pages-hint"
            aria-disabled={busy ? 'true' : undefined}
            onClick={() => store({ ...settings, keepProjectPages: !settings.keepProjectPages })}
          >
            <span className="settings-switch-knob" aria-hidden="true" />
          </button>
        </li>
      </ul>
      {note !== null ? (
        <p className="settings-muted" role="status" data-testid="history-settings-note">
          {note}
        </p>
      ) : null}
    </div>
  );
}
