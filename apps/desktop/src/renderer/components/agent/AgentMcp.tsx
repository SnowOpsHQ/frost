import { useRef, useState } from 'react';
import type { AgentMcpView } from '@app/specs/agent-mcp.spec';
import { agentActions } from '../../agent-actions';
import { emptyMcpDraft, mcpDraftToInput, mcpSaveMessage, mcpServerItems, mcpStartMessage, mcpTokenMessage, MCP_SETTINGS_WORDS, MCP_UNTRUSTED_LABEL, type McpServerDraft, type McpServerItem } from '../../agent-view';

// The MCP servers section of the agent settings (`agent-mcp.feature.md`, Settings): every server is
// labelled "Untrusted", says in a sentence how it is contained (or, plainly, that it runs without a
// sandbox), and shows its status, tool count and last error as text. Use in chats (on / off),
// Start / Stop (a command server's Start opens main's own dialog with the exact command line),
// Delete (asks once more here), and for an HTTP server a write-only token field. The add form takes
// an HTTP URL, or a command with one argument per line (no shell: each line is one argument), the
// folders a sandbox may read, whether it may use the network, and environment variables (their
// values are password fields, sent once and never shown again).

function TokenRow({ server }: { readonly server: McpServerItem }) {
  const field = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (clear: boolean) => {
    const input = field.current;
    if (input === null || busy) return;
    const token = input.value;
    // Out of the DOM before the call: the typed token is never left on the page.
    input.value = '';
    if (!clear && token.trim() === '') {
      setMessage('Paste a token first.');
      return;
    }
    setBusy(true);
    void agentActions.setMcpToken(server.id, clear ? null : token).then((result) => {
      setBusy(false);
      setMessage(mcpTokenMessage(result));
    });
  };
  return (
    <div className="agent-key-row" data-testid="agent-mcp-token">
      <input
        ref={field}
        className="agent-text-field"
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={`Bearer token for ${server.name}`}
        placeholder={server.hasToken ? 'Replace the saved token' : 'Bearer token (optional)'}
        data-testid="agent-mcp-token-input"
      />
      <button type="button" className="agent-button" disabled={busy} onClick={() => save(false)} data-testid="agent-mcp-token-save">
        Save
      </button>
      <button type="button" className="agent-button" disabled={busy || !server.hasToken} onClick={() => save(true)}>
        Clear
      </button>
      {message !== null ? (
        <p className="agent-key-message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function ServerRow({ server }: { readonly server: McpServerItem }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const act = (run: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    void run().then((text) => {
      setBusy(false);
      setMessage(text);
    });
  };
  return (
    <li className="agent-mcp-server" data-testid="agent-mcp-server" data-server={server.id} data-status={server.status} data-transport={server.transport}>
      <div className="agent-mcp-head">
        <span className="agent-mcp-name">{server.name}</span>
        <span className="agent-chip agent-untrusted" data-testid="agent-mcp-untrusted">
          {MCP_UNTRUSTED_LABEL}
        </span>
        <span className="agent-chip" data-tone={server.tone} data-testid="agent-mcp-status">
          {server.statusLabel}
        </span>
      </div>
      <p className="agent-section-text agent-muted">
        {server.transportLabel}: <bdi className="agent-mcp-target" data-testid="agent-mcp-target">{server.target}</bdi>
      </p>
      <p className="agent-section-text" data-testid="agent-mcp-sandbox" data-unsandboxed={server.unsandboxed}>
        {server.sandboxNote}
      </p>
      {server.envNames.length > 0 ? <p className="agent-section-text agent-muted">Environment: {server.envNames.join(', ')} (values saved, never shown)</p> : null}
      {server.toolsText !== '' ? (
        <p className="agent-section-text" data-testid="agent-mcp-tools">
          {server.toolsText}
        </p>
      ) : null}
      {server.error !== null ? (
        <p className="agent-field-error" data-testid="agent-mcp-error">
          {server.error}
        </p>
      ) : null}
      <div className="agent-key-row">
        <label className="agent-toggle">
          <input
            type="checkbox"
            data-testid="agent-mcp-enabled"
            checked={server.enabled}
            disabled={busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              act(async () => ((await agentActions.setMcpServerEnabled(server.id, enabled)) ? null : 'That could not be saved.'));
            }}
          />
          <span>Use in chats</span>
        </label>
        {server.canStop ? (
          <button type="button" className="agent-button" data-testid="agent-mcp-stop" disabled={busy} onClick={() => act(async () => ((await agentActions.stopMcpServer(server.id)) ? null : 'The server could not be stopped.'))}>
            Stop
          </button>
        ) : (
          <button type="button" className="agent-button agent-button-primary" data-testid="agent-mcp-start" disabled={busy || !server.canStart} onClick={() => act(async () => mcpStartMessage(await agentActions.startMcpServer(server.id)))}>
            Start
          </button>
        )}
        {confirmDelete ? (
          <button type="button" className="agent-button" data-testid="agent-mcp-delete-confirm" disabled={busy} onClick={() => act(async () => ((await agentActions.deleteMcpServer(server.id)) ? null : 'The server could not be deleted.'))}>
            Delete it
          </button>
        ) : (
          <button type="button" className="agent-button" data-testid="agent-mcp-delete" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete…
          </button>
        )}
      </div>
      {server.transport === 'http' ? <TokenRow server={server} /> : null}
      {message !== null ? (
        <p className="agent-key-message" role="status" data-testid="agent-mcp-message">
          {message}
        </p>
      ) : null}
    </li>
  );
}

function AddServer() {
  const [draft, setDraft] = useState<McpServerDraft>(emptyMcpDraft);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (changes: Partial<McpServerDraft>) => setDraft({ ...draft, ...changes });
  const save = () => {
    const input = mcpDraftToInput(draft);
    if (input === null) {
      setMessage('Give the server a name and an address or a command.');
      return;
    }
    setBusy(true);
    setMessage(null);
    void agentActions.saveMcpServer(input).then(({ result }) => {
      setBusy(false);
      setMessage(mcpSaveMessage(result));
      // Values typed into the form leave it once saved.
      if (result === 'saved') setDraft(emptyMcpDraft());
    });
  };
  return (
    <div className="agent-mcp-add" data-testid="agent-mcp-add">
      <h4 className="agent-field-label">Add a server</h4>
      <label className="agent-field-label" htmlFor="agent-mcp-name">
        Name
      </label>
      <input id="agent-mcp-name" className="agent-text-field" data-testid="agent-mcp-field-name" value={draft.name} maxLength={96} onChange={(event) => set({ name: event.target.value })} />
      <label className="agent-field-label" htmlFor="agent-mcp-transport">
        Kind
      </label>
      <select id="agent-mcp-transport" className="agent-select" data-testid="agent-mcp-field-transport" value={draft.transport} onChange={(event) => set({ transport: event.target.value === 'http' ? 'http' : 'stdio' })}>
        <option value="stdio">A command on this computer</option>
        <option value="http">An HTTPS address</option>
      </select>
      {draft.transport === 'http' ? (
        <>
          <label className="agent-field-label" htmlFor="agent-mcp-url">
            Address (https only)
          </label>
          <input id="agent-mcp-url" className="agent-text-field" data-testid="agent-mcp-field-url" value={draft.url} spellCheck={false} placeholder="https://" onChange={(event) => set({ url: event.target.value })} />
        </>
      ) : (
        <>
          <label className="agent-field-label" htmlFor="agent-mcp-command">
            Command (a program name or an absolute path; no shell)
          </label>
          <input id="agent-mcp-command" className="agent-text-field" data-testid="agent-mcp-field-command" value={draft.command} spellCheck={false} onChange={(event) => set({ command: event.target.value })} />
          <label className="agent-field-label" htmlFor="agent-mcp-args">
            Arguments (one per line, exactly as given)
          </label>
          <textarea id="agent-mcp-args" className="agent-input agent-mcp-lines" data-testid="agent-mcp-field-args" rows={3} spellCheck={false} value={draft.args} onChange={(event) => set({ args: event.target.value })} />
          <label className="agent-field-label" htmlFor="agent-mcp-read">
            Folders a sandbox lets it read (one absolute path per line)
          </label>
          <textarea id="agent-mcp-read" className="agent-input agent-mcp-lines" data-testid="agent-mcp-field-read" rows={2} spellCheck={false} value={draft.readPaths} onChange={(event) => set({ readPaths: event.target.value })} />
          <label className="agent-toggle">
            <input type="checkbox" data-testid="agent-mcp-field-network" checked={draft.allowNetwork} onChange={(event) => set({ allowNetwork: event.target.checked })} />
            <span>Let it use the network (in a sandbox; without one it always can)</span>
          </label>
          <fieldset className="agent-fieldset">
            <legend className="agent-field-label">Environment variables (values are stored encrypted, never shown again)</legend>
            {draft.env.map((item, index) => (
              <div className="agent-key-row" key={index}>
                <input
                  className="agent-text-field"
                  aria-label="Variable name"
                  value={item.name}
                  spellCheck={false}
                  onChange={(event) => set({ env: draft.env.map((row, i) => (i === index ? { ...row, name: event.target.value } : row)) })}
                />
                <input
                  className="agent-text-field"
                  type="password"
                  autoComplete="off"
                  aria-label="Variable value"
                  value={item.value}
                  onChange={(event) => set({ env: draft.env.map((row, i) => (i === index ? { ...row, value: event.target.value } : row)) })}
                />
                <button type="button" className="agent-button" onClick={() => set({ env: draft.env.filter((_row, i) => i !== index) })}>
                  Remove
                </button>
              </div>
            ))}
            <div className="agent-key-row">
              <button type="button" className="agent-button" disabled={draft.env.length >= 16} onClick={() => set({ env: [...draft.env, { name: '', value: '' }] })}>
                Add a variable
              </button>
            </div>
          </fieldset>
        </>
      )}
      <div className="agent-key-row">
        <button type="button" className="agent-button agent-button-primary" data-testid="agent-mcp-save" disabled={busy} onClick={save}>
          Add server
        </button>
      </div>
      {message !== null ? (
        <p className="agent-key-message" role="status" data-testid="agent-mcp-save-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function AgentMcp({ mcp }: { readonly mcp: AgentMcpView }) {
  const servers = mcpServerItems(mcp);
  return (
    <section className="agent-section" data-testid="agent-mcp">
      <h3 className="agent-section-title">{MCP_SETTINGS_WORDS.title}</h3>
      <p className="agent-section-text agent-muted">{MCP_SETTINGS_WORDS.explainer}</p>
      {!mcp.available ? <p className="agent-section-text">{MCP_SETTINGS_WORDS.notEntitled}</p> : null}
      {servers.length === 0 ? (
        <p className="agent-section-text agent-muted">{MCP_SETTINGS_WORDS.noServers}</p>
      ) : (
        <ul className="agent-mcp-list" data-testid="agent-mcp-list">
          {servers.map((server) => (
            <ServerRow key={server.id} server={server} />
          ))}
        </ul>
      )}
      {mcp.available ? <AddServer /> : null}
    </section>
  );
}
