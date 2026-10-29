import { useState } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { DevtoolsDrawer } from './components/devtools/DevtoolsDrawer';
import { FindBar } from './components/FindBar';
import { FullscreenNotice } from './components/FullscreenNotice';
import { HistoryView } from './components/HistoryView';
import { PageArea } from './components/PagePanels';
import { PromptBar } from './components/PermissionBar';
import { RenderProfileBar } from './components/RenderProfile';
import { SeoSidebar } from './components/SeoSidebar';
import { StatusBar } from './components/StatusBar';
import { TabStrip } from './components/TabStrip';
import { Toolbar } from './components/Toolbar';
import { UpdateBar } from './components/UpdateBar';
import { useBrowserState } from './hooks/useBrowserState';
import { useHistoryView } from './hooks/useHistoryView';
import { useNotice } from './hooks/useNotice';
import { usePing } from './hooks/usePing';
import { useSeoAudit } from './hooks/useSeoAudit';
import { useSidebarOpen } from './hooks/useSidebarOpen';
import { SettingsSlot } from './settings-view';
import type { PanelJump } from './palette/registry';
import { Projects } from './components/changes/Projects';
import { useProjectsSheet } from './components/changes/projects-sheet';

// The browser chrome (spec `browser-chrome.feature.md`, Layout; `tabs.feature.md`). Its rows: the
// tab strip, the toolbar, the permission prompt bar, the render-profile editor bar while open
// (`render-profile.feature.md`), the find bar while the active tab's is open
// (`browser-polish.feature.md`), the update notice while it has something to show
// (`update-client.feature.md`), the workspace (the page column, with the command palette's sheet
// or the History sheet over the page area, and the SEO sidebar docked on its right:
// `command-palette.feature.md`, `seo-sidebar.feature.md`), the SEO devtools drawer while open
// (`devtools.feature.md`), and the status bar; and the fullscreen notice. The page area takes what
// the others leave, and main lays the tab's view out over exactly that.
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
  // Browser polish (`browser-polish.feature.md`): the History sheet (per window) and the active tab's find bar.
  const [historyOpen, closeHistory] = useHistoryView(state?.historyViewSeq, tab);
  // Projects (`projects.feature.md`): the Projects sheet over the page column, like History.
  const [projectsOpen, closeProjects] = useProjectsSheet(historyOpen, closeHistory);
  return (
    <div className="chrome">
      <TabStrip state={state} />
      <Toolbar tab={tab} focusSeq={state?.focusAddressBarSeq} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} profileOpen={profileOpen} onToggleProfile={() => setProfileOpen((open) => !open)} />
      {/* Always present (empty without a prompt), so the grid rows stay put; polite, not focus-taking. */}
      <div className="prompt-slot" aria-live="polite">
        {tab?.permissionPrompt ? <PromptBar key={`${tab.id} ${tab.permissionPrompt.id}`} prompt={tab.permissionPrompt} covered={tab.fullscreen !== null} /> : null}
      </div>
      <div className="render-slot">{profileOpen ? <RenderProfileBar tab={tab} onClose={() => setProfileOpen(false)} /> : null}</div>
      {/* The find bar's row: empty unless the active tab's bar is open, and while the History sheet shows. */}
      <div className="find-slot">{historyOpen ? null : <FindBar find={state?.find} />}</div>
      {/* The update notice's row (`update-client.feature.md`, Chrome): always present, empty unless there is something to act on. */}
      <UpdateBar />
      {/* The workspace and, under it, the devtools drawer's band: the drawer is clamped against their height. */}
      <div className="workspace-stack">
        <div className="workspace">
          {/* The palette's sheet and the History sheet sit above the page area, never under the tab's view (`command-palette.spec.ts`). */}
          <div className="page-column" data-history={historyOpen ? 'open' : undefined}>
            <CommandPalette state={state} tab={tab} audit={empty ? null : audit} sidebarOpen={sidebarOpen} onSidebarOpenChange={setSidebarOpen} onPanelJump={setPanelJump} />
            {historyOpen ? <HistoryView onClose={closeHistory} /> : null}
            {projectsOpen ? <Projects tab={tab} onClose={closeProjects} /> : null}
            <SettingsSlot tab={tab} historySeq={state?.historyViewSeq} onOpen={closeHistory} />
            <PageArea tab={tab} empty={state !== null && empty} onEditProfile={() => setProfileOpen(true)} />
          </div>
          <SeoSidebar tab={tab} open={sidebarOpen} response={empty ? null : audit} onOpenChange={setSidebarOpen} jump={panelJump} notesGeneration={state?.contentNotesGeneration} />
        </div>
        {/* The SEO devtools drawer (`devtools.feature.md`): a band under the workspace, which shrinks above it. */}
        <DevtoolsDrawer state={state} tab={tab} audit={empty ? null : audit} onOpenPanel={(panel) => setPanelJump((last) => ({ panel, focus: true, seq: (last?.seq ?? 0) + 1 }))} />
      </div>
      <StatusBar tab={tab} notice={notice} ping={ping} connection={connection} />
      {tab?.fullscreen === 'notice' ? <FullscreenNotice tab={tab} /> : null}
    </div>
  );
}
