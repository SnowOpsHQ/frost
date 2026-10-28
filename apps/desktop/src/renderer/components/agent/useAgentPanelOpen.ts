import { useEffect, useState } from 'react';
import { AGENT_PANEL_STORAGE_KEY, agentPanelOpenFromStorage } from '../../agent-view';

/** The chrome's own `localStorage` (app://app); `null` if it cannot be read. */
function stored(): string | null {
  try {
    return window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Whether the agent panel is open (`AGENT_PANEL_STORAGE_KEY`; closed on a new install), persisted. */
export function useAgentPanelOpen(): [boolean, (open: boolean | ((was: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(() => agentPanelOpenFromStorage(stored()));
  useEffect(() => {
    try {
      window.localStorage.setItem(AGENT_PANEL_STORAGE_KEY, open ? '1' : '0');
    } catch {
      // Not persisted this run.
    }
  }, [open]);
  return [open, setOpen];
}
