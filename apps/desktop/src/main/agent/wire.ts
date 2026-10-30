import { MessageChannelMain, safeStorage, session, utilityProcess } from 'electron';
import { openExternalIfAllowed } from '../security/gesture';
import { focusWindow } from '../window-focus';
import { chatgptBrowserOpener } from './chatgpt/opener';
import { electronAgentDialogs } from './dialogs';
import { createAgentServiceFrom, type AgentServiceDeps } from './service';
import type { AgentSession } from './session';

// The agent panel's service, wired to Electron (Phase 5 Task 6a). Main adds it to the IPC services
// with one line: `agent: createAgentService({ app, browser, webContents, sessionStore, log: logSession })`.
// It also takes `ports` (Task 8: the search tools' data, `./ports`) and `entitlements`; the plan's
// Task 8 as-built note has the lines the lead adds once Phases 3 and 4 merge. Task 9 adds main's own
// dialogs (`./dialogs`: "Delete all chats" and the export's save dialog); `sessionStore` already
// carries the chats' and skills' tables.

export function createAgentService(deps: Omit<AgentServiceDeps, 'electron' | 'buildDir' | 'dialogs' | 'openExternal' | 'focusWindow'>): AgentSession {
  return createAgentServiceFrom({
    ...deps,
    buildDir: __dirname,
    electron: { utilityProcess, MessageChannelMain, safeStorage, session },
    dialogs: electronAgentDialogs,
    // The ChatGPT sign-in's authorize page only, through the scheme-allowlisted opener, and only when
    // `agent.chatgptSignIn` spent the sender window's live user gesture (`consumeGesture`, passed by main).
    openExternal: chatgptBrowserOpener(openExternalIfAllowed),
    // A ChatGPT sign-in that succeeds brings the window it was asked from to the front.
    focusWindow,
  });
}
