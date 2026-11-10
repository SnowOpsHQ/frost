/**
 * What's New's release notes and the `help.*` procedures' schemas (Phase 11 Task 11, Decision 14;
 * acceptance `help.feature.md`). Main-only (Zod): the chrome imports the plain values of
 * `help.spec.ts` and this module's types only.
 *
 * The notes are `apps/desktop/release-notes.json`, imported into the main bundle at build time (no
 * file is read at runtime) and checked with `ReleaseNotesSchema` when main starts and in a test.
 */
import { z } from 'zod';
import { DIAGNOSTICS_FORBIDDEN_CHARS, DIAGNOSTICS_LIMITS, DIAGNOSTICS_RESULTS } from './diagnostics.spec';
import { APP_VERSION_MAX_CHARS, FROST_REPOSITORY_URL, HELP_OPEN_RESULTS, HELP_SHEETS, isAppVersion } from './help.spec';

export const RELEASE_NOTES_LIMITS = {
  maxReleases: 50,
  maxItems: 10,
  maxItemChars: 200,
  maxTitleChars: 120,
  maxUrlChars: 2048,
} as const;

/** An app version (`isAppVersion`). */
export const AppVersionSchema = z.string().max(APP_VERSION_MAX_CHARS).refine(isAppVersion, { message: 'not an app version' });

/**
 * A release's own page: `https://github.com/SnowOpsHQ/frost/…` (a path under frost's repository),
 * nothing else; no credentials, query or fragment, so it never carries data.
 */
export function isReleaseUrl(value: string): boolean {
  if (value.length > RELEASE_NOTES_LIMITS.maxUrlChars || !value.startsWith(`${FROST_REPOSITORY_URL}/`)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.host === 'github.com' && url.username === '' && url.password === '' && url.search === '' && url.hash === '' && url.pathname.startsWith('/SnowOpsHQ/frost/') && url.href === value;
}

const OneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // One line of plain text: no control characters (the chrome renders it as React text).
    .refine((text) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(text) && text.trim() === text, { message: 'one trimmed line' });

/** One release: its version, date (`YYYY-MM-DD`), a title, 1–10 short items, and optionally its page. */
export const ReleaseNoteSchema = z.strictObject({
  version: AppVersionSchema,
  date: z.iso.date(),
  title: OneLine(RELEASE_NOTES_LIMITS.maxTitleChars),
  items: z.array(OneLine(RELEASE_NOTES_LIMITS.maxItemChars)).min(1).max(RELEASE_NOTES_LIMITS.maxItems),
  url: z.string().refine(isReleaseUrl, { message: 'not a page of frost’s repository' }).optional(),
});
export type ReleaseNote = z.infer<typeof ReleaseNoteSchema>;

/** The bundled notes: 1–50 releases, newest first, each version once. */
export const ReleaseNotesSchema = z
  .strictObject({ releases: z.array(ReleaseNoteSchema).min(1).max(RELEASE_NOTES_LIMITS.maxReleases) })
  .refine((notes) => new Set(notes.releases.map((release) => release.version)).size === notes.releases.length, { message: 'a version is listed twice' })
  .refine((notes) => notes.releases.every((release, i) => i === 0 || release.date <= notes.releases[i - 1]!.date), { message: 'releases are not newest first' });
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;

// ---- The `help.*` procedures ----------------------------------------------------------------------

/** `help.watch`: the last count seen (`-1`: none yet, answered at once). */
export const HelpWatchInputSchema = z.strictObject({ sinceSeq: z.int().min(-1).max(Number.MAX_SAFE_INTEGER) });
export type HelpWatchInput = z.infer<typeof HelpWatchInputSchema>;

/** `help.watch`'s answer: the sender window's count of Help menu requests and the sheet the last one asked for. */
export const HelpViewStateSchema = z.strictObject({ seq: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER), sheet: z.enum(HELP_SHEETS).nullable() });
export type HelpViewState = z.infer<typeof HelpViewStateSchema>;

/**
 * `help.whatsNew`'s answer: the running version (`null` if `app.getVersion()` is not a version) and the
 * bundled notes (a release page only as its URL, checked again).
 */
export const WhatsNewAnswerSchema = z.strictObject({ currentVersion: AppVersionSchema.nullable(), releases: z.array(ReleaseNoteSchema).max(RELEASE_NOTES_LIMITS.maxReleases) });
export type WhatsNewAnswer = z.infer<typeof WhatsNewAnswerSchema>;

/** `help.takeWhatsNew`'s answer: whether this window shows What's New now (once per version change). */
export const WhatsNewTakeAnswerSchema = z.boolean();

/** `help.openLink`: a `HELP_URLS` page, or a bundled release's page by its version. Never a URL. */
export const HelpOpenLinkInputSchema = z.discriminatedUnion('link', [
  z.strictObject({ link: z.literal('help') }),
  z.strictObject({ link: z.literal('issue') }),
  z.strictObject({ link: z.literal('release'), version: AppVersionSchema }),
]);
export type HelpOpenLinkInput = z.infer<typeof HelpOpenLinkInputSchema>;

export const HelpOpenResultSchema = z.enum(HELP_OPEN_RESULTS);

// ---- Export Diagnostics (Phase 11 Task 12; `diagnostics.spec.ts`, `diagnostics.feature.md`) --------

/** `help.diagnostics` takes nothing: main builds the report from what it holds. */
export const DiagnosticsInputSchema = z.undefined();

/**
 * `help.diagnostics`'s answer: the id main keeps the report under and its text, for review. The text
 * is checked once more on the way out: bounded, and no `/`, `\` or `@` at all (every path, address
 * and URL went with its token).
 */
export const DiagnosticsReportSchema = z.strictObject({
  reportId: z.uuid(),
  text: z
    .string()
    .min(1)
    .max(DIAGNOSTICS_LIMITS.maxReportChars)
    .refine((text) => !DIAGNOSTICS_FORBIDDEN_CHARS.test(text), { message: 'a report holds no slash, backslash or at sign' }),
});
export type DiagnosticsReport = z.infer<typeof DiagnosticsReportSchema>;

/** `help.saveDiagnostics`: which kept report to save. Never its text: main writes its own copy. */
export const SaveDiagnosticsInputSchema = z.strictObject({ reportId: z.uuid() });
export type SaveDiagnosticsInput = z.infer<typeof SaveDiagnosticsInputSchema>;

export const DiagnosticsResultSchema = z.enum(DIAGNOSTICS_RESULTS);
