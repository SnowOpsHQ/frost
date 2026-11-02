import { useEffect, useState } from 'react';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { GscPropertiesAnswer } from '@app/specs/gsc.schema';
import type { GscStatus } from '@app/specs/gsc.spec';
import { ipc } from '../ipc';

// Settings' count of Search Console properties (Phase 9 Task 3, SL-112; `gsc.feature.md`, Settings:
// property count): the existing `gsc.properties` read, only while connected, again when the connection
// changes (`gsc.watch`'s version). Main caches the list (`GSC_CACHE_TTL_MS`), so reopening Settings is
// cheap. A failed call reads as `network` (no count is shown).

const FAILED = { status: 'unavailable', reason: 'network' } as const;

/** The `gsc.properties` answer for the current connection (`null`: not connected, or not answered yet). */
export function useGscProperties(status: GscStatus | null): GscPropertiesAnswer | null {
  const connection = status?.connected ? status.version : null;
  const [held, setHeld] = useState<{ readonly connection: number; readonly answer: GscPropertiesAnswer } | null>(null);
  useEffect(() => {
    if (connection === null) return;
    let live = true;
    void ipc.gsc.properties
      .query()
      .catch((): GscPropertiesAnswer => FAILED)
      .then((answer) => {
        if (live) setHeld({ connection, answer });
      });
    return () => {
      live = false;
    };
  }, [connection]);
  return held !== null && held.connection === connection ? held.answer : null;
}
