/**
 * The `content.*` procedures' inputs (Phase 2.5 Task 3; acceptance `seo-content.feature.md`,
 * Router). Main-only (Zod): the chrome imports the plain values of `seo-content.spec.ts` and this
 * module's types only. Every procedure is `enforceSender`-first; these schemas are strict, so an
 * unknown key, an over-long value or a non-`http(s)` URL is refused before the service is called.
 */
import { z } from 'zod';
import { MAX_SNIPPET_VARIANTS, SNIPPET_HTML_SOURCES, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS, SNIPPET_VARIANT_TITLE_MAX_CHARS, TARGET_QUERY_MAX_CHARS } from './seo-content.spec';
import { SeoAuditRefSchema, SNAPSHOT_LIMITS } from './seo-snapshot.spec';
import { isWebUrl } from './web-url.spec';

/** A page URL the notes are kept for (the audit's URL): `http(s)`, at most `maxUrlChars`. Main drops its `#fragment`. */
const pageUrl = z.string().min(1).max(SNAPSHOT_LIMITS.maxUrlChars).refine(isWebUrl, { message: 'not an http(s) URL' });
const slot = z.int().min(0).max(MAX_SNIPPET_VARIANTS - 1);

/** `content.getNotes`: the page's target query and drafts. */
export const ContentNotesInputSchema = z.strictObject({ url: pageUrl });
export type ContentNotesInput = z.infer<typeof ContentNotesInputSchema>;

/** `content.setTargetQuery`: the query (`''` deletes it). */
export const SetTargetQueryInputSchema = z.strictObject({ url: pageUrl, query: z.string().max(TARGET_QUERY_MAX_CHARS) });
export type SetTargetQueryInput = z.infer<typeof SetTargetQueryInputSchema>;

/** `content.saveVariant`: a draft in a slot (written over what the slot held). */
export const SaveVariantInputSchema = z.strictObject({
  url: pageUrl,
  slot,
  title: z.string().max(SNIPPET_VARIANT_TITLE_MAX_CHARS),
  description: z.string().max(SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS),
});
export type SaveVariantInput = z.infer<typeof SaveVariantInputSchema>;

/** `content.deleteVariant`: empties a slot. */
export const DeleteVariantInputSchema = z.strictObject({ url: pageUrl, slot });
export type DeleteVariantInput = z.infer<typeof DeleteVariantInputSchema>;

/**
 * `content.copySnippetHtml`: the tab, the audit the panel shows (`SeoAuditRefSchema`), and what to
 * copy: the page's own title and description (`page`), or the draft in `slot` stored for that
 * audit's URL (`variant`).
 */
export const CopySnippetHtmlInputSchema = z.strictObject({
  tabId: z.int().positive(),
  audit: SeoAuditRefSchema,
  source: z.enum(SNIPPET_HTML_SOURCES),
  slot: slot.optional(),
}).refine((input) => (input.source === 'variant') === (input.slot !== undefined), { message: 'a variant needs its slot (and only a variant has one)' });
export type CopySnippetHtmlInput = z.infer<typeof CopySnippetHtmlInputSchema>;
