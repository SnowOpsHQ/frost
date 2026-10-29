import { useEffect, useRef, useState, type RefObject } from 'react';
import type { AgentSkillView } from '@app/specs/agent-session.spec';
import { CHAT_TEXT_MAX_CHARS } from '@app/specs/agent-session.spec';
import { SKILL_SLOT_MAX_CHARS } from '@app/specs/skills.spec';
import { agentActions } from '../../agent-actions';
import { canSend, composerKey, pickedSkill, skillOptions, skillRequest, type SkillFieldValues } from '../../agent-view';
import { SendIcon, StopSquareIcon } from './agent-icons';

// The composer (`agent-panel.feature.md`, Composer): Enter sends, Shift+Enter is a new line. While a
// turn runs (one at a time, app-wide) the field is disabled and Send becomes Stop. A refused send
// keeps the text (main raises the notice); a started one clears it.
//
// Skills (Task 7, `skills.feature.md`, composer-skill-picker): a compact picker above the field lists
// main's skills. Picking one swaps the message field for the skill's description and the inputs it
// declares (each optional; Enter in one runs it), and Send for Run. The picker is disabled while a
// turn runs. Run sends only the skill's id and its inputs: main renders the skill.

export function AgentComposer({
  chatId,
  running,
  stopChatId,
  inputRef,
  skills = [],
}: {
  /** The selected chat (`null`: the next message starts a new one). */
  readonly chatId: string | null;
  readonly running: boolean;
  /** The running chat, for Stop. */
  readonly stopChatId: string | null;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The skills main lists (`AgentState.skills`). */
  readonly skills?: readonly AgentSkillView[];
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [skillId, setSkillId] = useState('');
  const [fields, setFields] = useState<SkillFieldValues>({});
  const wasRunning = useRef(running);
  const skill = pickedSkill(skills, skillId);

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
  const runSkill = () => {
    if (skill === null || running || sending) return;
    setSending(true);
    void agentActions.send(chatId, skillRequest(skill, fields)).then((result) => {
      setSending(false);
      if (result === 'started') {
        setSkillId('');
        setFields({});
      }
    });
  };
  const stop = () => {
    if (stopChatId === null || stopping) return;
    setStopping(true);
    void agentActions.stop(stopChatId).then((stopped) => {
      if (!stopped) setStopping(false);
    });
  };

  const stopButton = (
    <button type="button" className="agent-button agent-send" data-testid="agent-stop" disabled={stopping || stopChatId === null} onClick={stop}>
      <StopSquareIcon />
      <span>Stop</span>
    </button>
  );

  return (
    <div className="agent-composer-area">
      {skills.length > 0 ? (
        <label className="agent-skill-bar">
          <span className="agent-skill-bar-label">Skill</span>
          <select
            className="agent-select agent-skill-select"
            data-testid="agent-skill-picker"
            aria-label="Run a skill"
            value={skill === null ? '' : skill.id}
            disabled={running || sending}
            onChange={(event) => {
              setSkillId(event.target.value);
              setFields({});
            }}
          >
            {skillOptions(skills).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {skill !== null ? (
        <form
          className="agent-composer"
          data-testid="agent-composer"
          data-mode="skill"
          onSubmit={(event) => {
            event.preventDefault();
            runSkill();
          }}
        >
          <div className="agent-skill" data-testid="agent-skill">
            <p className="agent-skill-description" data-testid="agent-skill-description">
              {skill.description}
            </p>
            {skill.inputs.map((input) => (
              <input
                key={input.slot}
                className="agent-text-field agent-skill-input"
                data-testid={`agent-skill-input-${input.slot}`}
                aria-label={input.label}
                placeholder={input.placeholder ?? input.label}
                maxLength={SKILL_SLOT_MAX_CHARS[input.slot]}
                value={fields[input.slot] ?? ''}
                disabled={running || sending}
                onChange={(event) => setFields({ ...fields, [input.slot]: event.target.value })}
              />
            ))}
          </div>
          {running ? (
            stopButton
          ) : (
            <button type="submit" className="agent-button agent-button-primary agent-send" data-testid="agent-skill-run" disabled={sending}>
              <SendIcon />
              <span>Run</span>
            </button>
          )}
        </form>
      ) : (
        <form
          className="agent-composer"
          data-testid="agent-composer"
          data-mode="message"
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
            stopButton
          ) : (
            <button type="submit" className="agent-button agent-button-primary agent-send" data-testid="agent-send" disabled={!canSend(text, running, sending)}>
              <SendIcon />
              <span>Send</span>
            </button>
          )}
        </form>
      )}
    </div>
  );
}
