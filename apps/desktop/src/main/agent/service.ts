import type { SkillRegistry } from '@app/ai-skills/skills';
import type { AgentGrantsStore } from './grants';
import { AGENT_E2E_SCRIPT_SWITCH } from '@app/specs/agent-session.spec';
import { e2eAgentScriptFrom } from './e2e-seam';
import type { AgentEntitlements } from './entitlements';
import { resolveAgentPorts, type AgentPorts } from './ports';
import { createAgent, type AgentElectron } from './index';
import { createAgentSession, type AgentSession } from './session';
import { createBrowserPageToolRunner, type PageToolsBrowser, type PageToolsWebContents } from './tools';

// The agent's main-side composition for the IPC (Phase 5 Task 6a; acceptance
// `specs/agent-session.feature.md`, Wiring): `createAgent` (host, key store, proxy, settings,
// grants, approval broker) with the real page tools and the tab controller's URLs, the session
// manager over it, the e2e seam (unpackaged only), and disposal when the app quits. The runtime is
// forked on the first message (the session calls `start()`), not at launch. `wire.ts` passes the
// Electron modules; tests pass fakes. The search tools' data ports (Task 8) and the entitlements
// port are optional: without them the ports answer "not connected in this build" and every agent
// feature is allowed (the lead wires Phases 3 and 4 here; the plan's Task 8 as-built note).

/** The parts of Electron's `app` used here. */
export interface AgentServiceApp {
  readonly isPackaged: boolean;
  getPath(name: 'userData'): string;
  readonly commandLine: { getSwitchValue(name: string): string };
  once(event: 'will-quit', listener: () => void): unknown;
}

/** The tab controller as the agent sees it: the page tools' calls, and each tab's URL. */
export interface AgentServiceBrowser extends PageToolsBrowser {
  getState(): { readonly activeTabId: number | null; readonly tabs: readonly { readonly id: number; readonly url: string; readonly title: string }[] };
}

export interface AgentServiceDeps {
  readonly app: AgentServiceApp;
  readonly electron: AgentElectron;
  readonly browser: AgentServiceBrowser;
  readonly webContents: PageToolsWebContents;
  /** The browser-session database (`agentGrants`: the standing grants' table). */
  readonly sessionStore: { readonly agentGrants: AgentGrantsStore };
  /** Main's build directory (`__dirname`): the runtime's bundle is beside main's. */
  readonly buildDir: string;
  /** The skills the panel can run (default: the built-ins; Task 9 passes the built-ins composed with the user's). */
  readonly skills?: SkillRegistry;
  /** The search tools' data ports (default: each not connected, `resolveAgentPorts`). */
  readonly ports?: AgentPorts;
  /** Which agent features may run (default: all; the lead wires Phase 4's `requireFeature`). */
  readonly entitlements?: AgentEntitlements;
  readonly log?: (line: string) => void;
}

export function createAgentServiceFrom(deps: AgentServiceDeps): AgentSession {
  const log = deps.log ?? (() => undefined);
  const e2eAgentScript = e2eAgentScriptFrom({ packaged: deps.app.isPackaged, switchValue: deps.app.commandLine.getSwitchValue(AGENT_E2E_SCRIPT_SWITCH), log });
  const tabOf = (tabId: number) => deps.browser.getState().tabs.find((item) => item.id === tabId);
  const tabUrl = (tabId: number): string | null => {
    const tab = tabOf(tabId);
    return tab === undefined || tab.url === '' ? null : tab.url;
  };
  const agent = createAgent({
    electron: deps.electron,
    userData: deps.app.getPath('userData'),
    buildDir: deps.buildDir,
    packaged: deps.app.isPackaged,
    log,
    grantsStore: deps.sessionStore.agentGrants,
    toolRunner: createBrowserPageToolRunner({ browser: deps.browser, webContents: deps.webContents, ports: resolveAgentPorts(deps.ports) }),
    ...(deps.entitlements ? { entitlements: deps.entitlements } : {}),
    tabUrl,
    e2eAgentScript,
  });
  const session = createAgentSession({
    host: agent.host,
    approvals: agent.approvals,
    credentials: agent.credentials,
    settings: agent.settings,
    entitlements: agent.entitlements,
    grants: agent.grants,
    start: () => agent.start(),
    activeTabId: () => deps.browser.getState().activeTabId,
    // A skill's `pageUrl` and `pageTitle`: the chat tab's, as the tab strip shows them.
    tabPage: (tabId) => {
      const tab = tabOf(tabId);
      return tab === undefined ? null : { url: tab.url === '' ? null : tab.url, title: tab.title === '' ? null : tab.title };
    },
    ...(deps.skills ? { skills: deps.skills } : {}),
    scripted: e2eAgentScript !== null,
    log,
  });
  // The stored route, model and grants, and which keys are set, for the panel's first state; the
  // runtime itself waits for the first message.
  void Promise.all([agent.settings.load(), agent.grants.load()]).then(() => session.refreshSetup());
  deps.app.once('will-quit', () => {
    session.dispose();
    agent.dispose();
  });
  return session;
}
