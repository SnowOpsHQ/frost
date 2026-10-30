/**
 * The ChatGPT plan route's schemas (plan `docs/plans/agent-chatgpt-plan.md`, Task 1; values in
 * `agent-chatgpt.spec.ts`; acceptance `agent-chatgpt.feature.md`). Zod, for main only (the chrome
 * imports `agent-chatgpt.spec.ts`, which carries no token type at all).
 *
 * - `ChatgptStoredStateSchema`: what main keeps, encrypted (`CHATGPT_CREDENTIALS_FILE`);
 * - `ChatgptHostFileSchema`: the host id's file (`CHATGPT_HOST_ID_FILE`, not secret);
 * - `ChatgptTokenAnswerSchema` / `ChatgptTokenErrorSchema`: the token endpoint's answers;
 * - `ChatgptCallbackSchema`: the redirect's parameters (its `state` already checked by the listener);
 * - `ChatgptIdTokenHeaderSchema` / `ChatgptIdTokenClaimsSchema`: the parts of an ID token frost reads;
 * - `ChatgptJwkSchema`: a signing key frost may use; `ChatgptModelEntrySchema`: one model-list entry.
 *
 * The answers are parsed loosely (unknown fields dropped, as servers add fields); the stored state
 * strictly (anything else is discarded).
 */
import { z } from 'zod';
import { advertisedEfforts, CHATGPT_ADVERTISED_EFFORTS_FIELD, CHATGPT_ID_TOKEN_ALG, CHATGPT_LIMITS, isChatgptHostId, isChatgptSlug, isIssuedClientId } from './agent-chatgpt.spec';

const L = CHATGPT_LIMITS;

/** A token as frost accepts it: bounded printable ASCII (JWTs and opaque refresh tokens are). */
export const ChatgptTokenSchema = z.string().min(1).max(L.maxTokenChars).regex(/^[\x21-\x7e]+$/);
/** A granted scope value (one word of `scope`). */
const ScopeWordSchema = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);
const EmailSchema = z.string().min(3).max(L.maxEmailChars).regex(/^[^\s@]+@[^\s@]+$/);
const SubjectSchema = z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/);
const EpochMs = z.int().nonnegative();

/** `earliest_refresh_at`: Unix seconds, or an ISO date-time; read as epoch milliseconds (`earliestRefreshAtMs`). */
const EarliestRefreshAtSchema = z.union([z.number().nonnegative().max(1e11), z.string().max(64)]);

/** The token endpoint's success answer (authorization code or refresh grant). */
export const ChatgptTokenAnswerSchema = z.object({
  access_token: ChatgptTokenSchema,
  /** Always on a code exchange with `offline_access`; a refresh answers a replacement (kept when absent). */
  refresh_token: ChatgptTokenSchema.optional(),
  /** Always on a code exchange; a refresh may answer one (checked like the first, without the nonce). */
  id_token: ChatgptTokenSchema.optional(),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.int().positive().max(L.maxExpiresInSeconds),
  /** Space-separated granted scopes. */
  scope: z.string().max(2048).optional(),
  earliest_refresh_at: EarliestRefreshAtSchema.optional(),
});
export type ChatgptTokenAnswer = z.infer<typeof ChatgptTokenAnswerSchema>;

/** The token endpoint's (or revocation endpoint's) OAuth error answer. */
export const ChatgptTokenErrorSchema = z.object({ error: z.string().min(1).max(128) });

/** `earliest_refresh_at` as epoch milliseconds, or `null` (absent or unreadable: no lower bound). */
export function earliestRefreshAtMs(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms) : null;
}

/** The redirect's parameters besides `state` (checked by the listener) and `code` / `error`. */
export const ChatgptCallbackSchema = z.object({
  /** A first registration's issued client id (`oaiapp_…`); a returning sign-in may omit it. */
  client_id: z.string().max(256).optional(),
  scope: z.string().max(2048).optional(),
});

/** The ID token's header: RS256 only, with the key id frost looks up in the JWKS. */
export const ChatgptIdTokenHeaderSchema = z.object({
  alg: z.literal(CHATGPT_ID_TOKEN_ALG),
  kid: z.string().min(1).max(256).optional(),
  typ: z.string().max(64).optional(),
});

/** The ID token's claims frost reads (the signature is checked first; `verifyIdToken` checks the values). */
export const ChatgptIdTokenClaimsSchema = z.object({
  iss: z.string().max(256),
  sub: SubjectSchema,
  aud: z.union([z.string().max(256), z.array(z.string().max(256)).min(1).max(16)]),
  exp: z.number(),
  iat: z.number(),
  nbf: z.number().optional(),
  nonce: z.string().max(256).optional(),
  azp: z.string().max(256).optional(),
  email: z.string().max(L.maxEmailChars).optional(),
});
export type ChatgptIdTokenClaims = z.infer<typeof ChatgptIdTokenClaimsSchema>;

/** An RSA signing key from the JWKS (others are skipped). */
export const ChatgptJwkSchema = z.object({
  kty: z.literal('RSA'),
  kid: z.string().min(1).max(256).optional(),
  use: z.literal('sig').optional(),
  alg: z.literal(CHATGPT_ID_TOKEN_ALG).optional(),
  n: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/),
  e: z.string().min(1).max(16).regex(/^[A-Za-z0-9_-]+$/),
});
export type ChatgptJwk = z.infer<typeof ChatgptJwkSchema>;

/**
 * One entry of `GET /v1/models` (`{ models: [...] }`): kept only when it parses and `visibility === 'list'`.
 * Its advertised reasoning levels (`CHATGPT_ADVERTISED_EFFORTS_FIELD`, optional; Phase 8 Task 8a)
 * are read leniently, never failing the entry: `advertisedEfforts` keeps at most the four known
 * levels, and none (absent, empty, unknown or malformed) leaves no `efforts` key (Auto only).
 */
export const ChatgptModelEntrySchema = z
  .object({
    slug: z.string().refine(isChatgptSlug),
    display_name: z
      .string()
      .max(L.maxDisplayNameChars)
      .refine((name) => name.trim() !== '' && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u.test(name)),
    visibility: z.string().max(64),
    [CHATGPT_ADVERTISED_EFFORTS_FIELD]: z.unknown().optional(),
  })
  .transform(({ slug, display_name, visibility, [CHATGPT_ADVERTISED_EFFORTS_FIELD]: advertised }) => {
    const efforts = advertisedEfforts(advertised);
    return { slug, display_name, visibility, ...(efforts.length > 0 ? { efforts } : {}) };
  });

// ---- Stored --------------------------------------------------------------------------------

/** The host id's file: not secret, but written atomically with mode 0600 like the others. */
export const ChatgptHostFileSchema = z.strictObject({ v: z.literal(1), hostId: z.string().refine(isChatgptHostId) });

/** A token set main holds. Times are epoch milliseconds (main's clock when the answer arrived). */
export const ChatgptStoredTokensSchema = z.strictObject({
  accessToken: ChatgptTokenSchema,
  refreshToken: ChatgptTokenSchema,
  /** The last verified ID token (kept for its identity; never sent anywhere but the authorize page, and frost does not send it yet). */
  idToken: ChatgptTokenSchema,
  expiresAt: EpochMs,
  /** Not refreshed before this (`earliest_refresh_at`), `null` for no bound. */
  earliestRefreshAt: EpochMs.nullable(),
  /** The granted scopes. */
  scopes: z.array(ScopeWordSchema).max(32),
  savedAt: EpochMs,
});
export type ChatgptStoredTokens = z.infer<typeof ChatgptStoredTokensSchema>;

/**
 * The sign-in, as main stores it (encrypted with `safeStorage`, OS keychain only). One account (v1):
 * - `clientId`: the issued client id, saved before the first code exchange and kept through
 *   sign-out and expiry (the next sign-in reuses it); `null` before the first registration;
 * - `account`: the verified ID token's `sub` (a returning sign-in must match it) and email;
 * - `tokens`: `null` when signed out or expired; `expired`: a refresh was refused;
 * - `acknowledged`: the one-time notice was dismissed (kept through sign-out).
 */
export const ChatgptStoredStateSchema = z.strictObject({
  v: z.literal(1),
  clientId: z.string().refine(isIssuedClientId).nullable(),
  account: z.strictObject({ sub: SubjectSchema, email: EmailSchema.nullable() }).nullable(),
  tokens: ChatgptStoredTokensSchema.nullable(),
  expired: z.boolean(),
  acknowledged: z.boolean(),
});
export type ChatgptStoredState = z.infer<typeof ChatgptStoredStateSchema>;

/** The state of a fresh install (nothing registered). */
export const EMPTY_CHATGPT_STATE: ChatgptStoredState = { v: 1, clientId: null, account: null, tokens: null, expired: false, acknowledged: false };
