import { useEffect } from 'react';
import { ADDRESS_PROMPT } from '@app/specs/browser-polish.spec';
import type { TabState } from '@app/specs/browser.spec';
import { useAddressInput } from '../hooks/useAddressInput';
import { useSeqChange } from '../hooks/useSeqChange';
import { LockIcon, NotSecureIcon, SearchIcon } from '../icons';
import { tabSecurity } from '../security';

// The address bar of the browser chrome (`App.tsx`; spec `browser-chrome.feature.md`, Layout). Styling is the
// bundled styles.css only (strict CSP). What typing in it does is `useAddressInput`'s, which the new tab's
// search field shares (`StartView.tsx`).

export function AddressBar({ tab, focusSeq }: { readonly tab: TabState | undefined; readonly focusSeq: number | undefined }) {
  const url = tab?.url ?? '';
  const empty = url === '';
  const tabId = tab?.id;
  const { field, focusAll, inputProps } = useAddressInput({ id: tabId, url, loading: tab?.loading === true });

  // An empty tab puts the caret in the address bar, unless keyboard focus is on a tab: the tablist's
  // Delete keeps it on the neighbour tab (`tabs.feature.md`), even when that tab is empty.
  useEffect(() => {
    if (empty && tabId !== undefined && document.activeElement?.getAttribute('role') !== 'tab') focusAll();
  }, [empty, tabId]);
  // Main asked for the address bar (new tab, Cmd/Ctrl+L, switching to an empty tab).
  useSeqChange(focusSeq, focusAll);

  const security = field.draft !== null || field.submitted !== null ? 'none' : tabSecurity(tab);
  return (
    <div className="address" data-security={security}>
      <span className="address-badge" title={security === 'secure' ? 'Secure connection' : security === 'insecure' ? 'Not secure' : undefined}>
        {security === 'secure' ? <LockIcon /> : security === 'insecure' ? <NotSecureIcon /> : <SearchIcon />}
      </span>
      <input {...inputProps} data-testid="address" className="address-input" aria-label="Address and search bar" placeholder={ADDRESS_PROMPT} />
    </div>
  );
}
