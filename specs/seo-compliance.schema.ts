/**
 * The Compliance panel's page data, as Zod schemas (Phase 2 Task 6; acceptance
 * `seo-compliance.feature.md`). Both are untrusted and validated in the analysis worker, never on
 * main's thread:
 * - `PageSecuritySchema`: what the extractor reads about security from the DOM (the snapshot's
 *   `security`);
 * - `AccessibilityResultSchema`: the accessibility check's answer (the run script's summary of
 *   `axe.run`), which main keeps for the tab's document after a size check and hands to the worker
 *   beside the snapshot (`PageContext.accessibility`).
 *
 * Main-only (Zod): the renderer imports this module for its types only. The caps are
 * `seo-compliance.spec.ts`.
 */
import { z } from 'zod';
import { A11Y_IMPACTS, A11Y_LIMITS as A, INSECURE_RESOURCE_KINDS, SECURITY_LIMITS as S } from './seo-compliance.spec';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import { isWebUrl } from './web-url.spec';

const count = z.int().nonnegative().max(SNAPSHOT_LIMITS.maxCount);
const urlText = z.string().max(SNAPSHOT_LIMITS.maxUrlChars);

/**
 * An http subresource of an https page: its kind (`INSECURE_RESOURCE_KINDS`), its URL resolved
 * against the document (an `http:` URL, cut to `maxUrlChars`), and the element that asks for it
 * (its local name).
 */
export const InsecureResourceSchema = z.strictObject({
  kind: z.enum(INSECURE_RESOURCE_KINDS),
  url: urlText.refine((url) => url.startsWith('http:'), { message: 'not an http: URL' }),
  tag: z.string().max(16),
});

/**
 * The snapshot's security facts (read by the extractor in the isolated world):
 * - `insecureResources`: distinct (kind, URL) http subresources, in document order, at most
 *   `maxInsecureResources`; `insecureResourceTotal` how many distinct ones the elements looked at
 *   ask for (only on an https page: empty otherwise); `resourcesTruncated` when the scan stopped at
 *   `maxResourceElements` or `budgetMs`;
 * - `metaCsp`: each `<meta http-equiv="Content-Security-Policy">`'s `content`, at most `maxMetaCsp`;
 * - `metaReferrer`: the last `<meta name="referrer">`'s `content` (`null` when there is none).
 */
export const PageSecuritySchema = z
  .strictObject({
    insecureResources: z.array(InsecureResourceSchema).max(S.maxInsecureResources),
    insecureResourceTotal: count,
    resourcesTruncated: z.boolean(),
    metaCsp: z.array(z.string().max(S.maxMetaChars)).max(S.maxMetaCsp),
    metaReferrer: z.string().max(S.maxMetaChars).nullable(),
  })
  .refine((s) => s.insecureResourceTotal >= s.insecureResources.length, { message: 'a total is below its list' });
export type PageSecurity = z.infer<typeof PageSecuritySchema>;
export type InsecureResource = z.infer<typeof InsecureResourceSchema>;

/** An element a violated rule failed on: its CSS selector (shadow-root steps joined with ` >>> `) and axe's failure summary. */
export const A11yNodeSchema = z.strictObject({
  selector: z.string().max(A.maxSelectorChars),
  summary: z.string().max(A.maxSummaryChars),
});

/**
 * A violated rule: its axe id, impact, help text and description (axe's own, English), its help URL
 * (an `http(s)` URL, or `''`), its tags, its elements (at most `maxNodesPerRule`) and how many there
 * are (`nodeTotal`).
 */
export const A11yViolationSchema = z
  .strictObject({
    id: z.string().min(1).max(A.maxIdChars),
    impact: z.enum(A11Y_IMPACTS),
    help: z.string().max(A.maxHelpChars),
    description: z.string().max(A.maxDescriptionChars),
    helpUrl: z
      .string()
      .max(A.maxUrlChars)
      .refine((url) => url === '' || isWebUrl(url), { message: 'not an http(s) URL' }),
    tags: z.array(z.string().max(A.maxTagChars)).max(A.maxTags),
    nodes: z.array(A11yNodeSchema).max(A.maxNodesPerRule),
    nodeTotal: count,
  })
  .refine((rule) => rule.nodeTotal >= rule.nodes.length, { message: 'a total is below its list' });

const ruleCount = z.int().nonnegative().max(A.maxRuleCount);

/**
 * The accessibility check's answer for one document:
 * - `url`: the document's URL when it ran (`http(s)`, cut to `maxUrlChars`; the worker ignores an
 *   answer for another URL than the snapshot's, fragment aside);
 * - `axeVersion`; `ranAt` (epoch ms) and `durationMs`;
 * - `violations`: worst impact first, at most `maxRules` (`violationTotal` counts them all);
 * - `passes`, `incomplete`, `inapplicable`: how many rules passed, need a person to review, or had
 *   nothing to check;
 * - `partial`: the run stopped at its own deadline (`A11Y_PAGE_BUDGET_MS`) before every rule ran.
 */
export const AccessibilityResultSchema = z
  .strictObject({
    url: urlText.min(1).refine(isWebUrl, { message: 'not an http(s) URL' }),
    axeVersion: z.string().max(A.maxVersionChars),
    ranAt: z.number().nonnegative(),
    durationMs: z.number().nonnegative(),
    violations: z.array(A11yViolationSchema).max(A.maxRules),
    violationTotal: ruleCount,
    passes: ruleCount,
    incomplete: ruleCount,
    inapplicable: ruleCount,
    partial: z.boolean(),
  })
  .refine((r) => r.violationTotal >= r.violations.length, { message: 'a total is below its list' });
export type AccessibilityResult = z.infer<typeof AccessibilityResultSchema>;
export type A11yViolation = z.infer<typeof A11yViolationSchema>;
export type A11yNode = z.infer<typeof A11yNodeSchema>;

/**
 * `PageContext.accessibility`: the answer main kept for the tab's document (`null`: no run, or none
 * for this document). An answer the schema rejects is `'invalid'`: the rest of the audit still
 * stands, and the panel says the results could not be read safely.
 */
export const AccessibilityContextSchema = z.union([AccessibilityResultSchema.nullable(), z.literal('invalid')]).catch('invalid');
export type AccessibilityContext = z.infer<typeof AccessibilityContextSchema>;
