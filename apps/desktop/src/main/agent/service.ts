import fs from 'node:fs/promises';
import { createBuiltinSkillRegistry, type SkillRegistry } from '@app/ai-skills/skills';
import { CHAT_PRUNE_INTERVAL_MS, chatExportFileName, type ChatExportFormat, type ChatExportResult, type ChatRetention } from '@app/specs/agent-data.spec';
import type { AgentGrantsStore } from './grants';
import { AGENT_E2E_SCRIPT_SWITCH } from '@app/specs/agent-session.spec';
import { chatExportText } from './chat-export';
import { createChatHistory, createMemoryChatsStore, type AgentChatsStore } from './chat-history';
import type { ChatSnapshot } from './chat-record';
import { e2eAgentScriptFrom } from './e2e-seam';
import { chatgptE2eSeamFrom, e2eBrowser } from './chatgpt/e2e-seam';
import { chatgptBrowserOpener } from './chatgpt/opener';
import { CHATGPT_E2E_SWITCH } from '@app/specs/agent-chatgpt-e2e.schema';
import { AGENT_MCP_PARTITION } from '@app/specs/agent-mcp.spec';
import { createDefaultAgentEntitlements, type AgentEntitlements } from './entitlements';
import { createMcpManager, createMcpSecrets, createMemoryMcpStore, nodeMcpDeps, type McpManagerDeps, type McpServersStore, type McpSessionLike, type McpStartPrompt } from './mcp';
import { resolveAgentPorts, type AgentPorts } from './ports';
import { createAgent, type AgentElectron } from './index';
import { createAgentSession, type AgentSession } from './session';
import { createSkillFiles, type SkillFileDialogs, type SkillFilesFs } from './skill-files';
import { createBrowserPageToolRunner, type PageToolsBrowser, type PageToolsWebContents } from './tools';
import { createMemorySkillsStore, createUserSkills, type AgentSkillPrefsStore, type AgentSkillsStore } from './user-skills';

// The agent's main-side composition for the IPC (Phase 5 Task 6a; acceptance
// `specs/agent-session.feature.md`, Wiring): `createAgent` (host, key store, proxy, settings,
// grants, approval broker) with the real page tools and the tab controller's URLs, the session
// manager over it, the e2e seam (unpackaged only), and disposal when the app quits. The runtime is
// forked on the first message (the session calls `start()`), not at launch. `wire.ts` passes the
// Electron modules; tests pass fakes. The search tools' data ports (Task 8) are optional: without
// them the ports answer "not connected in this build" (main wires Phases 3 and 4's). The agent is
// never gated (`UNGATED_FEATURES`): main passes no entitlements port, so every agent feature is
// allowed; the port stays a seam for tests of the refusal paths.
//
// Task 9 (acceptance `specs/agent-data.feature.md`, Wiring): the stored chats (`sessionStore.agentChats`;
// loaded and pruned at startup, pruned daily), the user's skills (`sessionStore.agentSkills`, composed
// after the built-ins), and main's own dialogs: "Delete all chats" asks first, and an export is
// written only to the file the user chose in the save dialog. Phase 8 Task 6: skills files
// (`./skill-files`), exported and imported through main's own save and open dialogs.

/** main's own dialogs for the agent's data (`dialogs.ts` with Electron; fakes in tests), and the skills files' (`SkillFileDialogs`). */
export interface AgentDialogs extends SkillFileDialogs {
  /** Asks before every chat is deleted: `true` only when the user confirmed. */
  confirmDeleteAllChats(): Promise<boolean>;
  /** Asks before a retention change deletes `chats` saved chats: `true` only when the user confirmed. */
  confirmRetentionChange(retention: ChatRetention, chats: number): Promise<boolean>;
  /** Asks where to save an export (`defaultName` offered): the chosen file, or `null` if cancelled. */
  chooseExportPath(defaultName: string, format: ChatExportFormat): Promise<string | null>;
  /** Asks before a command MCP server starts (Task 10), showing the exact command line: `true` only when the user confirmed. */
  confirmMcpStart(prompt: McpStartPrompt): Promise<boolean>;
}

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
  /**
   * The browser-session database: `agentGrants` (the standing grants' table), and Task 9's
   * `agentChats`, `agentSkills` and `agentSkillPrefs` (each in memory when absent: nothing persists).
   */
  readonly sessionStore: { readonly agentGrants: AgentGrantsStore; readonly agentChats?: AgentChatsStore; readonly agentSkills?: AgentSkillsStore; readonly agentSkillPrefs?: AgentSkillPrefsStore; readonly agentMcp?: McpServersStore };
  /** Main's build directory (`__dirname`): the runtime's bundle is beside main's. */
  readonly buildDir: string;
  /** frost's own skills (default: the built-ins); the user's are composed after them (Task 9). */
  readonly skills?: SkillRegistry;
  /** main's dialogs (Task 9); default: "Delete all chats" and deleting retention changes never confirmed, every export cancelled. */
  readonly dialogs?: AgentDialogs;
  /** Writes an export's text to the file the user chose (default: `fs.writeFile`, owner-only). */
  readonly writeExport?: (file: string, text: string) => Promise<void>;
  /** The skills files' reads and writes (Phase 8 Task 6; default: `node:fs/promises`). */
  readonly skillFilesFs?: SkillFilesFs;
  readonly now?: () => number;
  /** The daily prune's timer (default: the global `setInterval`, unref'd). */
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** The search tools' data ports (default: each not connected, `resolveAgentPorts`). */
  readonly ports?: AgentPorts;
  /** Which agent features may run (default: all, always: the agent is not gated; tests pass a refusing port). Never wired to the account's entitlements. */
  readonly entitlements?: AgentEntitlements;
  /**
   * MCP servers' operating-system pieces and secrets (Task 10); default: Node's and Electron's
   * (`mcp/node.ts`: `spawn` without a shell, the `agent-mcp` session, temporary folders, the
   * sandbox detection) and the encrypted secrets file. Tests pass fakes.
   */
  readonly mcp?: Partial<Omit<McpManagerDeps, 'store' | 'entitlements' | 'confirmStart' | 'userData'>>;
  /**
   * Opens the ChatGPT sign-in's authorize page in the system browser (`wire.ts`: the authorize page
   * only, through the scheme-allowlisted opener, only with `userGesture`); default: never.
   */
  readonly openExternal?: (url: string, userGesture: boolean) => boolean;
  /** Brings app window `windowId` to the front when a ChatGPT sign-in started from it succeeds; default: nothing. */
  readonly focusWindow?: (windowId: number) => void;
  /** Spends app window `windowId`'s live user gesture (main's per-window tracker); default: none, so no sign-in opens. */
  readonly consumeGesture?: (windowId: number) => boolean;
  readonly log?: (line: string) => void;
}

const NO_DIALOGS: AgentDialogs = {
  confirmDeleteAllChats: async () => false,
  confirmRetentionChange: async () => false,
  chooseExportPath: async () => null,
  confirmMcpStart: async () => false,
  chooseSkillExportPath: async () => null,
  chooseSkillImportFile: async () => null,
};

export function createAgentServiceFrom(deps: AgentServiceDeps): AgentSession {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const dialogs = deps.dialogs ?? NO_DIALOGS;
  const writeExport = deps.writeExport ?? ((file: string, text: string) => fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600 }));
  const history = createChatHistory({ store: deps.sessionStore.agentChats ?? createMemoryChatsStore(), now, log });
  // Each in memory when the database is absent (nothing persists); one memory store holds both, so a re-key moves the switch.
  const memorySkills = createMemorySkillsStore();
  const userSkills = createUserSkills({ store: deps.sessionStore.agentSkills ?? memorySkills, prefs: deps.sessionStore.agentSkillPrefs ?? memorySkills, builtins: deps.skills ?? createBuiltinSkillRegistry(), now, log });
  // Skills files go only to and from the file the user chose in main's own dialogs.
  const skillFiles = createSkillFiles({
    skills: userSkills,
    dialogs: { chooseSkillExportPath: (name) => dialogs.chooseSkillExportPath(name), chooseSkillImportFile: () => dialogs.chooseSkillImportFile() },
    fs: deps.skillFilesFs ?? fs,
    now,
    log,
  });
  /** An export: main's save dialog first; the text is built and written only to the file chosen there. */
  const exportChat = async (chat: ChatSnapshot, format: ChatExportFormat): Promise<ChatExportResult> => {
    let file: string | null = null;
    try {
      file = await dialogs.chooseExportPath(chatExportFileName(format, new Date(now())), format);
    } catch {
      return 'failed';
    }
    if (file === null) return 'cancelled';
    try {
      await writeExport(file, chatExportText(chat, format, now()));
      return 'saved';
    } catch {
      log('agent: a chat export could not be written');
      return 'failed';
    }
  };
  const e2eAgentScript = e2eAgentScriptFrom({ packaged: deps.app.isPackaged, switchValue: deps.app.commandLine.getSwitchValue(AGENT_E2E_SCRIPT_SWITCH), log });
  // The ChatGPT plan's e2e seam (unpackaged only): a local fake's endpoints, and a stand-in browser
  // for its authorize page (still only that page, still only on a spent gesture).
  const chatgptE2e = chatgptE2eSeamFrom({ packaged: deps.app.isPackaged, switchValue: deps.app.commandLine.getSwitchValue(CHATGPT_E2E_SWITCH), log });
  const openExternal = chatgptE2e !== null ? chatgptBrowserOpener(e2eBrowser({ log }), chatgptE2e.endpoints.authorize) : deps.openExternal;
  // "The tab's page" has one source: the chat tab's live WebContents (its URL and title, as the page
  // tools read them), for the broker (approvals, grants, `completeToolInput`) and the skills alike,
  // never the tab strip's copy.
  const liveContents = (tabId: number) => deps.webContents.getAllWebContents().find((item) => !item.isDestroyed() && deps.browser.tabIdOf(item) === tabId);
  const tabUrl = (tabId: number): string | null => {
    const url = liveContents(tabId)?.getURL() ?? '';
    return url === '' ? null : url;
  };
  const entitlements = deps.entitlements ?? createDefaultAgentEntitlements();
  const mcpSession = (): McpSessionLike => {
    const session = deps.electron.session.fromPartition(AGENT_MCP_PARTITION);
    if (typeof session.resolveHost !== 'function') throw new Error('no resolver');
    // Electron's `session.fetch` takes any request init; the MCP transport sends `POST` and `DELETE`.
    return session as unknown as McpSessionLike;
  };
  const mcp = createMcpManager({
    ...nodeMcpDeps(mcpSession),
    secrets: createMcpSecrets({ safeStorage: deps.electron.safeStorage, userData: deps.app.getPath('userData'), fs, log }),
    ...deps.mcp,
    userData: deps.app.getPath('userData'),
    store: deps.sessionStore.agentMcp ?? createMemoryMcpStore(),
    entitlements,
    confirmStart: (prompt) => dialogs.confirmMcpStart(prompt),
    now,
    log,
  });
  const agent = createAgent({
    electron: deps.electron,
    userData: deps.app.getPath('userData'),
    buildDir: deps.buildDir,
    packaged: deps.app.isPackaged,
    log,
    grantsStore: deps.sessionStore.agentGrants,
    toolRunner: createBrowserPageToolRunner({ browser: deps.browser, webContents: deps.webContents, ports: resolveAgentPorts(deps.ports) }),
    entitlements,
    mcp,
    tabUrl,
    e2eAgentScript,
    ...(openExternal ? { openExternal } : {}),
    ...(deps.focusWindow ? { focusWindow: deps.focusWindow } : {}),
    chatgptE2e,
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
    // A skill's `pageUrl` and `pageTitle`: the same source, at send time.
    tabPage: (tabId) => {
      const contents = liveContents(tabId);
      if (contents === undefined) return null;
      const url = contents.getURL();
      const title = contents.getTitle();
      return { url: url === '' ? null : url, title: title === '' ? null : title };
    },
    skills: userSkills.registry,
    userSkills,
    history,
    confirmDeleteAllChats: () => dialogs.confirmDeleteAllChats(),
    confirmRetentionChange: (retention, chats) => dialogs.confirmRetentionChange(retention, chats),
    exportChat,
    skillFiles,
    scripted: e2eAgentScript !== null,
    mcp,
    chatgpt: agent.chatgpt,
    ...(deps.consumeGesture ? { consumeGesture: deps.consumeGesture } : {}),
    now,
    log,
  });
  // The stored route, model, grants, skills and chats (pruned first), and which keys are set, for
  // the panel's first state; the runtime itself waits for the first message.
  void Promise.all([agent.settings.load(), agent.grants.load(), userSkills.load(), mcp.load(), history.load().then((chats) => session.restore(chats))]).then(() => session.refreshSetup());
  // The stored ChatGPT sign-in, then the account's models (kept with the settings, so after them).
  void agent.settings.load().then(() => agent.chatgpt.start());
  // Then daily, while frost runs (startup's prune is the load's).
  const setTimer = deps.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms).unref());
  const clearTimer = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const pruning = setTimer(() => void session.prune(), CHAT_PRUNE_INTERVAL_MS);
  deps.app.once('will-quit', () => {
    clearTimer(pruning);
    session.dispose();
    // Command servers' process groups get SIGKILL now, before the app goes (no timer may outlive it).
    mcp.killAll();
    void mcp.dispose();
    agent.dispose();
  });
  return session;
}
