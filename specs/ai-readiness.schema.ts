/**
 * The Zod side of AI readiness (Phase 9 Task 7; plain values in `ai-readiness.spec.ts`; acceptance
 * `ai-readiness.feature.md`): the probes' SERP worker's `llms-txt` jobs (`LlmsTxtJobSchema`) and their
 * answers (`LlmsTxtAnswerSchema`), and what a probe run reports about `/llms.txt`
 * (`LlmsTxtStateSchema`, `ProbeReportSchema.llmsTxt` in `visibility-probes.schema.ts`). Not for the
 * chrome renderer (no Zod there).
 *
 * Imports run one way: this file reads the plain specs only, and `visibility-probes.schema.ts` imports
 * it (never the other way round).
 */
import { z } from 'zod';
import { LLMS_TXT_FINDINGS, LLMS_TXT_OUTCOMES, LLMS_TXT_PARSE_LIMITS } from './ai-readiness.spec';
import { SNAPSHOT_LIMITS } from './seo-limits.spec';
import { LLMS_TXT_LIMITS, PROBE_LIMITS } from './visibility-probes.spec';
import { isWebUrl } from './web-url.spec';

const urlText = z.string().max(SNAPSHOT_LIMITS.maxUrlChars);
const count = z.int().nonnegative().max(LLMS_TXT_PARSE_LIMITS.maxLines);
const findings = z.array(z.enum(LLMS_TXT_FINDINGS)).max(LLMS_TXT_FINDINGS.length);
const title = z.string().max(LLMS_TXT_PARSE_LIMITS.maxTitleChars).nullable();

/** A 2xx text answer to read: the URL that gave it, its `Content-Type` and its body (at most `LLMS_TXT_LIMITS.maxBytes`). */
export const LlmsTxtJobSchema = z.strictObject({
  kind: z.literal('llms-txt'),
  url: urlText.refine(isWebUrl, { message: 'not an http(s) URL' }),
  contentType: z.string().max(PROBE_LIMITS.maxHeaderChars).nullable(),
  body: z.instanceof(Uint8Array).refine((body) => body.byteLength <= LLMS_TXT_LIMITS.maxBytes, { message: 'body over its cap' }),
});
export type LlmsTxtJob = z.infer<typeof LlmsTxtJobSchema>;

/**
 * What the file says (`parseLlmsTxt`): its H1 (capped; `null`: none), how many H2 sections and
 * `[name](url)` links it lists, and where it departs from the proposal (`LLMS_TXT_FINDINGS`).
 * `partial`: the parse stopped at `LLMS_TXT_PARSE_LIMITS`.
 */
export const LlmsTxtAnswerSchema = z.strictObject({
  kind: z.literal('llms-txt'),
  title,
  sections: count,
  links: count,
  findings,
  partial: z.boolean(),
});
export type LlmsTxtAnswer = z.infer<typeof LlmsTxtAnswerSchema>;

/** An `llms-txt` job's answer: `ok` with the answer, or `failed` (an invalid job, a body that could not be read). */
export type LlmsTxtJobResult = { readonly ok: true; readonly answer: LlmsTxtAnswer } | { readonly ok: false; readonly reason: 'invalid-job' | 'parse-failed' };

/**
 * A run's `/llms.txt`: the URL asked (`<page origin>/llms.txt`), how it ended (`LLMS_TXT_OUTCOMES`),
 * the final status (`null`: no response), the bytes read and whether the body was longer
 * (`truncated`), what the file says (`title`, `sections`, `links`, `findings`, `partial`: only for
 * `ok` and `malformed`; empty otherwise), and when frost got it (`readAt`, ms since the epoch; `null`
 * while pending). A cached answer keeps its `readAt`.
 */
export const LlmsTxtStateSchema = z.strictObject({
  url: urlText,
  outcome: z.enum(LLMS_TXT_OUTCOMES),
  status: z.int().min(0).max(999).nullable(),
  bytes: z.int().nonnegative().max(LLMS_TXT_LIMITS.maxBytes),
  truncated: z.boolean(),
  title,
  sections: count,
  links: count,
  findings,
  partial: z.boolean(),
  readAt: z.int().min(0).nullable(),
});
export type LlmsTxtState = z.infer<typeof LlmsTxtStateSchema>;
