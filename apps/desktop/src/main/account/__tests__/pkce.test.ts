// Spec: specs/account-api.schema.ts (CODE_VERIFIER_PATTERN, CODE_CHALLENGE_PATTERN, DESKTOP_STATE_PATTERN,
// DESKTOP_STATE_LIMITS, requestFingerprint), specs/account-state.schema.ts (ACCOUNT_REQUEST_ID_PATTERN)
// Acceptance: specs/account-signin.feature.md (PKCE)
import { describe, expect, test } from 'vitest';
import {
  CODE_CHALLENGE_PATTERN,
  CODE_VERIFIER_PATTERN,
  DESKTOP_STATE_LIMITS,
  DESKTOP_STATE_PATTERN,
  requestFingerprint,
} from '@app/specs/account-api.schema';
import { ACCOUNT_REQUEST_ID_PATTERN } from '@app/specs/account-state.schema';
import { challengeOf, createSignInRequest } from '../pkce';

describe('pkce', () => {
  test('pkce-verifier-shape', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const request = createSignInRequest();
      expect(request.verifier).toMatch(CODE_VERIFIER_PATTERN);
      expect(request.state).toMatch(DESKTOP_STATE_PATTERN);
      expect(request.state.length).toBeGreaterThanOrEqual(DESKTOP_STATE_LIMITS.minLength);
      expect(request.state.length).toBeLessThanOrEqual(DESKTOP_STATE_LIMITS.maxLength);
      expect(request.requestId).toMatch(ACCOUNT_REQUEST_ID_PATTERN);
      expect(request.challenge).toBe(challengeOf(request.verifier));
      expect(request.fingerprint).toBe(requestFingerprint(request.challenge));
      for (const value of [request.verifier, request.state, request.requestId]) {
        expect(seen.has(value)).toBe(false);
        seen.add(value);
      }
    }
  });

  test('pkce-challenge-is-s256', () => {
    // RFC 7636 Appendix B.
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(challengeOf(createSignInRequest().verifier)).toMatch(CODE_CHALLENGE_PATTERN);
  });
});
