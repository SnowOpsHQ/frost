import { createHash, randomBytes } from 'node:crypto';
import { requestFingerprint } from '@app/specs/account-api.schema';

// PKCE (RFC 7636, S256 only) and the nonces of one sign-in request (spec `account-api.schema.ts`,
// Desktop authorization; acceptance `account-signin.feature.md`, PKCE). Every value comes from
// `crypto.randomBytes`, base64url without padding (RFC 3986 unreserved characters only). Shared by the
// account sign-in and Search Console's OAuth (Task 8).

/** A PKCE verifier: 48 random bytes, 64 characters (`CODE_VERIFIER_PATTERN` allows 43 to 128). */
export function createVerifier(): string {
  return randomBytes(48).toString('base64url');
}

/** `BASE64URL(SHA-256(ASCII(verifier)))`: the S256 challenge (43 characters). */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A `state` nonce: 32 random bytes, 43 characters (`DESKTOP_STATE_PATTERN`). */
export function createState(): string {
  return randomBytes(32).toString('base64url');
}

/** A request ID: 16 random bytes, 22 characters (`ACCOUNT_REQUEST_ID_PATTERN`). Names a request; grants nothing. */
export function createRequestId(): string {
  return randomBytes(16).toString('base64url');
}

/** One sign-in request's values. `verifier` and `state` never leave main (nor reach a log). */
export interface SignInRequest {
  readonly requestId: string;
  readonly state: string;
  readonly verifier: string;
  readonly challenge: string;
  /** `requestFingerprint(challenge)`: what the browser page shows, for the user to compare. */
  readonly fingerprint: string;
}

export function createSignInRequest(): SignInRequest {
  const verifier = createVerifier();
  const challenge = challengeOf(verifier);
  return { requestId: createRequestId(), state: createState(), verifier, challenge, fingerprint: requestFingerprint(challenge) };
}
