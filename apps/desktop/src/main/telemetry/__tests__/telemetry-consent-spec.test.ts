// Spec: specs/telemetry-consent.schema.ts (TelemetryStateSchema, SetConsentInputSchema, RendererErrorInputSchema,
// TelemetryConsentFileSchema, TELEMETRY_CONSENT_FILE_VERSION), specs/telemetry-consent.spec.ts (RENDERER_ERROR_LIMITS),
// specs/telemetry-privacy.spec.ts (TELEMETRY_LIMITS)
// Acceptance: specs/telemetry.feature.md (Desktop, Spec schema)
import { describe, expect, test } from 'vitest';
import {
  RENDERER_ERROR_LIMITS,
  RendererErrorInputSchema,
  SetConsentInputSchema,
  TELEMETRY_CONSENT_FILE_VERSION,
  TelemetryConsentFileSchema,
  TelemetryStateSchema,
} from '@app/specs/telemetry-consent.schema';
import { TELEMETRY_LIMITS } from '@app/specs/telemetry-privacy.spec';

const STATE = { consent: { usage: false, errors: true }, configured: { usage: true, errors: false }, version: 3 };
const ERROR = { source: 'error', name: 'TypeError', message: 'x is not a function', stack: 'TypeError: x\n    at f (app://app/assets/index.js:1:2)' } as const;

describe('telemetry consent spec', () => {
  test('telemetry-state-is-strict', () => {
    expect(TelemetryStateSchema.parse(STATE)).toEqual(STATE);
    for (const bad of [
      { ...STATE, dsn: 'https://publickey@errors.example.test/42' },
      { ...STATE, endpoint: 'https://otel.example.test/v1/traces' },
      { ...STATE, configured: { usage: 'https://otel.example.test/v1/traces', errors: false } },
      { ...STATE, configured: { usage: true, errors: false, dsn: 'x' } },
      { ...STATE, consent: { usage: true } },
      { ...STATE, consent: { usage: true, errors: false, installId: 'abc' } },
      { ...STATE, version: -1 },
      { consent: STATE.consent, configured: STATE.configured },
    ]) {
      expect(TelemetryStateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test('telemetry-inputs-are-strict', () => {
    expect(SetConsentInputSchema.parse({ channel: 'usage', on: true })).toEqual({ channel: 'usage', on: true });
    for (const bad of [{ channel: 'crashes', on: true }, { channel: 'usage', on: 'yes' }, { channel: 'usage' }, { channel: 'errors', on: false, extra: 1 }]) {
      expect(SetConsentInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(RendererErrorInputSchema.parse(ERROR)).toEqual(ERROR);
    expect(RendererErrorInputSchema.parse({ ...ERROR, source: 'unhandledrejection', stack: null }).stack).toBeNull();
    expect(RendererErrorInputSchema.parse({ ...ERROR, message: 'm'.repeat(RENDERER_ERROR_LIMITS.maxMessageChars) }).message).toHaveLength(RENDERER_ERROR_LIMITS.maxMessageChars);
    for (const bad of [
      { ...ERROR, source: 'console' },
      { ...ERROR, url: 'https://example.com/' },
      { ...ERROR, name: 'n'.repeat(RENDERER_ERROR_LIMITS.maxNameChars + 1) },
      { ...ERROR, message: 'm'.repeat(RENDERER_ERROR_LIMITS.maxMessageChars + 1) },
      { ...ERROR, stack: 's'.repeat(RENDERER_ERROR_LIMITS.maxStackChars + 1) },
      { ...ERROR, stack: undefined },
      { ...ERROR, message: 42 },
    ]) {
      expect(RendererErrorInputSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  test('consent-file-schema-is-strict', () => {
    const file = { v: TELEMETRY_CONSENT_FILE_VERSION, usage: true, errors: false, decidedAt: 1_700_000_000_000 };
    expect(TelemetryConsentFileSchema.parse(file)).toEqual(file);
    for (const bad of [{ ...file, v: 2 }, { ...file, installId: 'x' }, { ...file, usage: 'true' }, { ...file, decidedAt: -1 }, { ...file, decidedAt: 1.5 }, { v: 1, usage: true, errors: false }]) {
      expect(TelemetryConsentFileSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test('renderer-limits-match-the-package', () => {
    expect(RENDERER_ERROR_LIMITS.maxNameChars).toBe(TELEMETRY_LIMITS.maxTypeChars);
    expect(RENDERER_ERROR_LIMITS.maxMessageChars).toBe(TELEMETRY_LIMITS.maxMessageChars);
  });
});
