import { useCallback, useEffect, useState } from 'react';
import { SIDEBAR_STORAGE_KEY } from '@app/specs/seo-sidebar.spec';
import { sidebarOpenFromStorage } from '../seo-view';
import { useSeqChange } from './useSeqChange';

/** The chrome's own `localStorage` (app://app); `null` if it cannot be read. */
function stored(): string | null {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Whether the SEO sidebar's panel is open (spec `seo-sidebar.spec.ts`): persisted under
 * `SIDEBAR_STORAGE_KEY`, toggled by the toolbar button and whenever main bumps
 * `toggleSidebarSeq` (its menu item and reserved shortcut).
 */
export function useSidebarOpen(toggleSeq: number | undefined): [boolean, (open: boolean) => void, () => void] {
  const [open, setOpen] = useState(() => sidebarOpenFromStorage(stored()));
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, open ? '1' : '0');
    } catch {
      // Not persisted this run.
    }
  }, [open]);
  const toggle = useCallback(() => setOpen((was) => !was), []);
  useSeqChange(toggleSeq, toggle);
  return [open, setOpen, toggle];
}
