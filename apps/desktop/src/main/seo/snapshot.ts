import { PageSnapshotSchema, type PageSnapshot } from '@app/specs/seo-snapshot.spec';

// The extractor's answer is the page's data: untrusted. It reaches the rules only through this
// parse (spec `seo-snapshot.spec.ts`, acceptance `seo-sidebar.feature.md`, Snapshot schema).

export type SnapshotResult = { readonly ok: true; readonly snapshot: PageSnapshot } | { readonly ok: false; readonly reason: 'invalid-snapshot' };

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
