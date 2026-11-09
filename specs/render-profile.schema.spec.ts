/**
 * Render profiles as Zod schemas (Phase 2.5 Task 1; acceptance `render-profile.feature.md`): the
 * procedures' inputs, `TabState.renderProfile`, and a pinned profile read back from the database.
 * Main-only (Zod): the chrome imports this module for its types only. Values and wording are
 * `render-profile.spec.ts`.
 */
import { z } from 'zod';
import {
  CUSTOM_USER_AGENT_PATTERN,
  DEVICE_PRESET_IDS,
  GEOLOCATION_LIMITS,
  hasGeolocationPrecision,
  MAX_CUSTOM_USER_AGENT_LENGTH,
  NETWORK_PRESET_IDS,
  RENDER_PROFILE_SOURCES,
  RENDER_PROFILE_STATUSES,
  USER_AGENT_IDS,
  type GeolocationOverride,
  type RenderProfile,
  type TabOverrides,
} from './render-profile.spec';

/**
 * A render profile (`RenderProfile`). `customUserAgent` is printable ASCII, at most
 * `MAX_CUSTOM_USER_AGENT_LENGTH` characters; non-blank exactly when `userAgent` is `custom`, else `''`.
 */
export const RenderProfileSchema = z
  .strictObject({
    device: z.enum(DEVICE_PRESET_IDS),
    userAgent: z.enum(USER_AGENT_IDS),
    customUserAgent: z.string().max(MAX_CUSTOM_USER_AGENT_LENGTH).regex(CUSTOM_USER_AGENT_PATTERN),
    network: z.enum(NETWORK_PRESET_IDS),
    javascriptDisabled: z.boolean(),
    cacheDisabled: z.boolean(),
  })
  .refine((profile) => (profile.userAgent === 'custom' ? profile.customUserAgent.trim() !== '' : profile.customUserAgent === ''), {
    message: 'customUserAgent is required for, and only for, a custom user agent',
    path: ['customUserAgent'],
  }) satisfies z.ZodType<RenderProfile>;

/**
 * `browser.setRenderProfile` input: the tab, its profile, and this site's pin: `true` makes the
 * profile this site's pin ("Pin to this site"), `false` removes the site's pin, and leaving it out
 * keeps the site's pin as it is (the profile is the tab's own). Answers whether the tab's profile was
 * set (an id that names no open tab is a no-op answering `false`).
 */
export const SetRenderProfileInputSchema = z.strictObject({
  tabId: z.int().positive(),
  profile: RenderProfileSchema,
  pin: z.boolean().optional(),
});
export type SetRenderProfileInput = z.infer<typeof SetRenderProfileInputSchema>;

/**
 * `browser.clearRenderProfile` input: the tab whose profile goes (Reset). Answers whether the tab
 * had one; this site's pin goes with it.
 */
export const ClearRenderProfileInputSchema = z.strictObject({ tabId: z.int().positive() });
export type ClearRenderProfileInput = z.infer<typeof ClearRenderProfileInputSchema>;

/** `TabState.renderProfile` (`TabRenderProfile`): `null` while the tab has none. */
export const TabRenderProfileSchema = z.strictObject({
  profile: RenderProfileSchema,
  source: z.enum(RENDER_PROFILE_SOURCES),
  pinned: z.boolean(),
  needsReload: z.boolean(),
  status: z.enum(RENDER_PROFILE_STATUSES),
});

// ---- Tab overrides (Phase 11 Task 6, Decision 8) ------------------------------------------------

/**
 * A browser geolocation override (`GeolocationOverride`): latitude ±90 and longitude ±180 with at
 * most `GEOLOCATION_LIMITS.decimals` decimals, accuracy a whole number of metres from
 * `minAccuracy` to `maxAccuracy`. Anything else is refused (`BAD_REQUEST`), never rounded.
 */
export const GeolocationOverrideSchema = z.strictObject({
  latitude: z.number().min(-GEOLOCATION_LIMITS.maxLatitude).max(GEOLOCATION_LIMITS.maxLatitude).refine(hasGeolocationPrecision, 'too many decimals'),
  longitude: z.number().min(-GEOLOCATION_LIMITS.maxLongitude).max(GEOLOCATION_LIMITS.maxLongitude).refine(hasGeolocationPrecision, 'too many decimals'),
  accuracy: z.int().min(GEOLOCATION_LIMITS.minAccuracy).max(GEOLOCATION_LIMITS.maxAccuracy),
}) satisfies z.ZodType<GeolocationOverride>;

/**
 * A tab's overrides (`TabOverrides`; `TabState.tabOverrides`). Strict: a render-profile field here,
 * or an override field in `RenderProfileSchema`, is refused (they never mix).
 */
export const TabOverridesSchema = z.strictObject({
  cssDisabled: z.boolean(),
  cookiesDisabled: z.boolean(),
  geolocation: GeolocationOverrideSchema.nullable(),
}) satisfies z.ZodType<TabOverrides>;

/**
 * `tabOverrides.set` input: the tab and its whole overrides (all off: back to normal). Answers whether
 * the tab's overrides were set (an id that names no open tab is a no-op answering `false`).
 */
export const SetTabOverridesInputSchema = z.strictObject({
  tabId: z.int().positive(),
  overrides: TabOverridesSchema,
});
export type SetTabOverridesInput = z.infer<typeof SetTabOverridesInputSchema>;
