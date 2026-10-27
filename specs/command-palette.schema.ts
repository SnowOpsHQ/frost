/**
 * The command palette's procedure inputs, as Zod schemas (Phase 2.5 Task 4; acceptance
 * `command-palette.feature.md`). Main-only (Zod): the renderer imports this module for its types
 * only. The plain values are `command-palette.spec.ts`.
 */
import { z } from 'zod';
import { COPY_VALUE_KEYS, OPEN_IN_TEMPLATE_IDS } from './command-palette.spec';
import { PAGE_COMMANDS } from './page-commands.spec';
import { SeoAuditRefSchema } from './seo-snapshot.spec';

/**
 * `seo.copyValue` input: the tab, the audit the chrome shows (`SeoAuditRefSchema`) and one
 * allowlisted key (`COPY_VALUE_KEYS`). Main writes that value of its own ready audit, if that audit
 * is the one shown; the chrome never sends the text to copy.
 */
export const SeoCopyValueInputSchema = z.strictObject({ tabId: z.int().positive(), audit: SeoAuditRefSchema, key: z.enum(COPY_VALUE_KEYS) });
export type SeoCopyValueInput = z.infer<typeof SeoCopyValueInputSchema>;

/**
 * `browser.pageCommand` input: one of the page commands (`page-commands.spec.ts`, `PAGE_COMMANDS`),
 * run on the active tab exactly as its menu item or reserved shortcut runs it (zoom steps and
 * clamps, stop only while loading …).
 */
export const PageCommandInputSchema = z.strictObject({ command: z.enum(PAGE_COMMANDS) });
export type PageCommandInput = z.infer<typeof PageCommandInputSchema>;

/**
 * `browser.openTool` input: one `OPEN_IN_TEMPLATES` id. Main builds the URL from the table and the
 * active tab's own URL (never a URL from the chrome) and refuses a page that came from a non-public
 * address (`OPEN_TOOL_REFUSALS`).
 */
export const OpenToolInputSchema = z.strictObject({ tool: z.enum(OPEN_IN_TEMPLATE_IDS) });
export type OpenToolInput = z.infer<typeof OpenToolInputSchema>;
