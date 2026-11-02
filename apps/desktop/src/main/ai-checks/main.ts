import { app, BrowserWindow, dialog, webContents, type BaseWindow, type WebContents } from 'electron';
import type { AiChecksRepository, SettingsRepository } from '@app/db';
import { AI_CHECKS_ENABLE_PROMPT } from '@app/specs/ai-checks.spec';
import type { SeoAuditResponse } from '@app/seo-core';
import type { AgentCheckPort } from '../agent/check-port';
import type { ServedHtml } from '../seo/served';
import { createAiChecksService, type AiChecksMainService } from './service';

// The AI checks in the main process (Phase 9 Task 10; acceptance `specs/ai-checks.feature.md`): the
// one Electron-facing wiring of `service.ts`. Main creates it with one line, after the agent (its
// check port) and before the IPC services, and adds one Clear Browsing Data part (`clear`).
//
// - The tabs: each tab's live browse WebContents (its URL, and the audit's served key: the same
//   `tabUserAgent` / `tabScripting` main's `servedInput` passes to `served.get` / `served.peek`) and
//   whether its audit is ready.
// - The served HTML: main's audit cache, read only with `peek` (the service never fetches).
// - While the mode is not `off`, the active tab's URL and audit version are looked at every
//   `WATCH_INTERVAL_MS`; a change asks the service to look again (a ready audit, the served HTML
//   settling, another tab). Nothing is polled while checks are off.
// - The consent dialog: a native message box main shows (`AI_CHECKS_ENABLE_PROMPT`), parented to
//   the focused window (else the app's); Cancel is the default.

/** How often the active tab's page and audit are looked at while checks are on (ms). */
const WATCH_INTERVAL_MS = 1_000;

export interface AiChecksMainDeps {
  readonly browser: {
    getState(): { readonly activeTabId: number | null; readonly tabs: readonly { readonly id: number; readonly url: string; readonly auditVersion: number }[] };
    tabIdOf(contents: WebContents): number | null;
    readonly seo: { getAudit(tabId: number): SeoAuditResponse };
  };
  /** Whether `contents` is a tab's (on the browse partition's session). */
  readonly isBrowseContents: (contents: WebContents) => boolean;
  /** Main's served-HTML cache (`null` until the browse session exists). */
  readonly served: () => ServedHtml | null;
  /** The audit's served key for a tab: its user agent and scripting (main's own `tabUserAgent` / `tabScripting`). */
  readonly tabUserAgent: (contents: WebContents) => string | null;
  readonly tabScripting: (contents: WebContents) => boolean;
  /** The agent's check port (`createAgentService(…).checks`). */
  readonly agent: AgentCheckPort;
  readonly sessionStore: { readonly aiChecks: AiChecksRepository; readonly settings: SettingsRepository };
  readonly log: (message: string) => void;
}

/** The consent dialog: only `AI_CHECKS_ENABLE_PROMPT.confirmIndex` confirms. */
export async function confirmEnableAiChecks(parent: BaseWindow | null): Promise<boolean> {
  const options = { ...AI_CHECKS_ENABLE_PROMPT.dialog, buttons: [...AI_CHECKS_ENABLE_PROMPT.dialog.buttons] };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === AI_CHECKS_ENABLE_PROMPT.confirmIndex;
}

export function createAiChecksMain(deps: AiChecksMainDeps): AiChecksMainService {
  const { browser } = deps;
  const contentsOf = (tabId: number): WebContents | null => webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && deps.isBrowseContents(contents) && browser.tabIdOf(contents) === tabId) ?? null;
  const service = createAiChecksService({
    tabs: {
      activeTabId: () => browser.getState().activeTabId,
      page: (tabId) => {
        const contents = contentsOf(tabId);
        if (contents === null) return null;
        return {
          contentsId: contents.id,
          url: contents.getURL(),
          userAgent: deps.tabUserAgent(contents),
          scripting: deps.tabScripting(contents),
          auditReady: browser.seo.getAudit(tabId).status === 'ready',
        };
      },
    },
    served: deps.served,
    agent: deps.agent,
    store: deps.sessionStore.aiChecks,
    settings: deps.sessionStore.settings,
    confirmEnable: () => confirmEnableAiChecks(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null),
    log: (line) => deps.log(line),
  });
  void service.load();
  let seen = '';
  const timer = setInterval(() => {
    if (service.mode() === 'off') {
      seen = '';
      return;
    }
    const state = browser.getState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    const key = active === undefined ? '' : `${active.id}\n${active.auditVersion}\n${active.url}`;
    if (key === seen) return;
    seen = key;
    service.refresh();
  }, WATCH_INTERVAL_MS);
  timer.unref();
  app.once('will-quit', () => {
    clearInterval(timer);
    service.dispose();
  });
  return service;
}
