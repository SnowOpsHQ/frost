import { MAX_RENDER_PROFILE_PINS, type RenderProfile } from '@app/specs/render-profile.spec';

// "Pin to this site" (spec `render-profile.feature.md`, Scope and lifetime): one render profile per
// origin, held in memory for lookups on every navigation and written through to the local database
// (`render_profile_pins` in `@app/db`). Loaded once at startup, before any tab loads; forgotten with
// Clear Browsing Data. At most `MAX_RENDER_PROFILE_PINS`: pinning one more drops the oldest.

export interface StoredPin {
  readonly origin: string;
  readonly profile: RenderProfile;
}

export interface RenderProfilePins {
  /** The pinned profile of `origin` (a serialized `http(s)` origin), else `null`. */
  get(origin: string | null): RenderProfile | null;
  /** Pins `profile` to `origin` (the newest pin). */
  set(origin: string, profile: RenderProfile): void;
  /** Removes `origin`'s pin, if it has one. */
  remove(origin: string): void;
  /** Adds what the database held at startup (oldest first); pins set since are kept. */
  load(pins: readonly StoredPin[]): void;
  /** Forgets every pin in memory (Clear Browsing Data deletes the stored ones). */
  forget(): void;
}

export interface RenderProfilePinsOptions {
  readonly save?: (origin: string, profile: RenderProfile) => void;
  readonly remove?: (origin: string) => void;
}

export function createRenderProfilePins(options: RenderProfilePinsOptions = {}): RenderProfilePins {
  /** Insertion order is age: the first key is the oldest pin. */
  const pins = new Map<string, RenderProfile>();

  const put = (origin: string, profile: RenderProfile): void => {
    pins.delete(origin);
    pins.set(origin, profile);
    while (pins.size > MAX_RENDER_PROFILE_PINS) {
      const oldest = pins.keys().next().value;
      if (oldest === undefined) break;
      pins.delete(oldest);
    }
  };

  return {
    get: (origin) => (origin === null ? null : (pins.get(origin) ?? null)),
    set(origin, profile) {
      put(origin, profile);
      options.save?.(origin, profile);
    },
    remove(origin) {
      if (!pins.delete(origin)) return;
      options.remove?.(origin);
    },
    load(stored) {
      const newer = [...pins];
      pins.clear();
      for (const pin of stored) put(pin.origin, pin.profile);
      for (const [origin, profile] of newer) put(origin, profile);
    },
    forget: () => pins.clear(),
  };
}
