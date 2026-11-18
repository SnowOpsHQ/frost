import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type { AgentState } from '@app/specs/agent-session.spec';
import { useAgentState } from '../../hooks/useAgentState';
import { useAgentPanelOpen } from './useAgentPanelOpen';

// The agent panel's one source of truth for the chrome (spec `agent-panel.feature.md`, Toggle): main's
// `AgentState` (polled once) and whether the panel is open, held by `App.tsx` and passed to the chrome
// row's toggle (`AgentToggle`) and the panel (`AgentPanel`), as the SEO sidebar's `useSidebarOpen` is.

/** Where focus goes after an explicit open or collapse: the composer, the row's toggle, or the head's settings button. */
export type AgentFocusTarget = 'input' | 'toggle' | 'settings';

export interface AgentPanelControl {
  /** Main's `AgentState` (`agent.watch`); `null` until the first answer. */
  readonly state: AgentState | null;
  /** Open: the user's remembered choice, or a new approval opened it for now. */
  readonly open: boolean;
  /** The user opens or collapses the panel: remembered, and any auto-open ends. */
  readonly setOpen: (next: boolean | ((was: boolean) => boolean)) => void;
  /** Opens or collapses it for the user, focus following: the composer, or the row's toggle. */
  readonly show: (next: boolean) => void;
  /** The focus target of the open or collapse under way (the panel moves focus once it has rendered). */
  readonly focusAfter: MutableRefObject<AgentFocusTarget | null>;
  /** The chrome row's toggle: focus goes there when the panel collapses. */
  readonly toggleRef: RefObject<HTMLButtonElement | null>;
}

export function useAgentPanel(): AgentPanelControl {
  const state = useAgentState();
  // `remembered` is the user's own choice (persisted; closed on a new install); a new approval opens
  // the panel for now (`autoOpened`) without changing it.
  const [remembered, setRemembered] = useAgentPanelOpen();
  const [autoOpened, setAutoOpened] = useState(false);
  const open = remembered || autoOpened;
  const auto = useRef(autoOpened);
  auto.current = autoOpened;
  const focusAfter = useRef<AgentFocusTarget | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const setOpen = useCallback(
    (next: boolean | ((was: boolean) => boolean)) => {
      const wasAuto = auto.current;
      setAutoOpened(false);
      setRemembered((was) => (typeof next === 'function' ? next(was || wasAuto) : next));
    },
    [setRemembered],
  );
  const show = useCallback(
    (next: boolean) => {
      focusAfter.current = next ? 'input' : 'toggle';
      setOpen(next);
    },
    [setOpen],
  );
  // A new approval request opens the panel, so it is never missed (the remembered choice stays, and focus doesn't move).
  const approvalId = state?.approval?.request.id ?? null;
  useEffect(() => {
    if (approvalId !== null) setAutoOpened(true);
  }, [approvalId]);
  return useMemo(() => ({ state, open, setOpen, show, focusAfter, toggleRef }), [state, open, setOpen, show]);
}
