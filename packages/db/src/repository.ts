import { asc, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { MAX_RECENT_VISITS, MAX_RESTORED_TABS, MAX_STORED_TITLE_LENGTH, MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import type { PersistedDecision, SitePermission } from '@app/specs/permissions.spec';
import { MAX_RENDER_PROFILE_PINS, type RenderProfile } from '@app/specs/render-profile.spec';
import type { SessionDatabase } from './client';
import { browserTabs, recentVisits, renderProfilePins, sitePermissions } from './schema';
import { isPersistedDecision, isSitePermission, MAX_STORED_PROFILE_LENGTH, storableOrigin, storableProfile, storableTitle, storableUrl } from './values';

// The browser-session repository (spec `browser-session-db.feature.md`, Repository): the only
// reads and writes of the session tables. Values are normalized on the way in (`values.ts`) and
// checked again on the way out, so a tampered row is skipped, never handed to the browser.

/** One tab of the saved strip: an `http(s)` URL, or `''` for an empty tab. */
export interface SessionTab {
  readonly url: string;
  readonly title: string;
}

/** The saved strip: tabs in order (at least one when loaded) and the active one's index. */
export interface SavedSession {
  readonly tabs: readonly SessionTab[];
  readonly activeIndex: number;
}

/**
 * Visits to one URL to add (`visits` ≥ 1, at `lastVisitAt`), or only its latest title
 * (`visits` 0: a title never creates a visit). An empty `title` keeps the stored one.
 */
export interface VisitUpdate {
  readonly url: string;
  readonly visits: number;
  readonly lastVisitAt: number;
  readonly title: string;
}

export interface Visit {
  readonly url: string;
  readonly title: string;
  readonly visitCount: number;
  readonly lastVisitAt: number;
}

/** A remembered decision that persists (a Block), keyed as the permission broker keys it. */
export interface StoredDecision {
  readonly origin: string;
  readonly topLevelOrigin: string;
  readonly permission: SitePermission;
  readonly decision: PersistedDecision;
}

/** A render profile pinned to an origin ("Pin to this site", `render-profile.feature.md`). */
export interface StoredRenderProfilePin {
  readonly origin: string;
  readonly profile: RenderProfile;
}

/** What one write carries: the latest tab strip (if it changed) and the visits since the last write. */
export interface SessionWrite {
  readonly session?: SavedSession;
  readonly visits?: readonly VisitUpdate[];
}

export interface SessionRepository {
  /** The saved strip, invalid rows skipped; one empty tab when nothing valid is saved. */
  loadSession(): Promise<SavedSession>;
  /** Replaces the saved strip. */
  saveSession(session: SavedSession): Promise<void>;
  /** Records one visit to `url` at `at` (with its title, if known). */
  recordVisit(url: string, at: number, title?: string): Promise<void>;
  /** Sets the title of `url`'s visit, if it has one. */
  updateVisitTitle(url: string, title: string): Promise<void>;
  /** Saves the strip and records the visits of `write` in one transaction, then prunes visits. */
  write(write: SessionWrite): Promise<void>;
  /** The most recently visited URLs first. */
  recentVisits(limit?: number): Promise<Visit[]>;
  /** The stored Blocks; any other row (an Allow, a tampered one) is skipped. */
  loadPermissionDecisions(): Promise<StoredDecision[]>;
  /** Remembers a Block (one row per key). Anything but a Block, or an invalid key, is ignored. */
  savePermissionDecision(decision: StoredDecision, at: number): Promise<void>;
  /**
   * The pinned render profiles, oldest first, at most `MAX_RENDER_PROFILE_PINS`; a row that is not a
   * serialized `http(s)` origin with a valid, non-default profile is skipped.
   */
  loadRenderProfilePins(): Promise<StoredRenderProfilePin[]>;
  /** Pins `profile` to `origin` (replacing its pin), then drops the oldest pins beyond the cap. Invalid values are ignored. */
  saveRenderProfilePin(origin: string, profile: RenderProfile, at: number): Promise<void>;
  deleteRenderProfilePin(origin: string): Promise<void>;
  /**
   * Deletes every visit, stored decision and pinned render profile in one transaction (Clear
   * Browsing Data); the tab strip is kept.
   */
  clearBrowsingData(): Promise<void>;
}

const EMPTY_SESSION: SavedSession = { tabs: [{ url: '', title: '' }], activeIndex: 0 };

/** `session` as stored: browsable URLs only (else an empty tab), capped titles, at most `MAX_RESTORED_TABS`. */
function storableSession(session: SavedSession): SavedSession {
  const tabs = session.tabs.slice(0, MAX_RESTORED_TABS).map((tab) => ({ url: storableUrl(tab.url) ?? '', title: storableTitle(tab.title) }));
  if (tabs.length === 0) return EMPTY_SESSION;
  const activeIndex = Number.isInteger(session.activeIndex) ? Math.min(Math.max(session.activeIndex, 0), tabs.length - 1) : 0;
  return { tabs, activeIndex };
}

type Row = { position: unknown; url: unknown; title: unknown; active: unknown };

/** The strip `rows` (in position order) describe; see `SessionRepository.loadSession`. */
export function sessionFromRows(rows: readonly Row[]): SavedSession {
  const tabs: SessionTab[] = [];
  /** Original row index of each kept tab. */
  const origins: number[] = [];
  let activeRow = -1;
  rows.forEach((row, index) => {
    if (activeRow < 0 && row.active === true) activeRow = index;
    if (tabs.length >= MAX_RESTORED_TABS) return;
    const url = row.url === '' ? '' : storableUrl(row.url);
    if (url === null) return;
    tabs.push({ url, title: storableTitle(row.title) });
    origins.push(index);
  });
  if (tabs.length === 0) return EMPTY_SESSION;
  if (activeRow < 0) return { tabs, activeIndex: 0 };
  // The saved active tab, else (skipped) the next kept tab to its right, else the last one.
  const next = origins.findIndex((origin) => origin >= activeRow);
  return { tabs, activeIndex: next < 0 ? tabs.length - 1 : next };
}

export function createSessionRepository(db: SessionDatabase): SessionRepository {
  const batch = async (items: BatchItem<'sqlite'>[]): Promise<void> => {
    if (items.length === 0) return;
    await db.batch(items as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  };

  const sessionItems = (session: SavedSession): BatchItem<'sqlite'>[] => {
    const stored = storableSession(session);
    return [
      db.delete(browserTabs),
      db.insert(browserTabs).values(stored.tabs.map((tab, position) => ({ position, url: tab.url, title: tab.title, active: position === stored.activeIndex }))),
    ];
  };

  const visitItems = (visits: readonly VisitUpdate[]): BatchItem<'sqlite'>[] => {
    const items: BatchItem<'sqlite'>[] = [];
    for (const visit of visits) {
      const url = storableUrl(visit.url);
      if (url === null) continue;
      const title = storableTitle(visit.title);
      if (visit.visits >= 1 && Number.isInteger(visit.visits)) {
        items.push(
          db
            .insert(recentVisits)
            .values({ url, title, visitCount: visit.visits, lastVisitAt: visit.lastVisitAt })
            .onConflictDoUpdate({
              target: recentVisits.url,
              set: {
                visitCount: sql`${recentVisits.visitCount} + excluded.visit_count`,
                lastVisitAt: sql`max(${recentVisits.lastVisitAt}, excluded.last_visit_at)`,
                title: sql`CASE WHEN excluded.title = '' THEN ${recentVisits.title} ELSE excluded.title END`,
              },
            }),
        );
      } else if (title !== '') {
        items.push(db.update(recentVisits).set({ title }).where(eq(recentVisits.url, url)));
      }
    }
    if (items.length > 0) {
      const kept = db.select({ url: recentVisits.url }).from(recentVisits).orderBy(desc(recentVisits.lastVisitAt)).limit(MAX_RECENT_VISITS);
      items.push(db.delete(recentVisits).where(notInArray(recentVisits.url, kept)));
    }
    return items;
  };

  const write = async ({ session, visits = [] }: SessionWrite): Promise<void> => {
    await batch([...(session ? sessionItems(session) : []), ...visitItems(visits)]);
  };

  return {
    async loadSession() {
      // A tampered file may hold any number of rows and values of any size: read no more rows than
      // can be restored, and no more of each value than can be stored (`substr` counts characters:
      // one over the URL cap, so an over-long URL is still seen as one; twice the title cap).
      const rows = await db
        .select({
          position: browserTabs.position,
          url: sql<unknown>`substr(${browserTabs.url}, 1, ${MAX_STORED_URL_LENGTH + 1})`,
          title: sql<unknown>`substr(${browserTabs.title}, 1, ${MAX_STORED_TITLE_LENGTH * 2})`,
          active: browserTabs.active,
        })
        .from(browserTabs)
        .orderBy(asc(browserTabs.position))
        .limit(MAX_RESTORED_TABS);
      return sessionFromRows(rows);
    },

    saveSession: (session) => write({ session }),

    recordVisit: (url, at, title = '') => write({ visits: [{ url, visits: 1, lastVisitAt: at, title }] }),

    updateVisitTitle: (url, title) => write({ visits: [{ url, visits: 0, lastVisitAt: 0, title }] }),

    write,

    async recentVisits(limit = MAX_RECENT_VISITS) {
      return db.select().from(recentVisits).orderBy(desc(recentVisits.lastVisitAt)).limit(limit);
    },

    async loadPermissionDecisions() {
      const rows = await db.select().from(sitePermissions);
      const decisions: StoredDecision[] = [];
      for (const row of rows) {
        const origin = storableOrigin(row.origin);
        const topLevelOrigin = storableOrigin(row.topLevelOrigin);
        if (origin === null || topLevelOrigin === null || !isSitePermission(row.permission) || !isPersistedDecision(row.decision)) continue;
        decisions.push({ origin, topLevelOrigin, permission: row.permission, decision: row.decision });
      }
      return decisions;
    },

    async savePermissionDecision({ origin, topLevelOrigin, permission, decision }, at) {
      if (storableOrigin(origin) === null || storableOrigin(topLevelOrigin) === null || !isSitePermission(permission) || !isPersistedDecision(decision)) return;
      await db
        .insert(sitePermissions)
        .values({ origin, topLevelOrigin, permission, decision, updatedAt: at })
        .onConflictDoUpdate({
          target: [sitePermissions.origin, sitePermissions.topLevelOrigin, sitePermissions.permission],
          set: { decision, updatedAt: at },
        });
    },

    async loadRenderProfilePins() {
      // A tampered file: no more rows than can be kept, and no more of each value than a profile needs.
      const rows = await db
        .select({
          origin: sql<unknown>`substr(${renderProfilePins.origin}, 1, ${MAX_STORED_URL_LENGTH + 1})`,
          profile: sql<unknown>`substr(${renderProfilePins.profile}, 1, ${MAX_STORED_PROFILE_LENGTH + 1})`,
        })
        .from(renderProfilePins)
        .orderBy(asc(renderProfilePins.updatedAt), asc(renderProfilePins.origin))
        .limit(MAX_RENDER_PROFILE_PINS);
      const pins: StoredRenderProfilePin[] = [];
      for (const row of rows) {
        const origin = storableOrigin(row.origin);
        const profile = typeof row.profile === 'string' ? storableProfile(row.profile) : null;
        if (origin !== null && profile !== null) pins.push({ origin, profile });
      }
      return pins;
    },

    async saveRenderProfilePin(origin, profile, at) {
      const stored = storableOrigin(origin);
      if (stored === null || storableProfile(profile) === null) return;
      const kept = db.select({ origin: renderProfilePins.origin }).from(renderProfilePins).orderBy(desc(renderProfilePins.updatedAt), desc(renderProfilePins.origin)).limit(MAX_RENDER_PROFILE_PINS);
      await batch([
        db
          .insert(renderProfilePins)
          .values({ origin: stored, profile: JSON.stringify(profile), updatedAt: at })
          .onConflictDoUpdate({ target: renderProfilePins.origin, set: { profile: JSON.stringify(profile), updatedAt: at } }),
        db.delete(renderProfilePins).where(notInArray(renderProfilePins.origin, kept)),
      ]);
    },

    deleteRenderProfilePin: (origin) => batch([db.delete(renderProfilePins).where(eq(renderProfilePins.origin, origin))]),

    clearBrowsingData: () => batch([db.delete(recentVisits), db.delete(sitePermissions), db.delete(renderProfilePins)]),
  };
}
