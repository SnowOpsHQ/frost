// Spec: specs/render-profile.spec.ts (renderProfileSummary, fitRenderViewport, RELOAD_TO_APPLY_LABEL, PROFILE_FAILED_NOTE,
// MAX_CUSTOM_USER_AGENT_LENGTH, CRAWLER_USER_AGENTS)
// Acceptance: specs/render-profile.feature.md (Visible state)
import { describe, expect, test } from 'vitest';
import { DEFAULT_RENDER_PROFILE, fitRenderViewport, MAX_CUSTOM_USER_AGENT_LENGTH, PROFILE_FAILED_NOTE, type TabRenderProfile } from '@app/specs/render-profile.spec';
import { DEFAULT_TAB_OVERRIDES, GEOLOCATION_PRESETS, TAB_OVERRIDES_FAILED_NOTE } from '@app/specs/render-profile.spec';
import { badgeLabel, chipText, draftOf, frameNotes, geolocationChoiceOf, geolocationDraftOf, geolocationOfDraft, outlineRect, overridesChipText, overridesFailedNote, profileOfDraft } from '../render-profile-view';

const state = (over: Partial<TabRenderProfile> = {}): TabRenderProfile => ({
  profile: { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' },
  source: 'tab',
  pinned: false,
  needsReload: false,
  status: 'active',
  ...over,
});

describe('render-profile view', () => {
  test('render-profile-view', () => {
    expect(badgeLabel(state())).toBe('Render profile: Phone 412×915 · Googlebot smartphone');
    expect(badgeLabel(state({ source: 'site', pinned: true }))).toBe('Render profile: Phone 412×915 · Googlebot smartphone (pinned to this site)');
    expect(chipText(state())).toBe('Phone 412×915 · Googlebot smartphone');
    expect(chipText(state({ needsReload: true }))).toBe('Phone 412×915 · Googlebot smartphone · Reload to apply');
    expect(chipText(state({ status: 'failed', needsReload: true }))).toBe('Phone 412×915 · Googlebot smartphone · not applied');
    expect(frameNotes(state())).toEqual({ failed: null, crawler: true });
    expect(frameNotes(state({ status: 'failed', profile: { ...DEFAULT_RENDER_PROFILE, javascriptDisabled: true } }))).toEqual({ failed: PROFILE_FAILED_NOTE, crawler: false });
  });

  test('outline-follows-the-fit', () => {
    const { view } = fitRenderViewport({ width: 900, height: 700 }, 'phone');
    expect(outlineRect(state(), 900, 700)).toEqual({ x: view.x - 1, y: view.y - 1, width: view.width + 2, height: view.height + 2 });
    expect(outlineRect(state({ profile: { ...DEFAULT_RENDER_PROFILE, javascriptDisabled: true } }), 900, 700)).toBeNull();
  });

  test('draft-round-trip', () => {
    expect(draftOf(null)).toEqual({ ...DEFAULT_RENDER_PROFILE, pin: false });
    const draft = draftOf(state({ pinned: true }));
    expect(draft.pin).toBe(true);
    expect(profileOfDraft(draft)).toEqual({ ok: true, profile: state().profile, isDefault: false });
    expect(profileOfDraft(draftOf(null))).toMatchObject({ ok: true, isDefault: true });
    // A custom user agent: trimmed, required, capped, ASCII; any other keeps no text.
    expect(profileOfDraft({ ...draft, userAgent: 'custom', customUserAgent: '  Bot/1  ' })).toMatchObject({ ok: true, profile: { customUserAgent: 'Bot/1' } });
    expect(profileOfDraft({ ...draft, userAgent: 'custom', customUserAgent: '   ' })).toMatchObject({ ok: false });
    expect(profileOfDraft({ ...draft, userAgent: 'custom', customUserAgent: 'x'.repeat(MAX_CUSTOM_USER_AGENT_LENGTH + 1) })).toMatchObject({ ok: false });
    expect(profileOfDraft({ ...draft, userAgent: 'custom', customUserAgent: 'boté' })).toMatchObject({ ok: false });
    expect(profileOfDraft({ ...draft, userAgent: 'mobile', customUserAgent: 'left over' })).toMatchObject({ ok: true, profile: { customUserAgent: '' } });
  });
});

// Phase 11 Task 6 (render-profile.feature.md, Tab overrides: Visible state): the overrides' chip and the location form.
describe('tab overrides view', () => {
  test('tab-overrides-view', () => {
    expect(overridesChipText(DEFAULT_TAB_OVERRIDES)).toBeNull();
    expect(overridesChipText({ cssDisabled: true, cookiesDisabled: true, geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 100 } })).toBe('CSS off (stylesheets) · Cookies off · Location 48.85660, 2.35220');
    expect(geolocationChoiceOf(null)).toBe('off');
    expect(geolocationChoiceOf(GEOLOCATION_PRESETS[1].geolocation)).toBe(GEOLOCATION_PRESETS[1].id);
    expect(geolocationChoiceOf({ ...GEOLOCATION_PRESETS[1].geolocation, accuracy: 5 })).toBe('custom');
    expect(geolocationDraftOf(null)).toEqual({ latitude: '', longitude: '', accuracy: '100' });
    expect(geolocationOfDraft({ latitude: '48.8566', longitude: '-2.35221', accuracy: '25' })).toEqual({ ok: true, geolocation: { latitude: 48.8566, longitude: -2.35221, accuracy: 25 } });
    for (const bad of [
      { latitude: '', longitude: '0', accuracy: '10' },
      { latitude: '91', longitude: '0', accuracy: '10' },
      { latitude: '0', longitude: '180.5', accuracy: '10' },
      { latitude: '1.123456', longitude: '0', accuracy: '10' },
      { latitude: '1e2', longitude: '0', accuracy: '10' },
      { latitude: '0', longitude: '0', accuracy: '0' },
      { latitude: '0', longitude: '0', accuracy: '1.5' },
      { latitude: '0', longitude: '0', accuracy: '100001' },
    ]) expect(geolocationOfDraft(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

// Whole-branch review: a failed CDP part of the overrides shows with or without a profile.
describe('tab overrides failure', () => {
  test('tab-overrides-failure-shown', () => {
    const cookies = { ...DEFAULT_TAB_OVERRIDES, cookiesDisabled: true };
    expect(overridesChipText(cookies, 'applying')).toBe('Cookies off');
    expect(overridesChipText(cookies, 'failed')).toBe('Cookies off · not applied');
    expect(overridesChipText(DEFAULT_TAB_OVERRIDES, 'failed')).toBeNull();
    expect(overridesFailedNote(cookies, 'failed')).toBe(TAB_OVERRIDES_FAILED_NOTE);
    expect(overridesFailedNote(cookies, 'active')).toBeNull();
    expect(overridesFailedNote(DEFAULT_TAB_OVERRIDES, 'failed')).toBeNull();
  });
});
