import { AI_CHECK_LIMITS } from '@app/specs/ai-checks.spec';
import { AiCheckOutputSchema, type AiCheckOutput } from '@app/specs/ai-checks.schema';
import { TARGET_QUERY_MAX_CHARS } from '@app/specs/seo-content.spec';

// A check's answer (Phase 9 Task 10, Decision 17; acceptance `specs/ai-checks.feature.md`): the
// model's plain text, untrusted. It is parsed here, in main, as one JSON object (a single Markdown
// code fence around it is tolerated); its texts lose every control and bidi-control character,
// collapse their whitespace and are cut to their caps; then the whole is checked strictly
// (`AiCheckOutputSchema`: exactly its keys, each value of its type and list). Anything else is
// `null` (`invalid-output`). The result is display-only: nothing acts on it.

/** C0 and C1 controls, and the bidi marks, embeddings, overrides and isolates. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** `value` as plain inert text: unsafe characters out, whitespace collapsed, at most `max` units (never splitting a pair). */
export function inertText(value: string, max: number): string {
  const text = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

/** A list value as the model may write it ("Article" for "article"); anything but a string unchanged. */
const listValue = (value: unknown): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/** The model's answer `text` as a checked `AiCheckOutput`, or `null` (`invalid-output`). Never throws. */
export function parseAiCheckOutput(text: unknown): AiCheckOutput | null {
  if (typeof text !== 'string' || text.length > AI_CHECK_LIMITS.maxOutputChars) return null;
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1]!;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  // Own keys only, copied onto a fresh object; a `__proto__` key is not an answer (and is never assigned).
  const given = value as Record<string, unknown>;
  if (Object.hasOwn(given, '__proto__')) return null;
  const candidate: Record<string, unknown> = {};
  for (const key of Object.keys(given)) candidate[key] = given[key];
  if (Object.hasOwn(candidate, 'pageType')) candidate['pageType'] = listValue(candidate['pageType']);
  if (Object.hasOwn(candidate, 'intent')) candidate['intent'] = listValue(candidate['intent']);
  if (Object.hasOwn(candidate, 'quality')) candidate['quality'] = listValue(candidate['quality']);
  if (typeof candidate['qualityReason'] === 'string') candidate['qualityReason'] = inertText(candidate['qualityReason'], AI_CHECK_LIMITS.maxReasonChars);
  if (typeof candidate['suggestedTarget'] === 'string') {
    const target = inertText(candidate['suggestedTarget'], TARGET_QUERY_MAX_CHARS);
    candidate['suggestedTarget'] = target === '' ? null : target;
  }
  const parsed = AiCheckOutputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
