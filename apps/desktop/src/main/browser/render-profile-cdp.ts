import {
  DEVICE_PRESETS,
  NETWORK_ENABLE_PARAMS,
  NETWORK_PRESETS,
  TOUCH_POINTS,
  USER_AGENT_PLATFORMS,
  CLIENT_HINTS_BRAND,
  normalChromeVersion,
  profileUserAgent,
  type RenderFit,
  type RenderProfile,
  type RenderProfileCdpMethod,
} from '@app/specs/render-profile.spec';

// The CDP commands that put a render profile into effect (spec `render-profile.feature.md`, How it
// is applied). Pure: it builds the list; `render-profile-debugger.ts` checks each method against
// `RENDER_PROFILE_CDP_METHODS` and sends it. A profile is always sent whole, so the commands for one
// profile replace whatever an earlier one set.

export interface CdpCommand {
  readonly method: RenderProfileCdpMethod;
  readonly params: Readonly<Record<string, unknown>>;
}

/** The emulated viewport when the page area is not known yet: the device's own size, unscaled. */
function unscaled(profile: RenderProfile): RenderFit['emulation'] {
  if (profile.device === 'none') return null;
  const preset = DEVICE_PRESETS[profile.device];
  return { width: preset.width, height: preset.height, scale: 1 };
}

/** `Emulation.setDeviceMetricsOverride` for `profile` at `emulation`, or the clear without a device. */
export function deviceMetricsCommand(profile: RenderProfile, emulation: RenderFit['emulation']): CdpCommand {
  if (profile.device === 'none' || emulation === null) return { method: 'Emulation.clearDeviceMetricsOverride', params: {} };
  const preset = DEVICE_PRESETS[profile.device];
  return {
    method: 'Emulation.setDeviceMetricsOverride',
    params: {
      width: emulation.width,
      height: emulation.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile: preset.mobile,
      scale: emulation.scale,
      screenWidth: preset.width,
      screenHeight: preset.height,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    },
  };
}

/**
 * The client hints matching an overriding user agent (`USER_AGENT_PLATFORMS`): brand and version
 * from the app's own engine, the platform and mobile flag the string claims. A custom user agent has
 * none (`undefined`).
 */
export function userAgentMetadata(profile: RenderProfile, chromeVersion: string): Record<string, unknown> | undefined {
  if (profile.userAgent === 'browser' || profile.userAgent === 'custom') return undefined;
  const version = normalChromeVersion(chromeVersion);
  const major = version.split('.')[0]!;
  const claim = USER_AGENT_PLATFORMS[profile.userAgent];
  return {
    brands: [{ brand: CLIENT_HINTS_BRAND, version: major }],
    fullVersionList: [{ brand: CLIENT_HINTS_BRAND, version }],
    platform: claim.platform,
    platformVersion: claim.platformVersion,
    architecture: claim.mobile ? '' : 'x86',
    model: '',
    mobile: claim.mobile,
    bitness: claim.mobile ? '' : '64',
    wow64: false,
  };
}

/**
 * Every command for `profile`, in order: the Network domain (enabled, with no buffers, only for
 * cache-off), the cache switch, the user agent (an empty one restores frost's own), the network
 * condition, device metrics and touch, then the JavaScript switch. `emulation` is the viewport fit to
 * the page area (`fitRenderViewport`); `undefined` uses the device's own size.
 */
export function renderProfileCommands(profile: RenderProfile, options: { readonly chromeVersion: string; readonly emulation?: RenderFit['emulation'] }): CdpCommand[] {
  const commands: CdpCommand[] = [];
  if (profile.cacheDisabled) {
    commands.push({ method: 'Network.enable', params: { ...NETWORK_ENABLE_PARAMS } }, { method: 'Network.setCacheDisabled', params: { cacheDisabled: true } });
  } else {
    commands.push({ method: 'Network.setCacheDisabled', params: { cacheDisabled: false } }, { method: 'Network.disable', params: {} });
  }

  const userAgent = profileUserAgent(profile, options.chromeVersion);
  const metadata = userAgentMetadata(profile, options.chromeVersion);
  const platform = profile.userAgent === 'browser' || profile.userAgent === 'custom' ? undefined : USER_AGENT_PLATFORMS[profile.userAgent].navigatorPlatform;
  commands.push({
    method: 'Network.setUserAgentOverride',
    params: { userAgent: userAgent ?? '', ...(platform ? { platform } : {}), ...(metadata ? { userAgentMetadata: metadata } : {}) },
  });

  const network = profile.network === 'none' ? null : NETWORK_PRESETS[profile.network];
  commands.push({
    method: 'Network.emulateNetworkConditions',
    params: network
      ? { offline: network.offline, latency: network.latencyMs, downloadThroughput: network.downloadBytesPerSecond, uploadThroughput: network.uploadBytesPerSecond, connectionType: network.connectionType }
      : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  });

  commands.push(deviceMetricsCommand(profile, options.emulation === undefined ? unscaled(profile) : options.emulation));
  const touch = profile.device !== 'none' && DEVICE_PRESETS[profile.device].touch;
  commands.push({ method: 'Emulation.setTouchEmulationEnabled', params: touch ? { enabled: true, maxTouchPoints: TOUCH_POINTS } : { enabled: false } });
  commands.push({ method: 'Emulation.setScriptExecutionDisabled', params: { value: profile.javascriptDisabled } });
  return commands;
}
