// Spec: specs/render-profile.spec.ts (renderProfileSummary, fitRenderViewport, RELOAD_TO_APPLY_LABEL, PROFILE_FAILED_NOTE,
// MAX_CUSTOM_USER_AGENT_LENGTH, CRAWLER_USER_AGENTS)
// Acceptance: specs/render-profile.feature.md (Visible state)
import { describe, expect, test } from 'vitest';
import { DEFAULT_RENDER_PROFILE, fitRenderViewport, MAX_CUSTOM_USER_AGENT_LENGTH, PROFILE_FAILED_NOTE, type TabRenderProfile } from '@app/specs/render-profile.spec';
import { badgeLabel, chipText, draftOf, frameNotes, outlineRect, profileOfDraft } from '../render-profile-view';

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
