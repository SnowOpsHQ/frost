import { AGENT_PANEL_TITLE } from '@app/specs/agent-panel.spec';
import { toggleBadge } from '../../agent-view';
import { AgentSparkIcon } from './agent-icons';
import type { AgentPanelControl } from './useAgentPanel';
import './agent.css';

// The AI agent's toggle, the chrome row's last tool (spec `agent-panel.feature.md`, Toggle; `CHROME_ROW`
// in `tabs.spec.ts`): pressed while the panel is open, drawn pressed as the SEO sidebar's toggle is
// (`.sidebar-toggle` in styles.css), and carrying the badge while the panel is collapsed (a turn
// running, an approval waiting). Collapsing the panel moves focus here (`toggleRef`).

export function AgentToggle({ agent }: { readonly agent: AgentPanelControl }) {
  const badge = agent.open ? null : toggleBadge(agent.state);
  const title = agent.open ? 'Collapse the AI agent' : 'Open the AI agent';
  return (
    <button
      ref={agent.toggleRef}
      type="button"
      className="tool sidebar-toggle agent-toggle-tool"
      data-testid="agent-toggle"
      aria-pressed={agent.open}
      aria-label={AGENT_PANEL_TITLE}
      title={title}
      onClick={() => agent.show(!agent.open)}
    >
      <AgentSparkIcon />
      {badge !== null ? <span className="agent-toggle-badge" data-testid="agent-toggle-badge" data-badge={badge} aria-hidden="true" /> : null}
    </button>
  );
}
