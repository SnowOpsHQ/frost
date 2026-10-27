import type { PermissionDecision } from '@app/specs/permissions.spec';
import type { PermissionBroker } from './permissions';
import type { Tab } from './tab-model';

// The controller's side of the permission broker (spec `permissions.feature.md`, Controller): each
// tab's head prompt in its state, answers for the active tab only, and its pending prompts denied
// when its document goes.

/** What the controller uses of the permission broker. */
export type TabPermissions = Pick<PermissionBroker, 'promptFor' | 'answer' | 'denyTab' | 'subscribe'>;

export interface TabPrompts {
  /** The tab's head prompt, or `null` (always `null` without a broker). */
  promptFor(tabId: number): ReturnType<PermissionBroker['promptFor']>;
  /** Answers the tab's prompt `promptId`; `false` without a broker or for any other id. */
  answer(tabId: number, promptId: string, decision: PermissionDecision): boolean;
  /**
   * Denies `tab`'s pending prompts (its document is going); answers whether it had any. The denial
   * reports no change itself: the operation that caused it reports its own once it is complete.
   */
  deny(tab: Tab): boolean;
}

/** `changed` hears every prompt that appeared, was answered or timed out (but not `deny`'s). */
export function createTabPrompts(broker: TabPermissions | undefined, changed: () => void): TabPrompts {
  let muted = false;
  broker?.subscribe(() => {
    if (!muted) changed();
  });
  return {
    promptFor: (tabId) => broker?.promptFor(tabId) ?? null,
    answer: (tabId, promptId, decision) => broker?.answer(tabId, promptId, decision) ?? false,
    deny(tab) {
      if (!broker || broker.promptFor(tab.id) === null) return false;
      muted = true;
      try {
        broker.denyTab(tab.id);
      } finally {
        muted = false;
      }
      return true;
    },
  };
}
