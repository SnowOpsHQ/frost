import { useState } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { FullscreenNotice } from './components/FullscreenNotice';
import { PageArea } from './components/PagePanels';
import { PromptBar } from './components/PermissionBar';
import { RenderProfileBar } from './components/RenderProfile';
import { SeoSidebar } from './components/SeoSidebar';
import { StatusBar } from './components/StatusBar';
import { TabStrip } from './components/TabStrip';
import { Toolbar } from './components/Toolbar';
import { useBrowserState } from './hooks/useBrowserState';
import { useNotice } from './hooks/useNotice';
import { usePing } from './hooks/usePing';
import { useSeoAudit } from './hooks/useSeoAudit';
import { useSidebarOpen } from './hooks/useSidebarOpen';
import type { PanelJump } from './palette/registry';

// The browser chrome (spec `browser-chrome.feature.md`, Layout; `tabs.feature.md`): tab strip,
// toolbar, permission prompt bar, the render-profile editor bar while open
// (`render-profile.feature.md`), page area with the SEO sidebar docked on its right
// (`seo-sidebar.feature.md`) and the command palette's sheet above it while open
// (`command-palette.feature.md`), status bar, and the fullscreen notice.
// All browser state lives in main; this page renders it and sends user intents over the
// sender-guarded `browser.*` procedures (`ipc.ts`). Styling is the bundled styles.css only
// (strict CSP). Runtime constants come from the Zod-free specs (`tabs.spec`, `permissions.spec`,
// `page-commands.spec`, `web-url.spec`); `browser.spec` is imported for its types only (its Zod
// schemas must stay out of this bundle: strict Trusted Types).

export function App() {
  const state = useBrowserState();
  const { ping, connection } = usePing();
  const tab = state?.tabs.find((t) => t.id === state.activeTabId);
  const empty = !tab || (tab.url === '' && !tab.loading);
  const notice = useNotice(state === null ? undefined : state.notice);
  const [sidebarOpen, setSidebarOpen, toggleSidebar] = useSidebarOpen(state?.toggleSidebarSeq);
  const audit = useSeoAudit(tab);
  // The command palette's panel jumps (`command-palette.feature.md`): the sidebar opens on that panel.
  const [panelJump, setPanelJump] = useState<PanelJump | null>(null);
  // The render-profile editor bar (`render-profile.feature.md`): open per window, under the toolbar.
  const [profileOpen, setProfileOpen] = useState(false);
  return (
    <div className="chrome">
      <TabStrip state={state} />
      <Toolbar tab={tab} focusSeq={state?.focusAddressBarSeq} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} profileOpen={profileOpen} onToggleProfile={() => setProfileOpen((open) => !open)} />
      {/* Always present (empty without a prompt), so the grid rows stay put; polite, not focus-taking. */}
      <div className="prompt-slot" aria-live="polite">
        {tab?.permissionPrompt ? <PromptBar key={`${tab.id} ${tab.permissionPrompt.id}`} prompt={tab.permissionPrompt} covered={tab.fullscreen !== null} /> : null}
      </div>
      <div className="render-slot">{profileOpen ? <RenderProfileBar tab={tab} onClose={() => setProfileOpen(false)} /> : null}</div>
      <div className="workspace">
        {/* The palette's sheet sits above the page area, never under the tab's view (`command-palette.spec.ts`). */}
        <div className="page-column">
          <CommandPalette state={state} tab={tab} audit={empty ? null : audit} sidebarOpen={sidebarOpen} onSidebarOpenChange={setSidebarOpen} onPanelJump={setPanelJump} />
          <PageArea tab={tab} empty={state !== null && empty} onEditProfile={() => setProfileOpen(true)} />
        </div>
        <SeoSidebar tab={tab} open={sidebarOpen} response={empty ? null : audit} onOpenChange={setSidebarOpen} jump={panelJump} />
      </div>
      <StatusBar tab={tab} notice={notice} ping={ping} connection={connection} />
      {tab?.fullscreen === 'notice' ? <FullscreenNotice tab={tab} /> : null}
    </div>
  );
}
