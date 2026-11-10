import type { PageBounds } from '@app/specs/browser.spec';
import {
  DEFAULT_RENDER_PROFILE,
  DEFAULT_TAB_OVERRIDES,
  fitRenderViewport,
  isDefaultRenderProfile,
  sameRenderProfile,
  type AuditRenderProfile,
  type RenderFit,
  type RenderProfile,
  type RenderProfileSource,
  type RenderProfileStatus,
  type TabOverrides,
  type TabRenderProfile,
} from '@app/specs/render-profile.spec';
import { isWebUrl, webOrigin } from '@app/specs/web-url.spec';
import { deviceMetricsCommand, renderProfileCommands } from './render-profile-cdp';
import type { ProfileDebugger } from './render-profile-debugger';
import type { RenderProfilePins } from './render-profile-pins';
import type { Tab, TabView } from './tab-model';

// Per-tab render profiles: a part of the browser controller (spec `render-profile.feature.md`). It
// keeps each tab's own profile and resolves the profile in effect — the tab's own, else its current
// origin's pin, else none — whenever the tab navigates; puts it into effect through the tab's own
// debugger (`render-profile-debugger.ts`, CDP commands from `render-profile-cdp.ts`), dispatched at
// once (CDP keeps them in order); lays the tab's view out inside the page-area frame; and tracks
// whether the page on
// screen loaded under the profile now in effect ("Reload to apply"). State lives per tab object and
// goes with it: a closed tab's profile is gone, and its debugger is detached when its view is
// released. Nothing here reaches another tab, the chrome's WebContents or the session.
//
// Tab overrides (Phase 11 Task 6, Decision 8; `render-profile.feature.md`, Tab overrides): each tab's
// overrides are held here too, as `entry.tabOverrides` (never `emulation`, which is the viewport fit),
// so the tab has **one merged command list**: the effective profile (frost's defaults when there is
// none) followed by the overrides' commands, sent whole through the tab's debugger. Its child-frame
// share and its re-attach after a Chromium-initiated detach therefore always restore both. The
// debugger is detached only when the profile is default and the overrides have no CDP part on (CSS
// off is not CDP). `tab-overrides.ts` keeps the overrides' state and hands them here
// (`setTabOverrides`); it never talks to the debugger. Whether their CDP part is in effect is
// `TabState.overridesStatus` (`overridesStatus`), tracked apart from the profile's status so a
// failure shows with no profile too (whole-branch review).

type TabContents = TabView['webContents'];

export interface RenderProfileOptions {
  /** A debugger for a tab's WebContents (`createProfileDebugger`); `detached` reports a detach frost did not ask for. */
  readonly debuggerFor: (contents: TabContents, detached: (reason: string) => void) => ProfileDebugger;
  readonly pins: RenderProfilePins;
  /** The app's own Chromium version (`process.versions.chrome`), for the user-agent strings. */
  readonly chromeVersion: string;
}

export interface RenderProfileContext {
  /** The browser state changed (bump and wake `watch`). */
  changed(): void;
  /** The page area in window content coordinates (clamped), when the chrome has reported it. */
  pageArea(): PageBounds | null;
}

export interface TabRenderProfiles {
  /**
   * Sets the tab's profile; the default profile is a Reset. `pin`: `true` makes it the pin of the site
   * the tab shows (its committed page) instead, `false` also unpins that site, and leaving it out
   * keeps the site's pin as it is. `false` when the options are missing, or `pin` without a site.
   */
  set(tab: Tab, profile: RenderProfile, pin?: boolean): boolean;
  /** Reset: the tab's profile and this site's pin go; a page loaded under the profile reloads. `false` if it had none. */
  clear(tab: Tab): boolean;
  /** `TabState.renderProfile`. */
  state(tab: Tab): TabRenderProfile | null;
  /** Listens to the tab's new view (navigations); answers what removes the listeners. */
  wire(tab: Tab, view: TabView): () => void;
  /** The tab's view is gone (closed, destroyed): its debugger is detached and forgotten. */
  released(tab: Tab): void;
  /**
   * Main is about to load `url` in the tab: the profile for its origin is put into effect first
   * (dispatched synchronously, so the load's first request carries it).
   */
  beforeLoad(tab: Tab, url: string): void;
  /** `to` was opened from `from`: it starts with `from`'s own profile (never its pin). */
  inherit(from: Tab, to: Tab): void;
  /** The bounds of the tab's view inside the page area `area` (the frame and the device fit). */
  viewBounds(tab: Tab, area: PageBounds): PageBounds;
  /**
   * The profile an audit extraction starting now in the tab runs under (`null`: none): taken at the
   * start of each run and kept with it (`render-profile-audits.ts`).
   */
  auditProfile(tab: Tab): AuditRenderProfile | null;
  /** Forgets every pin in memory (Clear Browsing Data). */
  forgetPins(): void;
  /**
   * The tab's overrides changed (`tab-overrides.ts`): kept as `entry.tabOverrides`, and the merged list
   * is sent again when their CDP part changed (the profile kept); detached when nothing is left.
   */
  setTabOverrides(tab: Tab, overrides: TabOverrides): void;
  /** `TabState.overridesStatus`: whether the overrides' CDP part is in effect (`active` when it has none). */
  overridesStatus(tab: Tab): RenderProfileStatus;
}

interface Effective {
  readonly profile: RenderProfile;
  readonly source: RenderProfileSource;
}

/** The profile state when a main-frame navigation started (and, once it commits, the document's). */
interface Mark {
  readonly seq: number;
  /** Everything for `seq` had been applied. */
  readonly applied: boolean;
  /** A profile was in effect (or being applied). */
  readonly profiled: boolean;
}

interface Entry {
  own: RenderProfile | null;
  /** The origin the tab is at, or navigating to (what its pin is looked up by). */
  origin: string | null;
  effective: Effective | null;
  /** Bumped on every change of `effective` (and on a re-apply). */
  seq: number;
  /** The last `seq` whose commands were dispatched (`-1`: none since the view came). */
  dispatchedSeq: number;
  /** The last `seq` whose commands were all answered. */
  appliedSeq: number;
  status: RenderProfileStatus;
  nav: Mark | null;
  doc: Mark | null;
  contents: TabContents | null;
  dbg: ProfileDebugger | null;
  /** The viewport last sent (`null`: none). */
  emulation: RenderFit['emulation'];
  /** A detach frost did not ask for was answered already (for this `seq`). */
  reattached: boolean;
  /** The tab's overrides (`TabOverrides`), merged into the list after the profile's commands. */
  tabOverrides: TabOverrides;
  /** The last list dispatched since the attach carried overrides that were on (a later one must clear them). */
  overridesSent: boolean;
  /** Whether the overrides' CDP part is in effect (`TabState.overridesStatus`). */
  overridesStatus: RenderProfileStatus;
  /** Bumped on every list dispatched (or detach): only the latest one's answer settles `overridesStatus`. */
  sends: number;
}

/** Whether `overrides` has anything for the debugger (CSS off is a page script, not CDP). */
const cdpOverridesOn = (overrides: TabOverrides): boolean => overrides.cookiesDisabled || overrides.geolocation !== null;

/** Whether the overrides' CDP part is the same in `a` and `b`. */
function sameCdpOverrides(a: TabOverrides, b: TabOverrides): boolean {
  const [ga, gb] = [a.geolocation, b.geolocation];
  return a.cookiesDisabled === b.cookiesDisabled && (ga === gb || (ga !== null && gb !== null && ga.latitude === gb.latitude && ga.longitude === gb.longitude && ga.accuracy === gb.accuracy));
}

function sameEffective(a: Effective | null, b: Effective | null): boolean {
  return a === b || (a !== null && b !== null && a.source === b.source && sameRenderProfile(a.profile, b.profile));
}

function sameEmulation(a: RenderFit['emulation'], b: RenderFit['emulation']): boolean {
  return a === b || (a !== null && b !== null && a.width === b.width && a.height === b.height && a.scale === b.scale);
}

export function createTabRenderProfiles(options: RenderProfileOptions | undefined, ctx: RenderProfileContext): TabRenderProfiles {
  const entries = new WeakMap<Tab, Entry>();

  const entryOf = (tab: Tab): Entry => {
    let entry = entries.get(tab);
    if (!entry) {
      entry = { own: null, origin: null, effective: null, seq: 0, dispatchedSeq: 0, appliedSeq: 0, status: 'active', nav: null, doc: null, contents: null, dbg: null, emulation: null, reattached: false, tabOverrides: DEFAULT_TAB_OVERRIDES, overridesSent: false, overridesStatus: 'active', sends: 0 };
      entries.set(tab, entry);
    }
    return entry;
  };

  const resolve = (entry: Entry): Effective | null => {
    if (entry.own) return { profile: entry.own, source: 'tab' };
    const pinned = options?.pins.get(entry.origin) ?? null;
    return pinned ? { profile: pinned, source: 'site' } : null;
  };

  const needsReload = (entry: Entry): boolean => entry.doc !== null && (entry.doc.seq !== entry.seq || !entry.doc.applied);

  /** The tab needs its debugger: a profile, or overrides with a CDP part. */
  const needsDebugger = (entry: Entry): boolean => entry.effective !== null || cdpOverridesOn(entry.tabOverrides);

  const mark = (entry: Entry): Mark => ({ seq: entry.seq, applied: entry.dispatchedSeq === entry.seq && entry.status !== 'failed', profiled: entry.effective !== null });

  const debuggerOf = (tab: Tab, entry: Entry, contents: TabContents): ProfileDebugger => {
    entry.dbg ??= options!.debuggerFor(contents, () => {
      // Chromium closed frost's session (frost never detaches without `detach()`): attach once more,
      // with the profile and the tab's overrides (one merged list), or the overrides alone.
      entry.overridesSent = false;
      if (entries.get(tab) !== entry || entry.contents !== contents || !needsDebugger(entry)) return;
      if (entry.reattached) {
        entry.status = 'failed';
        if (cdpOverridesOn(entry.tabOverrides)) entry.overridesStatus = 'failed';
        ctx.changed();
        return;
      }
      entry.seq += 1;
      apply(tab, entry);
      entry.reattached = true;
      ctx.changed();
    });
    return entry.dbg;
  };

  /**
   * Puts `entry.effective` and `entry.tabOverrides` into effect now: the merged list (the profile, or
   * frost's defaults without one, then the overrides) is dispatched at once, or the debugger detached
   * when neither needs it (which drops every override); its answers settle the status later
   * (`applying` until then; a fresh tab's renderer-side commands are answered only once its first load
   * made a renderer).
   */
  function apply(tab: Tab, entry: Entry): void {
    const contents = entry.contents;
    const seq = entry.seq;
    const effective = entry.effective;
    entry.status = effective ? 'applying' : 'active';
    const send = ++entry.sends;
    // Without render profiles nothing is sent: the overrides' CDP part is never in effect.
    entry.overridesStatus = !cdpOverridesOn(entry.tabOverrides) ? 'active' : options ? 'applying' : 'failed';
    // No view yet: applied once it comes (`wire`).
    if (!contents || !options) return;
    if (!needsDebugger(entry)) {
      entry.dbg?.detach();
      entry.emulation = null;
      entry.overridesSent = false;
      entry.dispatchedSeq = seq;
      entry.appliedSeq = seq;
      return;
    }
    let answered: Promise<void>;
    let withOverrides = false;
    try {
      const profile = effective?.profile ?? DEFAULT_RENDER_PROFILE;
      const area = ctx.pageArea();
      const emulation = profile.device === 'none' ? null : area ? fitRenderViewport(area, profile.device).emulation : undefined;
      // The overrides' commands go along while any is on, and once more to clear them after.
      const overridesOn = cdpOverridesOn(entry.tabOverrides);
      withOverrides = overridesOn || entry.overridesSent;
      answered = debuggerOf(tab, entry, contents).send(renderProfileCommands(profile, { chromeVersion: options.chromeVersion, emulation, ...(withOverrides ? { tabOverrides: entry.tabOverrides } : {}) }));
      entry.overridesSent = overridesOn;
      entry.emulation = emulation ?? null;
      entry.dispatchedSeq = seq;
    } catch (error) {
      answered = Promise.reject(error);
    }
    // The overrides' status follows this list's answer if it is still the latest one sent.
    const settleOverrides = (status: RenderProfileStatus): boolean => {
      if (entry.sends !== send || !withOverrides || !cdpOverridesOn(entry.tabOverrides) || entry.overridesStatus === status) return false;
      entry.overridesStatus = status;
      return true;
    };
    answered.then(
      () => {
        const overrides = settleOverrides('active');
        if (entry.seq !== seq) {
          if (overrides) ctx.changed();
          return;
        }
        entry.appliedSeq = seq;
        entry.status = 'active';
        ctx.changed();
      },
      () => {
        const overrides = settleOverrides('failed');
        if (entry.seq !== seq) {
          if (overrides) ctx.changed();
          return;
        }
        entry.status = 'failed';
        ctx.changed();
      },
    );
  }

  /** Resolves the profile in effect again; answers whether it changed (and then applies it). */
  const refresh = (tab: Tab, entry: Entry): boolean => {
    const next = resolve(entry);
    if (sameEffective(entry.effective, next)) return false;
    entry.effective = next;
    entry.seq += 1;
    entry.reattached = false;
    apply(tab, entry);
    ctx.changed();
    return true;
  };

  /** The tab is at (or heading for) `url`: its pin is looked up by that origin. */
  const moveTo = (tab: Tab, entry: Entry, url: string): boolean => {
    entry.origin = webOrigin(url);
    return refresh(tab, entry);
  };

  /** The origin of the page the tab shows (its committed URL), if it shows one. */
  const shownOrigin = (entry: Entry): string | null => (entry.contents && !entry.contents.isDestroyed() ? webOrigin(entry.contents.getURL()) : null);

  /** Removes `origin`'s pin, if it has one. */
  const unpin = (origin: string | null): void => {
    if (options && origin !== null && options.pins.get(origin)) options.pins.remove(origin);
  };

  /** Reset (see `TabRenderProfiles.clear`). */
  const clear = (tab: Tab): boolean => {
    const entry = entries.get(tab);
    if (!options || !entry?.effective) return false;
    const profiled = entry.doc?.profiled === true;
    // The shown site's pin goes, and the pin in effect (a destination's, mid-navigation) too.
    if (entry.effective.source === 'site') unpin(entry.origin);
    unpin(shownOrigin(entry));
    entry.own = null;
    refresh(tab, entry);
    // One click back to the defaults: a page loaded under the profile loads again without it (the
    // debugger is detached by now).
    const contents = entry.contents;
    if (profiled && contents && !contents.isDestroyed() && tab.error === null && !tab.crashed && isWebUrl(contents.getURL())) contents.reload();
    return true;
  };

  return {
    set(tab, profile, pin) {
      if (!options) return false;
      if (isDefaultRenderProfile(profile)) {
        clear(tab);
        return true;
      }
      const entry = entryOf(tab);
      // A pin is for the page the tab shows, never a destination still loading.
      const site = shownOrigin(entry);
      if (pin === true) {
        if (site === null) return false;
        options.pins.set(site, profile);
        entry.own = null;
      } else {
        entry.own = profile;
        if (pin === false) unpin(site);
      }
      entry.origin ??= site;
      refresh(tab, entry);
      // The pin flag may have changed with the same profile in effect.
      ctx.changed();
      return true;
    },

    clear,

    state(tab) {
      const entry = entries.get(tab);
      if (!entry?.effective) return null;
      const pinned = options?.pins.get(shownOrigin(entry) ?? entry.origin) ?? null;
      return {
        profile: entry.effective.profile,
        source: entry.effective.source,
        pinned: pinned !== null && sameRenderProfile(pinned, entry.effective.profile),
        needsReload: needsReload(entry),
        status: entry.status,
      };
    },

    wire(tab, view) {
      const entry = entryOf(tab);
      const contents = view.webContents;
      entry.contents = contents;
      entry.dbg = null;
      entry.nav = null;
      entry.doc = null;
      entry.emulation = null;
      entry.overridesSent = false;
      const emitter = contents as unknown as NodeJS.EventEmitter;
      const owns = (): boolean => entries.get(tab) === entry && entry.contents === contents;
      const listeners: [string, (...args: never[]) => void][] = [
        [
          'did-start-navigation',
          (details: { url?: unknown; isMainFrame?: unknown; isSameDocument?: unknown }) => {
            if (!owns() || details.isMainFrame !== true || details.isSameDocument === true || typeof details.url !== 'string') return;
            moveTo(tab, entry, details.url);
            entry.nav = mark(entry);
          },
        ],
        [
          'did-redirect-navigation',
          (details: { url?: unknown; isMainFrame?: unknown }) => {
            if (!owns() || details.isMainFrame !== true || typeof details.url !== 'string') return;
            // A redirect to a site with another profile: the document will not load under it in full.
            if (moveTo(tab, entry, details.url) && entry.nav) entry.nav = { ...entry.nav, applied: false };
          },
        ],
        [
          'did-navigate',
          (_event: unknown, url: unknown) => {
            if (!owns()) return;
            // (Electron always reports the start first; without it, the state now is the best guess.)
            entry.doc = entry.nav ?? mark(entry);
            entry.nav = null;
            const moved = typeof url === 'string' && moveTo(tab, entry, url);
            // "Reload to apply" may have changed (only shown with a profile; a move reported itself).
            if (!moved && entry.effective) ctx.changed();
          },
        ],
        [
          'did-fail-load',
          (_event: unknown, _code: unknown, _description: unknown, _url: unknown, isMainFrame: unknown) => {
            if (!owns() || isMainFrame !== true) return;
            // The document did not change: the tab is still where it was.
            entry.nav = null;
            moveTo(tab, entry, contents.getURL());
          },
        ],
      ];
      for (const [event, listener] of listeners) emitter.on(event, listener as (...args: unknown[]) => void);
      // A profile (or overrides) set before the view existed (an empty tab, a popup) is applied now.
      if (needsDebugger(entry)) apply(tab, entry);
      else entry.dispatchedSeq = entry.appliedSeq = entry.seq;
      return () => {
        for (const [event, listener] of listeners) emitter.off(event, listener as (...args: unknown[]) => void);
      };
    },

    released(tab) {
      const entry = entries.get(tab);
      if (!entry) return;
      const dbg = entry.dbg;
      entry.dbg = null;
      entry.contents = null;
      entry.nav = null;
      entry.doc = null;
      entry.dispatchedSeq = entry.appliedSeq = -1;
      entry.emulation = null;
      entry.overridesSent = false;
      entry.sends += 1;
      dbg?.dispose();
    },

    beforeLoad(tab, url) {
      if (options) moveTo(tab, entryOf(tab), url);
    },

    inherit(from, to) {
      const own = entries.get(from)?.own ?? null;
      if (own) entryOf(to).own = own;
    },

    viewBounds(tab, area) {
      const entry = entries.get(tab);
      if (!entry?.effective) return area;
      const profile = entry.effective.profile;
      const fit = fitRenderViewport(area, profile.device);
      // The page area changed size: the emulated viewport follows (once the profile was dispatched;
      // an apply still to come reads the page area itself).
      if (fit.emulation && entry.contents && entry.dbg && entry.dispatchedSeq === entry.seq && entry.status !== 'failed' && !sameEmulation(entry.emulation, fit.emulation)) {
        entry.emulation = fit.emulation;
        try {
          entry.dbg.sendTopLevel([deviceMetricsCommand(profile, fit.emulation)]).catch(() => undefined);
        } catch {
          // The tab is going; its next apply sends the whole profile again.
        }
      }
      return { x: area.x + fit.view.x, y: area.y + fit.view.y, width: fit.view.width, height: fit.view.height };
    },

    auditProfile(tab) {
      const entry = entries.get(tab);
      return entry?.effective ? { profile: entry.effective.profile, partial: needsReload(entry) || entry.appliedSeq !== entry.seq } : null;
    },

    forgetPins() {
      options?.pins.forget();
    },

    setTabOverrides(tab, overrides) {
      const entry = entryOf(tab);
      const before = entry.tabOverrides;
      entry.tabOverrides = overrides;
      // Without render profiles there is no debugger: the CDP part cannot be put into effect.
      if (!options) {
        entry.overridesStatus = cdpOverridesOn(overrides) ? 'failed' : 'active';
        return;
      }
      // CSS off is not CDP: only a change of the CDP part sends the list again (the profile kept).
      if (sameCdpOverrides(before, overrides)) return;
      entry.reattached = false;
      apply(tab, entry);
      ctx.changed();
    },

    overridesStatus(tab) {
      return entries.get(tab)?.overridesStatus ?? 'active';
    },
  };
}
