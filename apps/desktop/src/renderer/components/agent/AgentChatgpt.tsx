import { useLayoutEffect, useRef, useState, type FocusEvent, type RefObject } from 'react';
import { CHATGPT_UI, CHATGPT_USAGE_URL, type ChatgptAccountView, type ChatgptFailure } from '@app/specs/agent-chatgpt.spec';
import type { AgentSetupView } from '@app/specs/agent-session.spec';
import { agentActions } from '../../agent-actions';
import { chatgptComposerModel, chatgptErrorModel, chatgptSettingsModel, chatgptSignInMessage, chatgptSignInOptions, chatgptSignOutMessage, type ChatgptAction } from '../../agent-view';

// The ChatGPT plan in the panel (`agent-chatgpt.feature.md`, Panel; OpenAI's UI/UX guidelines in
// frost's words, `CHATGPT_UI`): the settings' sign-in section, the "Using ChatGPT plan · Manage
// usage" line and the one-time notice by the composer, and a plan failure's banner in the chat.
// Every word is fixed copy; the renderer never holds a token (main's `ChatgptAccountView` has none).
// A sign-in is a click: main spends that click's gesture before it opens the browser. "Manage
// usage" is a plain `target="_blank"` link: the app window's open handler sends it to the system
// browser through the scheme allowlist, on the click's own gesture.

/** "Manage usage": ChatGPT's usage settings in the system browser. */
export function ManageUsageLink({ primary = false, testId = 'agent-chatgpt-manage-usage' }: { readonly primary?: boolean; readonly testId?: string }) {
  return (
    <a className={primary ? 'agent-button agent-button-primary agent-chatgpt-usage-button' : 'agent-link'} data-testid={testId} href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
      {CHATGPT_UI.manageUsage}
    </a>
  );
}

/**
 * Keeps keyboard focus from falling to nothing: when the focused element inside `area` goes away
 * (its button replaced by the next state's, a notice dismissed), `fallback()` takes focus. Focus the
 * user moved elsewhere is left alone. Spread the handlers on `area`'s element.
 */
function useFocusRescue(area: RefObject<HTMLElement | null>, fallback: () => HTMLElement | null | undefined, key: string) {
  const inside = useRef(false);
  useLayoutEffect(() => {
    if (!inside.current) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    inside.current = false;
    fallback()?.focus();
    // Checked when the key changes (the buttons shown); `fallback` is read then.
  }, [key]);
  return {
    onFocus: () => {
      inside.current = true;
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const target = event.target;
      // A move elsewhere clears it; an element removed while focused keeps it, so its focus is rescued.
      queueMicrotask(() => {
        if (target.isConnected) inside.current = area.current?.contains(document.activeElement) === true;
      });
    },
  };
}

/** Runs a ChatGPT action and answers what to say about it (`null`: nothing; the account's state shows the rest). */
async function runAction(action: ChatgptAction): Promise<string | null> {
  if (action === 'cancel') {
    await agentActions.chatgptCancel();
    return null;
  }
  if (action === 'sign-out') return chatgptSignOutMessage(await agentActions.chatgptSignOut());
  const options = chatgptSignInOptions(action);
  return options === null ? null : chatgptSignInMessage(await agentActions.chatgptSignIn(options));
}

/** The settings' ChatGPT plan section: what the route is, the account's state and its actions. */
export function ChatgptAccountSection({ account }: { readonly account: ChatgptAccountView }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Read by the guard: two clicks before React renders again start one action. */
  const busyRef = useRef(false);
  const section = useRef<HTMLElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const model = chatgptSettingsModel(account);
  // Continue → Cancel → Sign out: the clicked button goes away, so the first action takes focus.
  const rescue = useFocusRescue(section, () => actions.current?.querySelector<HTMLButtonElement>('button'), `${model.state} ${model.actions.map((item) => item.action).join(' ')}`);
  const act = (action: ChatgptAction) => {
    if (action === 'cancel') {
      // Never held back: the sign-in it ends may itself still be waiting for its answer.
      setMessage(null);
      void runAction(action);
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    void runAction(action).then((said) => {
      busyRef.current = false;
      setBusy(false);
      setMessage(said);
    });
  };
  return (
    <section ref={section} className="agent-section" data-testid="agent-chatgpt" data-state={model.state} {...rescue}>
      <h3 className="agent-section-title">{CHATGPT_UI.routeLabel}</h3>
      <p className="agent-section-text agent-muted">{CHATGPT_UI.settingsDescription}</p>
      {/* Always rendered, so signing in, an expiry, a failure and an action's answer are announced. */}
      <div role="status" data-testid="agent-chatgpt-live">
        {model.account !== null ? (
          <p className="agent-section-text" data-testid="agent-chatgpt-account">
            {model.account}
          </p>
        ) : null}
        {model.status !== null ? (
          <p className="agent-section-text" data-testid="agent-chatgpt-status" data-plan-usage={model.planUsage ?? undefined}>
            {model.status}
          </p>
        ) : null}
        {model.error !== null ? (
          <p className="agent-key-message" data-testid="agent-chatgpt-error" data-error={account.error}>
            {model.error}
          </p>
        ) : null}
        {message !== null ? (
          <p className="agent-key-message" data-testid="agent-chatgpt-message">
            {message}
          </p>
        ) : null}
      </div>
      <div ref={actions} className="agent-key-row agent-chatgpt-actions">
        {model.actions.map((item) => (
          <button
            key={item.action}
            type="button"
            className={item.primary ? 'agent-button agent-button-primary' : 'agent-button'}
            data-testid={`agent-chatgpt-${item.action}`}
            // Cancel stays live while a sign-in waits; the rest wait for the last answer.
            disabled={busy && item.action !== 'cancel'}
            onClick={() => act(item.action)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** By the composer while the route is selected: "Using ChatGPT plan · Manage usage", and the one-time notice first. */
export function ChatgptComposerBar({ setup }: { readonly setup: Pick<AgentSetupView, 'route' | 'chatgpt'> }) {
  const [failed, setFailed] = useState(false);
  const notice = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  const model = chatgptComposerModel(setup);
  // "Got it" removes the notice (and itself): focus goes to the line's "Manage usage".
  const rescue = useFocusRescue(notice, () => line.current?.querySelector<HTMLAnchorElement>('a'), `${model.inUse} ${model.notice}`);
  if (!model.inUse) return null;
  return (
    <>
      {model.notice ? (
        <div ref={notice} className="agent-chatgpt-notice" role="status" data-testid="agent-chatgpt-notice" {...rescue}>
          <p className="agent-hint-title">{CHATGPT_UI.noticeTitle}</p>
          <p className="agent-hint-text">{CHATGPT_UI.noticeBody}</p>
          <div className="agent-key-row">
            <button
              type="button"
              className="agent-button agent-button-primary"
              data-testid="agent-chatgpt-got-it"
              onClick={() => {
                setFailed(false);
                void agentActions.chatgptAcknowledge().then((stored) => setFailed(!stored));
              }}
            >
              {CHATGPT_UI.noticeButton}
            </button>
            <ManageUsageLink testId="agent-chatgpt-notice-usage" />
          </div>
          {failed ? (
            <p className="agent-key-message" role="alert">
              {CHATGPT_UI.acknowledgeFailed}
            </p>
          ) : null}
        </div>
      ) : null}
      <p ref={line} className="agent-chatgpt-inuse" data-testid="agent-chatgpt-inuse">
        <span>{CHATGPT_UI.inUse}</span>
        <span aria-hidden="true"> · </span>
        <ManageUsageLink />
      </p>
    </>
  );
}

/** A ChatGPT plan failure on the turn: main's fixed copy and its recovery ("Manage usage" first at the usage limit). */
export function ChatgptErrorBanner({ failure }: { readonly failure: ChatgptFailure }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Read by the guard: a double click starts one sign-in. */
  const busyRef = useRef(false);
  const model = chatgptErrorModel(failure);
  const signIn = (options: { readonly reconsent?: true }) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    void agentActions.chatgptSignIn(options).then((result) => {
      busyRef.current = false;
      setBusy(false);
      setMessage(chatgptSignInMessage(result));
    });
  };
  return (
    <div className="agent-banner agent-chatgpt-error" role="alert" data-testid="agent-error" data-tone="error" data-reason={failure.reason}>
      <div className="agent-banner-text">
        {model.title !== null ? (
          <p className="agent-hint-title" data-testid="agent-chatgpt-error-title">
            {model.title}
          </p>
        ) : null}
        <p className="agent-chatgpt-error-text">{model.message}</p>
        {message !== null ? (
          <p className="agent-key-message" role="status" data-testid="agent-chatgpt-message">
            {message}
          </p>
        ) : null}
      </div>
      {model.recovery === 'manage-usage' ? <ManageUsageLink primary testId="agent-chatgpt-recovery" /> : null}
      {model.recovery === 'reconsent' || model.recovery === 'sign-in' ? (
        <button type="button" className="agent-button agent-button-primary" data-testid="agent-chatgpt-recovery" disabled={busy} onClick={() => signIn(model.recovery === 'reconsent' ? { reconsent: true } : {})}>
          {model.label}
        </button>
      ) : null}
    </div>
  );
}
