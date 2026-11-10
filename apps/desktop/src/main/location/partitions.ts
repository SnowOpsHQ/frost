import { session as electronSession, type Session } from 'electron';
import { locationPartition, proxyRulesFor, type LocationProxy } from '@app/specs/location-profiles.spec';
import { registerBrowseClassSession } from '../browser/browse-class';
import { markLocationSession, renewLocationSession } from './sessions';

// Location partitions (Phase 12 Task 10b; plan Decision 11, Global constraints "Partitions";
// acceptance `location-profiles.feature.md`, Behaviour). One **in-memory** partition per profile,
// `frost-location-<profileId>` (no `persist:`). Before a profile's first tab, `ensure` sets the
// partition's proxy (`fixed_servers`, `proxyRulesFor`, no bypass rules: Chromium's implicit loopback
// bypass stays; no `direct://` fallback) and **awaits** it, then registers the session as
// browse-class (`registerBrowseClassSession`, which runs every Task 10a installer on it), so the
// tab's WebContents is classified as a tab at its creation. Only this directory may register a
// browse-class session (`browse-class.ts`). The partition's spellchecker is turned off first (no
// languages, then disabled), so a location session never loads or downloads a dictionary: no request
// the user did not ask for leaves it (whole-branch review).
//
// Editing a profile resets its partition (after its tabs closed): storage and cache cleared (service
// workers too), connections closed, and the proxy set again before the next tab. Removing one
// retires it for the run: the same clearing, and it is never prepared again. A retired partition's
// proxy is left as it was (never `direct`): fail closed. Calls for one profile run one at a time.

/** The parts of a session this module uses (Electron's, or a fake in tests). */
export interface LocationSession {
  setProxy(config: { mode: 'fixed_servers'; proxyRules: string }): Promise<void>;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  closeAllConnections?(): Promise<void>;
  setSpellCheckerLanguages(languages: string[]): void;
  setSpellCheckerEnabled(enable: boolean): void;
}

export interface LocationPartitionsDeps {
  /** `session.fromPartition` (main: Electron's). */
  readonly fromPartition?: (partition: string) => LocationSession;
  /** `registerBrowseClassSession` (main: the registry's). */
  readonly register?: (session: LocationSession) => void;
  readonly log?: (line: string) => void;
}

export interface LocationPartitions {
  /**
   * The profile's session, with `proxy` in effect and registered browse-class: set and awaited first
   * (only when it differs from what was last applied), then registered. Rejects when the profile was
   * retired, or the proxy or the registration failed (no tab may open then).
   */
  ensure(profileId: string, proxy: LocationProxy): Promise<LocationSession>;
  /** The prepared profile whose session `session` is, and its applied proxy; `null` for any other (a retired one included). */
  proxyOf(session: unknown): { readonly profileId: string; readonly host: string; readonly port: number } | null;
  /** Edit: clears the partition and forgets the applied proxy (the next `ensure` sets it again). */
  reset(profileId: string): Promise<void>;
  /** Remove: as `reset`, then never prepared again this run. */
  retire(profileId: string): Promise<void>;
}

interface Prepared {
  readonly session: LocationSession;
  /** The proxy last applied (`null`: none since a reset). */
  applied: (LocationProxy & { readonly rules: string }) | null;
}

export function createLocationPartitions(deps: LocationPartitionsDeps = {}): LocationPartitions {
  const fromPartition = deps.fromPartition ?? ((partition: string) => electronSession.fromPartition(partition) as unknown as LocationSession);
  const register = deps.register ?? ((target: LocationSession) => registerBrowseClassSession(target as unknown as Session));
  const log = (line: string): void => deps.log?.(`location: ${line}`);
  const prepared = new Map<string, Prepared>();
  const retired = new Set<string>();
  /** Each profile's queue (one call at a time). */
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(profileId: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(profileId) ?? Promise.resolve()).then(run, run);
    queues.set(
      profileId,
      next.catch(() => undefined),
    );
    return next;
  };

  const clear = async (entry: Prepared): Promise<void> => {
    entry.applied = null;
    // Permission answers given in it so far end here.
    renewLocationSession(entry.session);
    for (const [what, run] of [
      ['storage', () => entry.session.clearStorageData()],
      ['cache', () => entry.session.clearCache()],
      ['connections', () => entry.session.closeAllConnections?.()],
    ] as const) {
      try {
        await run();
      } catch {
        log(`clearing a location partition's ${what} failed`);
      }
    }
  };

  return {
    ensure: (profileId, proxy) =>
      serial(profileId, async () => {
        if (retired.has(profileId)) throw new Error('location: profile removed');
        const rules = proxyRulesFor(proxy);
        let entry = prepared.get(profileId);
        if (!entry) {
          const created = fromPartition(locationPartition(profileId));
          // No dictionary is loaded or downloaded for it (no languages, then off: Electron turns spellcheck on with languages).
          created.setSpellCheckerLanguages([]);
          created.setSpellCheckerEnabled(false);
          entry = { session: created, applied: null };
          prepared.set(profileId, entry);
          // Known as a location session (its own permission answers, geolocation denied) before it joins the class.
          markLocationSession(entry.session, profileId);
        }
        if (entry.applied?.rules !== rules) {
          entry.applied = null;
          await entry.session.setProxy({ mode: 'fixed_servers', proxyRules: rules });
          entry.applied = { scheme: proxy.scheme, host: proxy.host, port: proxy.port, rules };
        }
        // After the proxy is in effect, before any tab: every browse-class installer runs on it (a no-op once registered).
        register(entry.session);
        return entry.session;
      }),
    proxyOf(candidate) {
      if (candidate === null || typeof candidate !== 'object') return null;
      for (const [profileId, entry] of prepared) {
        if (entry.session === candidate && entry.applied !== null && !retired.has(profileId)) return { profileId, host: entry.applied.host, port: entry.applied.port };
      }
      return null;
    },
    reset: (profileId) =>
      serial(profileId, async () => {
        const entry = prepared.get(profileId);
        if (entry) await clear(entry);
      }),
    retire: (profileId) =>
      serial(profileId, async () => {
        retired.add(profileId);
        const entry = prepared.get(profileId);
        if (entry) await clear(entry);
      }),
  };
}
