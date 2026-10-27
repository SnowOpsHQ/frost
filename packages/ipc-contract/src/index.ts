// Public surface of the IPC contract. Deliberately no unguarded procedure builder is exported.
export { appRouter, type AppRouter } from './router';
export { enforceSender } from './trpc';
export type { BrowserService, IpcServices, SeoAuditRef, SeoService } from './services';
export type { ContentNotesAnswer, ContentService, ContentVariant, SnippetHtmlSource } from './content-service';
export type { JavascriptService } from './javascript-router';
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
