import { useRef, useState } from 'react';
import type { CredentialSlot } from '@app/specs/agent-proxy.spec';
import type { ChatRetention } from '@app/specs/agent-data.spec';
import type { AgentSetupView } from '@app/specs/agent-session.spec';
import type { ModelId, ModelRoute } from '@app/specs/agent-tools.spec';
import { agentActions } from '../../agent-actions';
import {
  deleteAllChatsMessage,
  isolationLine,
  keySlotsFor,
  keyStateLabel,
  modelForRoute,
  modelOptions,
  protectionMessage,
  retentionHint,
  retentionOptions,
  routeOptions,
  runtimeLine,
  setKeyMessage,
  slotForRoute,
  slotLabel,
} from '../../agent-view';

// The agent's settings (`agent-panel.feature.md`, Settings): the model route, the model (only the
// ones the route serves), a key field per slot, and plainly what protects a key and isolates the
// agent process. A stored key is never shown, nor any part of it: a slot says only "Key saved".
// The key field is a password input the panel never keeps in state: Save reads it, empties it at
// once, and shows main's answer (`AGENT_SET_KEY_MESSAGES`). Task 9 (`agent-data.feature.md`): how
// long chats are kept and "Delete all chats" (main confirms in its own dialog), and the ways to the
// grants page and the skills editor.

function KeyRow({ slot, set, primary }: { readonly slot: CredentialSlot; readonly set: boolean; readonly primary: boolean }) {
  const field = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `agent-key-${slot}`;

  const save = () => {
    const input = field.current;
    if (input === null || busy) return;
    const key = input.value;
    // Out of the DOM before the call: the typed key is never left on the page.
    input.value = '';
    if (key.trim() === '') {
      setMessage('Paste a key first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    void agentActions.setKey(slot, key).then((result) => {
      setBusy(false);
      setMessage(setKeyMessage(result));
    });
  };
  const clear = () => {
    if (busy) return;
    setBusy(true);
    void agentActions.clearKey(slot).then((cleared) => {
      setBusy(false);
      setMessage(cleared ? 'Key removed.' : 'The key could not be removed. Try again.');
    });
  };

  return (
    <div className="agent-key" data-testid="agent-key" data-slot={slot} data-primary={primary} data-set={set}>
      <div className="agent-key-head">
        <label className="agent-field-label" htmlFor={id}>
          {slotLabel(slot)}
        </label>
        <span className="agent-chip" data-testid="agent-key-state" data-tone={set ? 'ok' : 'pending'}>
          {keyStateLabel(set)}
        </span>
      </div>
      <div className="agent-key-row">
        <input
          ref={field}
          id={id}
          className="agent-text-field"
          data-testid="agent-key-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={set ? 'Replace the saved key' : 'Paste a key'}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              save();
            }
          }}
        />
        <button type="button" className="agent-button agent-button-primary" data-testid="agent-key-save" disabled={busy} onClick={save}>
          Save
        </button>
        <button type="button" className="agent-button" data-testid="agent-key-clear" disabled={busy || !set} onClick={clear}>
          Clear
        </button>
      </div>
      {message !== null ? (
        <p className="agent-key-message" role="status" data-testid="agent-key-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function ChatHistorySection({ chatRetention }: { readonly chatRetention: ChatRetention }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="agent-section" data-testid="agent-chat-history">
      <h3 className="agent-section-title">Chat history</h3>
      <label className="agent-field-label" htmlFor="agent-retention">
        How long frost keeps chats
      </label>
      <select
        id="agent-retention"
        className="agent-select"
        data-testid="agent-retention"
        value={chatRetention}
        onChange={(event) => {
          void agentActions.setChatRetention(event.target.value as ChatRetention).then((ok) => setMessage(ok ? null : 'That choice could not be saved.'));
        }}
      >
        {retentionOptions().map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="agent-section-text agent-muted" data-testid="agent-retention-hint">
        {retentionHint(chatRetention)} Saved chats never hold a key.
      </p>
      <div className="agent-key-row">
        <button
          type="button"
          className="agent-button"
          data-testid="agent-delete-all-chats"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            void agentActions.deleteAllChats().then((result) => {
              setBusy(false);
              setMessage(deleteAllChatsMessage(result));
            });
          }}
        >
          Delete all chats…
        </button>
      </div>
      {message !== null ? (
        <p className="agent-key-message" role="status" data-testid="agent-chat-history-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}

export function AgentSettings({
  setup,
  grantsCount,
  readToolsAllowed,
  chatRetention,
  onOpen,
}: {
  readonly setup: AgentSetupView;
  readonly grantsCount: number;
  readonly readToolsAllowed: boolean;
  readonly chatRetention: ChatRetention;
  readonly onOpen: (view: 'grants' | 'skills') => void;
}) {
  const [saveFailed, setSaveFailed] = useState(false);
  const choose = (route: ModelRoute, modelId: ModelId | null) => {
    if (modelId === null) return;
    void agentActions.setModel(route, modelId).then((stored) => setSaveFailed(!stored));
  };
  const slot = slotForRoute(setup.route);
  return (
    <div className="agent-settings" data-testid="agent-settings">
      <section className="agent-section">
        <h3 className="agent-section-title">Model</h3>
        <label className="agent-field-label" htmlFor="agent-route">
          How frost reaches the model
        </label>
        <select id="agent-route" className="agent-select" data-testid="agent-route" value={setup.route} onChange={(event) => choose(event.target.value as ModelRoute, modelForRoute(event.target.value as ModelRoute, setup.modelId))}>
          {routeOptions().map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <label className="agent-field-label" htmlFor="agent-model">
          Model
        </label>
        <select id="agent-model" className="agent-select" data-testid="agent-model" value={setup.modelId} onChange={(event) => choose(setup.route, event.target.value as ModelId)}>
          {modelOptions(setup).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {saveFailed ? (
          <p className="agent-key-message" role="status">
            That choice could not be saved.
          </p>
        ) : null}
      </section>
      <section className="agent-section">
        <h3 className="agent-section-title">Keys</h3>
        <p className="agent-section-text" data-testid="agent-protection" data-protection={setup.protection}>
          {protectionMessage(setup)}
        </p>
        {keySlotsFor(setup.route).map((item) => (
          <KeyRow key={item} slot={item} set={setup.keys[item] === true} primary={item === slot} />
        ))}
        <p className="agent-section-text">Keys stay with frost's main process. The page, the agent process and the model never see them.</p>
      </section>
      <section className="agent-section">
        <h3 className="agent-section-title">Safety</h3>
        <p className="agent-section-text" data-testid="agent-isolation">
          {isolationLine(setup)}
        </p>
        <p className="agent-section-text agent-muted" data-testid="agent-isolation-note">
          {setup.isolation.note}
        </p>
        <p className="agent-section-text" data-testid="agent-runtime-status" data-status={setup.runtime.status}>
          Agent process status: {runtimeLine(setup.runtime)}
        </p>
        <p className="agent-section-text">
          {readToolsAllowed ? 'Reading tools run without asking on public pages.' : 'Every tool asks before it runs.'} Opening pages and clicking ask first unless you
          allowed a site; running JavaScript asks every time. Standing site grants: {grantsCount}.
        </p>
        <div className="agent-key-row">
          <button type="button" className="agent-button" data-testid="agent-open-grants" onClick={() => onOpen('grants')}>
            Site grants…
          </button>
          <button type="button" className="agent-button" data-testid="agent-open-skills" onClick={() => onOpen('skills')}>
            Skills…
          </button>
        </div>
      </section>
      <ChatHistorySection chatRetention={chatRetention} />
    </div>
  );
}
