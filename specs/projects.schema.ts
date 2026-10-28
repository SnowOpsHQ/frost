/**
 * The `projects.*` procedures' inputs and answers (Phase 6 Task 6; acceptance `projects.feature.md`).
 * Main-only (Zod): the chrome imports the plain values and types of `projects.spec.ts` (re-exported
 * here) instead. Every input is strict: an unknown key, an over-long value or a malformed id is
 * refused before main does anything with it. A URL is `http(s)` only, and storable.
 */
import { z } from 'zod';
import { MAX_STORED_URL_LENGTH } from './browser-session-db.spec';
import { MAX_PROJECT_PAGES, MAX_PROJECT_QUERIES, MAX_PROJECTS, PROJECT_NAME_MAX_CHARS, RETENTION_MODES, UUIDV7_PATTERN } from './capture-db.spec';
import { SearchParamsSchema } from './capture-search-params.schema';
import {
  PROJECT_REFUSALS,
  PROJECT_RUN_LIMITS,
  RUN_REFUSALS,
  RUN_SCREENSHOT_OUTCOMES,
  RUN_STATES,
  RUN_TARGET_KINDS,
  RUN_TARGET_OUTCOMES,
  type AddPageAnswer,
  type AddQueryAnswer,
  type CreateProjectAnswer,
  type DeleteProjectAnswer,
  type ProjectChangeAnswer,
  type ProjectDetail,
  type ProjectsAnswer,
  type ProjectSummary,
  type RunState,
  type StartRunAnswer,
} from './projects.spec';
import { RenderProfileSchema } from './render-profile.schema.spec';
import { isWebUrl } from './web-url.spec';

export * from './projects.spec';

const id = z.string().regex(UUIDV7_PATTERN);
const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** An `http(s)` URL frost can store (`MAX_STORED_URL_LENGTH`). */
const webUrl = z.string().min(1).max(MAX_STORED_URL_LENGTH).refine(isWebUrl, { message: 'not an http(s) URL' });
/** No control characters (C0, DEL, C1) and no bidirectional formatting characters. */
const PRINTABLE = /^[^\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]*$/;
/** A project name as typed: printable, not blank; main trims it (at most `PROJECT_NAME_MAX_CHARS` after trimming). */
const name = z
  .string()
  .min(1)
  .max(PROJECT_NAME_MAX_CHARS * 2)
  .regex(PRINTABLE)
  .refine((value) => value.trim() !== '', { message: 'blank name' });

// ---- Inputs ------------------------------------------------------------------------------------

/** `get`, `remove`, `addCurrentPage`. */
export const ProjectIdInputSchema = z.strictObject({ projectId: id });
export const CreateProjectInputSchema = z.strictObject({ name });
export const RenameProjectInputSchema = z.strictObject({ projectId: id, name });
/** `setRenderProfile`: a profile, or `null` for frost's default. */
export const SetProjectProfileInputSchema = z.strictObject({ projectId: id, profile: RenderProfileSchema.nullable() });
export const AddPageInputSchema = z.strictObject({ projectId: id, url: webUrl });
export const RemovePageInputSchema = z.strictObject({ projectId: id, pageId: id });
/** `addQuery`: the search (engine, query, country, language, location, device); `location` is recorded only. */
export const AddQueryInputSchema = z.strictObject({ projectId: id, params: SearchParamsSchema });
export const RemoveQueryInputSchema = z.strictObject({ projectId: id, queryId: id });
export const ForPageInputSchema = z.strictObject({ url: webUrl });
/** `startRun`: the project, and whether to take a viewport screenshot of each captured target. */
export const StartRunInputSchema = z.strictObject({ projectId: id, screenshot: z.boolean() });
export const RunStateInputSchema = z.strictObject({ sinceVersion: count });

export type ProjectIdInput = z.infer<typeof ProjectIdInputSchema>;
export type AddQueryInput = z.infer<typeof AddQueryInputSchema>;

// ---- Answers -----------------------------------------------------------------------------------

const refused = z.strictObject({ status: z.literal('refused'), reason: z.enum(PROJECT_REFUSALS) });

export const ProjectSummarySchema = z.strictObject({
  id,
  name: z.string().min(1).max(PROJECT_NAME_MAX_CHARS),
  unfiled: z.boolean(),
  renderProfile: RenderProfileSchema.nullable(),
  retention: z.strictObject({ mode: z.enum(RETENTION_MODES), value: count.nullable() }),
}) satisfies z.ZodType<ProjectSummary>;

export const ProjectsAnswerSchema = z.strictObject({ projects: z.array(ProjectSummarySchema).max(MAX_PROJECTS + 1) }) satisfies z.ZodType<ProjectsAnswer>;

const captures = { lastCapturedAt: count.nullable(), changeCount: count.nullable() };
export const ProjectDetailSchema = z
  .strictObject({
    project: ProjectSummarySchema,
    pages: z.array(z.strictObject({ id, url: webUrl, ...captures })).max(MAX_PROJECT_PAGES),
    queries: z.array(z.strictObject({ id, params: SearchParamsSchema, url: webUrl, ...captures })).max(MAX_PROJECT_QUERIES),
  })
  .nullable() satisfies z.ZodType<ProjectDetail>;

export const CreateProjectAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('created'), project: ProjectSummarySchema }), refused]) satisfies z.ZodType<CreateProjectAnswer>;
export const ProjectChangeAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok') }), refused]) satisfies z.ZodType<ProjectChangeAnswer>;
export const AddPageAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('added'), page: z.strictObject({ id, url: webUrl }) }), refused]) satisfies z.ZodType<AddPageAnswer>;
export const AddQueryAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('added'), query: z.strictObject({ id }) }), refused]) satisfies z.ZodType<AddQueryAnswer>;
export const DeleteProjectAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('deleted'), purged: z.strictObject({ captures: count, versions: count, diffs: count, screenshots: count }).nullable() }),
  refused,
]) satisfies z.ZodType<DeleteProjectAnswer>;
export const StartRunAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('started'), runId: id }),
  z.strictObject({ status: z.literal('refused'), reason: z.enum(RUN_REFUSALS) }),
]) satisfies z.ZodType<StartRunAnswer>;

/** `cancelRun`: whether a run was under way. */
export const CancelRunAnswerSchema = z.boolean();

export const RunStateSchema = z.strictObject({
  version: count,
  runId: id.nullable(),
  projectId: id.nullable(),
  state: z.enum(RUN_STATES),
  current: count,
  total: z.int().nonnegative().max(PROJECT_RUN_LIMITS.maxRunTargets),
  omitted: count,
  screenshot: z.boolean(),
  targets: z
    .array(
      z.strictObject({
        kind: z.enum(RUN_TARGET_KINDS),
        label: z.string().max(MAX_STORED_URL_LENGTH),
        outcome: z.enum(RUN_TARGET_OUTCOMES),
        changeCount: count.nullable(),
        screenshot: z.enum(RUN_SCREENSHOT_OUTCOMES).nullable(),
      }),
    )
    .max(PROJECT_RUN_LIMITS.maxRunTargets)
    .readonly(),
}) satisfies z.ZodType<RunState>;
