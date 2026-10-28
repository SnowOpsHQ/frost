import { useLayoutEffect, useRef, useState } from 'react';
import type { AgentActiveChatView, AgentMessageView, AgentNoticeView, AgentSetupView } from '@app/specs/agent-session.spec';
import { isAtBottom, setupChecklist, userMessageSkillLabel, visibleNotice } from '../../agent-view';
import { CloseIcon } from '../../icons';
import { AgentToolCard } from './AgentToolCard';

// The selected chat (`agent-panel.feature.md`, Chat): its messages oldest first, the assistant's
// text as it streams, tool cards, the last turn's error and a refused send's notice. Every text is
// a React text child (model and page text are never parsed as HTML or Markdown). The list follows
// the stream while it is scrolled to the bottom and leaves the user's place alone otherwise.

function Message({ message }: { readonly message: AgentMessageView }) {
  if (message.kind === 'user') {
    // A skill run shows the skill's name and the user's note, never the skill's template.
    const skill = userMessageSkillLabel(message);
    return (
      <div className="agent-msg agent-msg-user" data-testid="agent-message" data-kind="user" data-skill={message.skill?.id}>
        {skill !== null ? (
          <p className="agent-msg-skill" data-testid="agent-message-skill">
            {skill}
          </p>
        ) : null}
        {message.text !== '' ? <p className="agent-msg-text">{message.text}</p> : null}
      </div>
    );
  }
  return (
    <div className="agent-msg agent-msg-assistant" data-testid="agent-message" data-kind="assistant" data-streaming={message.streaming}>
      {message.text !== '' || message.streaming ? (
        <p className="agent-msg-text" data-testid="agent-assistant-text">
          {message.text}
          {message.streaming ? <span className="agent-caret" aria-hidden="true" /> : null}
        </p>
      ) : null}
      {message.tools.map((card) => (
        <AgentToolCard key={card.callId} card={card} />
      ))}
    </div>
  );
}

function SetupHint({ setup, onOpenSettings }: { readonly setup: AgentSetupView; readonly onOpenSettings: () => void }) {
  return (
    <div className="agent-hint" data-testid="agent-setup-hint">
      <p className="agent-hint-title">Set up the agent</p>
      <ul className="agent-checklist">
        {setupChecklist(setup)
          .filter((item) => item.id !== 'isolation')
          .map((item) => (
            <li key={item.id} className="agent-check" data-ok={item.ok}>
              <span className="agent-check-label">{item.label}</span>
              <span className="agent-check-value">{item.value}</span>
            </li>
          ))}
      </ul>
      <button type="button" className="agent-button agent-button-primary" data-testid="agent-open-settings" onClick={onOpenSettings}>
        Open agent settings
      </button>
    </div>
  );
}

export function AgentChat({
  active,
  setup,
  notice,
  onOpenSettings,
}: {
  readonly active: AgentActiveChatView | null;
  readonly setup: AgentSetupView;
  readonly notice: AgentNoticeView | null;
  readonly onOpenSettings: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [dismissed, setDismissed] = useState(0);
  const shownNotice = visibleNotice(notice, dismissed);
  const messages = active?.messages ?? [];

  // A new chat starts at its end.
  useLayoutEffect(() => {
    follow.current = true;
  }, [active?.id]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="agent-chat" ref={scroller} data-testid="agent-chat" onScroll={(event) => (follow.current = isAtBottom(event.currentTarget))}>
      {active?.truncated ? <p className="agent-truncated">Earlier messages are not shown.</p> : null}
      {messages.length === 0 ? (
        setup.ready ? (
          <div className="agent-hint" data-testid="agent-empty">
            <p className="agent-hint-title">Ask about this page</p>
            <p className="agent-hint-text">The agent reads the page's audit, facts and text. It asks you before it opens a page, clicks or runs code.</p>
          </div>
        ) : (
          <SetupHint setup={setup} onOpenSettings={onOpenSettings} />
        )
      ) : (
        messages.map((message) => <Message key={message.id} message={message} />)
      )}
      {active?.error ? (
        <p className="agent-banner" role="alert" data-testid="agent-error" data-tone="error">
          {active.error}
        </p>
      ) : null}
      {shownNotice !== null ? (
        <div className="agent-banner" role="status" data-testid="agent-notice" data-kind={shownNotice.kind}>
          <span className="agent-banner-text">{shownNotice.message}</span>
          {shownNotice.kind === 'setup-needed' ? (
            <button type="button" className="agent-link" onClick={onOpenSettings}>
              Settings
            </button>
          ) : null}
          <button type="button" className="tool agent-banner-close" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(shownNotice.seq)}>
            <CloseIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
}
