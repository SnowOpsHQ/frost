// When each tab's document was first shown and first hidden (spec `seo-speed.spec.ts`,
// `SHOWN_TOLERANCE_MS`; acceptance `seo-speed.feature.md`, Background tabs). frost's background
// tabs are detached views that still report `visible` and paint only once shown, so the page cannot
// tell; main can. Keyed by the tab's WebContents id, so both the controller (which attaches and
// detaches views) and main's audit collection (which only has the WebContents) can use it.

export interface ShownTimes {
  /** The tab's view was attached to the window. */
  shown(contentsId: number): void;
  /** The tab's view was detached (another tab shown, or a panel replaced the page). */
  hidden(contentsId: number): void;
  /** A new document committed: it has been shown since the view was last attached (if it is), never hidden. */
  committed(contentsId: number): void;
  forget(contentsId: number): void;
  /** The current document's first-shown and first-hidden times (epoch ms; `null`: not yet / not known). */
  of(contentsId: number): { readonly shownAt: number | null; readonly hiddenAt: number | null };
}

interface Times {
  /** When the view was last attached; `null` while detached. */
  attachedAt: number | null;
  shownAt: number | null;
  hiddenAt: number | null;
}

export function createShownTimes(now: () => number = Date.now): ShownTimes {
  const times = new Map<number, Times>();
  const of = (id: number): Times => {
    let entry = times.get(id);
    if (!entry) {
      entry = { attachedAt: null, shownAt: null, hiddenAt: null };
      times.set(id, entry);
    }
    return entry;
  };
  return {
    shown(id) {
      const entry = of(id);
      const at = now();
      entry.attachedAt ??= at;
      entry.shownAt ??= at;
    },
    hidden(id) {
      const entry = of(id);
      entry.attachedAt = null;
      if (entry.shownAt !== null) entry.hiddenAt ??= now();
    },
    committed(id) {
      const entry = of(id);
      entry.shownAt = entry.attachedAt;
      entry.hiddenAt = null;
    },
    forget(id) {
      times.delete(id);
    },
    of(id) {
      const entry = times.get(id);
      return { shownAt: entry?.shownAt ?? null, hiddenAt: entry?.hiddenAt ?? null };
    },
  };
}
