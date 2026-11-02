import type { ApprovalDecision } from '@app/specs/agent-approvals.spec';
import type { ChatgptSignInResult, ChatgptSignOutResult } from '@app/specs/agent-chatgpt.spec';
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
import type { CredentialSlot } from '@app/specs/agent-proxy.spec';
import type { ReasoningEffort } from '@app/specs/agent-reasoning.spec';
import type { AgentAnswerResult, AgentSendResult, AgentSetKeyResult, AgentSkillRequest, AgentState } from '@app/specs/agent-session.spec';
import type { AgentModelId, ModelRoute } from '@app/specs/agent-tools.spec';
import type { McpSaveResult, McpStartResult, McpTokenResult } from '@app/specs/agent-mcp.spec';
import type { AgentSaveMcpServerInput } from '@app/specs/agent-mcp.schema';

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
   * `message` is the typed text, or a skill run (Task 7): main renders the skill as the user turn and
   * offers the model only the skill's tools for that turn.
   */
  send(chatId: string | null, message: string | AgentSkillRequest): Promise<AgentSendResult>;
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
  setModel(route: ModelRoute, modelId: AgentModelId): Promise<boolean>;
  /**
   * Stores the reasoning level (Phase 8 Task 8b; the next turn sends its effective level); `false`
   * when it can't be stored.
   */
  setReasoningEffort(effort: ReasoningEffort): Promise<boolean>;
  /** Stores a key in `slot`; answers how that went, never the key. */
  setKey(slot: CredentialSlot, key: string): Promise<AgentSetKeyResult>;
  /** Removes the slot's key; `false` if it couldn't be removed. */
  clearKey(slot: CredentialSlot): Promise<boolean>;

  // ---- Task 9 (`agent-data.spec.ts`; acceptance `agent-data.feature.md`) ----
  /** The standing grants, oldest first (the grants page). */
  listGrants(): readonly AgentGrantView[];
  /** Revokes one grant (at once); `false` if it couldn't be written (it stays revoked for this run). */
  revokeGrant(tool: string, origin: string): Promise<boolean>;
  /** Revokes every grant (the panel confirmed first); `false` if it couldn't be written. */
  revokeAllGrants(): Promise<boolean>;
  /** Turns the read tools' implied grant on or off; `false` if it couldn't be stored. */
  setReadToolsAllowed(allowed: boolean): Promise<boolean>;
  /**
   * Sets how long chats are kept on disk and prunes under it at once. A change that would delete
   * chats asks first in main's own dialog (`cancelled` if the user keeps the old setting).
   */
  setChatRetention(retention: ChatRetention): Promise<AgentSetRetentionResult>;
  /** Deletes every chat, in memory and on disk, once main's own dialog confirmed it. */
  deleteAllChats(): Promise<AgentDeleteAllChatsResult>;
  /** Exports a chat, written only where the user chooses in main's save dialog. */
  exportChat(chatId: string, format: ChatExportFormat): Promise<ChatExportResult>;
  /** A skill in full for the editor (a built-in is read-only), or `null`. */
  skillDetail(id: string): AgentSkillDetail | null;
  /** Validates (`SkillSchema`) and stores a user skill; a built-in's id is refused. */
  saveSkill(draft: AgentSkillDraft, mode: AgentSkillSaveMode): Promise<AgentSaveSkillResult>;
  /** Deletes a user skill; `false` for a built-in or an unknown id. */
  deleteSkill(id: string): Promise<boolean>;
  /** Stores a copy of a skill (to start from a built-in) under a free id. */
  duplicateSkill(id: string): Promise<AgentSaveSkillResult>;
  /** Switches a skill on or off in the library (Phase 8 Task 5); `false` for an unknown id or a failed write. */
  setSkillEnabled(id: string, enabled: boolean): Promise<boolean>;

  // ---- Phase 8 Task 6: skill files (`agent-data.spec.ts`, Skill files; acceptance `agent-data.feature.md`, Import and export) ----
  /** Exports the user's skills (`ids`, or all of them) to the file the user chooses in main's save dialog. */
  exportSkills(ids: readonly string[] | 'all-mine'): Promise<SkillExportResult>;
  /** Reads the file the user chooses in main's open dialog and answers its review (a single-use token; nothing stored). */
  previewSkillImport(): Promise<AgentSkillImportPreviewResult>;
  /** Spends the review's token: stores its valid entries at `indices` (copies where an id or name clashes). */
  importSkills(token: string, indices: readonly number[]): Promise<AgentSkillImportResult>;
  /** Drops the review's token; `false` if it is not the open review's. */
  cancelSkillImport(token: string): boolean;

  // ---- Task 10 (`agent-mcp.spec.ts`; acceptance `agent-mcp.feature.md`) ----
  /** Adds a server (no `id`) or changes one; environment values go to main's credential store. */
  saveMcpServer(input: AgentSaveMcpServerInput): Promise<{ readonly result: McpSaveResult; readonly id?: string }>;
  /** Stops and deletes a server, and its token and environment values. */
  deleteMcpServer(id: string): Promise<boolean>;
  /** Turns a server's tools on or off for chats (off also stops it). */
  setMcpServerEnabled(id: string, enabled: boolean): Promise<boolean>;
  /** Connects a server; a command server starts only after main's native dialog was confirmed. */
  startMcpServer(id: string): Promise<McpStartResult>;
  stopMcpServer(id: string): Promise<boolean>;
  /** Stores (or with `null`, removes) an HTTP server's bearer token; never answers it. */
  setMcpToken(id: string, token: string | null): Promise<McpTokenResult>;

  // ---- ChatGPT plan (`agent-chatgpt.spec.ts`; plan `docs/plans/agent-chatgpt-plan.md`, Task 5) ----
  /**
   * Starts a ChatGPT sign-in for app window `windowId` (the IPC sender's): spends that window's live
   * user gesture first (none: `needs-gesture`, nothing opened), then opens the authorize page in the
   * system browser. `reconsent` asks for consent again (plan usage); `differentAccount` signs the
   * current account out (revoking) and registers fresh first. Never a token in the answer.
   */
  chatgptSignIn(windowId: number, options: { readonly reconsent?: boolean; readonly differentAccount?: boolean }): Promise<ChatgptSignInResult>;
  /** Ends a pending sign-in; `false` if none was pending. */
  chatgptCancel(): boolean;
  /** Revokes, then forgets the tokens (`not-revoked`: forgotten here, the server didn't confirm). */
  chatgptSignOut(): Promise<ChatgptSignOutResult>;
  /** Dismisses the one-time "You're using your ChatGPT plan" notice (persisted); `false` if not stored. */
  chatgptAcknowledge(): Promise<boolean>;
}
