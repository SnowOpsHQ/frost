import { TRPCError } from '@trpc/server';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import {
  AddPageAnswerSchema,
  AddPageInputSchema,
  AddQueryAnswerSchema,
  AddQueryInputSchema,
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
  type CreateProjectAnswer,
  type DeleteProjectAnswer,
  type ProjectChangeAnswer,
  type ProjectDetail,
  type ProjectsAnswer,
  type RunState,
  type StartRunAnswer,
} from '@app/specs/projects.schema';
import type { RenderProfile } from '@app/specs/render-profile.spec';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Projects ↔ main (Phase 6 Task 6; spec `projects.schema.ts`; acceptance `projects.feature.md`,
// Router). Every procedure starts `publicProcedure.use(enforceSender)`, then `requireProjects`
// (which fails closed without the service), and takes a strict input. Answers are checked against
// their schemas on the way out. Queries are added and removed by `addSearch` / `removeSearch`: no
// procedure name says "query" (`db-only-in-main`: no IPC procedure reads as being about the database).

/**
 * What the `projects.*` procedures call (main's `apps/desktop/src/main/changes/projects.ts`). Every
 * method answers; none rejects. A refusal names why (`PROJECT_REFUSALS`, `RUN_REFUSALS`).
 */
export interface ProjectsService {
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
  addQuery(projectId: string, params: SearchParams): Promise<AddQueryAnswer>;
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
    .mutation(({ ctx, input }) => ctx.projects.addQuery(input.projectId, input.params)),
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
    .mutation(({ ctx }) => ctx.projects.cancelRun() === true),
  runState: publicProcedure
    .use(enforceSender)
    .use(requireProjects)
    .input(RunStateInputSchema)
    .output(RunStateSchema)
    .query(({ ctx, input }) => ctx.projects.runState(input.sinceVersion)),
});
