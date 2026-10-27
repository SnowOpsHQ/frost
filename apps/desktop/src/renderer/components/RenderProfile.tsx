import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import {
  CRAWLER_HONESTY_NOTE,
  CRAWLER_USER_AGENTS,
  DEVICE_PRESET_IDS,
  deviceLabel,
  MAX_CUSTOM_USER_AGENT_LENGTH,
  NETWORK_LABELS,
  NETWORK_PRESET_IDS,
  QUICK_RENDER_PROFILES,
  RELOAD_TO_APPLY_LABEL,
  renderProfileSummary,
  USER_AGENT_IDS,
  USER_AGENT_LABELS,
  type DevicePresetId,
  type NetworkPresetId,
  type TabRenderProfile,
  type UserAgentId,
} from '@app/specs/render-profile.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { actions } from '../ipc';
import { badgeLabel, chipText, draftOf, frameNotes, outlineRect, profileOfDraft, type ProfileDraft } from '../render-profile-view';

// The chrome's side of per-tab render profiles (spec `render-profile.feature.md`, Visible state): the
// toolbar toggle, the editor bar (under the toolbar, so the page area makes room for it: nothing is
// drawn over the tab's view), the tab badge, the status-bar chip and the page-area frame. Every value
// comes from the tab's state; every change goes through `browser.setRenderProfile` /
// `browser.clearRenderProfile`. Styling is the bundled styles.css only (strict CSP: SVG attributes,
// never `style=`).

function Glyph({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : 'icon'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** A phone in front of a screen: "render as another device" (frost's own). */
export function RenderProfileIcon({ className }: { readonly className?: string }) {
  return (
    <Glyph className={className}>
      <rect x="2.8" y="4.2" width="14.5" height="10.6" rx="1.6" />
      <path d="M7 18.8h5.5" />
      <rect x="14.6" y="9.2" width="6.6" height="11.2" rx="1.5" />
      <path d="M17.4 18h1" />
    </Glyph>
  );
}

/** The toolbar's toggle for the editor bar; marked while the tab has a profile. */
export function RenderProfileToggle({ tab, open, onToggle }: { readonly tab: TabState | undefined; readonly open: boolean; readonly onToggle: () => void }) {
  const state = tab?.renderProfile ?? null;
  return (
    <button
      type="button"
      className="tool render-toggle"
      data-testid="render-profile-toggle"
      data-active={state !== null}
      aria-pressed={open}
      aria-label={state ? badgeLabel(state) : 'Render profile'}
      title={state ? `${badgeLabel(state)} — edit` : 'Render as another device, user agent or network'}
      onClick={onToggle}
    >
      <RenderProfileIcon />
    </button>
  );
}

/** The tab strip's badge on a profiled tab (its accessible name says which profile). */
export function TabProfileBadge({ state }: { readonly state: TabRenderProfile }) {
  const label = badgeLabel(state);
  return (
    <span className="tab-profile" data-testid="tab-render-profile" data-needs-reload={state.needsReload} data-status={state.status} title={label}>
      <RenderProfileIcon className="tab-profile-icon" />
      <span className="visually-hidden">, {label}</span>
    </span>
  );
}

/** The status bar's chip: the profile, "Reload to apply", or that it was not applied. */
export function StatusProfileChip({ state }: { readonly state: TabRenderProfile }) {
  return (
    <span className="status-render-profile" data-testid="status-render-profile" data-needs-reload={state.needsReload} data-status={state.status} title={badgeLabel(state)}>
      <RenderProfileIcon className="status-render-profile-icon" />
      <span>{chipText(state)}</span>
    </span>
  );
}

/** The page-area frame of a profiled tab (absent in fullscreen and without a profile). */
export function RenderProfileFrame({ tab, onEdit }: { readonly tab: TabState | undefined; readonly onEdit: () => void }) {
  const state = tab?.renderProfile ?? null;
  if (!tab || !state || tab.fullscreen !== null) return null;
  return <Frame tab={tab} state={state} onEdit={onEdit} />;
}

function Frame({ tab, state, onEdit }: { readonly tab: TabState; readonly state: TabRenderProfile; readonly onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const { width, height } = el.getBoundingClientRect();
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const outline = outlineRect(state, size.width, size.height);
  const notes = frameNotes(state);
  const page = tab.url !== '' && tab.error === null && !tab.crashed;
  return (
    <div ref={ref} className="render-frame" data-testid="render-frame" data-status={state.status} data-source={state.source} data-device={state.profile.device}>
      <svg className="render-frame-art" width={size.width} height={size.height} aria-hidden="true" focusable="false">
        {outline ? <rect className="render-frame-device" x={outline.x} y={outline.y} width={Math.max(0, outline.width)} height={Math.max(0, outline.height)} rx="3" /> : null}
      </svg>
      <div className="render-frame-header" role="group" aria-label="Render profile">
        <RenderProfileIcon className="render-frame-icon" />
        <span className="render-frame-summary" data-testid="render-frame-summary" title={badgeLabel(state)}>
          {renderProfileSummary(state.profile)}
        </span>
        {state.source === 'site' ? <span className="render-frame-tag">Pinned to this site</span> : null}
        {notes.crawler ? (
          <span className="render-frame-tag render-frame-caveat" data-testid="render-frame-crawler-note" title={CRAWLER_HONESTY_NOTE}>
            Not the real crawler
            <span className="visually-hidden">: {CRAWLER_HONESTY_NOTE}</span>
          </span>
        ) : null}
        {notes.failed ? (
          <span className="render-frame-tag render-frame-failed" data-testid="render-frame-failed" role="status">
            {notes.failed}
          </span>
        ) : null}
        <span className="render-frame-spacer" />
        {state.needsReload && page && state.status !== 'failed' ? (
          <button type="button" className="render-frame-button render-frame-primary" data-testid="render-frame-reload" onClick={() => void actions.reload()}>
            {RELOAD_TO_APPLY_LABEL}
          </button>
        ) : null}
        <button type="button" className="render-frame-button" data-testid="render-frame-edit" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="render-frame-button" data-testid="render-frame-reset" title="Back to frost’s defaults for this tab (and unpin this site)" onClick={() => void actions.clearRenderProfile(tab.id)}>
          Reset
        </button>
      </div>
    </div>
  );
}

/** The editor bar under the toolbar: quick profiles, the form, Apply / Reset, and the crawler caveat. */
export function RenderProfileBar({ tab, onClose }: { readonly tab: TabState | undefined; readonly onClose: () => void }) {
  const state = tab?.renderProfile ?? null;
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(state));
  // Another tab, or the profile changed from elsewhere: start from what is in effect.
  const seed = `${tab?.id ?? ''}\u0000${state ? JSON.stringify(state.profile) : ''}\u0000${state?.pinned === true}`;
  useEffect(() => setDraft(draftOf(state)), [seed]);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const result = profileOfDraft(draft);
  const site = tab !== undefined && isWebUrl(tab.url);
  const crawler = (CRAWLER_USER_AGENTS as readonly string[]).includes(draft.userAgent);
  const update = (patch: Partial<ProfileDraft>): void => setDraft((old) => ({ ...old, ...patch }));
  const apply = (): void => {
    if (!tab || !result.ok) return;
    if (result.isDefault) void actions.clearRenderProfile(tab.id);
    else void actions.setRenderProfile(tab.id, result.profile, draft.pin && site);
  };
  return (
    <section
      className="render-bar"
      data-testid="render-profile-bar"
      aria-label="Render profile"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="render-bar-row">
        <span className="render-bar-title">Render as</span>
        {QUICK_RENDER_PROFILES.map((quick, index) => (
          <button
            key={quick.id}
            ref={index === 0 ? first : undefined}
            type="button"
            className="render-chip"
            data-testid={`render-quick-${quick.id}`}
            disabled={!tab}
            onClick={() => {
              if (tab) void actions.setRenderProfile(tab.id, quick.profile, false);
            }}
          >
            {quick.label}
          </button>
        ))}
        <span className="render-frame-spacer" />
        <button type="button" className="tool render-bar-close" data-testid="render-profile-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Glyph>
            <path d="M6 6l12 12M18 6L6 18" />
          </Glyph>
        </button>
      </div>
      <form
        className="render-bar-row render-bar-form"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label className="render-field">
          <span>Device</span>
          <select data-testid="render-device" value={draft.device} onChange={(event) => update({ device: event.target.value as DevicePresetId })}>
            {DEVICE_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {deviceLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="render-field">
          <span>User agent</span>
          <select data-testid="render-user-agent" value={draft.userAgent} onChange={(event) => update({ userAgent: event.target.value as UserAgentId })}>
            {USER_AGENT_IDS.map((id) => (
              <option key={id} value={id}>
                {USER_AGENT_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        {draft.userAgent === 'custom' ? (
          <input
            className="render-custom-ua"
            data-testid="render-custom-ua"
            aria-label="Custom user agent"
            placeholder="User-Agent header"
            spellCheck={false}
            maxLength={MAX_CUSTOM_USER_AGENT_LENGTH}
            value={draft.customUserAgent}
            onChange={(event) => update({ customUserAgent: event.target.value })}
          />
        ) : null}
        <label className="render-field">
          <span>Network</span>
          <select data-testid="render-network" value={draft.network} onChange={(event) => update({ network: event.target.value as NetworkPresetId })}>
            {NETWORK_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {NETWORK_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="render-check">
          <input type="checkbox" data-testid="render-js-off" checked={draft.javascriptDisabled} onChange={(event) => update({ javascriptDisabled: event.target.checked })} />
          <span>JavaScript off</span>
        </label>
        <label className="render-check">
          <input type="checkbox" data-testid="render-cache-off" checked={draft.cacheDisabled} onChange={(event) => update({ cacheDisabled: event.target.checked })} />
          <span>Cache off</span>
        </label>
        <label className="render-check" title={site ? 'Use this profile whenever a tab opens this site (stored on this computer)' : 'Open a web page to pin a profile to its site'}>
          <input type="checkbox" data-testid="render-pin" disabled={!site} checked={draft.pin && site} onChange={(event) => update({ pin: event.target.checked })} />
          <span>Pin to this site</span>
        </label>
        <span className="render-frame-spacer" />
        {!result.ok ? (
          <span className="render-bar-error" role="alert" data-testid="render-error">
            {result.error}
          </span>
        ) : null}
        <button type="submit" className="render-frame-button render-frame-primary" data-testid="render-apply" disabled={!tab || !result.ok}>
          Apply
        </button>
        <button type="button" className="render-frame-button" data-testid="render-reset" disabled={!tab || state === null} onClick={() => tab && void actions.clearRenderProfile(tab.id)}>
          Reset
        </button>
      </form>
      {crawler ? (
        <p className="render-bar-note" data-testid="render-crawler-note">
          {CRAWLER_HONESTY_NOTE}
        </p>
      ) : null}
    </section>
  );
}
