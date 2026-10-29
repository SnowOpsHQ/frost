import { TRPCError } from '@trpc/server';
import type { RetentionMode } from '@app/specs/capture-db.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import {
  AddPageAnswerSchema,
  AddPageInputSchema,
  AddQueryAnswerSchema,
  AddQueryInputSchema,
  CancelRunAnswerSchema,
  CreateProjectAnswerSchema,
  CreateProjectInputSchema,
  DeleteProjectAnswerSchema,
  ForPageInputSchema,
  ProjectChangeAnswerSchema,
  ProjectDetailSchema,
  ProjectIdInputSchema,
  ProjectsAnswerSchema,
  RemovePageInputSchema,
  RemoveQueryInputSchema,
  RenameProjectInputSchema,
  RunStateInputSchema,
  RunStateSchema,
  SetProjectProfileInputSchema,
  StartRunAnswerSchema,
  StartRunInputSchema,
  type AddPageAnswer,
  type AddQueryAnswer,
  type SavedSearchInput,
  type CreateProjectAnswer,
  type DeleteProjectAnswer,
  type ProjectChangeAnswer,
  type ProjectDetail,
  type ProjectsAnswer,
  type RunState,
  type StartRunAnswer,
} from '@app/specs/projects.schema';
import type { RenderProfile } from '@app/specs/render-profile.spec';
import {
  CompactAnswerSchema,
  PurgeLogAnswerSchema,
  PurgeNowAnswerSchema,
  RetentionPreviewAnswerSchema,
  RetentionScopeInputSchema,
  SetRetentionAnswerSchema,
  SetRetentionInputSchema,
  UsageAnswerSchema,
  type CompactAnswer,
  type PurgeLogAnswer,
  type PurgeNowAnswer,
  type RetentionPreviewAnswer,
  type SetRetentionAnswer,
  type UsageAnswer,
} from '@app/specs/retention.schema';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Projects ↔ main (Phase 6 Task 6; spec `projects.schema.ts`; acceptance `projects.feature.md`,
// Router), with retention and disk usage (Task 7; `retention.schema.ts`, `retention.feature.md`).
// Every procedure starts `publicProcedure.use(enforceSender)`, then `requireProjects` (which fails
// closed without the service), and takes a strict input. Answers are checked against their schemas
// on the way out. Queries are added and removed by `addSearch` / `removeSearch`: no
// procedure name says "query" (`db-only-in-main`: no IPC procedure reads as being about the database).

/**
 * The retention procedures' half of the service (main's `apps/desktop/src/main/changes/retention.ts`;
 * spec `retention.schema.ts`, acceptance `retention.feature.md`). Every method answers; none rejects.
 */
export interface RetentionService {
  /** The project's policy (Unfiled included): `forever` with `null`, else N within `RETENTION_VALUE_BOUNDS`. */
  setRetention(projectId: string, mode: RetentionMode, value: number | null): Promise<SetRetentionAnswer>;
  /** What "Purge now" would remove under the policy now: a dry run. */
  retentionPreview(projectId: string): Promise<RetentionPreviewAnswer>;
  /** Plans, asks in main's dialog, purges (`purge-now`) and removes the files no row names any more. */
  purgeNow(projectId: string): Promise<PurgeNowAnswer>;
  /** Stored and measured disk usage of one project, or of everything (`null`). */
  usage(projectId: string | null): Promise<UsageAnswer>;
  /** The newest `PURGE_LOG_LIMIT` purges of one project, or of all (`null`). */
  purgeLog(projectId: string | null): Promise<PurgeLogAnswer>;
  /** Asks in main's dialog, then `VACUUM`s the session database (refused during a capture run). */
  compact(): Promise<CompactAnswer>;
}

/**
 * What the `projects.*` procedures call (main's `apps/desktop/src/main/changes/projects.ts`, with
 * `retention.ts` for `RetentionService`). Every method answers; none rejects. A refusal names why
 * (`PROJECT_REFUSALS`, `RUN_REFUSALS`, `RETENTION_REFUSALS`).
 */
export interface ProjectsService extends RetentionService {
  /** Live projects, Unfiled first. */
  list(): Promise<ProjectsAnswer>;
  /** A project with its pages and queries, each with its last capture here and its latest version's change count. */
  get(projectId: string): Promise<ProjectDetail>;
  create(name: string): Promise<CreateProjectAnswer>;
  rename(projectId: string, name: string): Promise<ProjectChangeAnswer>;
  /** The profile its runs use (`null`, or the default profile: frost's default). */
  setRenderProfile(projectId: string, profile: RenderProfile | null): Promise<ProjectChangeAnswer>;
  /** Deletes the project after main's confirmation: tombstoned, then its captures and screenshots purged (`project-deleted`). */
  remove(projectId: string): Promise<DeleteProjectAnswer>;
  addPage(projectId: string, url: string): Promise<AddPageAnswer>;
  /** Adds the active tab's page (main reads its URL). */
  addCurrentPage(projectId: string): Promise<AddPageAnswer>;
  removePage(projectId: string, pageId: string): Promise<ProjectChangeAnswer>;
  /** Adds a saved search: main builds its URL and stores the search parameters Phase 3 reads from it. */
  addQuery(projectId: string, search: SavedSearchInput): Promise<AddQueryAnswer>;
  removeQuery(projectId: string, queryId: string): Promise<ProjectChangeAnswer>;
  /** Live projects listing `url` as a page. */
  forPage(url: string): Promise<ProjectsAnswer>;
  /** Starts "Capture now" for the project (one run at a time, app-wide). */
  startRun(projectId: string, screenshot: boolean): Promise<StartRunAnswer>;
  /** Cancels the run under way; whether there was one. */
  cancelRun(): boolean;
  /** The run's state once newer than `sinceVersion`, else after `runStateWatchTimeoutMs` (long-poll). */
  runState(sinceVersion: number): Promise<RunState>;
}

/** Hands the procedure main's `ProjectsService` (after `enforceSender`; fails closed without it). */
const requireProjects = middleware(({ ctx, next }) => {
  const projects = ctx.services?.projects;
  if (!projects) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'projects service unavailable' });
  return next({ ctx: { ...ctx, projects } });
});

export const projectsRouter = router({
  list: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .output(ProjectsAnswerSchema)
    .query(({ ctx }) => ctx.projects.list()),
  get: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(ProjectIdInputSchema)
    .output(ProjectDetailSchema)
    .query(({ ctx, input }) => ctx.projects.get(input.projectId)),
  create: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(CreateProjectInputSchema)
    .output(CreateProjectAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.create(input.name)),
  rename: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(RenameProjectInputSchema)
    .output(ProjectChangeAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.rename(input.projectId, input.name)),
  setRenderProfile: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(SetProjectProfileInputSchema)
    .output(ProjectChangeAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.setRenderProfile(input.projectId, input.profile)),
  remove: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(ProjectIdInputSchema)
    .output(DeleteProjectAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.remove(input.projectId)),
  addPage: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(AddPageInputSchema)
    .output(AddPageAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.addPage(input.projectId, input.url)),
  addCurrentPage: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(ProjectIdInputSchema)
    .output(AddPageAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.addCurrentPage(input.projectId)),
  removePage: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(RemovePageInputSchema)
    .output(ProjectChangeAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.removePage(input.projectId, input.pageId)),
  addSearch: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(AddQueryInputSchema)
    .output(AddQueryAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.addQuery(input.projectId, input.search)),
  removeSearch: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(RemoveQueryInputSchema)
    .output(ProjectChangeAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.removeQuery(input.projectId, input.queryId)),
  forPage: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(ForPageInputSchema)
    .output(ProjectsAnswerSchema)
    .query(({ ctx, input }) => ctx.projects.forPage(input.url)),
  startRun: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(StartRunInputSchema)
    .output(StartRunAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.startRun(input.projectId, input.screenshot)),
  cancelRun: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .output(CancelRunAnswerSchema)
    .mutation(({ ctx }) => ctx.projects.cancelRun() === true),
  runState: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(RunStateInputSchema)
    .output(RunStateSchema)
    .query(({ ctx, input }) => ctx.projects.runState(input.sinceVersion)),
  // Retention and disk usage (Task 7; spec `retention.schema.ts`): no path, file name or hash comes in.
  setRetention: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(SetRetentionInputSchema)
    .output(SetRetentionAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.setRetention(input.projectId, input.policy.mode, input.policy.value)),
  retentionPreview: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(ProjectIdInputSchema)
    .output(RetentionPreviewAnswerSchema)
    .query(({ ctx, input }) => ctx.projects.retentionPreview(input.projectId)),
  purgeNow: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(ProjectIdInputSchema)
    .output(PurgeNowAnswerSchema)
    .mutation(({ ctx, input }) => ctx.projects.purgeNow(input.projectId)),
  usage: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(RetentionScopeInputSchema)
    .output(UsageAnswerSchema)
    .query(({ ctx, input }) => ctx.projects.usage(input.projectId)),
  purgeLog: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(RetentionScopeInputSchema)
    .output(PurgeLogAnswerSchema)
    .query(({ ctx, input }) => ctx.projects.purgeLog(input.projectId)),
  compact: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .output(CompactAnswerSchema)
    .mutation(({ ctx }) => ctx.projects.compact()),
});
