import { useEffect, useRef, useState } from 'react';
import { CHATGPT_UI } from '@app/specs/agent-chatgpt.spec';
import type { CredentialSlot } from '@app/specs/agent-proxy.spec';
import type { ChatRetention } from '@app/specs/agent-data.spec';
import type { AgentSetupView } from '@app/specs/agent-session.spec';
import type { AgentModelId, ModelRoute } from '@app/specs/agent-tools.spec';
import type { AgentMcpView } from '@app/specs/agent-mcp.spec';
import { agentActions } from '../../agent-actions';
import { AgentMcp } from './AgentMcp';
import { ChatgptAccountSection } from './AgentChatgpt';
import {
  deleteAllChatsMessage,
  isolationLine,
  keySlotsFor,
  keyStateLabel,
  modelOptionGroups,
  previewModel,
  protectionMessage,
  retentionHint,
  retentionOptions,
  routeChoice,
  routeOptions,
  runtimeLine,
  setKeyMessage,
  slotForRoute,
  slotLabel,
} from '../../agent-view';

// The agent's settings (`agent-panel.feature.md`, Settings): the model route, the model (only the
// ones the route serves, grouped by provider: Phase 8 Task 7), a key field per slot, and plainly what protects a key and isolates the
// agent process. A stored key is never shown, nor any part of it: a slot says only "Key saved".
// The key field is a password input the panel never keeps in state: Save reads it, empties it at
// once, and shows main's answer (`AGENT_SET_KEY_MESSAGES`). Task 9 (`agent-data.feature.md`): how
// long chats are kept and "Delete all chats" (main confirms in its own dialog), and the ways to the
// grants page and the skills editor. Task 10 (`agent-mcp.feature.md`): the MCP servers (`AgentMcp`).
// The ChatGPT plan (`agent-chatgpt.feature.md`, Panel): a route with a sign-in instead of a key
// (`ChatgptAccountSection`) and the account's own models. Picked before the account listed a model,
// the route is only previewed (its sign-in shown, nothing stored: main refuses that pair); once the
// list arrives its first model is stored with the route.

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
          // Main asks first, in its own dialog, when the change would delete saved chats; the select
          // shows main's setting whatever the answer.
          void agentActions.setChatRetention(event.target.value as ChatRetention).then((result) => setMessage(result === 'failed' ? 'That choice could not be saved.' : null));
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
  mcp,
  onOpen,
}: {
  readonly setup: AgentSetupView;
  readonly grantsCount: number;
  readonly readToolsAllowed: boolean;
  readonly chatRetention: ChatRetention;
  /** The MCP servers (Task 10); absent: none, and none can be added. */
  readonly mcp?: AgentMcpView;
  readonly onOpen: (view: 'grants' | 'skills') => void;
}) {
  const [saveFailed, setSaveFailed] = useState(false);
  /** The ChatGPT plan picked before its account listed a model: shown, not stored. */
  const [preview, setPreview] = useState<'chatgpt' | null>(null);
  const store = (route: ModelRoute, modelId: AgentModelId) => {
    void agentActions.setModel(route, modelId).then((stored) => setSaveFailed(!stored));
  };
  const pickRoute = (route: ModelRoute) => {
    const choice = routeChoice(route, setup);
    setPreview(choice.kind === 'preview' ? 'chatgpt' : null);
    if (choice.kind === 'set') store(choice.route, choice.modelId);
  };
  // Previewing, the account listed its models (after a sign-in): the route is stored with the first.
  const listed = preview === 'chatgpt' ? previewModel(setup) : null;
  useEffect(() => {
    if (preview !== 'chatgpt') return;
    if (setup.route === 'chatgpt') setPreview(null);
    else if (listed !== null) {
      setPreview(null);
      store('chatgpt', listed);
    }
  }, [preview, listed, setup.route]);
  const route: ModelRoute = preview ?? setup.route;
  const slot = slotForRoute(route);
  return (
    <div className="agent-settings" data-testid="agent-settings">
      <section className="agent-section">
        <h3 className="agent-section-title">Model</h3>
        <label className="agent-field-label" htmlFor="agent-route">
          How frost reaches the model
        </label>
        <select id="agent-route" className="agent-select" data-testid="agent-route" value={route} onChange={(event) => pickRoute(event.target.value as ModelRoute)}>
          {routeOptions().map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {route === 'chatgpt' && (preview !== null || setup.allowedModels.length === 0) ? (
          // No account list yet: nothing to choose, so a heading (no label pointing at a missing select).
          <>
            <p className="agent-field-label">Model</p>
            <p className="agent-section-text agent-muted" data-testid="agent-model-none">
              {setup.chatgpt.account.state === 'signed-in' ? CHATGPT_UI.noModels : CHATGPT_UI.signInToChooseModel}
            </p>
          </>
        ) : (
          <>
            <label className="agent-field-label" htmlFor="agent-model">
              Model
            </label>
            <select id="agent-model" className="agent-select" data-testid="agent-model" value={setup.modelId} onChange={(event) => store(setup.route, event.target.value as AgentModelId)}>
              {modelOptionGroups(setup).map((group) => {
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
          </>
        )}
        {saveFailed ? (
          <p className="agent-key-message" role="status">
            That choice could not be saved.
          </p>
        ) : null}
      </section>
      {route === 'chatgpt' ? <ChatgptAccountSection account={setup.chatgpt.account} /> : null}
      <section className="agent-section">
        <h3 className="agent-section-title">Keys</h3>
        <p className="agent-section-text" data-testid="agent-protection" data-protection={setup.protection}>
          {protectionMessage(setup)}
        </p>
        {keySlotsFor(route).map((item) => (
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
          allowed a site; running JavaScript and MCP tools ask every time. Standing site grants: {grantsCount}.
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
      <AgentMcp mcp={mcp ?? { available: false, servers: [] }} />
      <ChatHistorySection chatRetention={chatRetention} />
    </div>
  );
}
