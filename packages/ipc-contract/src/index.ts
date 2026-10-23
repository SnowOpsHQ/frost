// Public surface of the IPC contract. Deliberately no unguarded procedure builder is exported.
export { appRouter, type AppRouter } from './router';
export { enforceSender } from './trpc';
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
