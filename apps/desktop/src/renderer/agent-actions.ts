import type { ApprovalDecision } from '@app/specs/agent-approvals.spec';
import type { CredentialSlot } from '@app/specs/agent-proxy.spec';
import type { AgentAnswerResult, AgentSendResult, AgentSetKeyResult } from '@app/specs/agent-session.spec';
import type { ModelId, ModelRoute } from '@app/specs/agent-tools.spec';
import { ipc } from './ipc';

// The agent panel's intents (spec `agent-panel.spec.ts`; procedures
// `packages/ipc-contract/src/agent-router.ts`, all sender-guarded in main). Each resolves main's
// answer, or a safe fallback on an IPC failure. `setKey` is the only call that carries a key, and
// only renderer → main: its answer is one of `AGENT_SET_KEY_RESULTS`, never the key.

export const agentActions = {
  send: (chatId: string | null, text: string): Promise<AgentSendResult> => ipc.agent.send.mutate({ chatId, text }).catch((): AgentSendResult => 'unavailable'),
  stop: (chatId: string): Promise<boolean> => ipc.agent.stop.mutate({ chatId }).catch(() => false),
  newChat: (): Promise<null> => ipc.agent.newChat.mutate().catch(() => null),
  selectChat: (chatId: string): Promise<boolean> => ipc.agent.selectChat.mutate({ chatId }).catch(() => false),
  deleteChat: (chatId: string): Promise<boolean> => ipc.agent.deleteChat.mutate({ chatId }).catch(() => false),
  answerApproval: (approvalId: string, decision: ApprovalDecision): Promise<AgentAnswerResult> =>
    ipc.agent.answerApproval.mutate({ approvalId, decision }).catch((): AgentAnswerResult => 'unknown'),
  setModel: (route: ModelRoute, modelId: ModelId): Promise<boolean> => ipc.agent.setModel.mutate({ route, modelId }).catch(() => false),
  setKey: (slot: CredentialSlot, key: string): Promise<AgentSetKeyResult> => ipc.agent.setKey.mutate({ slot, key }).catch((): AgentSetKeyResult => 'failed'),
  clearKey: (slot: CredentialSlot): Promise<boolean> => ipc.agent.clearKey.mutate({ slot }).catch(() => false),
};

export type AgentActions = typeof agentActions;
