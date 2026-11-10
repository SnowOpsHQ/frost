// Public surface of the IPC contract. Deliberately no unguarded procedure builder is exported.
export { appRouter, type AppRouter } from './router';
export { enforceSender } from './trpc';
export type { BrowserService, IpcServices, SeoAuditRef, SeoService } from './services';
export type { ContentNotesAnswer, ContentService, ContentVariant, PreviewJsonLdFields, PreviewJsonLdSource, SnippetHtmlSource } from './content-service';
export type { JavascriptService } from './javascript-router';
export type { DevtoolsService } from './devtools-service';
export type { FindService, HistoryCursorAnswer, HistoryPageAnswer, HistoryRetentionAnswer, HistoryService, HistoryVisitAnswer, JumpBackInAnswer, SettingsService } from './polish-services';
export type { ChecksService } from './checks-service';
export type { UpdateService } from './update-router';
export type { SerpProbesService, SerpReadApi, SerpService } from './serp-service';
export type { AgentService } from './agent-service';
export type { ChangesReadApi, ChangesReadService, ChangesService } from './changes-service';
export type { ScreenshotsService } from './changes-service';
export type { ProjectsService } from './projects-router';
export type { RetentionService } from './projects-router';
export type { InspectorService } from './inspector-router';
export type { AccountService, SettingsRequests } from './account-service';
export { requireFeature } from './account-router';
export type { TelemetryService } from './telemetry-service';
export type { GscIpcService, GscService } from './gsc-service';
export type { AiChecksService } from './ai-checks-service';
export type { RankingsService } from './rankings-service';
export type { SeoExportService } from './seo-export-service';
export type { TabOverridesService } from './tab-overrides-router';
export type { HelpService } from './help-service';
export type { DataSourcesService } from './data-sources-service';
export type { CrawlIpcService } from './crawl-service';
export type { LocationService } from './location-service';
export type { AiAnswersService } from './ai-answers-service';
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
