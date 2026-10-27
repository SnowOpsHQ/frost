import { PALETTE_ACTION_ID_MAX, PALETTE_ACTION_ID_PATTERN, PALETTE_RECENT_MAX, PALETTE_RECENT_STORAGE_KEY } from '@app/specs/command-palette.spec';

// The command palette's recent actions (spec `command-palette.spec.ts`, `PALETTE_RECENT_STORAGE_KEY`):
// action ids, most recent first, in the chrome's own `localStorage`. Pure apart from the storage
// handed in; reading and writing never throw.

const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= PALETTE_ACTION_ID_MAX && PALETTE_ACTION_ID_PATTERN.test(id);

/** The stored list: well-formed ids only, no duplicates, at most `PALETTE_RECENT_MAX`. */
export function parseRecents(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const id of parsed) {
    if (out.length >= PALETTE_RECENT_MAX) break;
    if (validId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** `list` with `id` moved (or added) to the front, capped. */
export function pushRecent(list: readonly string[], id: string): string[] {
  if (!validId(id)) return [...list];
  return [id, ...list.filter((other) => other !== id)].slice(0, PALETTE_RECENT_MAX);
}

export function readRecents(storage: Pick<Storage, 'getItem'> | null): string[] {
  try {
    return parseRecents(storage?.getItem(PALETTE_RECENT_STORAGE_KEY) ?? null);
  } catch {
    return [];
  }
}

export function writeRecents(storage: Pick<Storage, 'setItem'> | null, list: readonly string[]): void {
  try {
    storage?.setItem(PALETTE_RECENT_STORAGE_KEY, JSON.stringify(list.slice(0, PALETTE_RECENT_MAX)));
  } catch {
    // Not kept this run (storage full or unavailable).
  }
}
