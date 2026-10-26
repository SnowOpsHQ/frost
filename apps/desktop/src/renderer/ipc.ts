import type { AppRouter } from '@app/ipc-contract';
import { createIpcClient } from '@app/ipc-contract/renderer';
import type { LinkFilter } from '@app/seo-core';
import type { SeoAuditRef } from '@app/ipc-contract';
import type { PermissionDecision } from '@app/specs/permissions.spec';
import type { HighlightMode } from '@app/specs/seo-sidebar.spec';

// The chrome's one IPC client (the sender-guarded `browser.*` and `seo.*` procedures, `ping`) and
// the user intents it sends. All browser state, and every SEO audit, lives in main. The chrome never
// touches the system clipboard itself: "Copy" commands ask main to write it.

export const ipc = createIpcClient<AppRouter>();

function ignore(): void {}

export const actions = {
  /** Resolves whether a navigation started (`false` on a no-op or an IPC failure). */
  navigate: (input: string) => ipc.browser.navigate.mutate({ input }).catch(() => false),
  newTab: () => ipc.browser.newTab.mutate().catch(ignore),
  closeTab: (tabId: number) => ipc.browser.closeTab.mutate({ tabId }).catch(ignore),
  activateTab: (tabId: number) => ipc.browser.activateTab.mutate({ tabId }).catch(ignore),
  back: () => ipc.browser.back.mutate().catch(ignore),
  forward: () => ipc.browser.forward.mutate().catch(ignore),
  reload: () => ipc.browser.reload.mutate().catch(ignore),
  stop: () => ipc.browser.stop.mutate().catch(ignore),
  answerPermission: (promptId: string, decision: PermissionDecision) => ipc.browser.answerPermission.mutate({ promptId, decision }).catch(ignore),
  setPageBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipc.browser.setPageBounds.mutate(bounds).catch(ignore),
  /** Audits the tab again (`seo.rerun`). */
  rerunAudit: (tabId: number) => ipc.seo.rerun.mutate({ tabId }).catch(ignore),
  /** Opens an `http(s)` URL from a panel in a background tab (main checks the scheme); resolves the tab's id or `null`. */
  openBackgroundTab: (url: string) => ipc.browser.openBackgroundTab.mutate({ url }).catch(() => null),
  /** Sets the tab's highlight overlay (`seo.setHighlight`); resolves whether it was set. */
  setHighlight: (tabId: number, mode: HighlightMode) => ipc.seo.setHighlight.mutate({ tabId, mode }).catch(() => false),
  /** Copies the filtered links of the audit on screen as CSV through main's clipboard; resolves how many rows (`null`: nothing copied). */
  copyLinksCsv: (tabId: number, audit: SeoAuditRef, filter: LinkFilter) => ipc.seo.copyLinksCsv.mutate({ tabId, audit, filter }).catch(() => null),
  /** Copies a URL the audit on screen lists through main's clipboard; resolves whether it was copied. */
  copyUrl: (tabId: number, audit: SeoAuditRef, url: string) => ipc.seo.copyUrl.mutate({ tabId, audit, url }).catch(() => false),
};
