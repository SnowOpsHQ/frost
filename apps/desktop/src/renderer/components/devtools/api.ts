import type { ClearSiteDataResult, ConsoleLogAnswer, NetworkHeadersAnswer, NetworkLogAnswer, RedirectTraceAnswer, StorageAnswer } from '@app/specs/devtools.spec';
import { ipc } from '../../ipc';

// The SEO devtools drawer's calls to main (spec `devtools.feature.md`, Router): the sender-guarded
// `devtools.*` procedures on the chrome's one IPC client. Every answer is already masked by main.
// An IPC failure answers `null` (or `false`), never an exception.

export const devtoolsApi = {
  /** The tab's next devtools version (a long-poll); `null` on an IPC failure. */
  watch: (tabId: number, sinceVersion: number): Promise<number | null> => ipc.devtools.watch.query({ tabId, sinceVersion }).catch(() => null),
  /** The rows changed since cursor `since` (no headers). */
  network: (tabId: number, since: number): Promise<NetworkLogAnswer | null> => ipc.devtools.network.query({ tabId, since }).catch(() => null),
  /** One row's headers, on demand (masked by main). */
  requestHeaders: (tabId: number, requestKey: number): Promise<NetworkHeadersAnswer | null> => ipc.devtools.requestHeaders.query({ tabId, requestKey }).catch(() => null),
  redirects: (tabId: number): Promise<RedirectTraceAnswer | null> => ipc.devtools.redirects.query({ tabId }).catch(() => null),
  console: (tabId: number): Promise<ConsoleLogAnswer | null> => ipc.devtools.console.query({ tabId }).catch(() => null),
  storage: (tabId: number): Promise<StorageAnswer | null> => ipc.devtools.storage.query({ tabId }).catch(() => null),
  revealCookie: (tabId: number, cookie: { name: string; domain: string; path: string }): Promise<boolean> => ipc.devtools.revealCookie.mutate({ tabId, ...cookie }).catch(() => false),
  /** "Clear this site's data" (main asks first); `null` on an IPC failure. */
  clearSiteData: (tabId: number): Promise<ClearSiteDataResult | null> => ipc.devtools.clearSiteData.mutate({ tabId }).catch(() => null),
  setOpen: (open: boolean): Promise<unknown> => ipc.devtools.setOpen.mutate({ open }).catch(() => null),
  setPreserveLog: (tabId: number, preserve: boolean): Promise<boolean> => ipc.devtools.setPreserveLog.mutate({ tabId, preserve }).catch(() => false),
};
