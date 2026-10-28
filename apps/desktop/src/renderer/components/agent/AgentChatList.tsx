import type { AgentChatSummary } from '@app/specs/agent-session.spec';
import { agentActions } from '../../agent-actions';
import { chatListItems } from '../../agent-view';
import { TrashIcon } from './agent-icons';

// The chat list (`agent-panel.feature.md`, Chats): every chat, most recently updated first; select
// one to show it, or delete it (a running chat is stopped first, by main).

export function AgentChatList({ chats, activeId, onSelected }: { readonly chats: readonly AgentChatSummary[]; readonly activeId: string | null; readonly onSelected: () => void }) {
  const items = chatListItems(chats, activeId);
  if (items.length === 0) {
    return (
      <div className="agent-hint" data-testid="agent-chats-empty">
        <p className="agent-hint-title">No chats yet</p>
        <p className="agent-hint-text">Chats are kept until frost quits.</p>
      </div>
    );
  }
  return (
    <ul className="agent-chats" data-testid="agent-chats">
      {items.map((item) => (
        <li key={item.id} className="agent-chat-item" data-testid="agent-chat-item" data-selected={item.selected} data-running={item.running}>
          <button
            type="button"
            className="agent-chat-select"
            aria-current={item.selected ? 'true' : undefined}
            onClick={() => {
              void agentActions.selectChat(item.id);
              onSelected();
            }}
          >
            {item.running ? <span className="agent-dot" aria-hidden="true" /> : null}
            <span className="agent-chat-title">{item.title}</span>
          </button>
          <button type="button" className="tool agent-chat-delete" data-testid="agent-chat-delete" aria-label={`Delete chat: ${item.title}`} title="Delete chat" onClick={() => void agentActions.deleteChat(item.id)}>
            <TrashIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}
