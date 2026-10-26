import { FullscreenNotice } from './components/FullscreenNotice';
import { PageArea } from './components/PagePanels';
import { PromptBar } from './components/PermissionBar';
import { SeoSidebar } from './components/SeoSidebar';
import { StatusBar } from './components/StatusBar';
import { TabStrip } from './components/TabStrip';
import { Toolbar } from './components/Toolbar';
import { useBrowserState } from './hooks/useBrowserState';
import { useNotice } from './hooks/useNotice';
import { usePing } from './hooks/usePing';
import { useSeoAudit } from './hooks/useSeoAudit';
import { useSidebarOpen } from './hooks/useSidebarOpen';

// The browser chrome (spec `browser-chrome.feature.md`, Layout; `tabs.feature.md`): tab strip,
// toolbar, permission prompt bar, page area with the SEO sidebar docked on its right
// (`seo-sidebar.feature.md`), status bar, and the fullscreen notice.
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
  return (
    <div className="chrome">
      <TabStrip state={state} />
      <Toolbar tab={tab} focusSeq={state?.focusAddressBarSeq} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
      {/* Always present (empty without a prompt), so the grid rows stay put; polite, not focus-taking. */}
      <div className="prompt-slot" aria-live="polite">
        {tab?.permissionPrompt ? <PromptBar key={`${tab.id} ${tab.permissionPrompt.id}`} prompt={tab.permissionPrompt} covered={tab.fullscreen !== null} /> : null}
      </div>
      <div className="workspace">
        <PageArea tab={tab} empty={state !== null && empty} />
        <SeoSidebar tab={tab} open={sidebarOpen} response={empty ? null : audit} onOpenChange={setSidebarOpen} />
      </div>
      <StatusBar tab={tab} notice={notice} ping={ping} connection={connection} />
      {tab?.fullscreen === 'notice' ? <FullscreenNotice tab={tab} /> : null}
    </div>
  );
}
