// Spec: specs/render-profile.spec.ts (AuditRenderProfile, DEFAULT_RENDER_PROFILE), specs/seo-limits.spec.ts (AUDIT_DEBOUNCE_MS)
// Acceptance: specs/render-profile.feature.md (Recorded with audits)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from '@app/specs/render-profile.spec';
import { AUDIT_DEBOUNCE_MS } from '@app/specs/seo-limits.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { rawSnapshot } from '../../../test/seo-fakes';
import { analyseSnapshot } from '../../seo/analyse';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';
import type { ProfileDebugger } from '../render-profile-debugger';
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
