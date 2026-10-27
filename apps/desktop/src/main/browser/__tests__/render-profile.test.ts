// Spec: specs/render-profile.spec.ts (DEVICE_PRESETS, USER_AGENT_TEMPLATES, NETWORK_PRESETS, RENDER_PROFILE_CDP_METHODS,
// NETWORK_ENABLE_PARAMS, CDP_PROTOCOL_VERSION, fitRenderViewport, RENDER_FRAME, MAX_RENDER_PROFILE_PINS, QUICK_RENDER_PROFILES),
// specs/render-profile.schema.spec.ts (RenderProfileSchema, TabRenderProfileSchema), RENDER_PROFILE_SESSION_METHODS,
// TARGET_AUTO_ATTACH_PARAMS, CHILD_RESUME_TIMEOUT_MS, TOP_LEVEL_ONLY_METHODS, WORKER_METHODS, clientHintsBrands
// Acceptance: specs/render-profile.feature.md
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BROWSE_PARTITION, BrowserStateSchema } from '@app/specs/browser.spec';
import {
  CDP_PROTOCOL_VERSION,
  CHILD_RESUME_TIMEOUT_MS,
  clientHintsBrands,
  isAllowedCdpCommand,
  TARGET_AUTO_ATTACH_PARAMS,
  TOP_LEVEL_ONLY_METHODS,
  WORKER_METHODS,
  DEFAULT_RENDER_PROFILE,
  DEVICE_PRESET_IDS,
  DEVICE_PRESETS,
  fitRenderViewport,
  isAllowedCdpMethod,
  MAX_CUSTOM_USER_AGENT_LENGTH,
  MAX_RENDER_PROFILE_PINS,
  NETWORK_ENABLE_PARAMS,
  NETWORK_PRESET_IDS,
  profileUserAgent,
  QUICK_RENDER_PROFILES,
  RENDER_FRAME,
  RENDER_PROFILE_CDP_METHODS,
  renderProfileSummary,
  USER_AGENT_IDS,
  type RenderProfile,
} from '@app/specs/render-profile.spec';
import { RenderProfileSchema } from '@app/specs/render-profile.schema.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent, fromPartition } from '../../../test/electron-fake';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';
import { renderProfileCommands, userAgentMetadata, type CdpCommand } from '../render-profile-cdp';
import { CdpMethodRefused, createProfileDebugger, type DebuggerHost, type ProfileDebugger } from '../render-profile-debugger';
import { createRenderProfilePins, type RenderProfilePins } from '../render-profile-pins';
import { createTabRenderProfiles } from '../render-profile';
import { createTab } from '../tab-model';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const VERSION = '140.0.7339.80';
const PHONE_BOT: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
const NO_JS: RenderProfile = { ...DEFAULT_RENDER_PROFILE, javascriptDisabled: true };

/** Lets every queued promise job run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('render-profile spec', () => {
  test('render-profile-spec-presets', () => {
    expect(DEVICE_PRESETS.phone).toMatchObject({ width: 412, mobile: true, touch: true });
    expect(DEVICE_PRESETS.tablet).toMatchObject({ mobile: true, touch: true });
    expect(DEVICE_PRESETS.desktop).toMatchObject({ mobile: false, touch: false });
    expect(RenderProfileSchema.parse(DEFAULT_RENDER_PROFILE)).toEqual(DEFAULT_RENDER_PROFILE);
    for (const quick of QUICK_RENDER_PROFILES) {
      expect(RenderProfileSchema.parse(quick.profile)).toEqual(quick.profile);
      expect(renderProfileSummary(quick.profile)).not.toBe('No overrides');
    }
    expect(renderProfileSummary(DEFAULT_RENDER_PROFILE)).toBe('No overrides');
    expect(renderProfileSummary({ ...PHONE_BOT, network: 'slow-3g', javascriptDisabled: true, cacheDisabled: true })).toBe('Phone 412×915 · Googlebot smartphone · Slow 3G · JavaScript off · Cache off');
  });

  test('custom-user-agent-is-capped', () => {
    const custom = (customUserAgent: string) => ({ ...DEFAULT_RENDER_PROFILE, userAgent: 'custom', customUserAgent });
    expect(RenderProfileSchema.safeParse(custom('x'.repeat(MAX_CUSTOM_USER_AGENT_LENGTH))).success).toBe(true);
    for (const bad of ['', '  ', 'x'.repeat(MAX_CUSTOM_USER_AGENT_LENGTH + 1), 'a\nb', 'tab\there', 'ünicode', 'bell\u0007']) expect(RenderProfileSchema.safeParse(custom(bad)).success, bad).toBe(false);
    // Only a custom user agent carries text.
    expect(RenderProfileSchema.safeParse({ ...DEFAULT_RENDER_PROFILE, customUserAgent: 'x' }).success).toBe(false);
  });

  test('user-agent-strings', () => {
    expect(profileUserAgent(DEFAULT_RENDER_PROFILE, VERSION)).toBeNull();
    expect(profileUserAgent(PHONE_BOT, VERSION)).toBe(
      `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${VERSION} Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`,
    );
    expect(profileUserAgent({ ...DEFAULT_RENDER_PROFILE, userAgent: 'googlebot-desktop' }, VERSION)).toContain(`Googlebot/2.1; +http://www.google.com/bot.html) Chrome/${VERSION} Safari`);
    expect(profileUserAgent({ ...DEFAULT_RENDER_PROFILE, userAgent: 'bingbot' }, VERSION)).toContain('bingbot/2.0');
    expect(profileUserAgent({ ...DEFAULT_RENDER_PROFILE, userAgent: 'mobile' }, VERSION)).toContain('Chrome/140.0.0.0 Mobile Safari');
    expect(profileUserAgent({ ...DEFAULT_RENDER_PROFILE, userAgent: 'custom', customUserAgent: '  MyBot/1.0  ' }, VERSION)).toBe('MyBot/1.0');
    // A malformed version never reaches a header.
    expect(profileUserAgent(PHONE_BOT, '140\r\nX: 1')).toContain('Chrome/0.0.0.0 Mobile');
    for (const id of USER_AGENT_IDS) {
      const ua = profileUserAgent({ ...DEFAULT_RENDER_PROFILE, userAgent: id, customUserAgent: id === 'custom' ? 'x' : '' }, VERSION);
      if (ua !== null) expect(ua).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  test('fit-keeps-device-width', () => {
    // Room for the phone: unscaled, centred under the frame's header, as tall as the device allows.
    const roomy = fitRenderViewport({ width: 1000, height: 1200 }, 'phone');
    expect(roomy.emulation).toEqual({ width: 412, height: 915, scale: 1 });
    expect(roomy.view).toEqual({ x: RENDER_FRAME.inset + Math.floor((1000 - 2 * RENDER_FRAME.inset - 412) / 2), y: RENDER_FRAME.header, width: 412, height: 915 });
    // A short page area: the viewport is as tall as the frame.
    expect(fitRenderViewport({ width: 1000, height: 600 }, 'phone').emulation).toEqual({ width: 412, height: 600 - RENDER_FRAME.header - RENDER_FRAME.inset, scale: 1 });
    // Too narrow: scaled down, the page still sees the device's width.
    const narrow = fitRenderViewport({ width: 300, height: 700 }, 'phone');
    expect(narrow.emulation!.width).toBe(412);
    expect(narrow.emulation!.scale).toBeCloseTo((300 - 2 * RENDER_FRAME.inset) / 412, 5);
    expect(narrow.view.width).toBeLessThanOrEqual(300 - 2 * RENDER_FRAME.inset);
    expect(narrow.view.height).toBeLessThanOrEqual(700 - RENDER_FRAME.header - RENDER_FRAME.inset);
    // Never scaled up; no device: the frame's inside.
    expect(fitRenderViewport({ width: 4000, height: 3000 }, 'desktop').emulation!.scale).toBe(1);
    expect(fitRenderViewport({ width: 800, height: 600 }, 'none')).toEqual({ view: { x: RENDER_FRAME.inset, y: RENDER_FRAME.header, width: 800 - 2 * RENDER_FRAME.inset, height: 600 - RENDER_FRAME.header - RENDER_FRAME.inset }, emulation: null });
    // A collapsed page area: nothing negative.
    for (const device of DEVICE_PRESET_IDS) {
      const { view, emulation } = fitRenderViewport({ width: 0, height: 0 }, device);
      for (const value of [view.x, view.y, view.width, view.height]) expect(value).toBeGreaterThanOrEqual(0);
      if (emulation) expect(emulation.height).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('cdp commands', () => {
  test('cdp-commands-for-profile', () => {
    const profile: RenderProfile = { ...PHONE_BOT, network: 'slow-3g', javascriptDisabled: true, cacheDisabled: true };
    const commands = renderProfileCommands(profile, { chromeVersion: VERSION, emulation: { width: 412, height: 700, scale: 0.8 } });
    expect(commands.map((c) => c.method)).toEqual([
      'Network.enable',
      'Network.setCacheDisabled',
      'Network.setUserAgentOverride',
      'Network.emulateNetworkConditions',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setScriptExecutionDisabled',
    ]);
    expect(commands[0]!.params).toEqual(NETWORK_ENABLE_PARAMS);
    expect(commands[1]!.params).toEqual({ cacheDisabled: true });
    const ua = commands[2]!.params as { userAgent: string; platform: string; userAgentMetadata: { mobile: boolean; platform: string; brands: { brand: string; version: string }[] } };
    expect(ua.userAgent).toContain('Googlebot/2.1');
    expect(ua.platform).toBe('Linux armv8l');
    expect(ua.userAgentMetadata).toMatchObject({ mobile: true, platform: 'Android', brands: clientHintsBrands(140, '140') });
    expect(commands[3]!.params).toEqual({ offline: false, latency: 2_000, downloadThroughput: 50_000, uploadThroughput: 50_000, connectionType: 'cellular3g' });
    expect(commands[4]!.params).toMatchObject({ width: 412, height: 700, scale: 0.8, deviceScaleFactor: 2.625, mobile: true, screenWidth: 412, screenHeight: 915 });
    expect(commands[5]!.params).toEqual({ enabled: true, maxTouchPoints: 5 });
    expect(commands[6]!.params).toEqual({ value: true });

    // The defaults undo everything an earlier profile set (frost's own user agent: an empty override).
    const reset = renderProfileCommands(DEFAULT_RENDER_PROFILE, { chromeVersion: VERSION });
    expect(reset).toEqual([
      { method: 'Network.setCacheDisabled', params: { cacheDisabled: false } },
      { method: 'Network.disable', params: {} },
      { method: 'Network.setUserAgentOverride', params: { userAgent: '' } },
      { method: 'Network.emulateNetworkConditions', params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } },
      { method: 'Emulation.clearDeviceMetricsOverride', params: {} },
      { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
      { method: 'Emulation.setScriptExecutionDisabled', params: { value: false } },
    ]);
    // A custom user agent: no client hints to derive.
    const custom = renderProfileCommands({ ...DEFAULT_RENDER_PROFILE, userAgent: 'custom', customUserAgent: 'MyBot/1.0' }, { chromeVersion: VERSION });
    expect(custom.find((c) => c.method === 'Network.setUserAgentOverride')!.params).toEqual({ userAgent: 'MyBot/1.0' });
    // Without a known page area the device's own size, unscaled.
    expect(renderProfileCommands(PHONE_BOT, { chromeVersion: VERSION }).find((c) => c.method === 'Emulation.setDeviceMetricsOverride')!.params).toMatchObject({ width: 412, height: 915, scale: 1 });
  });

  test('cdp-commands-are-allowlisted', () => {
    const seen = new Set<string>();
    for (const device of DEVICE_PRESET_IDS) {
      for (const userAgent of USER_AGENT_IDS) {
        for (const network of NETWORK_PRESET_IDS) {
          for (const javascriptDisabled of [false, true]) {
            for (const cacheDisabled of [false, true]) {
              const profile: RenderProfile = { device, userAgent, customUserAgent: userAgent === 'custom' ? 'x' : '', network, javascriptDisabled, cacheDisabled };
              for (const command of renderProfileCommands(profile, { chromeVersion: VERSION })) {
                expect(isAllowedCdpMethod(command.method), command.method).toBe(true);
                seen.add(command.method);
              }
            }
          }
        }
      }
    }
    // The allowlist is exactly what the builder needs: nothing observes the page.
    expect([...seen].sort()).toEqual([...RENDER_PROFILE_CDP_METHODS].sort());
    for (const method of RENDER_PROFILE_CDP_METHODS) expect(method).toMatch(/^(Emulation|Network)\./);
    for (const refused of ['Runtime.evaluate', 'Runtime.enable', 'Debugger.enable', 'Page.navigate', 'Network.getResponseBody', 'Network.getCookies', 'Emulation', 'network.enable', 'Network.enable ', undefined, 42]) {
      expect(isAllowedCdpMethod(refused), String(refused)).toBe(false);
    }
  });
});

/** A WebContents' `debugger` as Electron exposes it, recording what is done to it (with flat sessions). */
class FakeDebugger extends EventEmitter {
  attached = false;
  attach = vi.fn((_version?: string) => {
    if (this.attached) throw new Error('Debugger is already attached to the target');
    this.attached = true;
  });
  detach = vi.fn(() => {
    this.attached = false;
  });
  isAttached = () => this.attached;
  sendCommand = vi.fn(async (_method: string, _params?: object, _sessionId?: string): Promise<unknown> => ({}));
  /** The commands sent to `sessionId` (`''`: the tab itself), as `method` names. */
  sentTo(sessionId: string): string[] {
    return this.sendCommand.mock.calls.filter(([, , sid]) => (sid ?? '') === sessionId).map(([method]) => method);
  }
  /** Announces a child target, as Chromium does once auto-attach is on. */
  announce(sessionId: string, type: string, waitingForDebugger = true, parent = ''): void {
    this.emit('message', {}, 'Target.attachedToTarget', { sessionId, targetInfo: { type, url: '' }, waitingForDebugger }, parent);
  }
}

function debuggerHost(session: unknown = fromPartition(BROWSE_PARTITION)): { host: DebuggerHost; dbg: FakeDebugger; destroy(): void } {
  const dbg = new FakeDebugger();
  let destroyed = false;
  return { host: { debugger: dbg as unknown as DebuggerHost['debugger'], session: session as DebuggerHost['session'], isDestroyed: () => destroyed }, dbg, destroy: () => (destroyed = true) };
}

const PROFILE_METHODS = (profile: RenderProfile) => renderProfileCommands(profile, { chromeVersion: VERSION }).map((c) => c.method);

describe('render-profile debugger', () => {
  test('debugger-refuses-unlisted-method', async () => {
    const { host, dbg } = debuggerHost();
    const detached = vi.fn();
    const profileDebugger = createProfileDebugger(host, detached);
    expect(dbg.attach).not.toHaveBeenCalled();
    // One unlisted method refuses the whole batch, before anything reaches the debugger; the session
    // methods are never part of a profile either.
    for (const method of ['Runtime.evaluate', 'Debugger.enable', 'Page.reload', 'Runtime.runIfWaitingForDebugger', 'Target.setAutoAttach']) {
      expect(() => profileDebugger.send([{ method: 'Network.disable', params: {} }, { method, params: {} } as unknown as CdpCommand])).toThrow(CdpMethodRefused);
      expect(() => profileDebugger.sendTopLevel([{ method, params: {} } as unknown as CdpCommand])).toThrow(CdpMethodRefused);
    }
    expect(dbg.attach).not.toHaveBeenCalled();
    expect(dbg.sendCommand).not.toHaveBeenCalled();
    // Allowlisted commands: attached once (protocol 1.3), every one dispatched at once, in order,
    // before any has answered; then auto-attach for the tab's cross-site frames.
    const commands = renderProfileCommands(PHONE_BOT, { chromeVersion: VERSION });
    let answer: () => void = () => undefined;
    dbg.sendCommand.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve({}))));
    const answered = profileDebugger.send(commands);
    expect(dbg.sendCommand).toHaveBeenCalledTimes(commands.length + 1);
    expect(dbg.sendCommand).toHaveBeenLastCalledWith('Target.setAutoAttach', TARGET_AUTO_ATTACH_PARAMS);
    let settled = false;
    void answered.then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    answer();
    await answered;
    // Auto-attach is turned on once per attach; a refit goes to the tab only.
    await profileDebugger.send(commands.slice(0, 1));
    await profileDebugger.sendTopLevel(commands.slice(0, 1));
    expect(dbg.attach).toHaveBeenCalledExactlyOnceWith(CDP_PROTOCOL_VERSION);
    expect(dbg.sentTo('')).toEqual([...commands.map((c) => c.method), 'Target.setAutoAttach', commands[0]!.method, commands[0]!.method]);
    expect(profileDebugger.isAttached()).toBe(true);
  });

  test('debugger-refuses-non-browse-contents', () => {
    // The app's own window, a WebContents on another partition: never a debugger.
    for (const session of [fromPartition('persist:other'), fromPartition('persist:frost-app'), {}, null]) {
      const { host, dbg } = debuggerHost(session);
      expect(() => createProfileDebugger(host, vi.fn())).toThrow('browse-session tabs only');
      expect(dbg.attach).not.toHaveBeenCalled();
      expect(dbg.listenerCount('detach')).toBe(0);
    }
    expect(() => createProfileDebugger(debuggerHost().host, vi.fn())).not.toThrow();
  });

  test('session-methods-are-restricted', () => {
    expect(isAllowedCdpCommand('Target.setAutoAttach', TARGET_AUTO_ATTACH_PARAMS, 'top')).toBe(true);
    expect(isAllowedCdpCommand('Target.setAutoAttach', TARGET_AUTO_ATTACH_PARAMS, 'child')).toBe(true);
    expect(isAllowedCdpCommand('Target.setAutoAttach', { ...TARGET_AUTO_ATTACH_PARAMS, waitForDebuggerOnStart: false }, 'top')).toBe(false);
    expect(isAllowedCdpCommand('Target.setAutoAttach', { ...TARGET_AUTO_ATTACH_PARAMS, filter: [{ type: 'browser' }] }, 'top')).toBe(false);
    expect(isAllowedCdpCommand('Target.setAutoAttach', null, 'top')).toBe(false);
    expect(isAllowedCdpCommand('Runtime.runIfWaitingForDebugger', {}, 'child')).toBe(true);
    expect(isAllowedCdpCommand('Runtime.runIfWaitingForDebugger', {}, 'top')).toBe(false);
    expect(isAllowedCdpCommand('Runtime.runIfWaitingForDebugger', { x: 1 }, 'child')).toBe(false);
    for (const method of ['Runtime.enable', 'Runtime.evaluate', 'Target.attachToTarget', 'Target.createTarget', 'Target.setDiscoverTargets']) expect(isAllowedCdpCommand(method, {}, 'child'), method).toBe(false);
    expect(isAllowedCdpCommand('Network.setCacheDisabled', { cacheDisabled: true }, 'child')).toBe(true);
  });

  test('debugger-attaches-lazily-and-detaches', async () => {
    const { host, dbg, destroy } = debuggerHost();
    const detached = vi.fn();
    const profileDebugger = createProfileDebugger(host, detached);
    await profileDebugger.send([{ method: 'Network.disable', params: {} }]);
    // frost's own detach is not reported; one Chromium did is.
    profileDebugger.detach();
    expect(dbg.detach).toHaveBeenCalledTimes(1);
    expect(detached).not.toHaveBeenCalled();
    dbg.emit('detach', {}, 'target closed');
    expect(detached).toHaveBeenCalledExactlyOnceWith('target closed');
    // Disposed: detached, and no longer listening.
    await profileDebugger.send([{ method: 'Network.disable', params: {} }]);
    profileDebugger.dispose();
    expect(dbg.attached).toBe(false);
    expect(dbg.listenerCount('detach')).toBe(0);
    expect(dbg.listenerCount('message')).toBe(0);
    expect(() => profileDebugger.send([{ method: 'Network.disable', params: {} }])).toThrow();
    // A destroyed WebContents is never touched.
    const other = debuggerHost();
    const gone = createProfileDebugger(other.host, vi.fn());
    other.destroy();
    expect(() => gone.send([{ method: 'Network.disable', params: {} }])).toThrow('tab is gone');
    expect(other.dbg.attach).not.toHaveBeenCalled();
    // A failed command fails the batch.
    const failing = debuggerHost();
    failing.dbg.sendCommand.mockRejectedValueOnce(new Error('refused'));
    await expect(createProfileDebugger(failing.host, vi.fn()).send([{ method: 'Network.disable', params: {} }])).rejects.toThrow('refused');
    void destroy;
  });

  test('child-frames-get-the-profile', async () => {
    const { host, dbg } = debuggerHost();
    const profileDebugger = createProfileDebugger(host, vi.fn());
    const commands = renderProfileCommands({ ...PHONE_BOT, javascriptDisabled: true }, { chromeVersion: VERSION });
    await profileDebugger.send(commands);
    // A cross-site frame, announced paused: every profile command but the viewport, auto-attach for
    // its own cross-site frames, then (once they answered) it is resumed.
    dbg.announce('frame-1', 'iframe');
    const frameMethods = commands.map((c) => c.method).filter((m) => !(TOP_LEVEL_ONLY_METHODS as readonly string[]).includes(m));
    expect(dbg.sentTo('frame-1')).toEqual([...frameMethods, 'Target.setAutoAttach']);
    await settle();
    expect(dbg.sentTo('frame-1').at(-1)).toBe('Runtime.runIfWaitingForDebugger');
    // A frame nested in it is announced on its session and handled the same way.
    dbg.announce('frame-2', 'iframe', true, 'frame-1');
    await settle();
    expect(dbg.sentTo('frame-2')).toEqual([...frameMethods, 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
    // A dedicated worker: the user agent and the cache switch only.
    dbg.announce('worker-1', 'worker', true, 'frame-1');
    await settle();
    expect(dbg.sentTo('worker-1')).toEqual([...commands.map((c) => c.method).filter((m) => (WORKER_METHODS as readonly string[]).includes(m)), 'Runtime.runIfWaitingForDebugger']);
    // A child that was already running is not resumed (it never waited); anything else is only resumed.
    dbg.announce('frame-3', 'iframe', false);
    dbg.announce('other-1', 'shared_worker', true);
    await settle();
    expect(dbg.sentTo('frame-3')).toEqual([...frameMethods, 'Target.setAutoAttach']);
    expect(dbg.sentTo('other-1')).toEqual(['Runtime.runIfWaitingForDebugger']);
    // A child's failure never fails the tab's profile.
    dbg.sendCommand.mockImplementation(async (_m, _p, sid) => {
      if (sid) throw new Error('child refused');
      return {};
    });
    await expect(profileDebugger.send(commands)).resolves.toBeUndefined();
  });

  test('child-resumes-after-answers-or-timeout', async () => {
    vi.useFakeTimers();
    try {
      const { host, dbg } = debuggerHost();
      const profileDebugger = createProfileDebugger(host, vi.fn());
      await profileDebugger.send(renderProfileCommands(PHONE_BOT, { chromeVersion: VERSION }));
      // One of the child's commands never answers: it is not resumed early (that could leave it
      // paused for good), but at `CHILD_RESUME_TIMEOUT_MS`, once.
      dbg.sendCommand.mockImplementation(async (method, _p, sid) => (sid === 'stuck' && method === 'Network.setUserAgentOverride' ? new Promise(() => undefined) : {}));
      dbg.announce('stuck', 'iframe');
      await vi.advanceTimersByTimeAsync(CHILD_RESUME_TIMEOUT_MS - 1);
      expect(dbg.sentTo('stuck')).not.toContain('Runtime.runIfWaitingForDebugger');
      await vi.advanceTimersByTimeAsync(1);
      expect(dbg.sentTo('stuck').filter((m) => m === 'Runtime.runIfWaitingForDebugger')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(CHILD_RESUME_TIMEOUT_MS * 5);
      expect(dbg.sentTo('stuck').filter((m) => m === 'Runtime.runIfWaitingForDebugger')).toHaveLength(1);
      // A child whose dispatch throws (the tab is going) is still resumed at the deadline.
      dbg.sendCommand.mockImplementation((method, _p, sid) => {
        if (sid === 'broken' && method !== 'Runtime.runIfWaitingForDebugger') throw new Error('gone');
        return Promise.resolve({});
      });
      dbg.announce('broken', 'iframe');
      await vi.advanceTimersByTimeAsync(CHILD_RESUME_TIMEOUT_MS);
      expect(dbg.sentTo('broken').filter((m) => m === 'Runtime.runIfWaitingForDebugger')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('profile-change-reaches-children', async () => {
    const { host, dbg } = debuggerHost();
    const profileDebugger = createProfileDebugger(host, vi.fn());
    await profileDebugger.send(renderProfileCommands(PHONE_BOT, { chromeVersion: VERSION }));
    dbg.announce('frame-1', 'iframe');
    dbg.announce('frame-2', 'iframe');
    await settle();
    dbg.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'frame-2' }, '');
    dbg.sendCommand.mockClear();
    // The new profile reaches the tab and each live child (no resume: they run already).
    await profileDebugger.send(renderProfileCommands(NO_JS, { chromeVersion: VERSION }));
    expect(dbg.sentTo('frame-1')).toEqual(PROFILE_METHODS(NO_JS).filter((m) => !(TOP_LEVEL_ONLY_METHODS as readonly string[]).includes(m)));
    expect(dbg.sentTo('frame-2')).toEqual([]);
    // A refit of the viewport is for the tab alone; other protocol events are ignored.
    dbg.sendCommand.mockClear();
    dbg.emit('message', {}, 'Network.requestWillBeSent', { requestId: '1' }, 'frame-1');
    await profileDebugger.sendTopLevel([{ method: 'Emulation.clearDeviceMetricsOverride', params: {} }]);
    expect(dbg.sentTo('frame-1')).toEqual([]);
    // Detached: its children are forgotten; a stray announcement from a session frost no longer
    // has is not resumed.
    profileDebugger.detach();
    dbg.sendCommand.mockClear();
    dbg.announce('late', 'iframe');
    await settle();
    expect(dbg.sendCommand).not.toHaveBeenCalled();
  });
});

describe('client hints', () => {
  test('client-hints-grease', () => {
    // As the engine reports it (Electron 45 / Chromium 156: GREASE first, `Not:A-Brand` 8).
    expect(clientHintsBrands(156, '156')).toEqual([
      { brand: 'Not:A-Brand', version: '8' },
      { brand: 'Chromium', version: '156' },
    ]);
    expect(clientHintsBrands(157, '157')).toEqual([
      { brand: 'Chromium', version: '157' },
      { brand: 'Not-A.Brand', version: '99' },
    ]);
    expect(clientHintsBrands(140, '140.0.7339.80', true)).toEqual([
      { brand: 'Not=A?Brand', version: '24.0.0.0' },
      { brand: 'Chromium', version: '140.0.7339.80' },
    ]);
    const metadata = userAgentMetadata(PHONE_BOT, VERSION) as { brands: unknown; fullVersionList: unknown };
    expect(metadata.brands).toEqual(clientHintsBrands(140, '140'));
    expect(metadata.fullVersionList).toEqual(clientHintsBrands(140, VERSION, true));
  });
});

describe('render-profile pins', () => {
  test('pins-in-memory', () => {
    const save = vi.fn();
    const remove = vi.fn();
    const pins = createRenderProfilePins({ save, remove });
    pins.set('https://a.example', PHONE_BOT);
    expect(pins.get('https://a.example')).toEqual(PHONE_BOT);
    expect(pins.get(null)).toBeNull();
    expect(save).toHaveBeenCalledExactlyOnceWith('https://a.example', PHONE_BOT);
    pins.remove('https://b.example');
    expect(remove).not.toHaveBeenCalled();
    pins.remove('https://a.example');
    expect(remove).toHaveBeenCalledExactlyOnceWith('https://a.example');
    // Loaded pins come first; one set meanwhile stays the newest. The cap drops the oldest.
    pins.set('https://new.example', NO_JS);
    pins.load(Array.from({ length: MAX_RENDER_PROFILE_PINS }, (_, i) => ({ origin: `https://s${i}.example`, profile: PHONE_BOT })));
    expect(pins.get('https://new.example')).toEqual(NO_JS);
    expect(pins.get('https://s0.example')).toBeNull();
    expect(pins.get('https://s1.example')).toEqual(PHONE_BOT);
    pins.forget();
    expect(pins.get('https://new.example')).toBeNull();
  });
});

/** A tab's render-profile debugger as the controller sees it, recording each batch sent. */
class FakeProfileDebugger implements ProfileDebugger {
  attached = false;
  sent: CdpCommand[][] = [];
  hold = false;
  private waiting: (() => void)[] = [];
  constructor(readonly detached: (reason: string) => void) {}
  send = vi.fn(async (commands: readonly CdpCommand[]) => {
    this.attached = true;
    this.sent.push([...commands]);
    if (this.hold) await new Promise<void>((resolve) => this.waiting.push(resolve));
  });
  sendTopLevel = vi.fn(async (commands: readonly CdpCommand[]) => {
    this.sent.push([...commands]);
  });
  detach = vi.fn(() => {
    this.attached = false;
  });
  isAttached = () => this.attached;
  dispose = vi.fn(() => {
    this.attached = false;
  });
  release(): void {
    this.hold = false;
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

describe('render profiles in the controller', () => {
  let views: FakeTabView[];
  let win: FakeHostWindow;
  let controller: BrowserController;
  let pins: RenderProfilePins;
  let debuggers: Map<FakeTabContents, FakeProfileDebugger>;
  let pinWrites: ReturnType<typeof vi.fn<(origin: string, profile: RenderProfile) => void>>;
  let pinRemovals: ReturnType<typeof vi.fn<(origin: string) => void>>;

  beforeEach(() => {
    views = [];
    debuggers = new Map();
    win = new FakeHostWindow();
    pinWrites = vi.fn<(origin: string, profile: RenderProfile) => void>();
    pinRemovals = vi.fn<(origin: string) => void>();
    pins = createRenderProfilePins({ save: pinWrites, remove: pinRemovals });
    controller = createBrowserController({
      createView: () => {
        const created = new FakeTabView();
        views.push(created);
        return created as unknown as TabView;
      },
      platform: 'linux',
      renderProfiles: {
        pins,
        chromeVersion: VERSION,
        debuggerFor: (contents, detached) => {
          const dbg = new FakeProfileDebugger(detached);
          debuggers.set(contents as unknown as FakeTabContents, dbg);
          return dbg;
        },
      },
    });
    controller.attach(win as unknown as HostWindow);
    controller.setPageBounds({ x: 0, y: 90, width: 1000, height: 700 });
  });

  /** Starts and commits a main-frame navigation of `contents` to `url`, as Electron reports it. */
  const navigateTo = (contents: FakeTabContents, url: string): void => {
    contents.emit('did-start-navigation', fakeEvent({ url, isMainFrame: true, isSameDocument: false }));
    commit(contents, url, 'Page');
  };
  const tabState = (id: number) => controller.getState().tabs.find((t) => t.id === id)!;
  const activeId = () => controller.getState().activeTabId!;

  /** The active tab showing `url` (navigated from the address bar and committed). */
  async function openAt(url: string): Promise<{ id: number; contents: FakeTabContents }> {
    controller.navigate(url);
    await settle();
    const contents = views.at(-1)!.contents;
    navigateTo(contents, url);
    return { id: activeId(), contents };
  }

  test('profile-scoped-to-tab', async () => {
    const first = await openAt('https://a.example/');
    controller.newTab();
    const second = await openAt('https://b.example/');
    expect(controller.setRenderProfile(first.id, PHONE_BOT, false)).toBe(true);
    await settle();
    expect(tabState(first.id).renderProfile).toMatchObject({ profile: PHONE_BOT, source: 'tab', pinned: false, status: 'active' });
    expect(tabState(second.id).renderProfile).toBeNull();
    expect(BrowserStateSchema.parse(controller.getState())).toEqual(controller.getState());
    // Only the profiled tab ever got a debugger.
    expect([...debuggers.keys()]).toEqual([first.contents]);
    expect(debuggers.get(first.contents)!.sent[0]!.map((c) => c.method)).toContain('Network.setUserAgentOverride');
    // Closing the tab drops its profile and its debugger.
    controller.closeTab(first.id);
    expect(debuggers.get(first.contents)!.dispose).toHaveBeenCalled();
    expect(controller.getState().tabs.every((t) => t.renderProfile === null)).toBe(true);
    // Unknown ids are no-ops.
    expect(controller.setRenderProfile(999, PHONE_BOT, false)).toBe(false);
    expect(controller.clearRenderProfile(999)).toBe(false);
  });

  test('reload-to-apply', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.setRenderProfile(id, NO_JS, false);
    await settle();
    // The page on screen loaded without it.
    expect(tabState(id).renderProfile).toMatchObject({ needsReload: true, status: 'active' });
    navigateTo(contents, 'https://a.example/');
    expect(tabState(id).renderProfile!.needsReload).toBe(false);
    // A change while a navigation is under way: that document needs another reload.
    contents.emit('did-start-navigation', fakeEvent({ url: 'https://a.example/next', isMainFrame: true, isSameDocument: false }));
    controller.setRenderProfile(id, PHONE_BOT, false);
    await settle();
    commit(contents, 'https://a.example/next', 'Next');
    expect(tabState(id).renderProfile!.needsReload).toBe(true);
  });

  test('load-carries-profile', async () => {
    // A profile set on an empty tab is dispatched when its view comes, before the first load starts.
    const id = activeId();
    expect(controller.setRenderProfile(id, PHONE_BOT, false)).toBe(true);
    expect(tabState(id).renderProfile).toMatchObject({ status: 'applying', needsReload: false });
    controller.navigate('https://a.example/');
    const contents = views[0]!.contents;
    const dbg = debuggers.get(contents)!;
    expect(dbg.send).toHaveBeenCalledTimes(1);
    expect(contents.loadURL).toHaveBeenCalledExactlyOnceWith('https://a.example/');
    expect(dbg.send.mock.invocationCallOrder[0]!).toBeLessThan(contents.loadURL.mock.invocationCallOrder[0]!);
    navigateTo(contents, 'https://a.example/');
    await settle();
    expect(tabState(id).renderProfile).toMatchObject({ status: 'active', needsReload: false });
  });

  test('load-never-waits-for-answers', async () => {
    // A fresh tab answers renderer-side commands only once its first load made a renderer: the load
    // never waits for them, and the profile is `applying` until they answer.
    const { id, contents } = await openAt('https://a.example/');
    controller.setRenderProfile(id, PHONE_BOT, false);
    const dbg = debuggers.get(contents)!;
    await settle();
    dbg.hold = true;
    controller.setRenderProfile(id, NO_JS, false);
    controller.navigate('https://b.example/');
    expect(contents.loadURL).toHaveBeenCalledTimes(2);
    navigateTo(contents, 'https://b.example/');
    expect(tabState(id).renderProfile).toMatchObject({ status: 'applying', needsReload: false });
    dbg.release();
    await settle();
    expect(tabState(id).renderProfile).toMatchObject({ status: 'active', needsReload: false });
  });

  test('profile-persists-cross-origin', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.setRenderProfile(id, PHONE_BOT, false);
    await settle();
    const dbg = debuggers.get(contents)!;
    const batches = dbg.sent.length;
    navigateTo(contents, 'https://other.example/x');
    contents.emit('did-redirect-navigation', fakeEvent({ url: 'https://third.example/', isMainFrame: true }));
    await settle();
    expect(tabState(id).renderProfile).toMatchObject({ profile: PHONE_BOT, source: 'tab', needsReload: false });
    expect(dbg.sent.length).toBe(batches);
    expect(dbg.detach).not.toHaveBeenCalled();
  });

  test('pin-applies-by-origin', async () => {
    const first = await openAt('https://a.example/one');
    expect(controller.setRenderProfile(first.id, PHONE_BOT, true)).toBe(true);
    await settle();
    expect(pinWrites).toHaveBeenCalledExactlyOnceWith('https://a.example', PHONE_BOT);
    expect(tabState(first.id).renderProfile).toMatchObject({ source: 'site', pinned: true });
    // Another tab takes the pin when it loads the site, before its first request.
    controller.newTab();
    const second = await openAt('https://a.example/two');
    const dbg = debuggers.get(second.contents)!;
    expect(dbg.send.mock.invocationCallOrder[0]!).toBeLessThan(second.contents.loadURL.mock.invocationCallOrder[0]!);
    expect(tabState(second.id).renderProfile).toMatchObject({ source: 'site', pinned: true, needsReload: false });
    // Leaving the site drops it; a tab's own profile wins over the pin.
    navigateTo(second.contents, 'https://b.example/');
    await settle();
    expect(tabState(second.id).renderProfile).toBeNull();
    expect(dbg.detach).toHaveBeenCalled();
    controller.setRenderProfile(second.id, NO_JS, false);
    navigateTo(second.contents, 'https://a.example/three');
    await settle();
    expect(tabState(second.id).renderProfile).toMatchObject({ profile: NO_JS, source: 'tab', pinned: false });
    // No pin without a site.
    controller.newTab();
    expect(controller.setRenderProfile(activeId(), PHONE_BOT, true)).toBe(false);
  });

  test('reset-clears-pin', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.setRenderProfile(id, PHONE_BOT, true);
    await settle();
    navigateTo(contents, 'https://a.example/');
    expect(controller.clearRenderProfile(id)).toBe(true);
    await settle();
    expect(pinRemovals).toHaveBeenCalledExactlyOnceWith('https://a.example');
    expect(pins.get('https://a.example')).toBeNull();
    expect(tabState(id).renderProfile).toBeNull();
    // Detached (every override gone), then the page loaded under the profile loads again.
    const dbg = debuggers.get(contents)!;
    expect(dbg.detach).toHaveBeenCalled();
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(dbg.detach.mock.invocationCallOrder.at(-1)!).toBeLessThan(contents.reload.mock.invocationCallOrder[0]!);
    expect(controller.clearRenderProfile(id)).toBe(false);
    // Setting the default profile is a Reset too.
    controller.setRenderProfile(id, NO_JS, false);
    expect(controller.setRenderProfile(id, DEFAULT_RENDER_PROFILE, false)).toBe(true);
    expect(tabState(id).renderProfile).toBeNull();
  });

  test('popup-inherits-tab-profile', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.setRenderProfile(id, PHONE_BOT, false);
    await settle();
    const popupId = controller.openTabFromPage(contents, 'https://b.example/')!;
    await settle();
    const popup = views.at(-1)!.contents;
    expect(tabState(popupId).renderProfile).toMatchObject({ profile: PHONE_BOT, source: 'tab' });
    expect(debuggers.get(popup)!.send.mock.invocationCallOrder[0]!).toBeLessThan(popup.loadURL.mock.invocationCallOrder[0]!);
    // A pin is not inherited: the new tab's own site decides.
    const pinned = await (async () => {
      controller.newTab();
      return openAt('https://c.example/');
    })();
    controller.setRenderProfile(pinned.id, NO_JS, true);
    const child = controller.openTabFromPage(pinned.contents, 'https://d.example/')!;
    await settle();
    expect(tabState(child).renderProfile).toBeNull();
  });

  test('pin-committed-origin', async () => {
    // A navigation to another site is under way: the pin is for the page the tab shows.
    const { id, contents } = await openAt('https://a.example/');
    contents.emit('did-start-navigation', fakeEvent({ url: 'https://b.example/', isMainFrame: true, isSameDocument: false }));
    expect(controller.setRenderProfile(id, PHONE_BOT, true)).toBe(true);
    expect(pinWrites).toHaveBeenCalledExactlyOnceWith('https://a.example', PHONE_BOT);
    expect(pins.get('https://b.example')).toBeNull();
    // Unpinning, too, is about the page shown.
    contents.emit('did-start-navigation', fakeEvent({ url: 'https://b.example/', isMainFrame: true, isSameDocument: false }));
    controller.setRenderProfile(id, NO_JS, false);
    expect(pinRemovals).toHaveBeenCalledExactlyOnceWith('https://a.example');
  });

  test('quick-profile-keeps-site-pin', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.setRenderProfile(id, PHONE_BOT, true);
    // `pin` left out (a quick chip, the palette): the tab's own profile, the site's pin kept.
    expect(controller.setRenderProfile(id, NO_JS)).toBe(true);
    expect(pinRemovals).not.toHaveBeenCalled();
    expect(pins.get('https://a.example')).toEqual(PHONE_BOT);
    expect(tabState(id).renderProfile).toMatchObject({ profile: NO_JS, source: 'tab', pinned: false });
    // Another tab on the site still gets the pin.
    controller.newTab();
    const other = await openAt('https://a.example/x');
    expect(tabState(other.id).renderProfile).toMatchObject({ profile: PHONE_BOT, source: 'site', pinned: true });
    void contents;
  });

  test('forgotten-pins-stay-forgotten', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.setRenderProfile(id, PHONE_BOT, true);
    navigateTo(contents, 'https://b.example/');
    expect(tabState(id).renderProfile).toBeNull();
    // Clear Browsing Data: the pin is gone from memory too, so the site comes back unemulated.
    controller.forgetRenderProfilePins();
    navigateTo(contents, 'https://a.example/again');
    expect(tabState(id).renderProfile).toBeNull();
    controller.newTab();
    const other = await openAt('https://a.example/');
    expect(tabState(other.id).renderProfile).toBeNull();
    expect(debuggers.get(other.contents)).toBeUndefined();
  });

  test('tools-do-not-inherit', async () => {
    const { id } = await openAt('https://a.example/');
    controller.setRenderProfile(id, PHONE_BOT, false);
    // A tool, help page, robots.txt or sitemap (`inherit` left out or false): frost's defaults.
    const tool = controller.openBackgroundTab('https://validator.example/?url=x')!;
    const robots = controller.openBackgroundTab('https://a.example/robots.txt', false)!;
    await settle();
    expect(tabState(tool).renderProfile).toBeNull();
    expect(tabState(robots).renderProfile).toBeNull();
    // A page the sidebar opens from the audited page: the opener's own profile.
    const page = controller.openBackgroundTab('https://a.example/linked', true)!;
    await settle();
    expect(tabState(page).renderProfile).toMatchObject({ profile: PHONE_BOT, source: 'tab' });
  });

  test('unexpected-detach-reattaches-once', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.setRenderProfile(id, PHONE_BOT, false);
    await settle();
    const dbg = debuggers.get(contents)!;
    dbg.detached('target closed');
    await settle();
    expect(dbg.sent).toHaveLength(2);
    expect(tabState(id).renderProfile!.status).toBe('active');
    dbg.detached('target closed');
    await settle();
    expect(dbg.sent).toHaveLength(2);
    expect(tabState(id).renderProfile!.status).toBe('failed');
  });

  test('apply-failure-is-visible', async () => {
    const { id, contents } = await openAt('https://a.example/');
    controller.setRenderProfile(id, NO_JS, false);
    await settle();
    const dbg = debuggers.get(contents)!;
    dbg.send.mockRejectedValueOnce(new Error('refused'));
    controller.setRenderProfile(id, PHONE_BOT, false);
    await settle();
    expect(tabState(id).renderProfile!.status).toBe('failed');
  });

  test('view-in-frame', async () => {
    const { id } = await openAt('https://a.example/');
    const view = views[0]!;
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 90, width: 1000, height: 700 });
    controller.setRenderProfile(id, PHONE_BOT, false);
    await settle();
    const fit = fitRenderViewport({ width: 1000, height: 700 }, 'phone');
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: fit.view.x, y: 90 + fit.view.y, width: fit.view.width, height: fit.view.height });
    // The page area shrinks: the emulated viewport follows.
    controller.setPageBounds({ x: 0, y: 90, width: 300, height: 500 });
    await settle();
    const dbg = debuggers.get(views[0]!.contents)!;
    const metrics = dbg.sent.at(-1)!;
    expect(metrics).toEqual([{ method: 'Emulation.setDeviceMetricsOverride', params: expect.objectContaining({ width: 412, scale: fitRenderViewport({ width: 300, height: 500 }, 'phone').emulation!.scale }) }]);
    controller.clearRenderProfile(id);
    await settle();
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 90, width: 300, height: 500 });
  });
});

describe('audits record the profile', () => {
  test('audit-records-profile', async () => {
    const pins = createRenderProfilePins();
    const changed = vi.fn();
    const profiles = createTabRenderProfiles({ pins, chromeVersion: VERSION, debuggerFor: (_c, detached) => new FakeProfileDebugger(detached) }, { changed, pageArea: () => null });
    const tab = createTab(1);
    const view = new FakeTabView();
    profiles.wire(tab, view as unknown as TabView);
    view.contents.emit('did-start-navigation', fakeEvent({ url: 'https://a.example/', isMainFrame: true, isSameDocument: false }));
    view.contents.emit('did-navigate', fakeEvent(), 'https://a.example/');
    // What a run starting now runs under (kept with that run: `held-audit-keeps-its-profile`).
    expect(profiles.auditProfile(tab)).toBeNull();
    profiles.set(tab, PHONE_BOT, false);
    await settle();
    // Set after the page loaded: partial.
    expect(profiles.auditProfile(tab)).toEqual({ profile: PHONE_BOT, partial: true });
    view.contents.emit('did-start-navigation', fakeEvent({ url: 'https://a.example/', isMainFrame: true, isSameDocument: false }));
    view.contents.emit('did-navigate', fakeEvent(), 'https://a.example/');
    expect(profiles.auditProfile(tab)).toEqual({ profile: PHONE_BOT, partial: false });
  });
});
