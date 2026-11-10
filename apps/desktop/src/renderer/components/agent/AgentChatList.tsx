import { useEffect, useMemo, useState } from 'react';
import {
  CHAT_HISTORY_WORDS,
  CHAT_LIST_FILTERS,
  CHAT_SEARCH_DEBOUNCE_MS,
  CHAT_SEARCH_MAX_CHARS,
  chatSearchMatcher,
  chatTitleFromUser,
  STORED_CHAT_TITLE_MAX_CHARS,
  type ChatExportFormat,
  type ChatListFilter,
  type ChatRetention,
  type ChatSearchMatch,
} from '@app/specs/agent-data.spec';
import type { AgentChatSummary } from '@app/specs/agent-session.spec';
import { agentActions } from '../../agent-actions';
import { chatListItems, chatsInView, exportMessage, retentionHint, snippetParts } from '../../agent-view';
import { ArchiveIcon, ExportIcon, PencilIcon, TrashIcon } from './agent-icons';

// The chat list (`agent-panel.feature.md`, Chats): every chat, most recently updated first; select
// one to show it, or delete it (a running chat is stopped first, by main). Task 9
// (`agent-data.feature.md`, Export): export one as Markdown or JSON (main asks where, in its own save
// dialog), and a line saying how long chats are kept. Phase 11 Task 8 (`agent-data.feature.md`, Chat
// history): an Active / Archived switch, a search box (main searches titles and the user's and the
// assistant's text, never tool output, and answers a snippet), rename inline (Enter saves, Escape
// cancels) and archive / unarchive. Titles and snippets are untrusted text: React text in
// `<bdi dir="auto">` only, the match in a `<mark>`.

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

/** The title field shown in place of a chat's title while it is renamed. */
function RenameField({ chatId, title, onDone }: { readonly chatId: string; readonly title: string; readonly onDone: () => void }) {
  const [value, setValue] = useState(title);
  const [refused, setRefused] = useState(false);
  const save = () => {
    if (chatTitleFromUser(value) === null) {
      setRefused(true);
      return;
    }
    void agentActions.renameChat(chatId, value).then((ok) => {
      if (ok) onDone();
      else setRefused(true);
    });
  };
  return (
    <div className="agent-chat-rename">
      <input
        type="text"
        className="agent-text-field"
        data-testid="agent-chat-rename-input"
        aria-label={CHAT_HISTORY_WORDS.renameField}
        maxLength={STORED_CHAT_TITLE_MAX_CHARS}
        value={value}
        autoFocus
        onChange={(event) => {
          setValue(event.target.value);
          setRefused(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
      />
      {refused ? (
        <span className="agent-key-message" role="status" data-testid="agent-chat-rename-message">
          {CHAT_HISTORY_WORDS.renameFailed}
        </span>
      ) : null}
    </div>
  );
}

/** A search hit's snippet: the match marked, all of it text. */
function Snippet({ match }: { readonly match: ChatSearchMatch }) {
  const { before, hit, after } = snippetParts(match);
  return (
    <span className="agent-chat-snippet agent-muted" data-testid="agent-chat-snippet">
      <bdi dir="auto">
        {before}
        <mark>{hit}</mark>
        {after}
      </bdi>
    </span>
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
  const [filter, setFilter] = useState<ChatListFilter>('active');
  const [query, setQuery] = useState('');
  /** Main's answer for the query now (`null`: no query, or not answered yet). */
  const [results, setResults] = useState<readonly AgentChatSummary[] | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const searching = chatSearchMatcher(query) !== null;
  // Search again when the chats change (one added, renamed, archived, deleted), not on every streamed word.
  const listKey = useMemo(() => chats.map((chat) => `${chat.id}\u0000${chat.updatedAt}\u0000${chat.archived}\u0000${chat.title}`).join('\u0001'), [chats]);
  useEffect(() => {
    if (!searching) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void agentActions.listChats(filter, query.slice(0, CHAT_SEARCH_MAX_CHARS)).then((answer) => {
        if (live && answer !== null) setResults(answer);
      });
    }, CHAT_SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [filter, query, searching, listKey]);

  if (chats.length === 0) {
    return (
      <div className="agent-hint" data-testid="agent-chats-empty">
        <p className="agent-hint-title">No chats yet</p>
        <p className="agent-hint-text">{retentionHint(chatRetention)}</p>
      </div>
    );
  }
  const shown = searching ? (results ?? []) : chatsInView(chats, filter);
  const items = chatListItems(shown, activeId);
  const empty = searching ? (results !== null ? CHAT_HISTORY_WORDS.noMatch : null) : filter === 'archived' ? CHAT_HISTORY_WORDS.noArchived : CHAT_HISTORY_WORDS.noActive;
  return (
    <>
      <p className="agent-section-text agent-muted agent-chats-hint" data-testid="agent-chats-hint">
        {retentionHint(chatRetention)}
      </p>
      <div className="agent-chats-tools">
        <input
          type="search"
          className="agent-text-field"
          data-testid="agent-chats-search"
          aria-label={CHAT_HISTORY_WORDS.searchLabel}
          placeholder={CHAT_HISTORY_WORDS.searchPlaceholder}
          maxLength={CHAT_SEARCH_MAX_CHARS}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="agent-chips agent-chats-filter" role="group" aria-label={CHAT_HISTORY_WORDS.filterLabel}>
          {CHAT_LIST_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className="agent-chip"
              data-testid={`agent-chats-filter-${value}`}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setResults(null);
              }}
            >
              {value === 'active' ? CHAT_HISTORY_WORDS.active : CHAT_HISTORY_WORDS.archived}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 && empty !== null ? (
        <p className="agent-section-text agent-muted" role="status" data-testid={searching ? 'agent-chats-no-match' : 'agent-chats-view-empty'}>
          {empty}
        </p>
      ) : null}
      <ul className="agent-chats" data-testid="agent-chats">
        {items.map((item) => (
          <li key={item.id} className="agent-chat-item" data-testid="agent-chat-item" data-selected={item.selected} data-running={item.running} data-archived={item.archived}>
            {renaming === item.id ? (
              <RenameField chatId={item.id} title={item.title} onDone={() => setRenaming(null)} />
            ) : (
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
                <span className="agent-chat-text">
                  <span className="agent-chat-title" data-testid="agent-chat-title">
                    <bdi dir="auto">{item.title}</bdi>
                  </span>
                  {item.match !== undefined ? <Snippet match={item.match} /> : null}
                </span>
              </button>
            )}
            <button
              type="button"
              className="tool agent-chat-action"
              data-testid="agent-chat-rename"
              aria-label={`${CHAT_HISTORY_WORDS.rename}: ${item.title}`}
              aria-pressed={renaming === item.id}
              title={CHAT_HISTORY_WORDS.rename}
              onClick={() => setRenaming(renaming === item.id ? null : item.id)}
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              className="tool agent-chat-action"
              data-testid="agent-chat-archive"
              aria-label={`${item.archived ? CHAT_HISTORY_WORDS.unarchive : CHAT_HISTORY_WORDS.archive}: ${item.title}`}
              title={item.archived ? CHAT_HISTORY_WORDS.unarchive : CHAT_HISTORY_WORDS.archive}
              onClick={() => void agentActions.archiveChat(item.id, !item.archived)}
            >
              <ArchiveIcon />
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
