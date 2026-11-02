// `@app/db`: the local browser-session database (spec `specs/browser-session-db.feature.md`).
// Main process only: it opens `node:sqlite`. Never import it from the renderer or the preload.
// Main uses the store (`openSessionStore`) and the shapes it loads; the schema, migrations,
// repository and writer are the package's own (its tests import them from their modules).
export type { SavedSession, StoredDecision, StoredRenderProfilePin } from './repository';
export type { ContentNotes, ContentNotesRepository, SnippetVariant } from './content-notes';
export { openSessionStore, type SessionStore } from './store';
export type { HistoryCursor, HistoryPage, HistoryRepository, HistoryVisit, JumpBackIn } from './history';
export type { SettingsRepository } from './settings';
export type { AgentGrantsRepository, StoredAgentGrant } from './agent-grants';
export type { AgentChatRowsUpdate, AgentChatsRepository, StoredAgentChatHead, StoredAgentChatRows } from './agent-chats';
export type { AgentSkillsRepository, StoredAgentSkill } from './agent-skills';
export type { AgentSkillPrefsRepository, StoredSkillPref } from './agent-skill-prefs';
export type { AgentMcpRepository, AgentMcpServerWrite, StoredAgentMcpServer } from './agent-mcp';
export {
  isUuidv7,
  uuidv7,
  type AppendCaptureInput,
  type AppendCaptureResult,
  type AppendDiffInput,
  type AppendScreenshotInput,
  type CapturedPage,
  type ChangeIntelCursor,
  type ChangeIntelRepository,
  type ChangeIntelUsage,
  type DiffSummary,
  type ExecutePurgeResult,
  type HistoryEntry,
  type HistoryPage as ChangeHistoryPage,
  type Project,
  type ProjectPage,
  type ProjectQuery,
  type PurgeCounts,
  type PurgePlan,
  type PurgePolicy,
  type PurgeRecord,
  type RetentionPolicy,
  type ScreenshotPage,
  type StoredDiff,
  type StoredScreenshot,
  type StoredVersion,
  type VersionSummary,
} from './change-intel';
