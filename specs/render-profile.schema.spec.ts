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
  MAX_CUSTOM_USER_AGENT_LENGTH,
  NETWORK_PRESET_IDS,
  RENDER_PROFILE_SOURCES,
  RENDER_PROFILE_STATUSES,
  USER_AGENT_IDS,
  type RenderProfile,
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
 * `browser.setRenderProfile` input: the tab, its profile, and whether this site's pin is this
 * profile ("Pin to this site"; `false` removes the site's pin). Answers whether the tab's profile was
 * set (an id that names no open tab is a no-op answering `false`).
 */
export const SetRenderProfileInputSchema = z.strictObject({
  tabId: z.int().positive(),
  profile: RenderProfileSchema,
  pin: z.boolean(),
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
