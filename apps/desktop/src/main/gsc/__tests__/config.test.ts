// Spec: specs/gsc.spec.ts (GSC_CONFIG_ENV, GSC_ENDPOINTS, GSC_ENDPOINT_ENV, UNPACKAGED_HTTP_GSC_HOSTS,
// GSC_CLIENT_ID_PATTERN, GSC_CLIENT_SECRET_PATTERN)
// Acceptance: specs/gsc.feature.md (Configuration) · plan "Configuration"
import { describe, expect, test } from 'vitest';
import { GSC_CONFIG_ENV, GSC_ENDPOINT_ENV, GSC_ENDPOINTS } from '@app/specs/gsc.spec';
import { resolveGscConfig, type GscEnv } from '../config';

/** The client values (`null`: absent). */
const client = (id: string | null = 'test-client-id', secret: string | null = 'test-client-secret'): GscEnv => ({
  [GSC_CONFIG_ENV.clientId]: id ?? undefined,
  [GSC_CONFIG_ENV.clientSecret]: secret ?? undefined,
});

const FAKES = {
  [GSC_ENDPOINT_ENV.authUrl]: 'http://127.0.0.1:4100/o/oauth2/v2/auth',
  [GSC_ENDPOINT_ENV.tokenUrl]: 'http://127.0.0.1:4100/token',
  [GSC_ENDPOINT_ENV.revokeUrl]: 'http://localhost:4100/revoke',
  [GSC_ENDPOINT_ENV.apiBase]: 'https://gsc.test.example/webmasters/v3',
};

const resolve = (isPackaged: boolean, buildTime: GscEnv, runtime: Record<string, string | undefined> = {}) => resolveGscConfig({ isPackaged, buildTime, runtime });

describe('Search Console configuration', () => {
  test('gsc-config-missing-is-unconfigured', () => {
    expect(resolve(true, {})).toBeNull();
    expect(resolve(false, {})).toBeNull();
    expect(resolve(true, client(null))).toBeNull();
    expect(resolve(true, client('test-client-id', null))).toBeNull();
    expect(resolve(true, client('', ''))).toBeNull();
    expect(resolve(true, client())).toEqual({ clientId: 'test-client-id', clientSecret: 'test-client-secret', endpoints: GSC_ENDPOINTS });
  });

  test('gsc-config-baked-uses-google-endpoints', () => {
    for (const isPackaged of [true, false]) {
      const runtime = { ...client('other-client', 'other-secret'), ...FAKES };
      expect(resolve(isPackaged, client(), runtime)).toEqual({ clientId: 'test-client-id', clientSecret: 'test-client-secret', endpoints: GSC_ENDPOINTS });
      // Only one value baked in: the run-time environment is still ignored for both (unconfigured).
      expect(resolve(isPackaged, client('test-client-id', null), runtime)).toBeNull();
    }
  });

  test('gsc-config-runtime-only-unpackaged-unbaked', () => {
    expect(resolve(false, {}, client())).toEqual({ clientId: 'test-client-id', clientSecret: 'test-client-secret', endpoints: GSC_ENDPOINTS });
    expect(resolve(false, {}, { ...client(), ...FAKES })).toEqual({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      endpoints: { authUrl: FAKES.FROST_GSC_AUTH_URL, tokenUrl: FAKES.FROST_GSC_TOKEN_URL, revokeUrl: FAKES.FROST_GSC_REVOKE_URL, apiBase: FAKES.FROST_GSC_API_BASE },
    });
    // One override: the others stay Google's.
    expect(resolve(false, {}, { ...client(), [GSC_ENDPOINT_ENV.tokenUrl]: FAKES.FROST_GSC_TOKEN_URL })?.endpoints).toEqual({ ...GSC_ENDPOINTS, tokenUrl: FAKES.FROST_GSC_TOKEN_URL });
    // Packaged: never the run-time environment.
    expect(resolve(true, {}, { ...client(), ...FAKES })).toBeNull();
  });

  test('gsc-config-endpoint-overrides-validated', () => {
    for (const bad of [
      'http://gsc.test.example/token',
      'http://10.0.0.1/token',
      'http://[::1]:4100/token',
      'https://user:pass@gsc.test.example/token',
      'https://gsc.test.example/token?x=1',
      'https://gsc.test.example/token#x',
      'ftp://127.0.0.1/token',
      ' https://gsc.test.example/token',
      'not a url',
    ]) {
      expect(resolve(false, {}, { ...client(), [GSC_ENDPOINT_ENV.tokenUrl]: bad }), bad).toBeNull();
    }
    // An API base with a trailing slash is used without it.
    expect(resolve(false, {}, { ...client(), [GSC_ENDPOINT_ENV.apiBase]: 'http://127.0.0.1:4100/webmasters/v3/' })?.endpoints.apiBase).toBe('http://127.0.0.1:4100/webmasters/v3');
  });

  test('gsc-config-malformed-client-refused', () => {
    for (const [id, secret] of [
      ['bad id', 'test-client-secret'],
      ['test-client-id', 'bad secret'],
      ['id&redirect_uri=x', 'test-client-secret'],
      ['x'.repeat(257), 'test-client-secret'],
      ['test-client-id', 'line\nbreak'],
    ] as const) {
      expect(resolve(true, client(id, secret)), id).toBeNull();
    }
  });
});
