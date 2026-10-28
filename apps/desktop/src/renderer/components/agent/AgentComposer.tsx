import { useEffect, useRef, useState, type RefObject } from 'react';
import { CHAT_TEXT_MAX_CHARS } from '@app/specs/agent-session.spec';
import { agentActions } from '../../agent-actions';
import { canSend, composerKey } from '../../agent-view';
import { SendIcon, StopSquareIcon } from './agent-icons';

// The composer (`agent-panel.feature.md`, Composer): Enter sends, Shift+Enter is a new line. While a
// turn runs (one at a time, app-wide) the field is disabled and Send becomes Stop. A refused send
// keeps the text (main raises the notice); a started one clears it.

export function AgentComposer({
  chatId,
  running,
  stopChatId,
  inputRef,
}: {
  /** The selected chat (`null`: the next message starts a new one). */
  readonly chatId: string | null;
  readonly running: boolean;
  /** The running chat, for Stop. */
  readonly stopChatId: string | null;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const wasRunning = useRef(running);

  // Back from a turn: focus returns to the field if disabling it had dropped focus.
  useEffect(() => {
    if (wasRunning.current && !running) {
      setStopping(false);
      if (document.activeElement === null || document.activeElement === document.body) inputRef.current?.focus();
    }
    wasRunning.current = running;
  }, [running, inputRef]);

  const send = () => {
    if (!canSend(text, running, sending)) return;
    setSending(true);
    void agentActions.send(chatId, text).then((result) => {
      setSending(false);
      if (result === 'started') setText('');
    });
  };
  const stop = () => {
    if (stopChatId === null || stopping) return;
    setStopping(true);
    void agentActions.stop(stopChatId).then((stopped) => {
      if (!stopped) setStopping(false);
    });
  };

  return (
    <form
      className="agent-composer"
      data-testid="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        ref={inputRef}
        className="agent-input"
        data-testid="agent-input"
        aria-label="Message the agent"
        placeholder={running ? 'The agent is working…' : 'Ask about this page'}
        rows={3}
        maxLength={CHAT_TEXT_MAX_CHARS}
        value={text}
        disabled={running || sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (composerKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing }) === 'send') {
            event.preventDefault();
            send();
          }
        }}
      />
      {running ? (
        <button type="button" className="agent-button agent-send" data-testid="agent-stop" disabled={stopping || stopChatId === null} onClick={stop}>
          <StopSquareIcon />
          <span>Stop</span>
        </button>
      ) : (
        <button type="submit" className="agent-button agent-button-primary agent-send" data-testid="agent-send" disabled={!canSend(text, running, sending)}>
          <SendIcon />
          <span>Send</span>
        </button>
      )}
    </form>
  );
}
