import { useState } from 'react';
import type { AccountState } from '@app/specs/account-state.schema';
import { accountSection, signInResultMessage, type AccountButton } from './account-view';
import { settingsActions } from './settings-hooks';

// The Settings view's Account section (Phase 4 Task 9; acceptance `account-settings.feature.md`). It
// renders `accountSection(state)` and calls one `account.*` procedure per click, from the click itself
// (Sign in and the confirmation need a live user gesture in this window). What it shows next comes from
// `account.watch`, never from the click.

const LABELS: Readonly<Record<AccountButton, string>> = { 'sign-in': 'Sign in', cancel: 'Cancel', confirm: 'Sign in', refresh: 'Refresh', 'sign-out': 'Sign out' };
const PRIMARY: ReadonlySet<AccountButton> = new Set(['sign-in', 'confirm']);

function Fingerprint({ code }: { readonly code: string }) {
  return (
    <p className="settings-fingerprint" data-testid="account-fingerprint" aria-label={`Code ${code.split('').join(' ')}`}>
      {code}
    </p>
  );
}

export function AccountSettings({ state }: { readonly state: AccountState | null }) {
  const [busy, setBusy] = useState<AccountButton | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (state === null) return <p className="settings-muted">Loading…</p>;
  const section = accountSection(state);
  const { view } = section;

  const press = (button: AccountButton) => {
    setNote(null);
    setBusy(button);
    let call: Promise<unknown>;
    switch (button) {
      case 'sign-in':
        call = settingsActions.signIn().then((result) => setNote(signInResultMessage(result)));
        break;
      case 'confirm':
        call = settingsActions.confirmSignIn(section.requestId ?? '').then((ok) => {
          if (!ok) setNote("This sign-in couldn't be confirmed. Click Sign in again.");
        });
        break;
      case 'cancel':
        call = settingsActions.cancelSignIn(section.requestId ?? '');
        break;
      case 'refresh':
        call = settingsActions.refresh();
        break;
      case 'sign-out':
        call = settingsActions.signOut();
        break;
    }
    void call.finally(() => setBusy(null));
  };

  const buttons = (
    <div className="settings-actions">
      {view.buttons.map((button) => (
        <button
          key={button}
          type="button"
          className={PRIMARY.has(button) ? 'settings-button settings-button-primary' : 'settings-button'}
          data-testid={`account-${button}`}
          disabled={busy !== null}
          onClick={() => press(button)}
        >
          {LABELS[button]}
        </button>
      ))}
    </div>
  );

  return (
    <div className="settings-account" data-testid="account-section" data-status={state.status}>
      {view.kind === 'unconfigured' || view.kind === 'signed-out' ? <p className="settings-text">{view.message}</p> : null}
      {view.kind === 'awaiting-browser' ? (
        <div className="settings-card" aria-live="polite">
          <p className="settings-text">{view.message}</p>
          <Fingerprint code={view.fingerprint} />
          <p className="settings-muted">{view.hint}</p>
        </div>
      ) : null}
      {view.kind === 'confirming' ? (
        <div className="settings-card settings-confirm" role="group" aria-labelledby="account-question">
          <p className="settings-question" id="account-question" data-testid="account-question">
            {view.question}
          </p>
          <Fingerprint code={view.fingerprint} />
          <p className="settings-muted">{view.hint}</p>
        </div>
      ) : null}
      {view.kind === 'signed-in' ? (
        <div className="settings-card">
          <div className="settings-identity">
            <span className="settings-avatar" aria-hidden="true">
              {(view.name ?? view.email).slice(0, 1).toUpperCase()}
            </span>
            <div className="settings-identity-text">
              {view.name ? (
                <bdi className="settings-name" dir="auto">
                  {view.name}
                </bdi>
              ) : null}
              <bdi className="settings-email" dir="auto" data-testid="account-email">
                {view.email}
              </bdi>
            </div>
            <span className="settings-plan" data-testid="account-plan" data-pro={view.plan.pro ? 'true' : undefined}>
              {view.plan.label}
            </span>
          </div>
          <p className="settings-status" data-tone={view.plan.tone} data-testid="account-plan-status">
            {view.plan.status}
          </p>
          <ul className="settings-features" aria-label="Pro features">
            {view.plan.features.map((feature) => (
              <li key={feature.flag} className="settings-feature" data-included={feature.included ? 'true' : 'false'}>
                <span className="settings-feature-mark" aria-hidden="true">
                  {feature.included ? '✓' : '–'}
                </span>
                {feature.label}
                <span className="settings-sr">{feature.included ? ' (included)' : ' (not included)'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {buttons}
      {note ? (
        <p className="settings-note" role="status">
          {note}
        </p>
      ) : null}
      {section.error ? (
        <p className="settings-error" role="alert" data-testid="account-error">
          {section.error}
        </p>
      ) : null}
      {section.keychain ? <p className="settings-notice">{section.keychain}</p> : null}
    </div>
  );
}
