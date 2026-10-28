/**
 * The `inspector.*` procedures' inputs and answers (Phase 6 Task 8; acceptance
 * `inspector.feature.md`). Main-only (Zod): the chrome imports the plain values and types of
 * `inspector.spec.ts` (re-exported here) instead. Every schema is strict and capped: an unknown key,
 * a path longer than `maxPathDepth` or a malformed token is refused before main does anything with
 * it, and every answer a page script gives is checked with the same schemas in main before it is used.
 */
import { z } from 'zod';
import { PAGE_REGIONS } from './capture.spec';
import {
  DOC_TOKEN_PATTERN,
  INSPECTOR_LIMITS,
  INSPECTOR_REFUSALS,
  type InspectorAck,
  type InspectorChild,
  type InspectorChildrenAnswer,
  type InspectorChildrenInput,
  type InspectorHighlightInput,
  type InspectorNode,
  type InspectorNodeAnswer,
  type InspectorNodeInput,
  type InspectorPickAnswer,
  type InspectorPickInput,
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

export const InspectorChildrenInputSchema = z.strictObject({ tabId, path: NodePathSchema, docToken, offset: index }) satisfies z.ZodType<InspectorChildrenInput>;
export const InspectorNodeInputSchema = z.strictObject({ tabId, path: NodePathSchema, docToken }) satisfies z.ZodType<InspectorNodeInput>;
export const InspectorPickInputSchema = z.strictObject({ tabId, docToken }) satisfies z.ZodType<InspectorPickInput>;
export const InspectorHighlightInputSchema = z.strictObject({ tabId, path: NodePathSchema.nullable(), docToken }) satisfies z.ZodType<InspectorHighlightInput>;
export const InspectorTabInputSchema = z.strictObject({ tabId }) satisfies z.ZodType<InspectorTabInput>;

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
  region: z.enum(PAGE_REGIONS),
  seo: z.strictObject({
    headingLevel: z.int().min(1).max(6).nullable(),
    link: z.strictObject({ href: url, rel: value, target: value }).nullable(),
    image: z.strictObject({ src: url, alt: value.nullable(), naturalWidth: count, naturalHeight: count }).nullable(),
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
