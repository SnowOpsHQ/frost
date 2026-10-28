import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ApprovalDecision } from '@app/specs/agent-approvals.spec';
import { AGENT_APPROVAL_BUTTONS } from '@app/specs/agent-panel.spec';
import { APPROVAL_ENABLE_DELAY_MS, type AgentState } from '@app/specs/agent-session.spec';
import { agentActions } from '../../agent-actions';
import { answerMessage, approvalCardModel, type ApprovalContext } from '../../agent-view';
import { usePromptArmed } from '../../hooks/usePromptArmed';

// The approval card (`agent-panel.feature.md`, Approvals; Task 4's review): main's oldest pending
// request, one at a time (the panel keys it by id, so a new request is a new card and never
// reorders under the pointer), "N more waiting" behind it. The Allow buttons stay disabled for
// `APPROVAL_ENABLE_DELAY_MS` after the card appears (and again after the window regains focus, or
// while the tab's fullscreen page covers the chrome), so a click meant for something else can't
// approve a call. Deny and Escape always work. It shows the page, `navigate`'s full destination,
// the chat asking when it isn't the one on screen, and the whole input; for `execute_javascript`
// the exact code in a scrollable, wrapping monospace block (nothing hides past its right edge; a
// hint says when more lies below) and its note.

/** Whether a scroller has content below what it shows. */
function useMoreBelow<T extends HTMLElement>(): [RefObject<T | null>, boolean, () => void] {
  const ref = useRef<T>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = ref.current;
    setMore(el !== null && el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  };
  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, more, measure];
}

type Approval = NonNullable<AgentState['approval']>;

export function AgentApprovalCard({ approval, covered, context }: { readonly approval: Approval; readonly covered: boolean; readonly context?: ApprovalContext }) {
  const model = approvalCardModel(approval, context);
  const [codeBlock, moreCode, measureCode] = useMoreBelow<HTMLPreElement>();
  const armed = usePromptArmed(covered, APPROVAL_ENABLE_DELAY_MS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);

  // Escape needs focus inside the card: it takes focus when nothing else holds it (the composer is
  // disabled while a turn runs) or focus is already in the panel. Never a button: Enter does nothing.
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body || active.closest('[data-testid="agent-panel"]') !== null) card.current?.focus({ preventScroll: true });
  }, []);

  const answer = (decision: ApprovalDecision) => {
    if (busy || (decision !== 'deny' && !armed)) return;
    setBusy(true);
    setMessage(null);
    void agentActions.answerApproval(model.id, decision).then((result) => {
      setMessage(answerMessage(result));
      setBusy(false);
    });
  };

  return (
    <section
      ref={card}
      className="agent-approval"
      role="dialog"
      aria-modal="false"
      aria-labelledby="agent-approval-title"
      tabIndex={-1}
      data-testid="agent-approval"
      data-approval-id={model.id}
      data-tool={model.toolName}
      data-armed={armed}
      data-untrusted={model.untrusted}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          answer('deny');
        }
      }}
    >
      <h3 className="agent-approval-title" id="agent-approval-title" data-testid="agent-approval-title">
        {model.title}
      </h3>
      <p className="agent-approval-label">{model.label}</p>
      {model.askingChat !== null ? (
        <p className="agent-approval-page" data-testid="agent-approval-chat">
          <span className="agent-approval-key">Asked by</span>
          <bdi className="agent-approval-url">{model.askingChat}</bdi>
        </p>
      ) : null}
      {model.destination !== null ? (
        <p className="agent-approval-page">
          <span className="agent-approval-key">Opens</span>
          <bdi className="agent-approval-url" data-testid="agent-approval-destination">
            {model.destination}
          </bdi>
        </p>
      ) : null}
      {model.pageUrl !== null ? (
        <p className="agent-approval-page">
          <span className="agent-approval-key">Page</span>
          <bdi className="agent-approval-url" data-testid="agent-approval-page">
            {model.pageUrl}
          </bdi>
        </p>
      ) : null}
      {model.code !== null ? (
        <pre ref={codeBlock} className="agent-code" data-testid="agent-approval-code" tabIndex={0} aria-label="The JavaScript to run" onScroll={measureCode}>
          <code>{model.code}</code>
        </pre>
      ) : null}
      {model.code !== null && moreCode ? (
        <p className="agent-approval-more" data-testid="agent-approval-code-more">
          More code below: scroll to read all of it
        </p>
      ) : null}
      {model.input !== null ? (
        <pre className="agent-pre agent-approval-input" data-testid="agent-approval-input" tabIndex={0} aria-label="The exact input">
          {model.input}
        </pre>
      ) : null}
      {model.note !== null ? (
        <p className="agent-approval-note" data-testid="agent-approval-note">
          {model.note}
        </p>
      ) : null}
      {message !== null ? (
        <p className="agent-approval-message" role="status" data-testid="agent-approval-message">
          {message}
        </p>
      ) : null}
      <div className="agent-approval-actions">
        <button type="button" className="agent-button" data-testid="agent-deny" disabled={busy} onClick={() => answer('deny')}>
          {AGENT_APPROVAL_BUTTONS.deny}
        </button>
        {model.showAlways ? (
          <button type="button" className="agent-button" data-testid="agent-allow-always" disabled={busy || !armed} onClick={() => answer('allow-always')}>
            {AGENT_APPROVAL_BUTTONS.allowAlways}
          </button>
        ) : null}
        <button type="button" className="agent-button agent-button-primary" data-testid="agent-allow-once" disabled={busy || !armed} onClick={() => answer('allow-once')}>
          {AGENT_APPROVAL_BUTTONS.allowOnce}
        </button>
      </div>
      {model.queuedText !== null ? (
        <p className="agent-approval-queued" data-testid="agent-approval-queued">
          {model.queuedText}
        </p>
      ) : null}
    </section>
  );
}
