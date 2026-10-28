import { useState } from 'react';
import { useGscStatus, settingsActions } from './settings-hooks';
import { gscConnectResultMessage, gscSection, type GscButton } from './settings-gsc-view';

// The Settings view's Search Console section (Phase 4 Task 9; acceptance `account-settings.feature.md`):
// renders `gscSection(status)` from `gsc.watch` and calls one `gsc.*` procedure per click (Connect from
// the click itself: main needs a live user gesture in this window). Without Pro it points to Account.
// A button whose call runs is `aria-disabled` (it keeps focus).

const LABELS: Readonly<Record<GscButton, string>> = { connect: 'Connect', cancel: 'Cancel', disconnect: 'Disconnect', 'go-to-account': 'Go to Account' };

export function GscSettings({ onGoToAccount }: { readonly onGoToAccount: () => void }) {
  const status = useGscStatus();
  const [busy, setBusy] = useState<GscButton | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (status === null) return <p className="settings-muted">Loading…</p>;
  const section = gscSection(status);

  const press = (button: GscButton) => {
    if (busy !== null) return;
    setNote(null);
    if (button === 'go-to-account') {
      onGoToAccount();
      return;
    }
    setBusy(button);
    const call: Promise<unknown> =
      button === 'connect' ? settingsActions.connectGsc().then((result) => setNote(gscConnectResultMessage(result))) : button === 'cancel' ? settingsActions.cancelGsc() : settingsActions.disconnectGsc();
    void call.finally(() => setBusy(null));
  };

  return (
    <div className="settings-gsc" data-testid="gsc-section" data-kind={section.kind} aria-live="polite">
      {section.headline ? (
        <p className="settings-headline" data-testid="gsc-headline" data-connected={section.kind === 'connected' ? 'true' : undefined}>
          {section.headline}
        </p>
      ) : null}
      <p className="settings-text">{section.message}</p>
      {section.buttons.length > 0 ? (
        <div className="settings-actions">
          {section.buttons.map((button) => (
            <button
              key={button}
              type="button"
              className={button === 'connect' ? 'settings-button settings-button-primary' : 'settings-button'}
              data-testid={`gsc-${button}`}
              aria-disabled={busy !== null ? 'true' : undefined}
              onClick={() => press(button)}
            >
              {LABELS[button]}
            </button>
          ))}
        </div>
      ) : null}
      {note ? (
        <p className="settings-note" role="status">
          {note}
        </p>
      ) : null}
      {section.error ? (
        <p className="settings-error" role="alert" data-testid="gsc-error">
          {section.error}
        </p>
      ) : null}
      {section.keychain ? <p className="settings-notice">{section.keychain}</p> : null}
    </div>
  );
}
