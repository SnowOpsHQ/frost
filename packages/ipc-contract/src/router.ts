import { enforceSender, publicProcedure, router } from './trpc';

// Every procedure starts `publicProcedure.use(enforceSender)` (spec `ipc-sender.feature.md`,
// `every-procedure-enforces-sender`; Semgrep `ipc-sender-guard` in Task 5).
export const appRouter = router({
  ping: publicProcedure.use(enforceSender).query(() => 'pong' as const),
});

export type AppRouter = typeof appRouter;
