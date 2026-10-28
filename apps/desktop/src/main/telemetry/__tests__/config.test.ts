// Spec: specs/telemetry-consent.schema.ts (TELEMETRY_CONFIG_ENV, UNPACKAGED_HTTP_TELEMETRY_HOSTS,
// DSN_PUBLIC_KEY_PATTERN, DSN_PROJECT_ID_PATTERN), specs/build-config.spec.ts (runtimeOverridesAllowed)
// Acceptance: specs/telemetry.feature.md (Desktop, Configuration) · plan "Configuration"
import { describe, expect, test } from 'vitest';
import { ACCOUNT_CONFIG_ENV } from '@app/specs/account-state.schema';
import { GSC_CONFIG_ENV } from '@app/specs/gsc.spec';
import { TELEMETRY_CONFIG_ENV } from '@app/specs/telemetry-consent.schema';
import { resolveTelemetryConfig, type TelemetryEnv } from '../config';

const ENDPOINT = 'https://otel.example.test/v1/traces';
const DSN = 'https://publickey@errors.example.test/42';

const env = (endpoint: string | undefined, dsn: string | undefined): TelemetryEnv => ({
  [TELEMETRY_CONFIG_ENV.otelEndpoint]: endpoint,
  [TELEMETRY_CONFIG_ENV.sentryDsn]: dsn,
});
const resolve = (isPackaged: boolean, buildTime: TelemetryEnv, runtime: TelemetryEnv = {}) => resolveTelemetryConfig({ isPackaged, buildTime, runtime });

describe('telemetry configuration', () => {
  test('telemetry-config-missing-is-not-configured', () => {
    expect(resolve(true, {})).toEqual({ otelEndpoint: null, sentryDsn: null });
    expect(resolve(false, {})).toEqual({ otelEndpoint: null, sentryDsn: null });
    expect(resolve(true, env('', ''))).toEqual({ otelEndpoint: null, sentryDsn: null });
    expect(resolve(true, env(ENDPOINT, undefined))).toEqual({ otelEndpoint: ENDPOINT, sentryDsn: null });
    expect(resolve(true, env(undefined, DSN))).toEqual({ otelEndpoint: null, sentryDsn: DSN });
    expect(resolve(true, env(ENDPOINT, DSN))).toEqual({ otelEndpoint: ENDPOINT, sentryDsn: DSN });
  });

  test('telemetry-config-packaged-requires-https', () => {
    for (const endpoint of ['http://127.0.0.1:4318/v1/traces', 'http://otel.example.test/v1/traces', 'ftp://otel.example.test/', 'file:///tmp/x']) {
      expect(resolve(true, env(endpoint, undefined)).otelEndpoint, endpoint).toBeNull();
    }
    for (const dsn of ['http://publickey@127.0.0.1:9000/1', 'http://publickey@errors.example.test/42']) {
      expect(resolve(true, env(undefined, dsn)).sentryDsn, dsn).toBeNull();
    }
  });

  test('telemetry-config-unpackaged-allows-loopback-http', () => {
    expect(resolve(false, env('http://127.0.0.1:4318/v1/traces', 'http://publickey@127.0.0.1:9000/1'))).toEqual({
      otelEndpoint: 'http://127.0.0.1:4318/v1/traces',
      sentryDsn: 'http://publickey@127.0.0.1:9000/1',
    });
    for (const host of ['otel.example.test', '10.0.0.1:4318', '[::1]:4318', '127.0.0.2', 'localhost:4318']) {
      expect(resolve(false, env(`http://${host}/v1/traces`, `http://key@${host}/1`)), host).toEqual({ otelEndpoint: null, sentryDsn: null });
    }
    expect(resolve(false, env(ENDPOINT, DSN))).toEqual({ otelEndpoint: ENDPOINT, sentryDsn: DSN });
  });

  test('telemetry-config-runtime-env-only-unpackaged', () => {
    const runtime = env('http://127.0.0.1:4318/v1/traces', 'http://key@127.0.0.1:9000/7');
    expect(resolve(false, {}, runtime)).toEqual({ otelEndpoint: 'http://127.0.0.1:4318/v1/traces', sentryDsn: 'http://key@127.0.0.1:9000/7' });
    expect(resolve(false, env('', ''), runtime)).toEqual({ otelEndpoint: 'http://127.0.0.1:4318/v1/traces', sentryDsn: 'http://key@127.0.0.1:9000/7' });
    expect(resolve(true, {}, runtime)).toEqual({ otelEndpoint: null, sentryDsn: null });
  });

  test('telemetry-config-baked-build-ignores-runtime', () => {
    const runtime = env('http://127.0.0.1:4318/v1/traces', 'http://key@127.0.0.1:9000/7');
    for (const isPackaged of [true, false]) {
      expect(resolve(isPackaged, env(ENDPOINT, DSN), runtime), String(isPackaged)).toEqual({ otelEndpoint: ENDPOINT, sentryDsn: DSN });
      // Either one baked in: the run-time environment is ignored for both.
      expect(resolve(isPackaged, env(ENDPOINT, undefined), runtime)).toEqual({ otelEndpoint: ENDPOINT, sentryDsn: null });
      expect(resolve(isPackaged, env(undefined, DSN), runtime)).toEqual({ otelEndpoint: null, sentryDsn: DSN });
      // Another module's value baked in pins the whole build too (build-config.spec.ts).
      expect(resolve(isPackaged, { [ACCOUNT_CONFIG_ENV.apiBaseUrl]: 'https://api.example.test' }, runtime)).toEqual({ otelEndpoint: null, sentryDsn: null });
      expect(resolve(isPackaged, { [GSC_CONFIG_ENV.clientSecret]: 'built-secret' }, runtime)).toEqual({ otelEndpoint: null, sentryDsn: null });
    }
  });

  test('telemetry-config-shapes', () => {
    for (const endpoint of [
      'https://user:pw@otel.example.test/v1/traces',
      'https://user@otel.example.test/v1/traces',
      'https://otel.example.test/v1/traces?key=1',
      'https://otel.example.test/v1/traces#x',
      ' https://otel.example.test/v1/traces',
      'not a url',
    ]) {
      expect(resolve(true, env(endpoint, undefined)).otelEndpoint, endpoint).toBeNull();
    }
    expect(resolve(true, env('https://otel.example.test:4318/v1/traces', undefined)).otelEndpoint).toBe('https://otel.example.test:4318/v1/traces');
    for (const dsn of [
      'https://errors.example.test/42',
      'https://publickey:secret@errors.example.test/42',
      'https://public-key@errors.example.test/42',
      'https://publickey@errors.example.test/',
      'https://publickey@errors.example.test/abc',
      'https://publickey@errors.example.test/42?x=1',
      'https://publickey@errors.example.test/42#x',
      `https://${'k'.repeat(65)}@errors.example.test/42`,
      'https://publickey@errors.example.test/42 ',
    ]) {
      expect(resolve(true, env(undefined, dsn)).sentryDsn, dsn).toBeNull();
    }
    // A path prefix before the project is allowed (a Sentry DSN may have one).
    expect(resolve(true, env(undefined, 'https://publickey@errors.example.test/sentry/42')).sentryDsn).toBe('https://publickey@errors.example.test/sentry/42');
  });
});
