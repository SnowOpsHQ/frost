// Spec: specs/agent-tools.spec.ts (TOOL_RESULT_MAX_CHARS) · specs/agent-protocol.schema.ts (ToolResultSchema, UntrustedOutputSchema)
// Acceptance: specs/agent-approvals.feature.md (Scenarios: output)
import { describe, expect, test } from 'vitest';
import { AGENT_PROTOCOL_LIMITS, ToolResultSchema } from '@app/specs/agent-protocol.schema';
import { TOOL_RESULT_MAX_CHARS } from '@app/specs/agent-tools.spec';
import { capToolData, toolSource, wrapToolOutput } from '../tool-output';

describe('tool output', () => {
  test('output-wrapped-and-capped', () => {
    const small = wrapToolOutput('page_text', 'page_text https://example.com/', { text: 'Hello' });
    expect(small).toEqual({ ok: true, output: { untrusted: true, source: 'page_text https://example.com/', data: { text: 'Hello' } } });
    expect(ToolResultSchema.safeParse(small).success).toBe(true);
    // Undefined data is null; a fresh copy is handed on.
    expect(wrapToolOutput('click', 'click', undefined)).toEqual({ ok: true, output: { untrusted: true, source: 'click', data: null } });
    const original = { list: [1, 2] };
    const copied = wrapToolOutput('page_data', 'x', original);
    expect(copied?.ok && copied.output.data).not.toBe(original);

    // Over the cap: the cut JSON text and a flag, the whole within the cap.
    const big = { text: 'a'.repeat(TOOL_RESULT_MAX_CHARS * 2) };
    const capped = wrapToolOutput('page_text', 'page_text', big);
    expect(capped?.ok).toBe(true);
    const data = capped!.ok ? (capped!.output.data as { truncated: boolean; originalChars: number; json: string }) : null;
    expect(data?.truncated).toBe(true);
    expect(data?.originalChars).toBe(JSON.stringify(big).length);
    expect(data?.json.startsWith('{"text":"aaaa')).toBe(true);
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(JSON.stringify(data).length).toBeGreaterThan(TOOL_RESULT_MAX_CHARS - 100);

    // Escape-heavy text (quotes, controls) still fits once its escapes are counted.
    const escapes = capToolData({ text: '"\n\u0001'.repeat(TOOL_RESULT_MAX_CHARS) });
    expect(JSON.stringify(escapes?.value).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    // A surrogate pair is never split.
    for (let shift = 0; shift < 4; shift += 1) {
      const emoji = capToolData({ t: 'x'.repeat(shift) + '\u{1F600}'.repeat(TOOL_RESULT_MAX_CHARS) })!.value as { json: string };
      const last = emoji.json.charCodeAt(emoji.json.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    // Too deep or too many values: cut text too.
    let deep: unknown = 'end';
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect((capToolData(deep)!.value as { truncated: boolean }).truncated).toBe(true);
    // A prototype key is never handed on as an object key.
    const proto = capToolData(JSON.parse('{"__proto__":{"admin":true}}'))!.value as { truncated: boolean; json: string };
    expect(proto.truncated).toBe(true);

    // Not JSON data: refused.
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(wrapToolOutput('page_data', 'x', cycle)).toBeNull();
    expect(wrapToolOutput('page_data', 'x', 10n)).toBeNull();
    expect(wrapToolOutput('page_data', 'x', () => 1)).toBeNull();

    // The source: one line, capped, never empty.
    expect(toolSource('a\nb\u0000c', 'fallback')).toBe('a b c');
    expect(toolSource('', 'page_text')).toBe('page_text');
    expect(toolSource(7, 'page_text')).toBe('page_text');
    expect(toolSource('s'.repeat(10_000), 'x').length).toBe(AGENT_PROTOCOL_LIMITS.maxSourceChars);
  });
});
