// Spec: specs/render-profile.spec.ts (AuditRenderProfile, DEFAULT_RENDER_PROFILE, TabOverrides, DEFAULT_TAB_OVERRIDES),
// specs/seo-limits.spec.ts (AUDIT_DEBOUNCE_MS)
// Acceptance: specs/render-profile.feature.md (Recorded with audits; Tab overrides: Recorded with audits (the stamp))
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_RENDER_PROFILE, DEFAULT_TAB_OVERRIDES, type RenderProfile, type TabOverrides } from '@app/specs/render-profile.spec';
import { AUDIT_DEBOUNCE_MS } from '@app/specs/seo-limits.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { rawSnapshot } from '../../../test/seo-fakes';
import { analyseSnapshot } from '../../seo/analyse';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';
import type { ProfileDebugger } from '../render-profile-debugger';
import { withAuditProfiles } from '../render-profile-audits';
import { createRenderProfilePins } from '../render-profile-pins';

const URL_A = 'https://example.com/a';
const PHONE_BOT: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };

let views: FakeTabView[];
let controller: BrowserController;
let extractions: ((raw: unknown) => void)[];

const quietDebugger = (): ProfileDebugger => ({ send: async () => undefined, sendTopLevel: async () => undefined, detach: () => undefined, isAttached: () => true, dispose: () => undefined });

beforeEach(() => {
  vi.useFakeTimers();
  views = [];
  extractions = [];
  controller = createBrowserController({
    createView: () => {
      const view = new FakeTabView();
      views.push(view);
      return view as unknown as TabView;
    },
    platform: 'linux',
    seo: {
      extract: () => new Promise((resolve) => extractions.push(resolve)),
      analyse: async (raw) => analyseSnapshot(raw),
    },
    renderProfiles: { pins: createRenderProfilePins(), chromeVersion: '140.0.0.0', debuggerFor: () => quietDebugger() },
  });
  controller.attach(new FakeHostWindow() as unknown as HostWindow);
});

afterEach(() => {
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const activeId = () => controller.getState().activeTabId!;

/** A main-frame load of `url` as Electron reports it: started, committed, finished. */
function load(contents: FakeTabContents, url: string): void {
  contents.emit('did-start-navigation', fakeEvent({ url, isMainFrame: true, isSameDocument: false }));
  commit(contents, url, 'A');
  contents.emit('did-finish-load');
}

describe('audits keep the profile they ran under', () => {
  test('held-audit-keeps-its-profile', async () => {
    controller.navigate(URL_A);
    const contents = views[0]!.contents;
    load(contents, URL_A);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    extractions.shift()!(rawSnapshot(URL_A));
    await flush();
    const first = controller.seo.getAudit(activeId());
    expect(first).toMatchObject({ status: 'ready', renderProfile: null });

    // A profile, then a reload: the new run's extraction is under way while the first audit is
    // still the one shown. That audit keeps its own label (it ran under no profile).
    controller.setRenderProfile(activeId(), PHONE_BOT);
    await flush();
    load(contents, URL_A);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    expect(extractions).toHaveLength(1);
    const held = controller.seo.getAudit(activeId());
    expect(held.status).toBe('ready');
    expect(held.status === 'ready' && first.status === 'ready' && held.audit).toBe(first.status === 'ready' && first.audit);
    expect(held).toMatchObject({ renderProfile: null });

    // The new run settles: its audit carries the profile it ran under.
    extractions.shift()!(rawSnapshot(URL_A));
    await flush();
    const second = controller.seo.getAudit(activeId());
    expect(second.status === 'ready' && first.status === 'ready' && second.audit !== first.audit).toBe(true);
    expect(second).toMatchObject({ status: 'ready', renderProfile: { profile: PHONE_BOT, partial: false } });
  });
});

describe('audits record the tab overrides (the stamp)', () => {
  const CSS_OFF: TabOverrides = { ...DEFAULT_TAB_OVERRIDES, cssDisabled: true };
  const COOKIES_OFF: TabOverrides = { ...DEFAULT_TAB_OVERRIDES, cookiesDisabled: true };

  /** Loads `URL_A` in the active tab and lets its audit run to ready; answers the ready response. */
  async function audited() {
    load(views[0]!.contents, URL_A);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    extractions.shift()!(rawSnapshot(URL_A));
    await flush();
    return controller.seo.getAudit(activeId());
  }

  test('audit-stamps-emulation', async () => {
    controller.navigate(URL_A);
    controller.setRenderProfile(activeId(), PHONE_BOT);
    controller.tabOverrides.set(activeId(), CSS_OFF);
    await flush();
    const response = await audited();
    expect(response).toMatchObject({ status: 'ready', renderProfile: { profile: PHONE_BOT }, tabOverrides: CSS_OFF });
  });

  test('audit-stamps-emulation-with-no-profile', async () => {
    controller.navigate(URL_A);
    controller.tabOverrides.set(activeId(), COOKIES_OFF);
    await flush();
    const response = await audited();
    // A separate field: present without any profile.
    expect(response).toMatchObject({ status: 'ready', renderProfile: null, tabOverrides: COOKIES_OFF });
  });

  test('audit-profile-unchanged-by-stamp', async () => {
    controller.navigate(URL_A);
    controller.setRenderProfile(activeId(), PHONE_BOT);
    controller.tabOverrides.set(activeId(), { cssDisabled: true, cookiesDisabled: true, geolocation: { latitude: 1, longitude: 2, accuracy: 3 } });
    await flush();
    const response = await audited();
    // `AuditRenderProfile` is exactly the profile and its `partial`: the stamp is not in it.
    expect(response.status === 'ready' && response.renderProfile).toEqual({ profile: PHONE_BOT, partial: false });
    // The wrapper keeps the two apart: `profileOf` knows nothing of overrides.
    const extract = vi.fn(async () => ({ raw: true }));
    const profiles = withAuditProfiles({ extract, analyse: async (raw) => ({ ok: true, audit: { raw } }) as never }, () => null, () => CSS_OFF);
    const raw = await profiles.options.extract({} as never);
    const result = (await profiles.options.analyse(raw, undefined as never)) as unknown as { audit: object };
    expect(profiles.profileOf(result.audit)).toBeNull();
    expect(profiles.overridesOf(result.audit)).toEqual(CSS_OFF);
    // Unknown audits and a wrapper without an overrides reader: all off.
    expect(profiles.overridesOf({})).toEqual(DEFAULT_TAB_OVERRIDES);
    const plain = withAuditProfiles({ extract, analyse: async (r) => ({ ok: true, audit: { r } }) as never }, () => null);
    const second = (await plain.options.analyse(await plain.options.extract({} as never), undefined as never)) as unknown as { audit: object };
    expect(plain.overridesOf(second.audit)).toEqual(DEFAULT_TAB_OVERRIDES);
  });

  test('get-audit-carries-the-stamp', async () => {
    controller.navigate(URL_A);
    await flush();
    // Every audit this build takes carries one: all off here.
    const first = await audited();
    expect(first).toMatchObject({ status: 'ready', renderProfile: null, tabOverrides: DEFAULT_TAB_OVERRIDES });
    // Overrides turned on after the audit: the audit on screen keeps its own stamp (all off) …
    controller.tabOverrides.set(activeId(), CSS_OFF);
    expect(controller.seo.getAudit(activeId())).toMatchObject({ tabOverrides: DEFAULT_TAB_OVERRIDES });
    // … and the next audit carries the overrides it ran under, which stay with it once they are off.
    const second = await audited();
    expect(second).toMatchObject({ status: 'ready', tabOverrides: CSS_OFF });
    controller.tabOverrides.set(activeId(), DEFAULT_TAB_OVERRIDES);
    expect(controller.seo.getAudit(activeId())).toMatchObject({ tabOverrides: CSS_OFF });
    // Not ready: nothing to stamp.
    expect(controller.seo.getAudit(999)).not.toHaveProperty('tabOverrides');
  });
});
