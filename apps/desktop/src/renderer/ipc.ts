import type { AppRouter } from '@app/ipc-contract';
import { createIpcClient } from '@app/ipc-contract/renderer';
import type { LinkFilter } from '@app/seo-core';
import type { SeoAuditRef } from '@app/ipc-contract';
import type { CopyValueKey, OpenInTemplateId } from '@app/specs/command-palette.spec';
import type { PageCommand } from '@app/specs/page-commands.spec';
import type { PermissionDecision } from '@app/specs/permissions.spec';
import type { RenderProfile } from '@app/specs/render-profile.spec';
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
  /** Copies one JSON-LD block of the audit on screen through main's clipboard (main formats it); resolves whether it was copied. */
  copySchemaJson: (tabId: number, audit: SeoAuditRef, block: number) => ipc.seo.copySchemaJson.mutate({ tabId, audit, block }).catch(() => false),
  /** Measures the active tab's page speed (`seo.measureSpeed`); resolves its answer, `null` on an IPC failure. */
  measureSpeed: (tabId: number) => ipc.seo.measureSpeed.mutate({ tabId }).catch(() => null),
  /** Starts the accessibility check on the tab's page (`seo.runAccessibility`); resolves whether one is running. */
  runAccessibility: (tabId: number) => ipc.seo.runAccessibility.mutate({ tabId }).catch(() => false),
  // The command palette's (`command-palette.feature.md`).
  /** Runs a page command (zoom …) on the active tab, as its menu item does. */
  pageCommand: (command: PageCommand) => ipc.browser.pageCommand.mutate({ command }).catch(ignore),
  /** Gives focus back to the active tab's page; resolves whether a page took it. */
  focusPage: () => ipc.browser.focusPage.mutate().catch(() => false),
  /** The menu's Clear Browsing Data… (main asks first). */
  clearBrowsingData: () => ipc.browser.clearBrowsingData.mutate().catch(ignore),
  /** Copies one allowlisted value of the audit on screen through main's clipboard; resolves whether it was copied. */
  copyValue: (tabId: number, audit: SeoAuditRef, key: CopyValueKey) => ipc.seo.copyValue.mutate({ tabId, audit, key }).catch(() => false),
  /** "Open in" a tool: main builds the URL and may refuse (`OpenToolResult`); `null` on an IPC failure. */
  openTool: (tool: OpenInTemplateId) => ipc.browser.openTool.mutate({ tool }).catch(() => null),
  /** Sets the tab's render profile (`pin`: as this site's pin); resolves whether it was set (`render-profile.feature.md`). */
  setRenderProfile: (tabId: number, profile: RenderProfile, pin: boolean) => ipc.browser.setRenderProfile.mutate({ tabId, profile, pin }).catch(() => false),
  /** Reset: the tab's render profile and this site's pin go; resolves whether it had one. */
  clearRenderProfile: (tabId: number) => ipc.browser.clearRenderProfile.mutate({ tabId }).catch(() => false),
};
