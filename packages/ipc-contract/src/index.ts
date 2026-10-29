// Public surface of the IPC contract. Deliberately no unguarded procedure builder is exported.
export { appRouter, type AppRouter } from './router';
export { enforceSender } from './trpc';
export type { BrowserService, IpcServices, SeoAuditRef, SeoService } from './services';
export type { ContentNotesAnswer, ContentService, ContentVariant, SnippetHtmlSource } from './content-service';
export type { JavascriptService } from './javascript-router';
export type { DevtoolsService } from './devtools-service';
export type { FindService, HistoryCursorAnswer, HistoryPageAnswer, HistoryService, HistoryVisitAnswer, JumpBackInAnswer, SettingsService } from './polish-services';
export type { ChecksService } from './checks-service';
export type { SerpProbesService, SerpReadApi, SerpService } from './serp-service';
export type { ChangesReadApi, ChangesReadService, ChangesService } from './changes-service';
export type { ScreenshotsService } from './changes-service';
export type { ProjectsService } from './projects-router';
export type { RetentionService } from './projects-router';
export type { InspectorService } from './inspector-router';
export type { AccountService, SettingsRequests } from './account-service';
export { requireFeature } from './account-router';
export type { TelemetryService } from './telemetry-service';
export type { GscIpcService, GscService } from './gsc-service';
export {
  createContext,
  createSenderPolicy,
  senderRejection,
  type CreateContextOptions,
  type IpcContext,
  type SenderFacts,
  type SenderFrameLike,
  type SenderPolicy,
  type WebContentsLike,
  type WindowLike,
} from './sender';
