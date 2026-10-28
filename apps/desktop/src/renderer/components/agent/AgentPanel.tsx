import { useCallback, useEffect, useRef, useState } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import { AGENT_PANEL_TITLE } from '@app/specs/agent-panel.spec';
import { agentActions } from '../../agent-actions';
import { agentPaletteSources, onAgentPanelRequest, setPaletteSkills } from '../../agent-palette';
import { chatHeading, railBadge, runningChatId, skillRunChatId } from '../../agent-view';
import { useAgentState } from '../../hooks/useAgentState';
import { ChevronIcon, PlusIcon } from '../../icons';
import { registerPaletteActions } from '../../palette/registry';
import { AgentApprovalCard } from './AgentApprovalCard';
import { AgentChat } from './AgentChat';
import { AgentChatList } from './AgentChatList';
import { AgentComposer } from './AgentComposer';
import { AgentContextMeter } from './AgentContextMeter';
import { AgentGrants } from './AgentGrants';
import { AgentSettings } from './AgentSettings';
import { AgentSkills } from './AgentSkills';
import { AgentSparkIcon, ChatsIcon, SlidersIcon } from './agent-icons';
import { useAgentPanelOpen } from './useAgentPanelOpen';
import './agent.css';

// The AI agent panel (spec `agent-panel.spec.ts`; acceptance `agent-panel.feature.md`). Docked in
// the workspace row between the page column and the SEO sidebar: page | agent | SEO. Both may be
// open; each panel gives way before the page goes under its minimum, and the page area shrinks so
// main lays the tab's view out clear of it (`PageArea` reports its box on every resize).
// Collapsed it is a narrow rail with its toggle; the palette's "Toggle AI agent" works either way.
// Everything it shows is main's `AgentState` (`agent.watch`); intents go over the sender-guarded
// `agent.*` procedures (`agent-actions.ts`). Styling is agent.css only (bundled; strict CSP), and
// model, page and tool text are React text only.

// The palette's agent actions (`agent-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(...agentPaletteSources());
import.meta.hot?.dispose(unregisterPaletteActions);

/** The panel's views: Task 9 adds the grants page and the skills editor (reached from settings). */
type View = 'chat' | 'chats' | 'settings' | 'grants' | 'skills';

const VIEW_TITLES: Readonly<Record<View, string>> = { chat: AGENT_PANEL_TITLE, chats: 'Chats', settings: 'Agent settings', grants: 'Site grants', skills: 'Skills' };

export function AgentPanel({ tab }: { readonly tab: TabState | undefined }) {
  const state = useAgentState();
  // `remembered` is the user's own choice (persisted); a new approval opens the panel for now
  // (`autoOpened`) without changing it.
  const [remembered, setRemembered] = useAgentPanelOpen();
  const [autoOpened, setAutoOpened] = useState(false);
  const open = remembered || autoOpened;
  const auto = useRef(autoOpened);
  auto.current = autoOpened;
  /** The user opens or collapses the panel: that is remembered, and any auto-open ends. */
  const setOpen = useCallback(
    (next: boolean | ((was: boolean) => boolean)) => {
      const wasAuto = auto.current;
      setAutoOpened(false);
      setRemembered((was) => (typeof next === 'function' ? next(was || wasAuto) : next));
    },
    [setRemembered],
  );
  const [view, setView] = useState<View>('chat');
  const toggle = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const focusAfter = useRef<'input' | 'toggle' | null>(null);
  // The latest state, for the palette's requests (a skill runs in the chat on screen).
  const latest = useRef(state);
  latest.current = state;
  const activeTab = useRef(tab);
  activeTab.current = tab;

  // The palette's "Run skill" actions offer what main lists now, and nothing while a turn runs.
  const skills = state?.skills;
  const running = state?.running === true;
  useEffect(() => {
    setPaletteSkills({ skills: skills ?? [], running });
  }, [skills, running]);
  useEffect(() => () => setPaletteSkills({ skills: [], running: false }), []);

  const show = (next: boolean, focus: 'input' | 'toggle' | null = next ? 'input' : 'toggle') => {
    focusAfter.current = focus;
    setOpen(next);
  };

  // The palette's requests.
  useEffect(
    () =>
      onAgentPanelRequest((request) => {
        if (request.kind === 'toggle') {
          setOpen((was) => {
            focusAfter.current = was ? 'toggle' : 'input';
            return !was;
          });
          setView('chat');
        } else if (request.kind === 'settings') {
          focusAfter.current = null;
          setOpen(true);
          setView('settings');
        } else if (request.kind === 'run-skill') {
          // Runs at once with no inputs (the composer's picker is where a note is added), on the
          // active tab: in the chat on screen if that chat works on it, else in a new chat (which
          // main binds to the active tab).
          focusAfter.current = null;
          setOpen(true);
          setView('chat');
          void agentActions.send(skillRunChatId(latest.current?.active ?? null, activeTab.current?.id ?? null), { skillId: request.skillId });
        } else {
          focusAfter.current = 'input';
          setOpen(true);
          setView('chat');
          void agentActions.newChat();
        }
      }),
    [setOpen],
  );

  // A new approval request opens the panel, so it is never missed (the remembered choice stays).
  const approvalId = state?.approval?.request.id ?? null;
  useEffect(() => {
    if (approvalId !== null) setAutoOpened(true);
  }, [approvalId]);

  // Focus follows an explicit open or collapse (never a state update); the composer may only be
  // there once the first state arrived.
  const loaded = state !== null;
  useEffect(() => {
    const target = focusAfter.current;
    if (target === 'toggle' && !open) toggle.current?.focus();
    else if (target === 'input' && open && view === 'chat') {
      if (input.current === null) return;
      input.current.focus();
    }
    focusAfter.current = null;
  }, [open, view, loaded]);

  const badge = railBadge(state);
  if (!open) {
    return (
      <aside className="agent" data-testid="agent-panel" data-open="false" aria-label={AGENT_PANEL_TITLE}>
        <nav className="agent-rail" aria-label={AGENT_PANEL_TITLE}>
          <button ref={toggle} type="button" className="agent-rail-toggle" data-testid="agent-toggle" aria-expanded="false" aria-label="Open the AI agent" title="Open the AI agent" onClick={() => show(true)}>
            <AgentSparkIcon />
            {badge !== null ? <span className="agent-rail-badge" data-testid="agent-rail-badge" data-badge={badge} aria-hidden="true" /> : null}
          </button>
        </nav>
      </aside>
    );
  }

  const active = state?.active ?? null;
  const covered = tab?.fullscreen != null;
  return (
    <aside className="agent" data-testid="agent-panel" data-open="true" data-view={view} aria-label={AGENT_PANEL_TITLE}>
      <div className="agent-main">
        <header className="agent-head">
          <span className="agent-head-mark" aria-hidden="true">
            <AgentSparkIcon />
          </span>
          <div className="agent-head-text">
            <h2 className="agent-head-title">{VIEW_TITLES[view]}</h2>
            <span className="agent-head-sub" data-testid="agent-chat-heading">
              {chatHeading(active)}
            </span>
          </div>
          <button
            type="button"
            className="tool agent-head-tool"
            data-testid="agent-new-chat"
            aria-label="New chat"
            title="New chat"
            onClick={() => {
              void agentActions.newChat();
              setView('chat');
              input.current?.focus();
            }}
          >
            <PlusIcon />
          </button>
          <button type="button" className="tool agent-head-tool" data-testid="agent-chats-toggle" aria-label="Chats" title="Chats" aria-pressed={view === 'chats'} onClick={() => setView(view === 'chats' ? 'chat' : 'chats')}>
            <ChatsIcon />
          </button>
          <button type="button" className="tool agent-head-tool" data-testid="agent-settings-toggle" aria-label="Agent settings" title="Agent settings" aria-pressed={view === 'settings' || view === 'grants' || view === 'skills'} onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}>
            <SlidersIcon />
          </button>
          <button type="button" className="tool agent-head-tool" data-testid="agent-collapse" aria-label="Collapse the AI agent" title="Collapse the AI agent" onClick={() => show(false)}>
            <ChevronIcon className="agent-collapse-icon" />
          </button>
        </header>
        {state === null ? (
          <div className="agent-body">
            <p className="agent-hint-text" data-testid="agent-loading">
              Connecting to the agent…
            </p>
          </div>
        ) : (
          <>
            <div className="agent-body">
              {view === 'settings' ? (
                <div className="agent-scroll">
                  <AgentSettings setup={state.setup} grantsCount={state.grantsCount} readToolsAllowed={state.readToolsAllowed} chatRetention={state.chatRetention} onOpen={setView} />
                </div>
              ) : view === 'grants' ? (
                <div className="agent-scroll">
                  <AgentGrants grantsVersion={state.grantsVersion} readToolsAllowed={state.readToolsAllowed} />
                </div>
              ) : view === 'skills' ? (
                <div className="agent-scroll">
                  <AgentSkills skills={state.skills} />
                </div>
              ) : view === 'chats' ? (
                <div className="agent-scroll">
                  <AgentChatList chats={state.chats} activeId={active?.id ?? null} onSelected={() => setView('chat')} chatRetention={state.chatRetention} />
                </div>
              ) : (
                <AgentChat active={active} setup={state.setup} notice={state.notice} onOpenSettings={() => setView('settings')} />
              )}
            </div>
            {/* One request at a time, oldest first; keyed by id, so each new one arms afresh. */}
            {state.approval !== null ? <AgentApprovalCard key={state.approval.request.id} approval={state.approval} covered={covered} context={{ activeChatId: active?.id ?? null, chats: state.chats }} /> : null}
            <footer className="agent-foot">
              <AgentContextMeter active={active} />
              <AgentComposer chatId={active?.id ?? null} running={state.running} stopChatId={runningChatId(state)} inputRef={input} skills={state.skills} />
            </footer>
          </>
        )}
      </div>
    </aside>
  );
}
