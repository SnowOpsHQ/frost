import type { AgentToolCardView } from '@app/specs/agent-session.spec';
import { AGENT_UNTRUSTED_OUTPUT_LABEL } from '@app/specs/agent-panel.spec';
import { toolCardModel } from '../../agent-view';

// One tool call's card (`agent-panel.feature.md`, Tool cards): its label, a status chip, the input
// preview and the output preview. The output is untrusted page or third-party data: it is a React
// text child of a `<pre>`, so markup in it stays text and never becomes an element.

export function AgentToolCard({ card }: { readonly card: AgentToolCardView }) {
  const model = toolCardModel(card);
  return (
    <div className="agent-tool" data-testid="agent-tool-card" data-tool={model.toolName} data-status={model.status} data-untrusted={model.untrusted}>
      <div className="agent-tool-head">
        <span className="agent-tool-label">{model.label}</span>
        <span className="agent-chip" data-testid="agent-tool-status" data-tone={model.tone}>
          {model.statusLabel}
        </span>
      </div>
      <details className="agent-tool-details">
        <summary className="agent-tool-summary">Input</summary>
        <pre className="agent-pre" data-testid="agent-tool-input">
          {model.input}
        </pre>
      </details>
      {model.output !== null ? (
        <div className="agent-tool-output">
          <span className="agent-tool-caption">{AGENT_UNTRUSTED_OUTPUT_LABEL}</span>
          <pre className="agent-pre" data-testid="agent-tool-output">
            {model.output}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
