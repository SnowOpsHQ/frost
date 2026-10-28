/**
 * The `update.*` procedures' inputs (Phase 7 Task 5; acceptance `update-client.feature.md`, Router).
 * Main-only (Zod): the chrome imports the plain values in `update-client.spec.ts`, never this file
 * (strict Trusted Types keep Zod out of the renderer bundle). Every schema is strict: an unknown key,
 * a non-integer version or anything out of range is `BAD_REQUEST` before the service is touched.
 */
import { z } from 'zod';
import { UPDATE_CHECKS } from './update-client.spec';

/** `update.watch`: the state version the chrome has (`-1` before its first answer). */
export const UpdateWatchInputSchema = z.strictObject({ sinceVersion: z.int().min(-1).max(Number.MAX_SAFE_INTEGER) });
export type UpdateWatchInput = z.infer<typeof UpdateWatchInputSchema>;

/** `update.setChecks`: the user's automatic-check setting. */
export const UpdateSetChecksInputSchema = z.strictObject({ checks: z.enum(UPDATE_CHECKS) });
export type UpdateSetChecksInput = z.infer<typeof UpdateSetChecksInputSchema>;

/** `update.check`, `update.download`, `update.skip`, `update.install`: no input at all. */
export const UpdateNoInputSchema = z.undefined();
