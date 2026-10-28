import { TOOL_RESULT_MAX_CHARS } from '@app/specs/agent-tools.spec';
import { AGENT_PROTOCOL_LIMITS, isBoundedJson, ToolResultSchema, type ToolResult } from '@app/specs/agent-protocol.schema';

// Tool output as the model reads it (Phase 5 Task 4, plan decision 9; acceptance
// `specs/agent-approvals.feature.md`, Output): every result main hands back is wrapped as untrusted
// data, `{ untrusted: true, source, data }`, with `data`'s JSON text at most `TOOL_RESULT_MAX_CHARS`.
// Data over the cap (or too deep, or with too many values) is replaced by its JSON text, cut, and a
// flag, so the model still sees the start of it and knows it was cut. Anything that isn't JSON data
// at all (a function, a bigint, a cycle) is not handed on.

/** What replaces data over the cap: its JSON text cut at the cap, and how long it was. */
export interface TruncatedData {
  readonly truncated: true;
  readonly originalChars: number;
  readonly json: string;
}

/** `text` cut to at most `max` UTF-16 units, never splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * `data` within the cap: `{ value }` with a fresh copy when it fits, else with `TruncatedData`;
 * `null` when it isn't JSON data (`undefined` counts as `null`).
 */
export function capToolData(data: unknown, maxChars: number = TOOL_RESULT_MAX_CHARS): { readonly value: unknown } | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(data === undefined ? null : data);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  const value: unknown = JSON.parse(text);
  if (isBoundedJson(value, maxChars)) return { value };
  // Cut the text until the wrapper's own JSON text fits (escapes make it longer than the cut).
  let budget = maxChars;
  for (;;) {
    const truncated: TruncatedData = { truncated: true, originalChars: text.length, json: cut(text, budget) };
    const length = JSON.stringify(truncated).length;
    if (length <= maxChars) return { value: truncated };
    budget -= length - maxChars;
    if (budget <= 0) return { value: { truncated: true, originalChars: text.length, json: '' } satisfies TruncatedData };
  }
}

/** `source` as the wrapper takes it: one line, at most `maxSourceChars`, never empty. */
export function toolSource(source: unknown, fallback: string): string {
  const text = typeof source === 'string' ? source.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  return cut(text === '' ? fallback : text, AGENT_PROTOCOL_LIMITS.maxSourceChars);
}

/**
 * A successful `tool.result`'s result: `data` wrapped untrusted from `source` and capped, checked
 * against `ToolResultSchema`. `null` when it can't be (not JSON data): the broker answers `failed`.
 */
export function wrapToolOutput(toolName: string, source: unknown, data: unknown): ToolResult | null {
  const capped = capToolData(data);
  if (capped === null) return null;
  const parsed = ToolResultSchema.safeParse({ ok: true, output: { untrusted: true, source: toolSource(source, toolName), data: capped.value } });
  return parsed.success ? parsed.data : null;
}
