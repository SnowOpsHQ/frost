/**
 * The `projects.*` procedures' inputs and answers (Phase 6 Task 6; acceptance `projects.feature.md`).
 * Main-only (Zod): the chrome imports the plain values and types of `projects.spec.ts` (re-exported
 * here) instead. Every input is strict: an unknown key, an over-long value or a malformed id is
 * refused before main does anything with it. A URL is `http(s)` only, and storable.
 */
import { z } from 'zod';
import { MAX_STORED_URL_LENGTH } from './browser-session-db.spec';
import { SEARCH_ENGINE_IDS } from './browser-polish.spec';
import { MAX_PROJECT_PAGES, MAX_PROJECT_QUERIES, MAX_PROJECTS, PROJECT_NAME_MAX_CHARS, PROJECT_QUERY_MAX_CHARS, RETENTION_MODES, UUIDV7_PATTERN } from './capture-db.spec';
import { SearchParamsSchema } from './serp-search-params.schema';
import { SERP_DEVICES } from './serp.spec';
import { CAPTURE_CADENCES, DOMAIN_MAX_CHARS, ENTRY_KINDS, MAX_PROJECT_COMPETITORS, MAX_TAGS_PER_ENTRY, TAG_MAX_CHARS } from './workspace-db.spec';
import {
  BULK_LINE_OUTCOMES,
  BULK_SEARCH_LIMITS,
  PROJECT_REFUSALS,
  RUN_SCOPES,
  SITE_INPUT_MAX_CHARS,
  TAG_INPUT_MAX_CHARS,
  splitBulkSearches,
  type AddCompetitorAnswer,
  type BulkAddAnswer,
  type BulkSearchesInput,
  type SetSiteAnswer,
  type SetTagsAnswer,
  PROJECT_RUN_LIMITS,
  RUN_BLOCK_REASONS,
  RUN_REFUSALS,
  RUN_SCREENSHOT_OUTCOMES,
  RUN_STATES,
  RUN_TARGET_KINDS,
  RUN_TARGET_OUTCOMES,
  QUERY_FIELD_MAX_CHARS,
  PRINTABLE_TEXT,
  type AddPageAnswer,
  type AddQueryAnswer,
  type CreateProjectAnswer,
  type DeleteProjectAnswer,
  type ProjectChangeAnswer,
  type ProjectDetail,
  type ProjectsAnswer,
  type ProjectSummary,
  type RunState,
  type SavedSearchInput,
  type StartRunAnswer,
} from './projects.spec';
import { RenderProfileSchema } from './render-profile.schema.spec';
import { isWebUrl } from './web-url.spec';

export * from './projects.spec';

const id = z.string().regex(UUIDV7_PATTERN);
const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** An `http(s)` URL frost can store (`MAX_STORED_URL_LENGTH`). */
const webUrl = z.string().min(1).max(MAX_STORED_URL_LENGTH).refine(isWebUrl, { message: 'not an http(s) URL' });
/** No control characters (C0, DEL, C1) and no bidirectional formatting characters (`PRINTABLE_TEXT`). */
const PRINTABLE = PRINTABLE_TEXT;
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
/** A saved search as the query form describes it (`SavedSearchInput`); main reads its URL as Phase 3 does before storing it. */
export const SavedSearchInputSchema = z.strictObject({
  engine: z.enum(SEARCH_ENGINE_IDS),
  query: z
    .string()
    .min(1)
    .max(PROJECT_QUERY_MAX_CHARS)
    .regex(PRINTABLE)
    .refine((value) => value === value.trim(), { message: 'query must be trimmed' }),
  country: z.string().regex(/^[a-z]{2}$/).nullable(),
  language: z.string().max(QUERY_FIELD_MAX_CHARS.language).regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/).nullable(),
  device: z.enum(SERP_DEVICES),
}) satisfies z.ZodType<SavedSearchInput>;
/** `addQuery`: the project and the search. */
export const AddQueryInputSchema = z.strictObject({ projectId: id, search: SavedSearchInputSchema });
export const RemoveQueryInputSchema = z.strictObject({ projectId: id, queryId: id });
export const ForPageInputSchema = z.strictObject({ url: webUrl });
/**
 * `startRun`: the project, whether to take a viewport screenshot of each captured target, and (Phase
 * 10) which targets (`RUN_SCOPES`; `all` when left out).
 */
export const StartRunInputSchema = z.strictObject({ projectId: id, screenshot: z.boolean(), scope: z.enum(RUN_SCOPES).default('all') });
export const RunStateInputSchema = z.strictObject({ sinceVersion: count });


// Phase 10 Task 4: the project workspace. Domains and tags come in as typed (printable, bounded);
// main normalizes them (`normalizeSiteDomain`, `normalizeTag`) and answers `invalid-domain` /
// `invalid-tag` for what it refuses.

/** A site or competitor as typed: printable, not blank, at most `SITE_INPUT_MAX_CHARS`. */
const domainInput = z
  .string()
  .min(1)
  .max(SITE_INPUT_MAX_CHARS)
  .regex(PRINTABLE)
  .refine((value) => value.trim() !== '', { message: 'blank domain' });
/** A tag as typed: printable, at most `TAG_INPUT_MAX_CHARS`. */
const tagInput = z.string().min(1).max(TAG_INPUT_MAX_CHARS).regex(PRINTABLE);
const tagInputs = z.array(tagInput).max(MAX_TAGS_PER_ENTRY);
/** No value twice. */
const distinct = <T>(values: readonly T[]): boolean => new Set(values.map((value) => JSON.stringify(value))).size === values.length;

export const SetFavoriteInputSchema = z.strictObject({ projectId: id, favorite: z.boolean() });
/** `setSite`: a domain (or URL) as typed, or `null` to clear it; and whether subdomains count. */
export const SetSiteInputSchema = z.strictObject({ projectId: id, domain: domainInput.nullable(), subdomains: z.boolean() });
export const AddCompetitorInputSchema = z.strictObject({ projectId: id, domain: domainInput });
export const RemoveCompetitorInputSchema = z.strictObject({ projectId: id, competitorId: id });
/** `setTags`: a page (`page`) or saved search (`search`) of the project, and its tags afterwards (as typed). */
export const SetTagsInputSchema = z.strictObject({ projectId: id, entryKind: z.enum(ENTRY_KINDS), entryId: id, tags: tagInputs });
/** The Bulk add form (`BulkSearchesInput`): 1–`maxLines` queries in `text`, distinct locales and devices. */
export const BulkSearchesInputSchema = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(BULK_SEARCH_LIMITS.maxTextChars)
    .refine((value) => {
      const lines = splitBulkSearches(value).length;
      return lines >= 1 && lines <= BULK_SEARCH_LIMITS.maxLines;
    }, { message: 'one to maxLines queries' }),
  engine: SavedSearchInputSchema.shape.engine,
  locales: z
    .array(z.strictObject({ country: SavedSearchInputSchema.shape.country, language: SavedSearchInputSchema.shape.language }))
    .min(1)
    .max(BULK_SEARCH_LIMITS.maxLocales)
    .refine(distinct, { message: 'a locale twice' }),
  devices: z.array(z.enum(SERP_DEVICES)).min(1).max(SERP_DEVICES.length).refine(distinct, { message: 'a device twice' }),
  tags: tagInputs,
}) satisfies z.ZodType<BulkSearchesInput>;
export const BulkAddSearchesInputSchema = z.strictObject({ projectId: id, searches: BulkSearchesInputSchema });

// Phase 10 Task 8: the cadence (a due notice only; refused `unavailable` while `RANK_CHECK_AVAILABLE`
// is `false`) and the automatic start (refused `unavailable` while `AUTO_CAPTURE_AVAILABLE` is `false`).
// Main asks `RANK_RUN_DISCLOSURE` before a cadence is first set.
/** `setCadence`: one of `CAPTURE_CADENCES`. */
export const SetCadenceInputSchema = z.strictObject({ projectId: id, cadence: z.enum(CAPTURE_CADENCES) });
/** `setAutoCapture`: whether its due runs start by themselves. */
export const SetAutoCaptureInputSchema = z.strictObject({ projectId: id, on: z.boolean() });

export type ProjectIdInput = z.infer<typeof ProjectIdInputSchema>;
export type AddQueryInput = z.infer<typeof AddQueryInputSchema>;

// ---- Answers -----------------------------------------------------------------------------------

const refused = z.strictObject({ status: z.literal('refused'), reason: z.enum(PROJECT_REFUSALS) });

/** A stored host (`normalizeSiteDomain`'s form). */
const domain = z.string().min(1).max(DOMAIN_MAX_CHARS).regex(/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/);
/** A stored tag (`normalizeTag`'s form). */
const tag = z.string().min(1).max(TAG_MAX_CHARS).regex(PRINTABLE);
const tags = z.array(tag).max(MAX_TAGS_PER_ENTRY);
const site = z.strictObject({ domain, subdomains: z.boolean() });
const competitor = z.strictObject({ id, domain });

export const ProjectSummarySchema = z.strictObject({
  id,
  name: z.string().min(1).max(PROJECT_NAME_MAX_CHARS),
  unfiled: z.boolean(),
  renderProfile: RenderProfileSchema.nullable(),
  retention: z.strictObject({ mode: z.enum(RETENTION_MODES), value: count.nullable() }),
  favorite: z.boolean(),
  site: site.nullable(),
  createdAt: count,
  lastCapturedAt: count.nullable(),
  cadence: z.enum(CAPTURE_CADENCES),
  autoCapture: z.boolean(),
  due: z.boolean(),
}) satisfies z.ZodType<ProjectSummary>;

export const ProjectsAnswerSchema = z.strictObject({ projects: z.array(ProjectSummarySchema).max(MAX_PROJECTS + 1) }) satisfies z.ZodType<ProjectsAnswer>;

const captures = { lastCapturedAt: count.nullable(), changeCount: count.nullable() };
export const ProjectDetailSchema = z
  .strictObject({
    project: ProjectSummarySchema,
    pages: z.array(z.strictObject({ id, url: webUrl, ...captures, tags })).max(MAX_PROJECT_PAGES),
    queries: z.array(z.strictObject({ id, params: SearchParamsSchema, url: webUrl, ...captures, tags })).max(MAX_PROJECT_QUERIES),
    competitors: z.array(competitor).max(MAX_PROJECT_COMPETITORS),
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

export const SetSiteAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok'), site: site.nullable() }), refused]) satisfies z.ZodType<SetSiteAnswer>;
export const AddCompetitorAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('added'), competitor }), refused]) satisfies z.ZodType<AddCompetitorAnswer>;
export const SetTagsAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok'), tags }), refused]) satisfies z.ZodType<SetTagsAnswer>;
export const BulkAddAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('done'),
    lines: z
      .array(z.strictObject({ query: z.string().min(1).max(BULK_SEARCH_LIMITS.maxTextChars), outcome: z.enum(BULK_LINE_OUTCOMES), added: z.int().nonnegative().max(BULK_SEARCH_LIMITS.maxLocales * SERP_DEVICES.length) }))
      .max(BULK_SEARCH_LIMITS.maxLines),
  }),
  refused,
]) satisfies z.ZodType<BulkAddAnswer>;

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
  blockedReason: z.enum(RUN_BLOCK_REASONS).nullable(),
}) satisfies z.ZodType<RunState>;
