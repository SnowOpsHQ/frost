import { useEffect, useRef, useState } from 'react';
import type { SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import type { SeoCategory } from '@app/specs/seo-rules.spec';
import type { HighlightMode } from '@app/specs/seo-sidebar.spec';
import { CopyIcon, HighlightIcon, OpenTabIcon } from '../../icons';
import { actions } from '../../ipc';
import { formatCount, openableUrl } from '../../seo-view';
import { Issue } from './Overview';

// Shared parts of the Links, Images and Social panels (acceptance `seo-panels.feature.md`): the
// panel's own ranked issues, a row's actions (open in a background tab, copy the URL: both through
// main), the highlight toggle, and a short-lived status line. Page URLs are never rendered as
// links: "Open in new tab" is a button that asks main (`browser.openBackgroundTab`, http(s) only).

/** The ranked issues of `categories` (each expands to why / how to fix / samples); a line when there are none. */
export function PanelIssues({ audit, categories, clean, testId }: { readonly audit: SeoAudit; readonly categories: readonly SeoCategory[]; readonly clean: string; readonly testId?: string }) {
  const mine = audit.findings.filter((finding) => categories.includes(finding.category));
  return (
    <section className="seo-issues" data-testid={testId}>
      <header className="seo-section-head">
        <h3 className="seo-section-title">Issues</h3>
        {mine.length > 0 ? <span className="seo-badge">{formatCount(mine.length)}</span> : null}
      </header>
      {mine.length === 0 ? (
        <p className="seo-empty-line seo-all-clear-line">{clean}</p>
      ) : (
        <ol className="seo-issue-list">
          {mine.map((finding) => (
            <Issue key={finding.ruleId} finding={finding} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** A status message shown for a moment after an action (polite live region). */
export function useFlash(): [string, (message: string) => void] {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    message,
    (next: string) => {
      clearTimeout(timer.current);
      setMessage(next);
      timer.current = setTimeout(() => setMessage(''), 2_400);
    },
  ];
}

export function Flash({ message, testId }: { readonly message: string; readonly testId?: string }) {
  return (
    <span className="seo-flash" role="status" aria-live="polite" data-testid={testId} data-shown={message !== ''}>
      {message}
    </span>
  );
}

/** The audit a panel shows, as main checks it before copying (`SeoAuditRef`). */
export function auditRef(audit: SeoAudit): { url: string; takenAt: number } {
  return { url: audit.url, takenAt: audit.takenAt };
}

/** A row's actions on `url` (from `audit`): open it in a background tab (only `http(s)`), copy it. */
export function UrlActions({
  tabId,
  audit,
  url,
  openLabel = 'Open in new tab',
  flash,
}: {
  readonly tabId: number;
  readonly audit: SeoAudit;
  readonly url: string;
  readonly openLabel?: string;
  readonly flash: (message: string) => void;
}) {
  const openable = openableUrl(url);
  return (
    <div className="seo-row-actions" data-testid="seo-row-actions">
      <button
        type="button"
        className="seo-action"
        data-testid="seo-open-url"
        disabled={!openable}
        title={openable ? undefined : 'Only http and https addresses open in a tab'}
        onClick={() => {
          void actions.openBackgroundTab(url).then((id) => flash(id === null ? 'Could not open a tab' : 'Opened in a background tab'));
        }}
      >
        <OpenTabIcon />
        <span>{openLabel}</span>
      </button>
      <button
        type="button"
        className="seo-action"
        data-testid="seo-copy-url"
        disabled={url === ''}
        onClick={() => {
          void actions.copyUrl(tabId, auditRef(audit), url).then((ok) => flash(ok ? 'URL copied' : 'Nothing to copy'));
        }}
      >
        <CopyIcon />
        <span>Copy URL</span>
      </button>
    </div>
  );
}

/** Turns the page overlay for `mode` on or off in the active tab (its state comes from main, `TabState.highlight`). */
export function HighlightToggle({ tab, mode, label, testId }: { readonly tab: TabState; readonly mode: Exclude<HighlightMode, 'off'>; readonly label: string; readonly testId: string }) {
  const on = tab.highlight === mode;
  return (
    <button
      type="button"
      className="seo-toggle"
      data-testid={testId}
      aria-pressed={on}
      title={on ? 'Remove the outlines from the page' : 'Outline them on the page'}
      onClick={() => void actions.setHighlight(tab.id, on ? 'off' : mode)}
    >
      <HighlightIcon />
      <span>{label}</span>
    </button>
  );
}
