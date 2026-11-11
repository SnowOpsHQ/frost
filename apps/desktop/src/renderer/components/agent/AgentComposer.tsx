import { useEffect, useRef, useState, type RefObject } from 'react';
import type { AgentAttachableTab, AgentAttachmentView, AgentSkillView } from '@app/specs/agent-session.spec';
import { AGENT_ATTACH_MESSAGES, AGENT_ATTACH_WORDS, AGENT_ATTACHMENT_STATE_LABELS } from '@app/specs/agent-panel.spec';
import { MAX_CHAT_ATTACHMENTS } from '@app/specs/agent-tools.spec';
import { SKILL_LIBRARY_WORDS } from '@app/specs/agent-data.spec';
import { CHAT_TEXT_MAX_CHARS } from '@app/specs/agent-session.spec';
import { SKILL_SLOT_MAX_CHARS } from '@app/specs/skills.spec';
import { agentActions } from '../../agent-actions';
import { atMenuTrigger, attachmentName, canSend, composerKey, enabledSkills, pickedSkill, pickerSkills, skillOptionGroups, skillRequest, withoutAtTrigger, type SkillFieldValues } from '../../agent-view';
import { SendIcon, StopSquareIcon } from './agent-icons';

// The composer (`agent-panel.feature.md`, Composer): Enter sends, Shift+Enter is a new line. While a
// turn runs (one at a time, app-wide) the field is disabled and Send becomes Stop. A refused send
// keeps the text (main raises the notice); a started one clears it.
//
// Skills (Task 7, `skills.feature.md`, composer-skill-picker): a compact picker above the field lists
// main's skills. Picking one swaps the message field for the skill's description and the inputs it
// declares (each optional; Enter in one runs it), and Send for Run. The picker is disabled while a
// turn runs. Run sends only the skill's id and its inputs: main renders the skill. The picker lists
// the skills switched on (Phase 8 Task 5, `agent-data.feature.md`, Skills library) and a search box
// narrows them; a skill picked and then switched off drops back to the message field.
//
// @-attached tabs (Phase 11 Task 9, `agent-attach.feature.md`): typing `@` at the start of a word, or
// the Attach button, opens a menu of the other open web tabs main lists (title as React text, and
// origin); picking one asks main to attach it (to the selected chat, or the new chat the next message
// starts) and drops the `@` typed. The chips show each attachment's (untrusted) title, origin and
// state, with Detach. The user alone attaches: nothing the model says reaches this menu. The menu is a
// labelled group of buttons (Tab moves through them, Escape closes it), not an ARIA menu.

/** The `@` menu: main's list (`null` while it loads), a refusal to show, and where the `@` was typed. */
interface AttachMenu {
  readonly tabs: readonly AgentAttachableTab[] | null;
  readonly message: string | null;
  /** The caret just after the typed `@` (dropped when a tab is picked); `null` from the button. */
  readonly at: number | null;
}

function AttachmentChips({ chatId, attachments }: { readonly chatId: string | null; readonly attachments: readonly AgentAttachmentView[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="agent-attachments" data-testid="agent-attachments">
      {attachments.map((attachment) => {
        const name = attachmentName(attachment);
        const state = AGENT_ATTACHMENT_STATE_LABELS[attachment.state];
        return (
          <li key={attachment.ref} className="agent-attachment" data-testid="agent-attachment" data-ref={attachment.ref} data-state={attachment.state}>
            <span className="agent-attachment-text">
              <bdi dir="auto" className="agent-attachment-title" data-testid="agent-attachment-title">
                {name}
              </bdi>
              <span className="agent-attachment-origin" data-testid="agent-attachment-origin">
                {attachment.origin}
              </span>
              {state !== '' ? (
                <span className="agent-attachment-state" data-testid="agent-attachment-state">
                  {state}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              className="tool agent-attachment-detach"
              data-testid="agent-attachment-detach"
              aria-label={`${AGENT_ATTACH_WORDS.detach}: ${name}`}
              title={AGENT_ATTACH_WORDS.detach}
              onClick={() => void agentActions.detachTab(chatId, attachment.ref)}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function AgentComposer({
  chatId,
  running,
  stopChatId,
  inputRef,
  skills = [],
  attachments = [],
}: {
  /** The selected chat (`null`: the next message starts a new one). */
  readonly chatId: string | null;
  readonly running: boolean;
  /** The running chat, for Stop. */
  readonly stopChatId: string | null;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The skills main lists (`AgentState.skills`). */
  readonly skills?: readonly AgentSkillView[];
  /** The selected chat's attached tabs, or the new chat's (`AgentState.draftAttachments`). */
  readonly attachments?: readonly AgentAttachmentView[];
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [skillId, setSkillId] = useState('');
  const [fields, setFields] = useState<SkillFieldValues>({});
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<AttachMenu | null>(null);
  // Counts menu openings: a list main answers for an earlier one (another chat's) is dropped.
  const menuOpenings = useRef(0);
  const wasRunning = useRef(running);
  const full = attachments.length >= MAX_CHAT_ATTACHMENTS;
  const offered = enabledSkills(skills);
  const skill = pickedSkill(offered, skillId);
  const matching = pickerSkills(skills, query, skillId);

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

  // ---- The `@` menu ----
  const openMenu = (at: number | null) => {
    const opening = ++menuOpenings.current;
    setMenu({ tabs: null, message: full ? AGENT_ATTACH_WORDS.full : null, at });
    if (full) return;
    void agentActions.attachableTabs(chatId).then((tabs) => {
      if (opening === menuOpenings.current) setMenu((current) => (current === null ? null : { ...current, tabs }));
    });
  };
  const closeMenu = () => setMenu(null);
  // Another chat selected: its own menu, if any, starts afresh.
  useEffect(() => setMenu(null), [chatId]);
  const attach = (tab: AgentAttachableTab) => {
    const at = menu?.at ?? null;
    void agentActions.attachTab(chatId, tab.tabId, tab.origin).then((result) => {
      if (result !== 'attached') {
        setMenu((current) => (current === null ? null : { ...current, message: AGENT_ATTACH_MESSAGES[result] }));
        return;
      }
      setMenu(null);
      // The `@` that opened the menu is replaced by the chip.
      if (at !== null) setText((current) => withoutAtTrigger(current, at).text);
      inputRef.current?.focus();
    });
  };

  const attachRow = (
    <div className="agent-attach-row">
      <AttachmentChips chatId={chatId} attachments={attachments} />
      <button
        type="button"
        className="tool agent-attach-button"
        data-testid="agent-attach"
        aria-label={AGENT_ATTACH_WORDS.button}
        title={AGENT_ATTACH_WORDS.button}
        aria-expanded={menu !== null}
        disabled={running || sending}
        onClick={() => (menu === null ? openMenu(null) : closeMenu())}
      >
        @
      </button>
      {menu !== null ? (
        <div
          className="agent-attach-menu"
          role="group"
          aria-label={AGENT_ATTACH_WORDS.menuLabel}
          data-testid="agent-attach-menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeMenu();
              inputRef.current?.focus();
            }
          }}
        >
          {menu.message !== null ? (
            <p className="agent-section-text agent-muted" role="status" data-testid="agent-attach-message">
              {menu.message}
            </p>
          ) : null}
          {menu.tabs !== null && menu.tabs.length === 0 && menu.message === null ? (
            <p className="agent-section-text agent-muted" role="status" data-testid="agent-attach-none">
              {AGENT_ATTACH_WORDS.none}
            </p>
          ) : null}
          {(menu.tabs ?? []).map((tab) => (
            <button key={tab.tabId} type="button" className="agent-attach-option" data-testid="agent-attach-option" data-tab-id={tab.tabId} onClick={() => attach(tab)}>
              <bdi dir="auto" className="agent-attachment-title">
                {attachmentName(tab)}
              </bdi>
              <span className="agent-attachment-origin">{tab.origin}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  const stopButton = (
    <button type="button" className="agent-button agent-send" data-testid="agent-stop" disabled={stopping || stopChatId === null} onClick={stop}>
      <StopSquareIcon />
      <span>Stop</span>
    </button>
  );

  return (
    <div className="agent-composer-area">
      {attachRow}
      {offered.length > 0 ? (
        <input
          type="search"
          className="agent-text-field agent-skill-search"
          data-testid="agent-skill-search"
          aria-label={SKILL_LIBRARY_WORDS.searchPlaceholder}
          placeholder={SKILL_LIBRARY_WORDS.searchPlaceholder}
          value={query}
          disabled={running || sending}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {offered.length > 0 && query.trim() !== '' && matching.length === 0 ? (
        <p className="agent-section-text agent-muted" role="status" data-testid="agent-skill-no-match">
          {SKILL_LIBRARY_WORDS.noMatch}
        </p>
      ) : null}
      {offered.length > 0 ? (
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
            {skillOptionGroups(matching).map((group) => {
              const options = group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ));
              return group.label === null ? (
                options
              ) : (
                <optgroup key={group.label} label={group.label}>
                  {options}
                </optgroup>
              );
            })}
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
            onChange={(event) => {
              const value = event.target.value;
              setText(value);
              // `@` typed at the start of a word opens the attach menu (it stays in the text unless a tab is picked).
              const caret = event.target.selectionStart ?? value.length;
              if (value.length > text.length && atMenuTrigger(value, caret)) openMenu(caret);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && menu !== null) {
                event.preventDefault();
                closeMenu();
                return;
              }
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
