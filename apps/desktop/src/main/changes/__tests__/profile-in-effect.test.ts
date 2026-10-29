// Spec: specs/render-profile.spec.ts (TabRenderProfile, AuditRenderProfile, RENDER_PROFILE_STATUSES)
// Acceptance: specs/changes-capture.feature.md (The render profile recorded; Scenario profile-in-effect-rule),
// specs/screenshot.feature.md (the screenshot's render profile)
import { describe, expect, test } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { DEFAULT_RENDER_PROFILE, RENDER_PROFILE_STATUSES, type RenderProfile } from '@app/specs/render-profile.spec';
import { recordedProfile, tabProfileInEffect } from '../profile-in-effect';

const PHONE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };

describe('the render profile recorded', () => {
  test('profile-in-effect-rule', () => {
    // A tab's profile, by the rule an audit's `partial` follows: only an active profile the page loaded under is whole.
    const tab = (needsReload: boolean, status: (typeof RENDER_PROFILE_STATUSES)[number]) => tabProfileInEffect({ profile: PHONE, needsReload, status });
    expect(tab(false, 'active')).toEqual({ profile: PHONE, partial: false });
    expect(tab(true, 'active')).toEqual({ profile: PHONE, partial: true });
    expect(tab(false, 'applying')).toEqual({ profile: PHONE, partial: true });
    // A failed profile is still the one set on the tab: recorded, partial (as an audit records it).
    expect(tab(false, 'failed')).toEqual({ profile: PHONE, partial: true });
    expect(tabProfileInEffect(null)).toBeNull();

    // As a row records it: canonical JSON with its `partial`, whether from a tab or an audit.
    expect(recordedProfile(tab(true, 'failed'))).toEqual({ profile: PHONE, json: canonicalJson(PHONE), partial: true });
    expect(recordedProfile({ profile: PHONE, partial: false })).toEqual({ profile: PHONE, json: canonicalJson(PHONE), partial: false });
    expect(recordedProfile(null)).toBeNull();
    // One that does not fit its schema does not read back (a capture refuses; a screenshot records none).
    expect(recordedProfile({ profile: { device: 'toaster' } as unknown as RenderProfile, partial: false })).toBeUndefined();
  });
});
