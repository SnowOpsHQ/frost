/**
 * The `inspector.*` procedures' inputs and answers (Phase 6 Task 8; acceptance
 * `inspector.feature.md`). Main-only (Zod): the chrome imports the plain values and types of
 * `inspector.spec.ts` (re-exported here) instead. Every schema is strict and capped: an unknown key,
 * a path longer than `maxPathDepth` or a malformed token is refused before main does anything with
 * it, and every answer a page script gives is checked with the same schemas in main before it is used.
 */
import { z } from 'zod';
import { SERVED_UNAVAILABLE_REASONS } from './seo-javascript.spec';
import {
  DOC_TOKEN_PATTERN,
  INSPECTOR_LIMITS,
  INSPECTOR_REFUSALS,
  INSPECTOR_REGIONS,
  INSPECTOR_SEARCH_LIMITS,
  INSPECTOR_SEARCH_MODES,
  INSPECTOR_SOURCE_KINDS,
  INSPECTOR_SOURCE_MAX_CHARS,
  type InspectorAck,
  type InspectorChild,
  type InspectorChildrenAnswer,
  type InspectorChildrenInput,
  type InspectorCopySourceAnswer,
  type InspectorCopySourceInput,
  type InspectorHighlightInput,
  type InspectorNode,
  type InspectorNodeAnswer,
  type InspectorNodeInput,
  type InspectorPickAnswer,
  type InspectorPickInput,
  type InspectorSearchAnswer,
  type InspectorSearchInput,
  type InspectorSourceAnswer,
  type InspectorSourceInput,
  type InspectorTabInput,
} from './inspector.spec';

export * from './inspector.spec';

const L = INSPECTOR_LIMITS;
const tabId = z.int().positive();
/** A child index: a page can hold many children, but never more than this many. */
const index = z.int().nonnegative().max(10_000_000);
export const NodePathSchema = z.array(index).max(L.maxPathDepth);
export const DocTokenSchema = z.string().regex(DOC_TOKEN_PATTERN);
const docToken = DocTokenSchema.nullable();
const count = z.int().nonnegative().max(10_000_000);
const text = (max: number) => z.string().max(max);
const px = z.number().finite().min(-1e9).max(1e9);

// ---- Inputs ------------------------------------------------------------------------------------

/** A tag as a row names it (lowercased `localName`, capped). */
export const TagSchema = z.string().min(1).max(L.maxNameChars);

/** `null` token and tag only for the first read of a document: `<html>`'s children from offset 0. */
export const InspectorChildrenInputSchema = z
  .strictObject({ tabId, path: NodePathSchema, tag: TagSchema.nullable(), docToken, offset: index })
  .refine((input) => (input.docToken !== null && input.tag !== null) || (input.path.length === 0 && input.offset === 0), { message: 'a null token or tag is only for the first read' }) satisfies z.ZodType<InspectorChildrenInput>;
export const InspectorNodeInputSchema = z.strictObject({ tabId, path: NodePathSchema, tag: TagSchema, docToken: DocTokenSchema }) satisfies z.ZodType<InspectorNodeInput>;
export const InspectorPickInputSchema = z.strictObject({ tabId, docToken }) satisfies z.ZodType<InspectorPickInput>;
export const InspectorHighlightInputSchema = z.strictObject({ tabId, node: z.strictObject({ path: NodePathSchema, tag: TagSchema }).nullable(), docToken: DocTokenSchema }) satisfies z.ZodType<InspectorHighlightInput>;
export const InspectorTabInputSchema = z.strictObject({ tabId }) satisfies z.ZodType<InspectorTabInput>;

/**
 * A search's query: 1 to `maxQueryChars` characters, not only whitespace, no control character (a
 * line break included). It is data the page script compares or hands to `querySelectorAll`, never code.
 */
export const InspectorSearchQuerySchema = z
  .string()
  .min(1)
  .max(INSPECTOR_SEARCH_LIMITS.maxQueryChars)
  .refine((query) => query.trim() !== '', { message: 'an empty query' })
  .refine((query) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(query), { message: 'a control character' });
export const InspectorSearchInputSchema = z.strictObject({ tabId, docToken: DocTokenSchema, mode: z.enum(INSPECTOR_SEARCH_MODES), query: InspectorSearchQuerySchema }) satisfies z.ZodType<InspectorSearchInput>;
export const InspectorSourceInputSchema = z.strictObject({ tabId, docToken: DocTokenSchema, kind: z.enum(INSPECTOR_SOURCE_KINDS) }) satisfies z.ZodType<InspectorSourceInput>;
/** A source answer's `ref`: main's serial for exactly that text. */
export const SourceRefSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** "Copy source": the tab, the document, which source and the `ref` it was answered under; never the text. */
export const InspectorCopySourceInputSchema = z.strictObject({ tabId, docToken: DocTokenSchema, kind: z.enum(INSPECTOR_SOURCE_KINDS), ref: SourceRefSchema }) satisfies z.ZodType<InspectorCopySourceInput>;

// ---- Answers -----------------------------------------------------------------------------------

export const InspectorRefusedSchema = z.strictObject({ status: z.literal('refused'), reason: z.enum(INSPECTOR_REFUSALS) });

export const InspectorChildSchema = z.strictObject({
  index,
  tag: text(L.maxNameChars).min(1),
  id: text(L.maxNameChars),
  classes: z.array(text(L.maxNameChars).min(1)).max(L.maxClassNames),
  childElementCount: count,
  textPreview: text(L.maxTextPreviewChars),
  shadow: z.boolean(),
}) satisfies z.ZodType<InspectorChild>;

export const InspectorChildrenAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    docToken: DocTokenSchema,
    path: NodePathSchema,
    node: InspectorChildSchema,
    offset: index,
    children: z.array(InspectorChildSchema).max(L.maxChildren),
    more: z.boolean(),
  }),
  InspectorRefusedSchema,
]) satisfies z.ZodType<InspectorChildrenAnswer>;

const url = text(L.maxUrlChars);
const value = text(L.maxValueChars);

export const InspectorNodeSchema = z.strictObject({
  tag: text(L.maxNameChars).min(1),
  attributes: z.array(z.strictObject({ name: text(L.maxAttributeNameChars).min(1), value: text(L.maxAttributeValueChars), truncated: z.boolean() })).max(L.maxAttributes),
  attributesMore: z.boolean(),
  box: z.strictObject({ x: px, y: px, width: px.nonnegative(), height: px.nonnegative() }),
  offset: z.strictObject({ x: px, y: px }),
  styles: z.array(z.strictObject({ name: z.enum(L.computedStyleProps), value })).max(L.computedStyleProps.length),
  region: z.enum(INSPECTOR_REGIONS),
  seo: z.strictObject({
    headingLevel: z.int().min(1).max(6).nullable(),
    link: z.strictObject({ href: url, rel: value, target: value }).nullable(),
    image: z.strictObject({ src: url.nullable(), alt: value.nullable(), naturalWidth: count, naturalHeight: count }).nullable(),
    meta: z.strictObject({ name: value, content: value }).nullable(),
    linkRel: z.strictObject({ rel: value, href: url }).nullable(),
    lang: value.nullable(),
  }),
  childElementCount: count,
}) satisfies z.ZodType<InspectorNode>;

export const InspectorNodeAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), docToken: DocTokenSchema, path: NodePathSchema, node: InspectorNodeSchema }),
  InspectorRefusedSchema,
]) satisfies z.ZodType<InspectorNodeAnswer>;

export const InspectorPickAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('picked'), docToken: DocTokenSchema, path: NodePathSchema }),
  InspectorRefusedSchema,
]) satisfies z.ZodType<InspectorPickAnswer>;

export const InspectorAckSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok') }), InspectorRefusedSchema]) satisfies z.ZodType<InspectorAck>;

export const InspectorSearchAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    docToken: DocTokenSchema,
    matches: z.array(z.strictObject({ path: NodePathSchema, node: InspectorChildSchema })).max(INSPECTOR_SEARCH_LIMITS.maxResults),
    more: z.boolean(),
  }),
  InspectorRefusedSchema,
]) satisfies z.ZodType<InspectorSearchAnswer>;

const sourceKind = z.enum(INSPECTOR_SOURCE_KINDS);
const httpStatus = z.int().min(100).max(999).nullable();
const servedPending = z.strictObject({ status: z.literal('pending'), kind: z.literal('served') });
const servedUnavailable = z.strictObject({ status: z.literal('unavailable'), kind: z.literal('served'), reason: z.enum(SERVED_UNAVAILABLE_REASONS), httpStatus });

export const InspectorSourceAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), kind: sourceKind, docToken: DocTokenSchema, ref: SourceRefSchema, text: z.string().max(INSPECTOR_SOURCE_MAX_CHARS), truncated: z.boolean() }),
  servedPending,
  servedUnavailable,
  InspectorRefusedSchema,
]) satisfies z.ZodType<InspectorSourceAnswer>;

export const InspectorCopySourceAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('copied'), kind: sourceKind, truncated: z.boolean() }), InspectorRefusedSchema]) satisfies z.ZodType<InspectorCopySourceAnswer>;
