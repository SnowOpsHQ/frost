/**
 * The retention procedures' inputs and answers (Phase 6 Task 7; acceptance `retention.feature.md`):
 * `projects.setRetention`, `retentionPreview`, `purgeNow`, `usage`, `purgeLog` and `compact`.
 * Main-only (Zod): the chrome imports the plain values and types of `retention.spec.ts` (re-exported
 * here). Every input is strict; a policy is `forever` with no N, or N within its bounds.
 */
import { z } from 'zod';
import { PURGE_REASONS, RETENTION_MODES, UUIDV7_PATTERN } from './capture-db.spec';
import {
  PURGE_LOG_LIMIT,
  RETENTION_REFUSALS,
  RETENTION_VALUE_BOUNDS,
  type CompactAnswer,
  type PurgeLogAnswer,
  type PurgeNowAnswer,
  type RetentionPreviewAnswer,
  type SetRetentionAnswer,
  type UsageAnswer,
} from './retention.spec';

export * from './retention.spec';

const id = z.string().regex(UUIDV7_PATTERN);
const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bounded = (mode: keyof typeof RETENTION_VALUE_BOUNDS) => z.int().min(RETENTION_VALUE_BOUNDS[mode].min).max(RETENTION_VALUE_BOUNDS[mode].max);

// ---- Inputs ------------------------------------------------------------------------------------

/** A policy: `forever` (no N), the last N versions, or N days. */
const policy = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('forever'), value: z.null() }),
  z.strictObject({ mode: z.literal('versions'), value: bounded('versions') }),
  z.strictObject({ mode: z.literal('days'), value: bounded('days') }),
]);

export const SetRetentionInputSchema = z.strictObject({ projectId: id, policy });
/** `usage` and `purgeLog`: one project, or every one (`null`). */
export const RetentionScopeInputSchema = z.strictObject({ projectId: id.nullable() });

export type SetRetentionInput = z.infer<typeof SetRetentionInputSchema>;

// ---- Answers -----------------------------------------------------------------------------------

const refused = z.strictObject({ status: z.literal('refused'), reason: z.enum(RETENTION_REFUSALS) });
const counts = z.strictObject({ captures: count, versions: count, diffs: count, screenshots: count });

export const SetRetentionAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok') }), refused]) satisfies z.ZodType<SetRetentionAnswer>;

export const RetentionPreviewAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok'), policy, counts, bytes: count }), refused]) satisfies z.ZodType<RetentionPreviewAnswer>;

export const PurgeNowAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('purged'), counts, bytes: count, files: count }),
  z.strictObject({ status: z.literal('empty') }),
  z.strictObject({ status: z.literal('changed') }),
  refused,
]) satisfies z.ZodType<PurgeNowAnswer>;

export const UsageAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    usage: z.strictObject({
      projectId: id.nullable(),
      captures: count,
      versions: count,
      sharedVersions: count,
      snapshotBytes: count,
      diffBytes: count,
      screenshots: count,
      files: z.strictObject({ count, bytes: count, missing: count, shared: count }),
      database: z.strictObject({ bytes: count, walBytes: count }).nullable(),
    }),
  }),
  refused,
]) satisfies z.ZodType<UsageAnswer>;

export const PurgeLogAnswerSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        id,
        reason: z.enum(PURGE_REASONS),
        projectId: id.nullable(),
        policy: z.strictObject({ mode: z.enum([...RETENTION_MODES, 'all']), value: count.nullable() }).nullable(),
        counts,
        bytes: count,
        createdAt: count,
      }),
    )
    .max(PURGE_LOG_LIMIT),
}) satisfies z.ZodType<PurgeLogAnswer>;

export const CompactAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('compacted'), before: count, after: count }), refused]) satisfies z.ZodType<CompactAnswer>;
