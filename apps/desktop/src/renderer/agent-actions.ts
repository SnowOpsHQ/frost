import type { ApprovalDecision } from '@app/specs/agent-approvals.spec';
import type {
  AgentDeleteAllChatsResult,
  AgentGrantView,
  AgentSaveSkillResult,
  AgentSetRetentionResult,
  AgentSkillDetail,
  AgentSkillDraft,
  AgentSkillImportPreviewResult,
  AgentSkillImportResult,
  AgentSkillSaveMode,
  ChatExportFormat,
  ChatExportResult,
  ChatRetention,
  SkillExportResult,
} from '@app/specs/agent-data.spec';
import type { ChatgptSignInResult, ChatgptSignOutResult } from '@app/specs/agent-chatgpt.spec';
import type { CredentialSlot } from '@app/specs/agent-proxy.spec';
import type { ReasoningEffort } from '@app/specs/agent-reasoning.spec';
import type { AgentAnswerResult, AgentSendResult, AgentSetKeyResult, AgentSkillRequest } from '@app/specs/agent-session.spec';
import type { AgentModelId, ModelRoute } from '@app/specs/agent-tools.spec';
import type { McpSaveResult, McpStartResult, McpTokenResult } from '@app/specs/agent-mcp.spec';
import type { AgentSaveMcpServerRequest } from './agent-view';
import { ipc } from './ipc';

// The agent panel's intents (spec `agent-panel.spec.ts`; procedures
// `packages/ipc-contract/src/agent-router.ts`, all sender-guarded in main). Each resolves main's
// answer, or a safe fallback on an IPC failure. `setKey` is the only call that carries a key, and
// only renderer → main: its answer is one of `AGENT_SET_KEY_RESULTS`, never the key. `send` takes the
// typed text or a skill run (Task 7: the skill's id and its inputs; main resolves and renders it).
// Phase 8 Task 9: the reasoning level (`agent-reasoning.spec.ts`), stored beside the route and model.
// Task 9 (`agent-data.spec.ts`): the grants page, the chat retention, "Delete all chats" and export
// (main asks in its own dialogs: the renderer never names a file), and the skills editor. Phase 8
// Task 6: skills files, exported and imported through main's own dialogs (an import is reviewed first).

export const agentActions = {
  send: (chatId: string | null, message: string | AgentSkillRequest): Promise<AgentSendResult> =>
    ipc.agent.send.mutate(typeof message === 'string' ? { chatId, text: message } : { chatId, ...message }).catch((): AgentSendResult => 'unavailable'),
  stop: (chatId: string): Promise<boolean> => ipc.agent.stop.mutate({ chatId }).catch(() => false),
  newChat: (): Promise<null> => ipc.agent.newChat.mutate().catch(() => null),
  selectChat: (chatId: string): Promise<boolean> => ipc.agent.selectChat.mutate({ chatId }).catch(() => false),
  deleteChat: (chatId: string): Promise<boolean> => ipc.agent.deleteChat.mutate({ chatId }).catch(() => false),
  answerApproval: (approvalId: string, decision: ApprovalDecision): Promise<AgentAnswerResult> =>
    ipc.agent.answerApproval.mutate({ approvalId, decision }).catch((): AgentAnswerResult => 'unknown'),
  setModel: (route: ModelRoute, modelId: AgentModelId): Promise<boolean> => ipc.agent.setModel.mutate({ route, modelId }).catch(() => false),
  setReasoningEffort: (effort: ReasoningEffort): Promise<boolean> => ipc.agent.setReasoningEffort.mutate({ effort }).catch(() => false),
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
  setSkillEnabled: (id: string, enabled: boolean): Promise<boolean> => ipc.agent.setSkillEnabled.mutate({ id, enabled }).catch(() => false),
  exportSkills: (ids: readonly string[] | 'all-mine'): Promise<SkillExportResult> =>
    ipc.agent.exportSkills.mutate({ ids: ids === 'all-mine' ? 'all-mine' : [...ids] }).catch((): SkillExportResult => 'failed'),
  previewSkillImport: (): Promise<AgentSkillImportPreviewResult> => ipc.agent.previewSkillImport.mutate().catch((): AgentSkillImportPreviewResult => ({ result: 'failed' })),
  importSkills: (token: string, indices: readonly number[]): Promise<AgentSkillImportResult> =>
    ipc.agent.importSkills.mutate({ token, indices: [...indices] }).catch((): AgentSkillImportResult => ({ result: 'failed' })),
  cancelSkillImport: (token: string): Promise<boolean> => ipc.agent.cancelSkillImport.mutate({ token }).catch(() => false),
  // Task 10 (`agent-mcp.spec.ts`): MCP servers. A command server's Start opens main's own dialog.
  saveMcpServer: (server: AgentSaveMcpServerRequest): Promise<{ readonly result: McpSaveResult; readonly id?: string }> =>
    ipc.agent.saveMcpServer
      .mutate(
        server.transport === 'http'
          ? { ...server }
          : { ...server, args: [...server.args], readPaths: [...server.readPaths], env: server.env.map((item) => ({ ...item })) },
      )
      .catch(() => ({ result: 'failed' as const })),
  deleteMcpServer: (id: string): Promise<boolean> => ipc.agent.deleteMcpServer.mutate({ id }).catch(() => false),
  setMcpServerEnabled: (id: string, enabled: boolean): Promise<boolean> => ipc.agent.setMcpServerEnabled.mutate({ id, enabled }).catch(() => false),
  startMcpServer: (id: string): Promise<McpStartResult> => ipc.agent.startMcpServer.mutate({ id }).catch((): McpStartResult => 'failed'),
  stopMcpServer: (id: string): Promise<boolean> => ipc.agent.stopMcpServer.mutate({ id }).catch(() => false),
  /** Write-only: the token goes to main once; the answer never carries it. */
  setMcpToken: (id: string, token: string | null): Promise<McpTokenResult> => ipc.agent.setMcpToken.mutate({ id, token }).catch((): McpTokenResult => 'failed'),
  // ChatGPT plan (`agent-chatgpt.spec.ts`): main spends the click's gesture, then opens the browser; no token ever comes back.
  chatgptSignIn: (options: { readonly reconsent?: boolean; readonly differentAccount?: boolean } = {}): Promise<ChatgptSignInResult> =>
    ipc.agent.chatgptSignIn.mutate({ ...options }).catch((): ChatgptSignInResult => 'failed'),
  chatgptCancel: (): Promise<boolean> => ipc.agent.chatgptCancel.mutate().catch(() => false),
  chatgptSignOut: (): Promise<ChatgptSignOutResult | 'failed'> => ipc.agent.chatgptSignOut.mutate().catch((): 'failed' => 'failed'),
  chatgptAcknowledge: (): Promise<boolean> => ipc.agent.chatgptAcknowledge.mutate().catch(() => false),
};

export type AgentActions = typeof agentActions;
