/**
 * Location profiles' shapes (Phase 12 Task 10b; values `location-profiles.spec.ts`; acceptance
 * `location-profiles.feature.md`). Main checks every row it reads and every answer it sends against
 * these; the `location.*` procedures validate their input with them. **No answer carries a secret**:
 * `LocationProfileSchema` has no username or password, only `hasCredentials`. The username and
 * password cross IPC once, renderer → main, inside `LocationProfileInputSchema`.
 */
import { z } from 'zod';
import { KEY_PROTECTIONS } from './agent-proxy.spec';
import {
  LOCATION_LIMITS,
  LOCATION_NEW_TAB_RESULTS,
  LOCATION_PROFILE_ID_PATTERN,
  LOCATION_PROXY_SCHEMES,
  LOCATION_WRITE_RESULTS,
  normalizeLocationHost,
  normalizeLocationLabel,
  normalizeLocationPassword,
  normalizeLocationUsername,
} from './location-profiles.spec';

export const LocationProfileIdSchema = z.string().regex(LOCATION_PROFILE_ID_PATTERN);

/** A label as the user typed it (trimmed, printable, at most `maxLabelChars`). */
export const LocationLabelSchema = z
  .string()
  .max(LOCATION_LIMITS.maxLabelChars)
  .refine((value) => normalizeLocationLabel(value) === value, { message: 'not a location label' });

export const LocationHostSchema = z
  .string()
  .max(LOCATION_LIMITS.maxHostChars)
  .refine((value) => normalizeLocationHost(value) === value, { message: 'not a proxy host' });

export const LocationPortSchema = z.int().min(LOCATION_LIMITS.minPort).max(LOCATION_LIMITS.maxPort);

/** A profile as main shows it: **no secret**, whether credentials are stored only. */
export const LocationProfileSchema = z.strictObject({
  id: LocationProfileIdSchema,
  label: LocationLabelSchema,
  scheme: z.enum(LOCATION_PROXY_SCHEMES),
  host: LocationHostSchema,
  port: LocationPortSchema,
  /** A username and password are stored for it (in main's key store; never sent). */
  hasCredentials: z.boolean(),
});
export type LocationProfile = z.infer<typeof LocationProfileSchema>;

/** `location.list`: every profile, oldest first, and how well a sign-in would be protected here. */
export const LocationProfilesViewSchema = z.strictObject({
  protection: z.enum(KEY_PROTECTIONS),
  profiles: z.array(LocationProfileSchema).max(LOCATION_LIMITS.maxProfiles),
});
export type LocationProfilesView = z.infer<typeof LocationProfilesViewSchema>;

/**
 * A profile to create or the new values of one to update. `username` and `password` are write-only
 * and go together (one without the other is invalid); absent on update keeps the stored ones, unless
 * the proxy's scheme, host or port changed (then they are removed: a sign-in is never sent to a
 * proxy it was not saved for). A `socks5` profile with either is refused (`socks-credentials`).
 */
export const LocationProfileInputSchema = z
  .strictObject({
    label: z.string().max(LOCATION_LIMITS.maxLabelChars * 2),
    scheme: z.enum(LOCATION_PROXY_SCHEMES),
    host: z.string().max(LOCATION_LIMITS.maxHostChars + 8),
    port: LocationPortSchema,
    username: z
      .string()
      .max(LOCATION_LIMITS.maxCredentialChars)
      .refine((value) => normalizeLocationUsername(value) === value)
      .optional(),
    password: z
      .string()
      .max(LOCATION_LIMITS.maxCredentialChars)
      .refine((value) => normalizeLocationPassword(value) === value)
      .optional(),
  })
  .refine((input) => (input.username === undefined) === (input.password === undefined), { message: 'username and password go together' });
export type LocationProfileInput = z.infer<typeof LocationProfileInputSchema>;

export const LocationUpdateInputSchema = z.strictObject({ id: LocationProfileIdSchema, profile: LocationProfileInputSchema });
export type LocationUpdateInput = z.infer<typeof LocationUpdateInputSchema>;

export const LocationIdInputSchema = z.strictObject({ id: LocationProfileIdSchema });

/** `location.newTab({ profileId })`. */
export const LocationNewTabInputSchema = z.strictObject({ profileId: LocationProfileIdSchema });

export const LocationWriteResultSchema = z.enum(LOCATION_WRITE_RESULTS);
export const LocationNewTabResultSchema = z.enum(LOCATION_NEW_TAB_RESULTS);

/** A tab's location (`TabState.location`, `browser.spec.ts`): the profile and its label, set at the tab's creation only. */
export const TabLocationSchema = z.strictObject({
  profileId: LocationProfileIdSchema,
  label: LocationLabelSchema,
});
export type TabLocation = z.infer<typeof TabLocationSchema>;
