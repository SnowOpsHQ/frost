/**
 * The Zod side of the update client (Phase 7 Task 4; plain values in `update-client.spec.ts`;
 * acceptance `update-client.feature.md`): the prefs file `userData/frost-update.json`. Main-only
 * (Zod). Strict: an unknown key, or any field out of shape, makes the whole file invalid, and the
 * client then starts over from defaults (a new install ID included) and rewrites it.
 */
import { z } from 'zod';
import { UPDATE_CHECKS, UPDATE_PREFS_FORMAT, type UpdatePrefs } from './update-client.spec';
import { UpdateVersionSchema } from './update-manifest.schema';

/** The high-water mark (`UpdateHighWaterMark`): a version and its manifest's UTC `releasedAt`. */
export const UpdateHighWaterMarkSchema = z.strictObject({
  version: UpdateVersionSchema,
  releasedAt: z.iso.datetime(),
});

export const UpdatePrefsSchema = z.strictObject({
  format: z.literal(UPDATE_PREFS_FORMAT),
  installId: z.uuidv4(),
  checks: z.enum(UPDATE_CHECKS),
  skippedVersion: UpdateVersionSchema.optional(),
  highWaterMark: UpdateHighWaterMarkSchema.optional(),
}) satisfies z.ZodType<UpdatePrefs>;
