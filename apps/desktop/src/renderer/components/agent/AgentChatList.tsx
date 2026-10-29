import { useState } from 'react';
import type { ChatExportFormat, ChatRetention } from '@app/specs/agent-data.spec';
import type { AgentChatSummary } from '@app/specs/agent-session.spec';
import { agentActions } from '../../agent-actions';
import { chatListItems, exportMessage, retentionHint } from '../../agent-view';
import { ExportIcon, TrashIcon } from './agent-icons';

// The chat list (`agent-panel.feature.md`, Chats): every chat, most recently updated first; select
// one to show it, or delete it (a running chat is stopped first, by main). Task 9
// (`agent-data.feature.md`, Export): export one as Markdown or JSON (main asks where, in its own save
// dialog), and a line saying how long chats are kept.

function ExportButtons({ chatId, title }: { readonly chatId: string; readonly title: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (format: ChatExportFormat) => {
    setBusy(true);
    setMessage(null);
    void agentActions.exportChat(chatId, format).then((result) => {
      setBusy(false);
      setMessage(exportMessage(result));
    });
  };
  return (
    <div className="agent-chat-export" data-testid="agent-chat-export">
      <button type="button" className="agent-button" data-testid="agent-export-markdown" disabled={busy} aria-label={`Export as Markdown: ${title}`} onClick={() => run('markdown')}>
        Markdown
      </button>
      <button type="button" className="agent-button" data-testid="agent-export-json" disabled={busy} aria-label={`Export as JSON: ${title}`} onClick={() => run('json')}>
        JSON
      </button>
      {message !== null ? (
        <span className="agent-key-message" role="status" data-testid="agent-export-message">
          {message}
        </span>
      ) : null}
    </div>
  );
}

export function AgentChatList({
  chats,
  activeId,
  onSelected,
  chatRetention,
}: {
  readonly chats: readonly AgentChatSummary[];
  readonly activeId: string | null;
  readonly onSelected: () => void;
  readonly chatRetention: ChatRetention;
}) {
  const items = chatListItems(chats, activeId);
  const [exporting, setExporting] = useState<string | null>(null);
  if (items.length === 0) {
    return (
      <div className="agent-hint" data-testid="agent-chats-empty">
        <p className="agent-hint-title">No chats yet</p>
        <p className="agent-hint-text">{retentionHint(chatRetention)}</p>
      </div>
    );
  }
  return (
    <>
      <p className="agent-section-text agent-muted agent-chats-hint" data-testid="agent-chats-hint">
        {retentionHint(chatRetention)}
      </p>
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
            <button
              type="button"
              className="tool agent-chat-export-toggle"
              data-testid="agent-chat-export-toggle"
              aria-label={`Export chat: ${item.title}`}
              aria-expanded={exporting === item.id}
              title="Export chat"
              onClick={() => setExporting(exporting === item.id ? null : item.id)}
            >
              <ExportIcon />
            </button>
            <button type="button" className="tool agent-chat-delete" data-testid="agent-chat-delete" aria-label={`Delete chat: ${item.title}`} title="Delete chat" onClick={() => void agentActions.deleteChat(item.id)}>
              <TrashIcon />
            </button>
            {exporting === item.id ? <ExportButtons chatId={item.id} title={item.title} /> : null}
          </li>
        ))}
      </ul>
    </>
  );
}
