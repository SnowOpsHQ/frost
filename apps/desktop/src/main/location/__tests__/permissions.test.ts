// Spec: specs/permissions.spec.ts (PROMPTABLE_PERMISSIONS), specs/browser-session-db.feature.md (Permission decisions: Blocks persist)
// Acceptance: specs/location-profiles.feature.md (Permissions: location-geolocation-denied, location-permissions-not-persisted)
// · plan docs/plans/phase-12-big-bets.md, Task 10b (security review, lead ruling)
import { describe, expect, test, vi } from 'vitest';
import type { StoredDecision } from '@app/db';
import { createBrowsePermissionHandlers, createPermissionBroker, createPersistentDecisionStore } from '../../browser/permissions';
import { markLocationSession, renewLocationSession } from '../sessions';

const SITE = 'https://site.example';
const PROFILE = '01920000-0000-7000-8000-0000000000c1';

/** A tab's WebContents on `session`, showing `SITE` in its main frame. */
function contentsOn(session: object) {
  const mainFrame = { url: `${SITE}/`, origin: SITE, framesInSubtree: [] as unknown[] };
  mainFrame.framesInSubtree = [mainFrame];
  return { session, mainFrame };
}

function setup() {
  const persisted: StoredDecision[] = [];
  const broker = createPermissionBroker({ store: createPersistentDecisionStore((decision) => persisted.push(decision)), randomId: (() => {
    let n = 0;
    return () => `p${(n += 1)}`;
  })() });
  const browse = { name: 'browse' };
  const location = { name: 'location' };
  markLocationSession(location, PROFILE);
  const home = contentsOn(browse);
  const located = contentsOn(location);
  const tabs = new Map<unknown, number>([
    [home, 1],
    [located, 2],
  ]);
  const handlers = createBrowsePermissionHandlers({ broker, tabIdOf: (contents) => tabs.get(contents) ?? null });
  const ask = (contents: unknown, permission: string, extra: Record<string, unknown> = {}) => {
    const callback = vi.fn<(granted: boolean) => void>();
    handlers.request(contents, permission, callback, { isMainFrame: true, requestingUrl: `${SITE}/`, ...extra });
    return callback;
  };
  const check = (contents: unknown, permission: string) => handlers.check(contents, permission, SITE, { isMainFrame: true, embeddingOrigin: SITE });
  const checkCamera = (contents: unknown) => handlers.check(contents, 'media', SITE, { mediaType: 'video', securityOrigin: `${SITE}/`, embeddingOrigin: SITE });
  return { broker, persisted, home, located, ask, check, checkCamera, location };
}

describe('permissions in a location session', () => {
  test('location-geolocation-denied', () => {
    const { broker, home, located, ask, check } = setup();
    // At home: asked, allowed (remembered for the run).
    const atHome = ask(home, 'geolocation');
    expect(broker.answer(1, broker.promptFor(1)!.id, 'allow')).toBe(true);
    expect(atHome).toHaveBeenCalledWith(true);
    expect(check(home, 'geolocation')).toBe(true);
    // In the location tab: that Allow does not apply, and geolocation is denied outright, without a prompt.
    const there = ask(located, 'geolocation');
    expect(there).toHaveBeenCalledExactlyOnceWith(false);
    expect(broker.promptFor(2)).toBeNull();
    expect(check(located, 'geolocation')).toBe(false);
  });

  test('location-permissions-not-persisted', () => {
    const { broker, persisted, home, located, ask, checkCamera, location } = setup();
    // A home Block persists, as before; it does not apply in the location tab, which asks afresh.
    ask(home, 'notifications');
    broker.answer(1, broker.promptFor(1)!.id, 'block');
    expect(persisted).toEqual([{ origin: SITE, topLevelOrigin: SITE, permission: 'notifications', decision: 'block' }]);
    const there = ask(located, 'notifications');
    expect(there).not.toHaveBeenCalled();
    expect(broker.promptFor(2)).toMatchObject({ origin: SITE, permission: 'notifications' });
    // Its answers are kept in memory for its own session only, never written.
    broker.answer(2, broker.promptFor(2)!.id, 'block');
    expect(there).toHaveBeenCalledWith(false);
    const camera = ask(located, 'media', { mediaTypes: ['video'] });
    broker.answer(2, broker.promptFor(2)!.id, 'allow');
    expect(camera).toHaveBeenCalledWith(true);
    expect(persisted).toHaveLength(1);
    expect(checkCamera(located)).toBe(true);
    // Not at home, and no longer once the partition is reset (edited) or retired.
    expect(checkCamera(home)).toBe(false);
    renewLocationSession(location);
    expect(checkCamera(located)).toBe(false);
    const again = ask(located, 'notifications');
    expect(again).not.toHaveBeenCalled();
    expect(broker.promptFor(2)).not.toBeNull();
  });
});
