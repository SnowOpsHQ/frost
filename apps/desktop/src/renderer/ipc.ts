import type { AppRouter } from '@app/ipc-contract';
import { createIpcClient } from '@app/ipc-contract/renderer';
import type { PermissionDecision } from '@app/specs/permissions.spec';

// The chrome's one IPC client (the sender-guarded `browser.*` procedures, `ping`) and the user
// intents it sends. All browser state lives in main.

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
};
