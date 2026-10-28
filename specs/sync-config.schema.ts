/**
 * The Zod side of the sync config (Phase 7 Task 8; plain values in `sync.spec.ts`, Sync config;
 * acceptance `sync-config.feature.md`): the file `userData/frost-sync.json`. Main-only (Zod).
 * Strict: an unknown key, or any field out of shape, makes the whole file tampered, and sync is
 * then off for the run (the file is left alone).
 */
import { z } from 'zod';
import { MAX_SYNC_CONFIG_BYTES, syncEndpointProblem, type SyncConfigFile } from './sync.spec';

/** Canonical base64 (padded, no whitespace), as `Buffer#toString('base64')` writes it. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const SyncEndpointSchema = z.string().refine((url) => syncEndpointProblem(url) === null, 'endpoint-invalid');

/** `safeStorage` ciphertext of the token, base64; never empty, never longer than the file may be. */
export const SyncEncryptedTokenSchema = z.string().min(4).max(MAX_SYNC_CONFIG_BYTES).regex(BASE64);

export const SyncConfigFileSchema = z
  .strictObject({
    enabled: z.boolean(),
    url: SyncEndpointSchema.optional(),
    encryptedToken: SyncEncryptedTokenSchema.optional(),
    deviceId: z.uuidv4().optional(),
  })
  .refine((config) => config.encryptedToken === undefined || config.url !== undefined, 'token-needs-endpoint') satisfies z.ZodType<SyncConfigFile>;
