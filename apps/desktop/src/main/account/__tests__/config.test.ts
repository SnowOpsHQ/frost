// Spec: specs/account-state.schema.ts (ACCOUNT_CONFIG_ENV, UNPACKAGED_HTTP_API_HOSTS), specs/entitlements-snapshot.spec.ts (EntitlementJwksSchema)
// Acceptance: specs/account-signin.feature.md (Configuration) · plan "Configuration"
import { describe, expect, test } from 'vitest';
import { ACCOUNT_CONFIG_ENV } from '@app/specs/account-state.schema';
import { resolveAccountConfig, type AccountEnv } from '../config';

const JWKS = { keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), kid: 'k1' }] };
const JWKS_TEXT = JSON.stringify(JWKS);

const env = (apiBase: string | undefined, jwks: string | undefined = JWKS_TEXT): AccountEnv => ({
  [ACCOUNT_CONFIG_ENV.apiBaseUrl]: apiBase,
  [ACCOUNT_CONFIG_ENV.entitlementJwks]: jwks,
});

const resolve = (isPackaged: boolean, buildTime: AccountEnv, runtime: AccountEnv = {}) => resolveAccountConfig({ isPackaged, buildTime, runtime });

describe('account configuration', () => {
  test('config-missing-is-unconfigured', () => {
    expect(resolve(true, {})).toBeNull();
    expect(resolve(false, {})).toBeNull();
    expect(resolve(true, env(undefined))).toBeNull();
    expect(resolve(true, { [ACCOUNT_CONFIG_ENV.apiBaseUrl]: 'https://api.example.com' })).toBeNull();
    expect(resolve(true, env('', ''))).toBeNull();
    expect(resolve(true, env('https://api.example.com'))).toEqual({ apiBase: 'https://api.example.com', jwks: JWKS });
  });

  test('config-packaged-requires-https', () => {
    for (const base of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://api.example.com', 'ftp://api.example.com', 'file:///x']) {
      expect(resolve(true, env(base)), base).toBeNull();
    }
    expect(resolve(true, env('https://api.example.com:8443'))?.apiBase).toBe('https://api.example.com:8443');
  });

  test('config-unpackaged-allows-loopback-http', () => {
    expect(resolve(false, env('http://127.0.0.1:8787'))?.apiBase).toBe('http://127.0.0.1:8787');
    expect(resolve(false, env('http://localhost:8787'))?.apiBase).toBe('http://localhost:8787');
    expect(resolve(false, env('https://api.example.com'))?.apiBase).toBe('https://api.example.com');
    for (const base of ['http://api.example.com', 'http://10.0.0.1:8787', 'http://[::1]:8787', 'http://127.0.0.2']) {
      expect(resolve(false, env(base)), base).toBeNull();
    }
  });

  test('config-runtime-env-only-unpackaged', () => {
    const runtime = env('http://127.0.0.1:9999');
    expect(resolve(false, {}, runtime)).toEqual({ apiBase: 'http://127.0.0.1:9999', jwks: JWKS });
    expect(resolve(false, { [ACCOUNT_CONFIG_ENV.apiBaseUrl]: '', [ACCOUNT_CONFIG_ENV.entitlementJwks]: '' }, runtime)?.apiBase).toBe('http://127.0.0.1:9999');
    expect(resolve(true, {}, runtime)).toBeNull();
    expect(resolve(true, {}, env('https://api.example.com'))).toBeNull();
  });

  test('config-baked-build-ignores-runtime', () => {
    const otherKeys = JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'B'.repeat(43), kid: 'attacker' }] });
    const runtime = env('http://127.0.0.1:9999', otherKeys);
    for (const isPackaged of [true, false]) {
      // Both baked in: the run-time environment changes nothing.
      expect(resolve(isPackaged, env('https://built.example.com'), runtime), String(isPackaged)).toEqual({ apiBase: 'https://built.example.com', jwks: JWKS });
      // Either one baked in: the run-time environment is ignored for both (the other stays missing).
      expect(resolve(isPackaged, { [ACCOUNT_CONFIG_ENV.apiBaseUrl]: 'https://built.example.com' }, runtime)).toBeNull();
      expect(resolve(isPackaged, { [ACCOUNT_CONFIG_ENV.entitlementJwks]: JWKS_TEXT }, runtime)).toBeNull();
      // Even an invalid baked-in value pins the build: no fallback to the environment.
      expect(resolve(isPackaged, env('not a url', 'not json'), runtime)).toBeNull();
    }
  });

  test('config-api-base-is-origin-only', () => {
    expect(resolve(true, env('https://api.example.com/'))?.apiBase).toBe('https://api.example.com');
    for (const base of ['https://api.example.com/v1', 'https://api.example.com/?x=1', 'https://api.example.com/#x', 'https://user:pw@api.example.com', 'https://user@api.example.com', 'not a url', ' https://api.example.com']) {
      expect(resolve(true, env(base)), base).toBeNull();
    }
  });

  test('config-malformed-jwks-is-unconfigured', () => {
    for (const jwks of ['not json', '{}', '{"keys":[]}', JSON.stringify({ keys: [{ ...JWKS.keys[0], d: 'A'.repeat(43) }] }), JSON.stringify({ keys: [JWKS.keys[0], JWKS.keys[0]] })]) {
      expect(resolve(true, env('https://api.example.com', jwks)), jwks).toBeNull();
    }
  });
});
