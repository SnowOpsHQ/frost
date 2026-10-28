// Spec: specs/agent-tools.spec.ts (AGENT_TOOL_NAMES, AGENT_TOOL_INPUT_LIMITS, EXECUTE_JS_MAX_SOURCE_CHARS,
// TOOL_RESULT_MAX_CHARS)
// Acceptance: specs/agent-protocol.feature.md (Tool definitions and ports)
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { AGENT_TOOL_INPUT_LIMITS, AGENT_TOOL_NAMES, EXECUTE_JS_MAX_SOURCE_CHARS, TOOL_RESULT_MAX_CHARS } from '@app/specs/agent-tools.spec';
import { AGENT_TOOL_DEFINITIONS, getToolDefinition } from '../index';

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
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'app://app/', 'data:text/html,hi', 'example.com', '', `https://example.com/${'a'.repeat(L.maxUrlChars)}`]) {
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
    expect(accepts('serp_results', { query: 'q', device: 'watch' })).toBe(false);
    expect(accepts('run_ai_search', { query: 'q', locale: 'de' })).toBe(true);

    expect(accepts('gsc_performance', {})).toBe(true);
    expect(accepts('gsc_performance', { url: 'https://example.com/', days: L.maxGscDays })).toBe(true);
    expect(accepts('gsc_performance', { days: L.maxGscDays + 1 })).toBe(false);
    expect(accepts('gsc_performance', { days: 0 })).toBe(false);
    expect(accepts('gsc_performance', { url: 'ftp://example.com/' })).toBe(false);
  });

  test('tool-inputs-have-json-schemas', () => {
    for (const definition of AGENT_TOOL_DEFINITIONS) {
      const schema = z.toJSONSchema(definition.inputSchema, { io: 'input' }) as Record<string, unknown>;
      expect(schema.type, definition.name).toBe('object');
      expect(schema.additionalProperties, definition.name).toBe(false);
    }
  });
});
