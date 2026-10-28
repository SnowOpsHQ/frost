/**
 * The `screenshots.*` procedures' inputs and answers, and the `listScreenshots` read operation's
 * schemas (Phase 6 Task 5; acceptance `screenshot.feature.md`). Main-only (Zod): the chrome imports
 * the plain values and types of `screenshot.spec.ts` (re-exported here) instead. Every schema is
 * strict: an unknown key, a malformed id or an over-long value is refused before main does anything
 * with it. No input takes a path, a file name or a hash: a screenshot is named by its row id only.
 */
import { z } from 'zod';
import { MAX_STORED_URL_LENGTH } from './browser-session-db.spec';
import { MAX_HISTORY_PAGE, SCREENSHOT_KINDS, UUIDV7_PATTERN } from './capture-db.spec';
import { SearchParamsSchema } from './capture-search-params.schema';
import { RenderProfileSchema } from './render-profile.schema.spec';
import {
  SCREENSHOT_IMAGE_SIZES,
  SCREENSHOT_REFUSALS,
  type CancelAreaInput,
  type ScreenshotEntry,
  type ScreenshotIdInput,
  type ScreenshotImageAnswer,
  type ScreenshotImageInput,
  type ScreenshotRect,
  type ScreenshotsAnswer,
  type ScreenshotsCursor,
  type ScreenshotsInput,
  type TakeScreenshotAnswer,
  type TakeScreenshotInput,
} from './screenshot.spec';
import { isWebUrl } from './web-url.spec';

export * from './screenshot.spec';

const id = z.string().regex(UUIDV7_PATTERN);
const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.int().positive().max(Number.MAX_SAFE_INTEGER);
const tabId = z.int().positive();
/** A page's URL: `http(s)`, at most `MAX_STORED_URL_LENGTH` (main drops its `#fragment`). */
const pageUrl = z.string().min(1).max(MAX_STORED_URL_LENGTH).refine(isWebUrl, { message: 'not an http(s) URL' });
const kind = z.enum(SCREENSHOT_KINDS);

// ---- Inputs ------------------------------------------------------------------------------------

/** `screenshots.take`: the active tab, the kind, and the project to file it in (default Unfiled). */
export const TakeScreenshotInputSchema = z.strictObject({ tabId, kind, projectId: id.optional() }) satisfies z.ZodType<TakeScreenshotInput>;

export const ScreenshotsCursorSchema = z.strictObject({ createdAt: count, id }) satisfies z.ZodType<ScreenshotsCursor>;

/** `screenshots.list` (and the read API's `listScreenshots`): a page's and/or a project's screenshots, newest first. */
export const ScreenshotsInputSchema = z.strictObject({
  url: pageUrl.optional(),
  projectId: id.optional(),
  cursor: ScreenshotsCursorSchema.optional(),
  limit: z.int().min(1).max(MAX_HISTORY_PAGE).optional(),
}) satisfies z.ZodType<ScreenshotsInput>;

/** `screenshots.image`: one screenshot's thumbnail or preview, by row id. */
export const ScreenshotImageInputSchema = z.strictObject({ id, size: z.enum(SCREENSHOT_IMAGE_SIZES) }) satisfies z.ZodType<ScreenshotImageInput>;

/** `screenshots.reveal` and `screenshots.copy`: one screenshot, by row id. */
export const ScreenshotIdInputSchema = z.strictObject({ id }) satisfies z.ZodType<ScreenshotIdInput>;

/** `screenshots.cancelArea`: the tab whose pending area selection ends. */
export const CancelAreaInputSchema = z.strictObject({ tabId }) satisfies z.ZodType<CancelAreaInput>;

// ---- Answers -----------------------------------------------------------------------------------

/** An area in CSS viewport px (whole pixels, at least 1 × 1): also the stored `ci_screenshots.rect`. */
export const ScreenshotRectSchema = z.strictObject({ x: count, y: count, width: positive, height: positive }) satisfies z.ZodType<ScreenshotRect>;

export const TakeScreenshotAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('saved'), id, kind, width: positive, height: positive, bytes: positive, truncated: z.boolean() }),
  z.strictObject({ status: z.literal('refused'), reason: z.enum(SCREENSHOT_REFUSALS) }),
]) satisfies z.ZodType<TakeScreenshotAnswer>;

export const ScreenshotEntrySchema = z
  .strictObject({
    id,
    projectId: id,
    pageUrl,
    captureId: id.nullable(),
    kind,
    rect: ScreenshotRectSchema.nullable(),
    width: positive,
    height: positive,
    bytes: positive,
    segments: positive,
    renderProfile: RenderProfileSchema.nullable(),
    searchParams: SearchParamsSchema.nullable(),
    createdAt: count,
  })
  .refine((entry) => (entry.kind === 'area') === (entry.rect !== null), { message: 'an area screenshot has its rect, the other kinds none', path: ['rect'] }) satisfies z.ZodType<ScreenshotEntry>;

export const ScreenshotsAnswerSchema = z.strictObject({
  screenshots: z.array(ScreenshotEntrySchema).max(MAX_HISTORY_PAGE),
  next: ScreenshotsCursorSchema.nullable(),
}) satisfies z.ZodType<ScreenshotsAnswer>;

/** A thumbnail (PNG) or preview (JPEG) as a base64 `data:` URL (the chrome's CSP allows `img-src data:`), or `null`. */
export const ScreenshotImageAnswerSchema = z
  .string()
  .regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/)
  .nullable() satisfies z.ZodType<ScreenshotImageAnswer>;
