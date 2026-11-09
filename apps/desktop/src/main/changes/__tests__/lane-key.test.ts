// Spec: specs/render-profile.spec.ts (TabOverrides, DEFAULT_TAB_OVERRIDES), specs/capture-db.spec.ts (lane keys)
// Acceptance: specs/render-profile.feature.md (Tab overrides: tab-local, not a profile)
import { describe, expect, test } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { DEFAULT_RENDER_PROFILE, DEFAULT_TAB_OVERRIDES, type RenderProfile, type TabOverrides } from '@app/specs/render-profile.spec';
import { recordedProfile } from '../profile-in-effect';
import { laneKeyFor, sha256Hex } from '../snapshot';

const PAGE = 'https://example.com/guides/tea';
const PHONE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
const ALL: TabOverrides = { cssDisabled: true, cookiesDisabled: true, geolocation: { latitude: 1, longitude: 2, accuracy: 3 } };

describe('lane keys', () => {
  test('lane-key-unchanged-by-emulation', () => {
    // A regression guard: the lane key is built from the URL, the profile and the search parameters
    // only, exactly as before Phase 11, so the overrides cannot move a capture to another lane.
    for (const profile of [null, PHONE]) {
      expect(laneKeyFor(PAGE, profile, null)).toBe(sha256Hex(canonicalJson({ url: PAGE, renderProfile: profile, searchParams: null })));
    }
    // The profile recorded for an audit is the profile alone, whatever overrides it ran under.
    const recorded = recordedProfile({ profile: PHONE, partial: false });
    expect(recorded && JSON.parse(recorded.json)).toEqual(PHONE);
    expect(recorded!.json).not.toMatch(/cssDisabled|cookiesDisabled|geolocation/);
    // Even a profile object that somehow carried override fields records (and keys) the profile alone.
    const smuggled = { ...PHONE, ...ALL } as unknown as RenderProfile;
    expect(recordedProfile({ profile: smuggled, partial: false })).toBeUndefined();
    expect(Object.keys(DEFAULT_TAB_OVERRIDES).some((key) => key in DEFAULT_RENDER_PROFILE)).toBe(false);
  });
});
