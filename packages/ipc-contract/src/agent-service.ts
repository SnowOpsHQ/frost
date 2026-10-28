import type { ApprovalDecision } from '@app/specs/agent-approvals.spec';
import type { CredentialSlot } from '@app/specs/agent-proxy.spec';
import type { AgentAnswerResult, AgentSendResult, AgentSetKeyResult, AgentState } from '@app/specs/agent-session.spec';
import type { ModelId, ModelRoute } from '@app/specs/agent-tools.spec';

// The agent panel's main-side service as the `agent.*` procedures see it (Phase 5 Task 6a;
// acceptance `agent-session.feature.md`, Router). Main implements it over its chat session manager
// (`apps/desktop/src/main/agent/session.ts`); this package only knows the interface. Nothing here
// answers a key: the renderer can set or clear one and learn from `AgentState.setup.keys` whether
// one is set.

export interface AgentService {
  /** The panel's state now (`AgentState`; never a key). */
  getState(): AgentState;
  /**
   * Resolves with the state once its `version` exceeds `sinceVersion` (at once if it already does).
   * When `signal` aborts, resolves with the current state and drops the waiter. At most
   * `MAX_PENDING_AGENT_WATCHES` wait; one more answers the oldest early.
   */
  watch(sinceVersion: number, signal?: AbortSignal): Promise<AgentState>;
  /**
   * Sends the user's message in chat `chatId` (`null`: a new chat, bound to the active tab) and
   * starts a turn, unless one is running (`busy`, nothing queued) or the agent isn't set up. Resolves
   * once the turn started or was refused (a refusal also shows as `AgentState.notice`). Never rejects.
   */
  send(chatId: string | null, text: string): Promise<AgentSendResult>;
  /** Stops the chat's running turn (its pending approvals expire); `false` if none was running. */
  stop(chatId: string): boolean;
  /** Selects a new, empty chat (the next `send` with `null` creates it). */
  newChat(): void;
  /** Selects a chat; `false` for an unknown id. */
  selectChat(chatId: string): boolean;
  /** Deletes a chat (stopping its turn first); `false` for an unknown id. */
  deleteChat(chatId: string): boolean;
  /** Answers the approval request `approvalId` once (the panel's buttons only). Never rejects. */
  answerApproval(approvalId: string, decision: ApprovalDecision): Promise<AgentAnswerResult>;
  /** Sets the route and model (the next turn uses them); `false` when the pair isn't valid or can't be stored. */
  setModel(route: ModelRoute, modelId: ModelId): Promise<boolean>;
  /** Stores a key in `slot`; answers how that went, never the key. */
  setKey(slot: CredentialSlot, key: string): Promise<AgentSetKeyResult>;
  /** Removes the slot's key; `false` if it couldn't be removed. */
  clearKey(slot: CredentialSlot): Promise<boolean>;
}
