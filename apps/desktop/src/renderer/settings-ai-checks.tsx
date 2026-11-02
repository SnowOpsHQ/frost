import { useState } from 'react';
import { AI_CHECKS_COPY as COPY, type AiCheckMode } from '@app/specs/ai-checks.spec';
import { requestAgentPanel } from './agent-palette';
import { modelLabel } from './agent-view';
import { aiChecksModeItems, costNote, shownMode } from './ai-checks-view';
import { aiChecksActions, useAiChecks } from './hooks/useAiChecks';
import { useAgentState } from './hooks/useAgentState';
import './settings-ai-checks.css';

// The Settings view's AI checks section (Phase 9 Task 11; acceptance `ai-checks.feature.md`, UI): the
// three modes as a radio group showing main's mode, the cost note naming the route and model the agent
// settings name (read from `agent.watch`, which carries no key; until it answers, from the AI checks
// state's own route and model), and the way to the agent's model settings. A click only asks main
// (`aiChecks.setMode`): leaving `off`, main shows its own consent dialog first, and the checked mode is
// main's answer, never the click's guess (a cancelled dialog leaves `Off` checked). While the call runs
// the modes are `aria-disabled` (they keep focus). `tabId`: the active tab (the state is per tab; the
// mode is not).

export function AiChecksSettings({ tabId }: { readonly tabId: number | undefined }) {
  const state = useAiChecks(tabId);
  const agent = useAgentState();
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState<{ readonly mode: AiCheckMode; readonly version: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mode = shownMode(state, answered);
  const items = aiChecksModeItems(mode);
  if (items === null) return <p className="settings-muted">{COPY.settings.loading}</p>;

  const setup = agent?.setup ?? null;
  const cost = costNote(setup !== null ? { route: setup.route, modelId: setup.modelId, modelName: modelLabel(setup.modelId, setup.chatgpt.models) } : (state?.model ?? null));

  const choose = (next: AiCheckMode) => {
    if (busy || next === mode) return;
    const version = state?.version ?? -1;
    setBusy(true);
    setNote(null);
    void aiChecksActions.setMode(next).then((answer) => {
      setBusy(false);
      if (answer === null) return setNote(COPY.settings.failed);
      setAnswered({ mode: answer, version });
      if (answer === 'off' && next !== 'off') setNote(COPY.settings.stayedOff);
    });
  };

  return (
    <div className="settings-ai-checks" data-testid="ai-checks-section" data-mode={mode ?? undefined}>
      <p className="settings-text">{COPY.settings.intro}</p>
      <ul className="settings-toggles" role="radiogroup" aria-label={COPY.settings.modesLabel}>
        {items.map((item) => (
          <li key={item.mode} className="settings-toggle">
            <button
              type="button"
              role="radio"
              className="settings-choice"
              data-testid="ai-checks-mode"
              data-mode={item.mode}
              aria-checked={item.checked}
              aria-describedby={`ai-checks-mode-${item.mode}`}
              aria-disabled={busy ? 'true' : undefined}
              onClick={() => choose(item.mode)}
            >
              <span className="settings-choice-mark" aria-hidden="true" />
              <span className="settings-toggle-text">
                <span className="settings-toggle-label">{item.label}</span>
                <span className="settings-muted" id={`ai-checks-mode-${item.mode}`}>
                  {item.description}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="settings-muted">{COPY.settings.consentNote}</p>
      <p className="settings-text" data-testid="ai-checks-settings-cost">
        {cost}
      </p>
      <div className="settings-actions">
        <button type="button" className="settings-button" data-testid="ai-checks-agent-settings" onClick={() => requestAgentPanel({ kind: 'settings' })}>
          {COPY.settings.agentSettings}
        </button>
      </div>
      {note ? (
        <p className="settings-note" role="status" data-testid="ai-checks-settings-note">
          {note}
        </p>
      ) : null}
    </div>
  );
}
