import { ReleaseNotesSchema, type ReleaseNotes } from '@app/specs/whats-new.schema';
import bundled from '../../../release-notes.json';

// What's New's notes (Phase 11 Task 11, Decision 14; acceptance `help.feature.md`, Release notes):
// `apps/desktop/release-notes.json`, imported here so Vite bundles it into main (no file is read at
// runtime; a packaged build needs nothing on disk), checked with `ReleaseNotesSchema` at startup.

/** The notes (`bundled` by default) if they pass `ReleaseNotesSchema`, else `null` (logged once). */
export function loadReleaseNotes(source: unknown = bundled, log?: (message: string) => void): ReleaseNotes | null {
  const parsed = ReleaseNotesSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  log?.('help: the bundled release notes are not valid; What’s New lists nothing');
  return null;
}
