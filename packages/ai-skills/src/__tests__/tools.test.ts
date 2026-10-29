// Spec: specs/agent-tools.spec.ts (AGENT_TOOL_NAMES, AGENT_TOOL_INPUT_LIMITS, EXECUTE_JS_MAX_SOURCE_CHARS, UNSAFE_INPUT_CHARS,
// TOOL_RESULT_MAX_CHARS)
// Acceptance: specs/agent-protocol.feature.md (Tool definitions and ports)
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { AGENT_TOOL_INPUT_LIMITS, AGENT_TOOL_NAMES, EXECUTE_JS_MAX_SOURCE_CHARS, isSafeInputText, TOOL_RESULT_MAX_CHARS } from '@app/specs/agent-tools.spec';
import { AGENT_TOOL_DEFINITIONS, getToolDefinition, UNTRUSTED_OUTPUT_NOTE } from '../index';

const L = AGENT_TOOL_INPUT_LIMITS;
const accepts = (name: string, input: unknown) => getToolDefinition(name)!.inputSchema.safeParse(input).success;

describe('tool definitions', () => {
  test('every-catalogue-tool-has-a-definition', () => {
    const names = AGENT_TOOL_DEFINITIONS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toStrictEqual([...AGENT_TOOL_NAMES].sort());
    for (const name of AGENT_TOOL_NAMES) {
      const definition = getToolDefinition(name);
      expect(definition?.name).toBe(name);
      expect(definition!.description.trim().length).toBeGreaterThan(20);
    }
    expect(getToolDefinition('shell')).toBeUndefined();
    expect(getToolDefinition('toString')).toBeUndefined();
    expect(getToolDefinition('mcp__docs__search')).toBeUndefined();
  });

  test('tool-inputs-validated', () => {
    for (const name of ['page_audit', 'page_data']) {
      expect(accepts(name, {})).toBe(true);
      expect(accepts(name, { extra: 1 })).toBe(false);
    }
    expect(accepts('page_text', {})).toBe(true);
    expect(accepts('page_text', { maxChars: TOOL_RESULT_MAX_CHARS })).toBe(true);
    expect(accepts('page_text', { maxChars: TOOL_RESULT_MAX_CHARS + 1 })).toBe(false);
    expect(accepts('page_text', { maxChars: 0 })).toBe(false);
    expect(accepts('page_text', { maxChars: 1.5 })).toBe(false);

    expect(accepts('navigate', { url: 'https://example.com/a?b=c' })).toBe(true);
    expect(accepts('navigate', { url: 'http://example.com/' })).toBe(true);
    for (const url of ['https://user:pass@example.com/', 'https://user@example.com/', 'https://:pass@example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'app://app/', 'data:text/html,hi', 'example.com', '', `https://example.com/${'a'.repeat(L.maxUrlChars)}`]) {
      expect(accepts('navigate', { url })).toBe(false);
    }
    expect(accepts('navigate', {})).toBe(false);
    expect(accepts('navigate', { url: 'https://example.com/', newTab: true })).toBe(false);

    expect(accepts('click', { selector: 'a.next' })).toBe(true);
    expect(accepts('click', { text: 'Next page' })).toBe(true);
    expect(accepts('click', {})).toBe(false);
    expect(accepts('click', { selector: 'a', text: 'Next' })).toBe(false);
    expect(accepts('click', { selector: '' })).toBe(false);
    expect(accepts('click', { selector: 'a'.repeat(L.maxSelectorChars + 1) })).toBe(false);
    expect(accepts('click', { text: 'a'.repeat(L.maxClickTextChars + 1) })).toBe(false);

    expect(accepts('execute_javascript', { code: 'document.title' })).toBe(true);
    expect(accepts('execute_javascript', { code: 'x'.repeat(EXECUTE_JS_MAX_SOURCE_CHARS) })).toBe(true);
    expect(accepts('execute_javascript', { code: 'x'.repeat(EXECUTE_JS_MAX_SOURCE_CHARS + 1) })).toBe(false);
    expect(accepts('execute_javascript', { code: '' })).toBe(false);
    expect(accepts('execute_javascript', { code: '1', world: 'main' })).toBe(false);

    for (const name of ['serp_results', 'search_intent', 'run_ai_search']) {
      expect(accepts(name, { query: 'best running shoes' })).toBe(true);
      expect(accepts(name, { query: '' })).toBe(false);
      expect(accepts(name, { query: 'q'.repeat(L.maxQueryChars + 1) })).toBe(false);
      expect(accepts(name, { query: 'q', extra: true })).toBe(false);
    }
    expect(accepts('serp_results', { query: 'q', locale: 'en-US', device: 'mobile' })).toBe(true);
    expect(accepts('serp_results', { query: 'q', locale: 'english' })).toBe(false);
    for (const locale of ['en', 'en-US', 'es-419', 'EN-us', 'fil-PH']) expect(accepts('serp_results', { query: 'q', locale }), locale).toBe(true);
    for (const locale of ['e', 'en-', 'en-U', 'en-1234', 'en_US', 'en-US-x', 'english']) expect(accepts('serp_results', { query: 'q', locale }), locale).toBe(false);
    const serp = getToolDefinition('serp_results').inputSchema;
    expect(serp.parse({ query: 'q', locale: 'EN-us' }).locale).toBe('en-US');
    expect(serp.parse({ query: 'q', locale: 'ES-419' }).locale).toBe('es-419');
    expect(getToolDefinition('run_ai_search').inputSchema.parse({ query: 'q', locale: 'De' }).locale).toBe('de');
    expect(accepts('serp_results', { query: 'q', device: 'watch' })).toBe(false);
    expect(accepts('run_ai_search', { query: 'q', locale: 'de' })).toBe(true);

    expect(accepts('gsc_performance', {})).toBe(true);
    expect(accepts('gsc_performance', { url: 'https://example.com/', days: L.maxGscDays })).toBe(true);
    expect(accepts('gsc_performance', { days: L.maxGscDays + 1 })).toBe(false);
    expect(accepts('gsc_performance', { days: 0 })).toBe(false);
    expect(accepts('gsc_performance', { url: 'ftp://example.com/' })).toBe(false);
    expect(accepts('gsc_performance', { url: 'https://user@example.com/' })).toBe(false);
  });

  test('tool-descriptions-mark-untrusted-output', () => {
    expect(UNTRUSTED_OUTPUT_NOTE).toMatch(/untrusted/i);
    expect(UNTRUSTED_OUTPUT_NOTE).toMatch(/never/i);
    for (const name of ['page_audit', 'page_data', 'page_text', 'click', 'execute_javascript', 'serp_results', 'run_ai_search', 'gsc_performance'] as const) {
      expect(getToolDefinition(name).description, name).toContain(UNTRUSTED_OUTPUT_NOTE);
    }
  });

  test('tool-inputs-safe-text', () => {
    // C0, DEL and C1 controls; bidi overrides and isolates; zero-width characters, the BOM and the
    // soft hyphen (Unicode Cf); the line and paragraph separators; a lone surrogate.
    const unsafe = ['\u0000', '\u0007', '\r', '\u001b', '\u007f', '\u0085', '\u009b', '\u202e', '\u202a', '\u2066', '\u2069', '\u200b', '\u200d', '\u2060', '\ufeff', '\u00ad', '\u061c', '\u2028', '\u2029', '\ud800', '\udfff'];
    for (const ch of unsafe) {
      const label = `U+${ch.charCodeAt(0).toString(16)}`;
      expect(isSafeInputText(`a${ch}b`), label).toBe(false);
      expect(accepts('click', { selector: `#buy${ch}` }), label).toBe(false);
      expect(accepts('click', { text: `Buy${ch} now` }), label).toBe(false);
      expect(accepts('navigate', { url: `https://example.com/${ch}` }), label).toBe(false);
      expect(accepts('gsc_performance', { url: `https://example.com/${ch}` }), label).toBe(false);
      expect(accepts('serp_results', { query: `tea${ch}` }), label).toBe(false);
      expect(accepts('run_ai_search', { query: `tea${ch}` }), label).toBe(false);
      expect(accepts('execute_javascript', { code: `1${ch}+1` }), label).toBe(false);
    }
    // Leading or trailing ones aren't trimmed away first.
    expect(accepts('serp_results', { query: '\u202etea' })).toBe(false);
    expect(accepts('navigate', { url: 'https://example.com/\n' })).toBe(false);
    expect(accepts('navigate', { url: '\thttps://example.com/' })).toBe(false);
    // Code may hold line feeds and tabs; other text may not.
    expect(accepts('execute_javascript', { code: 'const a = 1;\n\ta + 1' })).toBe(true);
    expect(isSafeInputText('a\n\tb', 'code')).toBe(true);
    expect(isSafeInputText('a\nb')).toBe(false);
    expect(accepts('click', { text: 'Next\npage' })).toBe(false);
    // Visible non-ASCII text is fine: accents, CJK, a paired emoji.
    expect(accepts('click', { text: 'Café 购物 \u{1F600}' })).toBe(true);
    expect(accepts('serp_results', { query: 'té verde' })).toBe(true);
    expect(accepts('execute_javascript', { code: 'document.title // ünïcödé' })).toBe(true);
  });

  test('tool-inputs-have-json-schemas', () => {
    for (const definition of AGENT_TOOL_DEFINITIONS) {
      const schema = z.toJSONSchema(definition.inputSchema, { io: 'input' }) as Record<string, unknown>;
      expect(schema.type, definition.name).toBe('object');
      expect(schema.additionalProperties, definition.name).toBe(false);
    }
  });
});
