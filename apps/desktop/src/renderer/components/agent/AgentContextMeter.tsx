import type { AgentActiveChatView } from '@app/specs/agent-session.spec';
import { contextMeter } from '../../agent-view';

// The context meter (`agent-panel.feature.md`): tokens in the selected chat's context against its
// model's window, as a bar and a line; with no published window, tokens only.

export function AgentContextMeter({ active }: { readonly active: AgentActiveChatView | null }) {
  const meter = contextMeter(active);
  if (meter === null) return null;
  return (
    <div className="agent-meter" data-testid="agent-context-meter" data-level={meter.level} title="The context the next request starts from">
      {meter.percent !== null ? <progress className="agent-meter-bar" max={100} value={meter.percent} aria-label="Context used" /> : null}
      <span className="agent-meter-text" data-testid="agent-context-meter-text">
        {meter.text}
      </span>
    </div>
  );
}
