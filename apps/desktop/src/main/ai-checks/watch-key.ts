/**
 * What the 1 s poll compares to know the service should look again: every tab's id, audit version and URL,
 * plus the active tab. A background tab's audit settling counts: a page asked for ("Check this page") may
 * wait on its served HTML while the user is on another tab.
 */
export function aiChecksWatchKey(state: { readonly activeTabId: number | null; readonly tabs: readonly { readonly id: number; readonly url: string; readonly auditVersion: number }[] }): string {
  return [String(state.activeTabId), ...state.tabs.map((tab) => `${tab.id}\n${tab.auditVersion}\n${tab.url}`)].join('\n\n');
}
