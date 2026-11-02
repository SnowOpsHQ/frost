import { parseLlmsTxt } from '@app/seo-core';
import { LlmsTxtAnswerSchema, LlmsTxtJobSchema, type LlmsTxtJobResult } from '@app/specs/ai-readiness.schema';

// The probes' SERP worker's `llms-txt` jobs (spec `ai-readiness.spec.ts`, llms.txt; acceptance
// `ai-readiness.feature.md`, `llms-txt-parsed-in-worker`). Runs only in the SERP worker
// (`serp-worker.ts`, `kind: 'llms-txt'`), never on main's thread, under the probe parser's deadline
// (`probe-parser.ts`). The job is validated with `LlmsTxtJobSchema` first; the body (untrusted text) is
// decoded with the charset its `Content-Type` names (else UTF-8) and read by seo-core's `parseLlmsTxt`;
// only the answer, validated with `LlmsTxtAnswerSchema`, leaves the worker.

/** The charset a `Content-Type` names, if the decoder knows it. */
function decoderFor(contentType: string | null): TextDecoder {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      // An unknown label: UTF-8, as for a file without one.
    }
  }
  return new TextDecoder('utf-8');
}

/** Validates and runs one `llms-txt` job (`LlmsTxtJobSchema`). Never throws. */
export function runLlmsTxtJob(raw: unknown): LlmsTxtJobResult {
  let job;
  try {
    const parsed = LlmsTxtJobSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'invalid-job' };
    job = parsed.data;
  } catch {
    return { ok: false, reason: 'invalid-job' };
  }
  try {
    const read = parseLlmsTxt(decoderFor(job.contentType).decode(job.body));
    const answer = LlmsTxtAnswerSchema.safeParse({ kind: 'llms-txt', title: read.title, sections: read.sections, links: read.links, findings: [...read.findings], partial: read.partial });
    return answer.success ? { ok: true, answer: answer.data } : { ok: false, reason: 'parse-failed' };
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
}
