import { MessageChannelMain, safeStorage, session, utilityProcess } from 'electron';
import { createAgentServiceFrom, type AgentServiceDeps } from './service';
import type { AgentSession } from './session';

// The agent panel's service, wired to Electron (Phase 5 Task 6a). Main adds it to the IPC services
// with one line: `agent: createAgentService({ app, browser, webContents, sessionStore, log: logSession })`.
// It also takes `ports` (Task 8: the search tools' data, `./ports`) and `entitlements`; the plan's
// Task 8 as-built note has the lines the lead adds once Phases 3 and 4 merge.

export function createAgentService(deps: Omit<AgentServiceDeps, 'electron' | 'buildDir'>): AgentSession {
  return createAgentServiceFrom({ ...deps, buildDir: __dirname, electron: { utilityProcess, MessageChannelMain, safeStorage, session } });
}
