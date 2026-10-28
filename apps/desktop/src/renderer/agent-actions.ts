import type { ApprovalDecision } from '@app/specs/agent-approvals.spec';
import type {
  AgentDeleteAllChatsResult,
  AgentGrantView,
  AgentSaveSkillResult,
  AgentSetRetentionResult,
  AgentSkillDetail,
  AgentSkillDraft,
  AgentSkillSaveMode,
  ChatExportFormat,
  ChatExportResult,
  ChatRetention,
} from '@app/specs/agent-data.spec';
import type { CredentialSlot } from '@app/specs/agent-proxy.spec';
import type { AgentAnswerResult, AgentSendResult, AgentSetKeyResult, AgentSkillRequest } from '@app/specs/agent-session.spec';
import type { ModelId, ModelRoute } from '@app/specs/agent-tools.spec';
import { ipc } from './ipc';

// The agent panel's intents (spec `agent-panel.spec.ts`; procedures
// `packages/ipc-contract/src/agent-router.ts`, all sender-guarded in main). Each resolves main's
// answer, or a safe fallback on an IPC failure. `setKey` is the only call that carries a key, and
// only renderer → main: its answer is one of `AGENT_SET_KEY_RESULTS`, never the key. `send` takes the
// typed text or a skill run (Task 7: the skill's id and its inputs; main resolves and renders it).
// Task 9 (`agent-data.spec.ts`): the grants page, the chat retention, "Delete all chats" and export
// (main asks in its own dialogs: the renderer never names a file), and the skills editor.

export const agentActions = {
  send: (chatId: string | null, message: string | AgentSkillRequest): Promise<AgentSendResult> =>
    ipc.agent.send.mutate(typeof message === 'string' ? { chatId, text: message } : { chatId, ...message }).catch((): AgentSendResult => 'unavailable'),
  stop: (chatId: string): Promise<boolean> => ipc.agent.stop.mutate({ chatId }).catch(() => false),
  newChat: (): Promise<null> => ipc.agent.newChat.mutate().catch(() => null),
  selectChat: (chatId: string): Promise<boolean> => ipc.agent.selectChat.mutate({ chatId }).catch(() => false),
  deleteChat: (chatId: string): Promise<boolean> => ipc.agent.deleteChat.mutate({ chatId }).catch(() => false),
  answerApproval: (approvalId: string, decision: ApprovalDecision): Promise<AgentAnswerResult> =>
    ipc.agent.answerApproval.mutate({ approvalId, decision }).catch((): AgentAnswerResult => 'unknown'),
  setModel: (route: ModelRoute, modelId: ModelId): Promise<boolean> => ipc.agent.setModel.mutate({ route, modelId }).catch(() => false),
  setKey: (slot: CredentialSlot, key: string): Promise<AgentSetKeyResult> => ipc.agent.setKey.mutate({ slot, key }).catch((): AgentSetKeyResult => 'failed'),
  clearKey: (slot: CredentialSlot): Promise<boolean> => ipc.agent.clearKey.mutate({ slot }).catch(() => false),
  listGrants: (): Promise<readonly AgentGrantView[] | null> => ipc.agent.listGrants.query().catch(() => null),
  revokeGrant: (tool: string, origin: string): Promise<boolean> => ipc.agent.revokeGrant.mutate({ tool, origin }).catch(() => false),
  revokeAllGrants: (): Promise<boolean> => ipc.agent.revokeAllGrants.mutate().catch(() => false),
  setReadToolsAllowed: (allowed: boolean): Promise<boolean> => ipc.agent.setReadToolsAllowed.mutate({ allowed }).catch(() => false),
  setChatRetention: (retention: ChatRetention): Promise<AgentSetRetentionResult> => ipc.agent.setChatRetention.mutate({ retention }).catch((): AgentSetRetentionResult => 'failed'),
  deleteAllChats: (): Promise<AgentDeleteAllChatsResult> => ipc.agent.deleteAllChats.mutate().catch((): AgentDeleteAllChatsResult => 'failed'),
  exportChat: (chatId: string, format: ChatExportFormat): Promise<ChatExportResult> => ipc.agent.exportChat.mutate({ chatId, format }).catch((): ChatExportResult => 'failed'),
  skillDetail: (id: string): Promise<AgentSkillDetail | null> => ipc.agent.skillDetail.query({ id }).catch(() => null),
  saveSkill: (skill: AgentSkillDraft, mode: AgentSkillSaveMode): Promise<AgentSaveSkillResult> =>
    ipc.agent.saveSkill
      .mutate({ skill: { ...skill, allowedTools: [...skill.allowedTools], inputs: skill.inputs.map((input) => ({ ...input })) }, mode })
      .catch((): AgentSaveSkillResult => ({ result: 'failed' })),
  deleteSkill: (id: string): Promise<boolean> => ipc.agent.deleteSkill.mutate({ id }).catch(() => false),
  duplicateSkill: (id: string): Promise<AgentSaveSkillResult> => ipc.agent.duplicateSkill.mutate({ id }).catch((): AgentSaveSkillResult => ({ result: 'failed' })),
};

export type AgentActions = typeof agentActions;
