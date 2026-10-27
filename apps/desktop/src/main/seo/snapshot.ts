import { PageContextSchema, PageSnapshotSchema, type ExtractedSnapshot, type PageContext } from '@app/specs/seo-snapshot.spec';

// The extractor's answer is the page's data: untrusted. It reaches the rules only through this
// parse (spec `seo-snapshot.spec.ts`, acceptance `seo-sidebar.feature.md`, Snapshot schema). So
// does what main collected beside it (the response's headers and robots.txt come from the page's
// server: `PageContextSchema`, acceptance `seo-indexability.feature.md`).

export type SnapshotResult = { readonly ok: true; readonly snapshot: ExtractedSnapshot } | { readonly ok: false; readonly reason: 'invalid-snapshot' };

/** `raw` as a snapshot if it parses with `PageSnapshotSchema` (strict, capped); never throws. */
export function parseSnapshot(raw: unknown): SnapshotResult {
  try {
    const parsed = PageSnapshotSchema.safeParse(raw);
    return parsed.success ? { ok: true, snapshot: parsed.data } : { ok: false, reason: 'invalid-snapshot' };
  } catch {
    // A getter that throws, or anything else Zod could not walk.
    return { ok: false, reason: 'invalid-snapshot' };
  }
}

/** `raw` as the page's context if it parses with `PageContextSchema` (strict, capped), else `null`; never throws. */
export function parseContext(raw: unknown): PageContext | null {
  try {
    const parsed = PageContextSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
