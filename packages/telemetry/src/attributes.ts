/**
 * Span attributes and names (spec: `SPAN_ATTRIBUTE_ALLOWLIST`, `SPAN_NAME_PATTERN`). Only allowlisted
 * keys whose values pass their rule leave; everything else is dropped, never coerced.
 */
import { SPAN_ATTRIBUTE_ALLOWLIST, SPAN_NAME_FALLBACK, SPAN_NAME_PATTERN, TELEMETRY_LIMITS, type SpanAttributeRule } from '@app/specs/telemetry-privacy.spec';
import { cap, type Scrubber } from './scrub';

export type AllowedValue = string | number | boolean;

/** The value to export for `rule`, or `undefined` to drop it. */
export function allowedValue(rule: SpanAttributeRule, value: unknown, scrub: Scrubber): AllowedValue | undefined {
  switch (rule.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      if (rule.kind === 'int' && !Number.isSafeInteger(value)) return undefined;
      return value >= rule.min && value <= rule.max ? value : undefined;
    }
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value) ? value : undefined;
    case 'token': {
      if (typeof value !== 'string') return undefined;
      const token = cap(scrub(value), rule.maxChars);
      return rule.pattern.test(token) ? token : undefined;
    }
  }
}

/** The allowlisted attributes of `attributes`, in allowlist order. */
export function allowedAttributes(attributes: Readonly<Record<string, unknown>>, scrub: Scrubber): [key: string, value: AllowedValue][] {
  const out: [string, AllowedValue][] = [];
  for (const [key, rule] of Object.entries(SPAN_ATTRIBUTE_ALLOWLIST) as [string, SpanAttributeRule][]) {
    if (!Object.hasOwn(attributes, key)) continue;
    const value = allowedValue(rule, attributes[key], scrub);
    if (value !== undefined) out.push([key, value]);
  }
  return out;
}

/** A span's exported name: its own when it is a fixed identifier, else `SPAN_NAME_FALLBACK`. */
export function exportedSpanName(name: string): string {
  return name.length <= TELEMETRY_LIMITS.maxSpanNameChars && SPAN_NAME_PATTERN.test(name) ? name : SPAN_NAME_FALLBACK;
}
