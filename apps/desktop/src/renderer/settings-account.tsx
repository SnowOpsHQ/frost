import { useEffect, useRef, useState } from 'react';
import type { AccountState } from '@app/specs/account-state.schema';
import { ACCOUNT_SETTINGS_TEXT } from '@app/specs/account-settings.spec';
import { accountSection, signInResultMessage, type AccountButton } from './account-view';
import { useConfirmArmed } from './settings-arming';
import { settingsActions } from './settings-hooks';

// The Settings view's Account section (Phase 4 Task 9; acceptance `account-settings.feature.md`). It
// renders `accountSection(state)` and calls one `account.*` procedure per click, from the click itself
// (Sign in and the confirmation need a live user gesture in this window). What it shows next comes from
// `account.watch`, never from the click. The confirmation's button has its own words and place, and
// takes no activation until it is armed (`settings-arming.ts`). A button whose call runs is
// `aria-disabled` (it keeps focus).

const LABELS: Readonly<Record<AccountButton, string>> = {
  'sign-in': 'Sign in',
  cancel: 'Cancel',
  confirm: ACCOUNT_SETTINGS_TEXT.confirmLabel,
  refresh: 'Refresh',
  'sign-out': 'Sign out',
};
const PRIMARY: ReadonlySet<AccountButton> = new Set(['sign-in', 'confirm']);

function Fingerprint({ code }: { readonly code: string }) {
  return (
    <p className="settings-fingerprint" data-testid="account-fingerprint" aria-label={`Code ${code.split('').join(' ')}`}>
      {code}
    </p>
  );
}

function ActionButton({ button, busy, inert = false, onPress }: { readonly button: AccountButton; readonly busy: boolean; readonly inert?: boolean; readonly onPress: (button: AccountButton) => void }) {
  return (
    <button
      type="button"
      className={PRIMARY.has(button) ? 'settings-button settings-button-primary' : 'settings-button'}
      data-testid={`account-${button}`}
      aria-disabled={busy || inert ? 'true' : undefined}
      onClick={() => {
        if (!busy && !inert) onPress(button);
      }}
    >
      {LABELS[button]}
    </button>
  );
}

/** The in-app confirmation: the question (focused when it appears), the code, Cancel, then the armed confirm button. */
function Confirmation({ question, fingerprint, hint, busy, onPress }: { readonly question: string; readonly fingerprint: string; readonly hint: string; readonly busy: boolean; readonly onPress: (button: AccountButton) => void }) {
  const armed = useConfirmArmed();
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="settings-card settings-confirm" role="group" aria-labelledby="account-question">
      <p ref={heading} className="settings-question" id="account-question" data-testid="account-question" tabIndex={-1}>
        {question}
      </p>
      <Fingerprint code={fingerprint} />
      <p className="settings-muted">{hint}</p>
      <div className="settings-actions settings-confirm-actions">
        <ActionButton button="cancel" busy={busy} onPress={onPress} />
        <ActionButton button="confirm" busy={busy} inert={!armed} onPress={onPress} />
      </div>
    </div>
  );
}

export function AccountSettings({ state }: { readonly state: AccountState | null }) {
  const [busy, setBusy] = useState<AccountButton | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (state === null) return <p className="settings-muted">Loading…</p>;
  const section = accountSection(state);
  const { view } = section;

  const press = (button: AccountButton) => {
    if (busy !== null) return;
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

  return (
    <div className="settings-account" data-testid="account-section" data-status={state.status}>
      <div aria-live="polite">
        {view.kind === 'unconfigured' || view.kind === 'signed-out' ? <p className="settings-text">{view.message}</p> : null}
        {view.kind === 'awaiting-browser' ? (
          <div className="settings-card">
            <p className="settings-text">{view.message}</p>
            <Fingerprint code={view.fingerprint} />
            <p className="settings-muted">{view.hint}</p>
          </div>
        ) : null}
        {view.kind === 'signed-in' ? (
          <div className="settings-card">
            <div className="settings-identity">
              <span className="settings-avatar" aria-hidden="true">
                {view.initial}
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
      </div>
      {view.kind === 'confirming' ? (
        <Confirmation key={section.requestId ?? ''} question={view.question} fingerprint={view.fingerprint} hint={view.hint} busy={busy !== null} onPress={press} />
      ) : view.buttons.length > 0 ? (
        <div className="settings-actions">
          {view.buttons.map((button) => (
            <ActionButton key={button} button={button} busy={busy !== null} onPress={press} />
          ))}
        </div>
      ) : null}
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
