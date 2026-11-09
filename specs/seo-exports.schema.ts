/**
 * The `seoExport.*` procedure input (Phase 11 Task 1, Decision 1; acceptance `seo-exports.feature.md`,
 * Router). Main-only (Zod): the chrome imports the plain values of `seo-exports.spec.ts` and this
 * module's types only. Strict: an unknown key, a kind outside `SEO_EXPORT_KINDS`, a filter outside
 * `IMAGE_FILTERS`, or a filter on a kind other than `images` is refused before the service is called.
 */
import { z } from 'zod';
import { SEO_EXPORT_KINDS } from './seo-exports.spec';
import { IMAGE_FILTERS } from './seo-sidebar.spec';
import { SeoAuditRefSchema } from './seo-snapshot.spec';

/**
 * `seoExport.copyCsv`: the tab, the audit the chrome shows (`SeoAuditRefSchema`), what to export and,
 * for images only, the panel's filter (`all` when left out). Main formats the CSV from its own ready
 * audit, if it is that audit, and writes its own clipboard.
 */
export const SeoExportInputSchema = z
  .strictObject({ tabId: z.int().positive(), audit: SeoAuditRefSchema, kind: z.enum(SEO_EXPORT_KINDS), filter: z.enum(IMAGE_FILTERS).optional() })
  .refine((input) => input.filter === undefined || input.kind === 'images', { message: 'only images take a filter' });
export type SeoExportInput = z.infer<typeof SeoExportInputSchema>;
