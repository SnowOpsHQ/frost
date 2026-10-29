import { useEffect, useState } from 'react';
import { AGENT_GRANTS_EMPTY, AGENT_GRANTS_EXPLAINER, AGENT_GRANTS_REVOKE_ALL_CONFIRM, AGENT_READ_TOOLS_HINT, AGENT_READ_TOOLS_LABEL, type AgentGrantView } from '@app/specs/agent-data.spec';
import { agentActions } from '../../agent-actions';
import { grantItems } from '../../agent-view';

// The grants page (`agent-data.feature.md`, Grants page): every standing grant (the tool, the site,
// when), revoke one or all (all asks first, here in the panel), and the read tools' switch, with
// what a grant means said plainly. The list is main's (`agent.listGrants`), read again whenever
// main says the grants changed (`AgentState.grantsVersion`). Origins and labels are React text only.

export function AgentGrants({ grantsVersion, readToolsAllowed }: { readonly grantsVersion: number; readonly readToolsAllowed: boolean }) {
  const [grants, setGrants] = useState<readonly AgentGrantView[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void agentActions.listGrants().then((list) => {
      if (live) setGrants(list ?? []);
    });
    return () => {
      live = false;
    };
  }, [grantsVersion]);

  const items = grantItems(grants ?? []);
  const revoke = (tool: string, origin: string) => {
    setBusy(true);
    void agentActions.revokeGrant(tool, origin).then((ok) => {
      setBusy(false);
      setMessage(ok ? null : 'That grant could not be revoked on disk. It stays revoked until frost quits; try again.');
    });
  };
  const revokeAll = () => {
    setBusy(true);
    setConfirming(false);
    void agentActions.revokeAllGrants().then((ok) => {
      setBusy(false);
      setMessage(ok ? 'Every site grant was revoked.' : 'The grants could not be revoked on disk. Try again.');
    });
  };

  return (
    <div className="agent-settings" data-testid="agent-grants">
      <section className="agent-section">
        <h3 className="agent-section-title">Reading tools</h3>
        <label className="agent-toggle">
          <input
            type="checkbox"
            data-testid="agent-read-tools"
            checked={readToolsAllowed}
            onChange={(event) => {
              const allowed = event.target.checked;
              void agentActions.setReadToolsAllowed(allowed).then((ok) => setMessage(ok ? null : 'That setting could not be saved. Try again.'));
            }}
          />
          <span>{AGENT_READ_TOOLS_LABEL}</span>
        </label>
        <p className="agent-section-text agent-muted">{AGENT_READ_TOOLS_HINT}</p>
      </section>
      <section className="agent-section">
        <h3 className="agent-section-title">Site grants</h3>
        <p className="agent-section-text" data-testid="agent-grants-explainer">
          {AGENT_GRANTS_EXPLAINER}
        </p>
        {grants === null ? (
          <p className="agent-section-text agent-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="agent-section-text agent-muted" data-testid="agent-grants-empty">
            {AGENT_GRANTS_EMPTY}
          </p>
        ) : (
          <ul className="agent-list" data-testid="agent-grants-list">
            {items.map((item) => (
              <li key={item.key} className="agent-list-item" data-testid="agent-grant" data-tool={item.tool} data-origin={item.origin}>
                <div className="agent-list-text">
                  <span className="agent-list-title" data-testid="agent-grant-origin">
                    {item.origin}
                  </span>
                  <span className="agent-list-sub" data-testid="agent-grant-label">
                    {item.label}
                    {item.since !== '' ? ` · since ${item.since}` : ''}
                  </span>
                </div>
                <button type="button" className="agent-button" data-testid="agent-grant-revoke" disabled={busy} aria-label={`Revoke: ${item.label} on ${item.origin}`} onClick={() => revoke(item.tool, item.origin)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        {items.length > 0 ? (
          confirming ? (
            <div className="agent-confirm" role="group" aria-label="Revoke every grant" data-testid="agent-grants-confirm">
              <p className="agent-section-text">{AGENT_GRANTS_REVOKE_ALL_CONFIRM}</p>
              <div className="agent-key-row">
                <button type="button" className="agent-button agent-button-primary" data-testid="agent-grants-confirm-yes" disabled={busy} onClick={revokeAll}>
                  Revoke all
                </button>
                <button type="button" className="agent-button" data-testid="agent-grants-confirm-no" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="agent-key-row">
              <button type="button" className="agent-button" data-testid="agent-grants-revoke-all" disabled={busy} onClick={() => setConfirming(true)}>
                Revoke all…
              </button>
            </div>
          )
        ) : null}
        {message !== null ? (
          <p className="agent-key-message" role="status" data-testid="agent-grants-message">
            {message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
