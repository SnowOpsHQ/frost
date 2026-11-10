// Which sessions are location partitions, for the code that must treat them apart (Phase 12 Task 10b,
// security review; acceptance `location-profiles.feature.md`, Permissions). No Electron import: the
// permission handlers (`browser/permissions.ts`) ask here, per request, by the requesting WebContents'
// session. `partitions.ts` marks a profile's session before it joins the browse class, and renews it
// whenever the partition is reset or retired, so a profile's in-memory permission answers end with
// the session they were given in.

const marks = new WeakMap<object, { readonly profileId: string; generation: number }>();

/** `session` is the location profile `profileId`'s partition (a no-op if already marked). */
export function markLocationSession(session: object, profileId: string): void {
  if (!marks.has(session)) marks.set(session, { profileId, generation: 0 });
}

/** The partition was reset or retired: answers given in it before are no longer its own. */
export function renewLocationSession(session: object): void {
  const mark = marks.get(session);
  if (mark) mark.generation += 1;
}

/**
 * The permission context of `session`: `location:<profileId>:<generation>` for a location partition,
 * `null` for any other session (the user's own connection).
 */
export function locationContextOf(session: unknown): string | null {
  if (session === null || typeof session !== 'object') return null;
  const mark = marks.get(session);
  return mark ? `location:${mark.profileId}:${mark.generation}` : null;
}
