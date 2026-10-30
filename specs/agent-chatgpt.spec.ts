/**
 * The agent's ChatGPT plan route: Sign in with ChatGPT, open-source token sharing (plan
 * `docs/plans/agent-chatgpt-plan.md`, Task 1; acceptance `agent-chatgpt.feature.md`). Plain values,
 * types and pure functions with no Zod and **no imports** but `agent-reasoning.spec.ts`'s plain
 * values (itself import-free at runtime: types only), so the chrome renderer imports them as
 * they are (strict Trusted Types) and `agent-tools.spec.ts` can use `isChatgptModelId` without a
 * cycle. The Zod schemas (the stored state, the token endpoint's answers, the redirect's parameters,
 * the ID token's claims, the model list) are in `agent-chatgpt.schema.ts`, for main only.
 *
 * Main owns every token (`apps/desktop/src/main/agent/chatgpt/`): the renderer sees only
 * `ChatgptAccountView` (state, email, plan usage, the one-time notice), the runtime and the model
 * never see a token, and nothing here is a credential. Endpoints are fixed constants; main fetches
 * them on its own in-memory session partition (`CHATGPT_PARTITION`) with `redirect: 'error'` and
 * `credentials: 'omit'`.
 *
 * Written clean-room from OpenAI's published protocol (Sign in with ChatGPT, token sharing for
 * open-source tools; the OpenID discovery document); no code from any SDK or devkit.
 */
import { REASONING_EFFORTS, type ReasoningEffort } from './agent-reasoning.spec';

// ---- Endpoints -------------------------------------------------------------------------------

/** The OpenID issuer (`iss` of every ID token frost accepts). */
export const CHATGPT_ISSUER = 'https://auth.openai.com';

/**
 * Every URL the ChatGPT route reaches, as exact canonical strings (`new URL(url).href === url`):
 * the authorization page (opened in the system browser, never fetched), the token, revocation and
 * key endpoints (the discovery document's), the account's model list and the one inference endpoint
 * (the model proxy's, `MODEL_REQUESTS.chatgpt`).
 */
export const CHATGPT_ENDPOINTS = {
  issuer: CHATGPT_ISSUER,
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  revoke: 'https://auth.openai.com/api/accounts/oauth/revoke',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  models: 'https://api.openai.com/v1/models',
  responses: 'https://api.openai.com/v1/responses',
} as const;
export type ChatgptEndpoints = { readonly [K in keyof typeof CHATGPT_ENDPOINTS]: string };

// ---- Authorization ---------------------------------------------------------------------------

/** The `client_id` of a first registration (never stored, never used for a token request). */
export const CHATGPT_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
/** `agent_name_hint` on a first registration only: the app's actual name, the same on every install. */
export const CHATGPT_AGENT_NAME = 'frost';
/** The scope that lets frost run requests on the user's ChatGPT plan. */
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
/** Every scope frost asks for, in order: identity, then plan usage. */
export const CHATGPT_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', CHATGPT_PLAN_SCOPE] as const;
/** The authorize request's `scope` (space-separated). */
export const CHATGPT_SCOPE = CHATGPT_SCOPES.join(' ');
/** The `resource` of the authorize, code exchange and refresh requests. */
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
/** The ID token's only accepted signature algorithm. */
export const CHATGPT_ID_TOKEN_ALG = 'RS256';

/**
 * The redirect: `http://127.0.0.1:<port>/auth/callback`. Only the port varies; never `localhost`;
 * the same string in the authorize request and the code exchange (main's loopback listener,
 * `main/account/loopback.ts`, with this path).
 */
export const CHATGPT_REDIRECT_HOST = '127.0.0.1';
export const CHATGPT_REDIRECT_PATH = '/auth/callback';
/** Whether `uri` is a redirect frost would send: `http://127.0.0.1:<1024–65535>/auth/callback`, nothing else. */
export function isChatgptRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/auth\/callback$/.exec(uri);
  return match !== null && Number(match[1]) >= 1024 && Number(match[1]) <= 65_535;
}

/**
 * An issued client id as frost accepts it from the redirect (OpenAI's are `oaiapp_…`; frost only
 * bounds the characters and length, and never takes `CHATGPT_DYNAMIC_CLIENT_ID` as one).
 */
export const CHATGPT_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
export function isIssuedClientId(value: unknown): value is string {
  return typeof value === 'string' && CHATGPT_CLIENT_ID_PATTERN.test(value) && value !== CHATGPT_DYNAMIC_CLIENT_ID;
}

/**
 * The host id: generated once per install as `urn:uuid:<uuidv4>` (lower-case), stored in
 * `userData` (`CHATGPT_HOST_ID_FILE`) before the first sign-in and sent as `ext_agent_host_id` on
 * every authorize request. Opaque; not a credential, not derived from the user.
 */
export const CHATGPT_HOST_ID_FILE = 'agent-chatgpt-host.json';
export const CHATGPT_HOST_ID_PATTERN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isChatgptHostId(value: unknown): value is string {
  return typeof value === 'string' && CHATGPT_HOST_ID_PATTERN.test(value);
}

/** The encrypted sign-in state (`ChatgptStoredStateSchema`), with the model keys' rules: mode 0600, atomic writes, OS keychain only. */
export const CHATGPT_CREDENTIALS_FILE = 'agent-chatgpt-credentials.json';
/** The in-memory session the auth and model-list requests go out on (no `persist:` prefix). */
export const CHATGPT_PARTITION = 'agent-chatgpt';

// ---- Timing and bounds -----------------------------------------------------------------------

/**
 * An access token is refreshed this long before it expires (never before `earliest_refresh_at`,
 * which is read as at most `expiresAt - CHATGPT_REFRESH_MARGIN_MS`, so it can't hold a refresh past
 * expiry).
 */
export const CHATGPT_REFRESH_MARGIN_MS = 60_000;

export const CHATGPT_LIMITS = {
  /** How long a sign-in waits for the browser's redirect. */
  signInTimeoutMs: 10 * 60_000,
  /** Each call to the auth server or the model list. */
  requestTimeoutMs: 30_000,
  /** An answer's body, at most (bytes); a longer one is refused unread. */
  maxResponseBytes: 256 * 1024,
  /**
   * The model list's body, at most (bytes). Live answers carry each model's metadata and run well
   * past `maxResponseBytes` (seen 2026-10-29), so the list has its own, larger bound.
   */
  maxModelListBytes: 8 * 1024 * 1024,
  /** A token (access, refresh or ID; characters). */
  maxTokenChars: 16_384,
  /**
   * Clock skew allowed when checking an ID token's `exp`, `iat` and `nbf` (milliseconds): a user's
   * clock a few minutes off must not fail every sign-in. A refreshed ID token that fails only on
   * time keeps the new tokens and the last verified identity (`agent-chatgpt.feature.md`).
   */
  clockSkewMs: 300_000,
  /** The longest `expires_in` believed (seconds; access tokens live an hour). */
  maxExpiresInSeconds: 24 * 60 * 60,
  /**
   * Keys kept from the JWKS document; how soon an unknown `kid` (or a failed fetch) may fetch it
   * again; and how long a fetched document is trusted before it is fetched again (a key the issuer
   * rotated out stops being accepted).
   */
  maxJwksKeys: 16,
  jwksRefetchMs: 60_000,
  jwksTtlMs: 24 * 60 * 60_000,
  /**
   * After a refresh fails without ending the sign-in (no answer, `5xx`, an unusable answer), no new
   * refresh is tried for this long: requests meanwhile use the current token while it lasts, or fail.
   */
  refreshBackoffMs: 30_000,
  /** Revocation attempts at sign-out (a network failure or `5xx` is retried), and the waits between them. */
  revokeAttempts: 3,
  revokeBackoffMs: [500, 2_000],
  /**
   * A Responses error answer main reads to find its code (bytes; the rest is not read), and one
   * streamed event main looks into for a `response.failed` (bytes; a longer event is skipped).
   */
  maxErrorBodyBytes: 16 * 1024,
  maxStreamEventBytes: 64 * 1024,
  /** Models kept from the account's list, and each one's bounds. */
  maxModels: 64,
  maxDisplayNameChars: 200,
  /** An email shown in the settings (characters). */
  maxEmailChars: 320,
  /** The stored state's text, at most (characters), and its file (bytes). */
  maxStoredChars: 64 * 1024,
  maxFileBytes: 128 * 1024,
} as const;

// ---- Errors ----------------------------------------------------------------------------------

/**
 * What the panel can say about a failed ChatGPT request (Task 3 maps responses to these):
 * - `usage-limit`: the plan's (or frost's) usage limit is reached: "Manage usage" first;
 * - `plan-unavailable`: usage or the user's plan couldn't be checked: retry later;
 * - `not-eligible`: this account or workspace can't use its plan in other apps;
 * - `plan-usage-off`: the grant doesn't cover plan usage: sign in again to turn it on (re-consent);
 * - `unsupported`: frost sent something the route doesn't take: a bug to report (with `error.param`);
 * - `signed-out`: the sign-in ended (a refresh was refused): sign in again.
 */
export const CHATGPT_ERROR_REASONS = ['usage-limit', 'plan-unavailable', 'not-eligible', 'plan-usage-off', 'unsupported', 'signed-out'] as const;
export type ChatgptErrorReason = (typeof CHATGPT_ERROR_REASONS)[number];

/** Responses `error.code` values with a specific recovery, and the reason each maps to. Any other code is a plain failure. */
export const CHATGPT_ERROR_CODE_REASONS: Readonly<Record<string, ChatgptErrorReason>> = {
  subscription_sharing_usage_limit_exceeded: 'usage-limit',
  subscription_sharing_usage_unavailable: 'plan-unavailable',
  subscription_sharing_user_unavailable: 'plan-unavailable',
  subscription_sharing_user_not_eligible: 'not-eligible',
  chatpass_v2_scope_not_authorized: 'plan-usage-off',
  chatpass_v2_invalid_authorization_context: 'plan-usage-off',
  subscription_sharing_unsupported_capability: 'unsupported',
  subscription_sharing_route_not_supported: 'unsupported',
};

/** The reason for a Responses `error.code`, or `null` (an ordinary failure). Never throws. */
export function chatgptErrorReason(code: unknown): ChatgptErrorReason | null {
  return typeof code === 'string' && Object.hasOwn(CHATGPT_ERROR_CODE_REASONS, code) ? CHATGPT_ERROR_CODE_REASONS[code]! : null;
}

/**
 * A ChatGPT plan failure as the session reports it on the turn (`AgentActiveChatView.chatgptError`):
 * its reason, and for `unsupported` the `error.param` OpenAI named (the bug report needs it). Main
 * finds it in the Responses answer (`chatgptAnswerFailure`), in a streamed `response.failed`
 * (`chatgptStreamFailure`), or in the sign-in (`signed-out`, `plan-usage-off`); never in the
 * runtime's words.
 */
export interface ChatgptFailure {
  readonly reason: ChatgptErrorReason;
  readonly param?: string;
}

/**
 * `error.param` as frost passes it on: a request field path (`tools[0].type`, `input.3.content`):
 * letters, digits, `_`, `.`, `[` and `]`, 128 characters at most. Anything else (a quote, a URL, a
 * space, a value echoed back) is dropped, so upstream text can't reach the chat beyond a field path.
 */
export const CHATGPT_ERROR_PARAM_PATTERN = /^[A-Za-z0-9_.[\]]{1,128}$/;

/**
 * Direct-admission answers (a `{ detail }` body and no `error.code`, before a response starts), by
 * status: `401` (the signed identity or plan permission wasn't accepted: sign in again and allow
 * plan usage), `403` (a policy, such as the serving region), `503` (direct routing unavailable: retry
 * later). The `detail` text is diagnostic: never shown, logged or passed on.
 */
export const CHATGPT_DETAIL_STATUS_REASONS: Readonly<Record<number, ChatgptErrorReason>> = {
  401: 'plan-usage-off',
  403: 'not-eligible',
  503: 'plan-unavailable',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{ code, param }` as a failure (its `param` kept only for `unsupported`, and only when well-formed). */
function failureOfCode(error: unknown): ChatgptFailure | null {
  if (!isRecord(error)) return null;
  const reason = chatgptErrorReason(error.code);
  if (reason === null) return null;
  const param = error.param;
  return reason === 'unsupported' && typeof param === 'string' && CHATGPT_ERROR_PARAM_PATTERN.test(param) ? { reason, param } : { reason };
}

/**
 * The failure a Responses error answer (`status` ≥ 400, its parsed JSON `body`) stands for: a
 * documented `error.code` (`CHATGPT_ERROR_CODE_REASONS`), else a direct-admission `{ detail }` by
 * status (`CHATGPT_DETAIL_STATUS_REASONS`), else `null` (an ordinary failure). Never throws.
 */
export function chatgptAnswerFailure(status: number, body: unknown): ChatgptFailure | null {
  if (!Number.isInteger(status) || status < 400 || !isRecord(body)) return null;
  const coded = failureOfCode(body.error);
  if (coded !== null) return coded;
  if (body.error === undefined && typeof body.detail === 'string' && Object.hasOwn(CHATGPT_DETAIL_STATUS_REASONS, status)) return { reason: CHATGPT_DETAIL_STATUS_REASONS[status]! };
  return null;
}

/**
 * The failure a streamed Responses event (its parsed `data`) stands for: `response.failed` with a
 * documented `response.error.code` (a usage limit can arrive after streaming began), or an `error`
 * event with one (`code` at the top or under `error`). `null` for anything else. Never throws.
 */
export function chatgptStreamFailure(event: unknown): ChatgptFailure | null {
  if (!isRecord(event)) return null;
  if (event.type === 'response.failed') return isRecord(event.response) ? failureOfCode(event.response.error) : null;
  if (event.type === 'error') return failureOfCode(event) ?? failureOfCode(event.error);
  return null;
}

/** What the chat says for a failure: the reason's message, and for `unsupported` the param named. */
export function chatgptFailureMessage(failure: ChatgptFailure): string {
  const message = CHATGPT_ERROR_MESSAGES[failure.reason];
  return failure.reason === 'unsupported' && failure.param !== undefined ? `${message} (${failure.param})` : message;
}

/**
 * Token-endpoint `error` codes that mean the refresh token is unusable: the sign-in becomes
 * `expired` (tokens forgotten; the issued client id and the host id kept for the next sign-in).
 * Any other refresh failure (network, `5xx`) keeps the tokens.
 */
export const CHATGPT_REFRESH_FAILURE_CODES = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'] as const;
export function isRefreshFailureCode(code: unknown): boolean {
  return typeof code === 'string' && (CHATGPT_REFRESH_FAILURE_CODES as readonly string[]).includes(code);
}

// ---- Models ----------------------------------------------------------------------------------

/**
 * A ChatGPT model id: `chatgpt/<slug>`, the slug as the account's model list names it. These ids are
 * open-ended (the account decides), so they are **not** in `ALLOWED_MODEL_IDS` and not a `ModelId`:
 * `ModelId` stays the closed catalogue union (every `Record<ModelId, …>` stays total), and
 * `AgentModelId = ModelId | ChatgptModelId` (`agent-tools.spec.ts`) is what settings, `chat.start`
 * and the views carry. The two sets can't overlap (catalogue ids start `anthropic/` or `openai/`).
 * A ChatGPT id is valid for a turn only while its slug is in the account's last model list (main).
 */
export const CHATGPT_MODEL_PREFIX = 'chatgpt/';
export type ChatgptModelId = `chatgpt/${string}`;
/** A slug: a letter or digit, then letters, digits, `.`, `_`, `-` or `:` (64 characters at most). */
export const CHATGPT_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isChatgptSlug(value: unknown): value is string {
  return typeof value === 'string' && CHATGPT_SLUG_PATTERN.test(value);
}

/** Whether `value` is `chatgpt/<slug>` with a well-formed slug. */
export function isChatgptModelId(value: unknown): value is ChatgptModelId {
  return typeof value === 'string' && value.startsWith(CHATGPT_MODEL_PREFIX) && isChatgptSlug(value.slice(CHATGPT_MODEL_PREFIX.length));
}

/** `chatgpt/<slug>`, or `null` for a malformed slug. */
export function chatgptModelId(slug: string): ChatgptModelId | null {
  return isChatgptSlug(slug) ? `chatgpt/${slug}` : null;
}

/** The slug of a ChatGPT model id (what the Responses request's `model` carries). */
export function chatgptSlugOf(modelId: ChatgptModelId): string {
  return modelId.slice(CHATGPT_MODEL_PREFIX.length);
}

/**
 * The reasoning levels a ChatGPT model entry may advertise (Phase 8 Task 8a, Decision 8): every
 * level but `auto`, which is always offered and never stored. `off` is sent as `minimal`
 * (`reasoningWire`).
 */
export const CHATGPT_ADVERTISED_EFFORTS = ['off', 'low', 'medium', 'high'] as const satisfies readonly ReasoningEffort[];
export type ChatgptAdvertisedEffort = (typeof CHATGPT_ADVERTISED_EFFORTS)[number];

/**
 * The `GET /v1/models` entry field read for a model's supported reasoning levels (Open question 1,
 * lead ruling): optional; its items are level strings or objects with an `effort` string (Codex's
 * `supported_reasoning_levels` shape). Named once here, so a live check can rename it.
 */
export const CHATGPT_ADVERTISED_EFFORTS_FIELD = 'supported_reasoning_levels';

/**
 * The room a model entry's `efforts` takes in the settings file, at most (bytes): the worst case,
 * `,"efforts":["off","low","medium","high"]`, is 40 bytes.
 */
export const CHATGPT_EFFORTS_ENTRY_MAX_BYTES = 64;

/**
 * The levels an entry's `CHATGPT_ADVERTISED_EFFORTS_FIELD` value advertises, bounded: only
 * `CHATGPT_ADVERTISED_EFFORTS` values (from strings, or objects' `effort` strings), each once, in
 * `REASONING_EFFORTS` order, so at most 4. Anything else (absent, not a list, `auto`, an unknown
 * level such as `minimal` or `xhigh`) is dropped; `[]` means Auto only.
 */
export function advertisedEfforts(value: unknown): ChatgptAdvertisedEffort[] {
  if (!Array.isArray(value)) return [];
  const found = new Set<string>();
  for (const item of value) {
    const effort = typeof item === 'string' ? item : typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as { effort?: unknown }).effort : undefined;
    if (typeof effort === 'string') found.add(effort);
  }
  return REASONING_EFFORTS.filter((effort): effort is ChatgptAdvertisedEffort => effort !== 'auto' && found.has(effort));
}

/** A model the account lists (`visibility: 'list'`), in the server's order. */
export interface ChatgptModelView {
  readonly id: ChatgptModelId;
  /** The list's `display_name`. */
  readonly label: string;
  /**
   * The reasoning levels the entry advertised (`advertisedEfforts`), when any: absent means the
   * model offers Auto only (Phase 8 Task 8a).
   */
  readonly efforts?: readonly ReasoningEffort[];
}

/** Whether `value` is a non-empty list of distinct `CHATGPT_ADVERTISED_EFFORTS`, in that order. */
function isAdvertisedEffortList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHATGPT_ADVERTISED_EFFORTS.length) return false;
  let last = -1;
  for (const effort of value) {
    const at = (CHATGPT_ADVERTISED_EFFORTS as readonly unknown[]).indexOf(effort);
    if (at <= last) return false;
    last = at;
  }
  return true;
}

/**
 * Whether `value` is a model-list entry as main keeps it (the settings file persists the last list,
 * so a restart without network keeps the choice): exactly `{ id, label }`, or `{ id, label,
 * efforts }` with `efforts` a non-empty list of distinct `CHATGPT_ADVERTISED_EFFORTS` in that order
 * (a file of the build before the levels has 2-key entries and still reads); a well-formed ChatGPT
 * id and a trimmed, non-empty label within `maxDisplayNameChars` with no control or format character.
 */
export function isChatgptModelView(value: unknown): value is ChatgptModelView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.includes('id') || !keys.includes('label')) return false;
  if (keys.length === 3 ? !keys.includes('efforts') || !isAdvertisedEffortList((value as { efforts: unknown }).efforts) : keys.length !== 2) return false;
  const { id, label } = value as { id: unknown; label: unknown };
  return (
    isChatgptModelId(id) &&
    typeof label === 'string' &&
    label !== '' &&
    label === label.trim() &&
    label.length <= CHATGPT_LIMITS.maxDisplayNameChars &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u.test(label)
  );
}

// ---- Requests --------------------------------------------------------------------------------

/**
 * The tool namespace every tool is grouped in on this route (the route takes function tools only
 * inside a namespace): the runtime sets `providerOptions.openai.namespace` to it on each tool, and
 * the model proxy accepts no other namespace name.
 */
export const CHATGPT_TOOL_NAMESPACE = { name: 'frost', description: "frost's browser and SEO tools, and the MCP tools the user connected." } as const;

/**
 * Responses body fields the route refuses (OpenAI's preview limitations): never sent, and refused by
 * the model proxy if they are (`BODY_FIELDS.chatgpt` excludes them).
 */
export const CHATGPT_FORBIDDEN_BODY_FIELDS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
] as const;

// ---- The renderer's view ---------------------------------------------------------------------

/**
 * - `signed-out`: no tokens (never signed in, or signed out);
 * - `pending`: a sign-in is waiting for the browser (or exchanging the code);
 * - `signed-in`: tokens held;
 * - `expired`: a refresh was refused: sign in again (the issued client id is kept).
 */
export const CHATGPT_AUTH_STATES = ['signed-out', 'pending', 'signed-in', 'expired'] as const;
export type ChatgptAuthState = (typeof CHATGPT_AUTH_STATES)[number];

/** Whether the grant covers plan usage (`CHATGPT_PLAN_SCOPE` granted) or the user declined it. */
export const CHATGPT_PLAN_USAGES = ['on', 'declined'] as const;
export type ChatgptPlanUsage = (typeof CHATGPT_PLAN_USAGES)[number];

/** Plan usage for a granted `scope` (space-separated): `on` only when it holds `CHATGPT_PLAN_SCOPE`. */
export function planUsageOf(scope: string | readonly string[]): ChatgptPlanUsage {
  const scopes = typeof scope === 'string' ? scope.split(/\s+/) : scope;
  return scopes.includes(CHATGPT_PLAN_SCOPE) ? 'on' : 'declined';
}

/**
 * Why the last sign-in failed (cleared by the next one):
 * - `cancelled`: the user cancelled in frost; `declined`: the browser answered `access_denied`;
 * - `timed-out`: no redirect within `signInTimeoutMs`; `browser-failed`: the browser couldn't open;
 * - `registration-incomplete`: a first registration's redirect carried no issued client id;
 * - `client-mismatch`: the redirect named another client than the saved one;
 * - `exchange-failed`: the code exchange was refused or answered something unusable;
 * - `id-token`: the ID token failed a check (signature, issuer, audience, nonce, expiry);
 * - `account-mismatch`: a returning sign-in came back as another ChatGPT account;
 * - `no-keychain`: no OS keychain to store tokens; `store-failed`: writing them failed;
 * - `store-unreadable`: a saved sign-in exists but couldn't be read (the keychain refused it): it is
 *   not overwritten, so no sign-in starts until it can be read again;
 * - `network`: the auth server couldn't be reached.
 */
export const CHATGPT_SIGN_IN_ERRORS = [
  'cancelled',
  'declined',
  'timed-out',
  'browser-failed',
  'registration-incomplete',
  'client-mismatch',
  'exchange-failed',
  'id-token',
  'account-mismatch',
  'no-keychain',
  'store-failed',
  'store-unreadable',
  'network',
] as const;
export type ChatgptSignInError = (typeof CHATGPT_SIGN_IN_ERRORS)[number];

/** The account as the renderer sees it: no token, no client id, no host id, no `sub`. */
export interface ChatgptAccountView {
  readonly state: ChatgptAuthState;
  /** The signed-in (or expired) account's email, from its verified ID token. */
  readonly email?: string;
  /** Only while `signed-in`. */
  readonly planUsage?: ChatgptPlanUsage;
  /** Whether the user dismissed the one-time "You're using your ChatGPT plan" notice. */
  readonly acknowledged: boolean;
  /** Why the last sign-in failed, until the next one starts. */
  readonly error?: ChatgptSignInError;
}

/**
 * `chatgptSignIn`'s answer: started (the browser is open), or why not. `needs-gesture`: the sender's
 * window had no live user gesture to spend (nothing opened; the button must be clicked).
 * `not-revoked`: "Use a different account" stopped because ChatGPT didn't confirm the held account's
 * sign-out: nothing was forgotten (the tokens and the registration stay, so the next try revokes
 * again) and no browser opened.
 */
export const CHATGPT_SIGN_IN_RESULTS = ['started', 'no-keychain', 'browser-failed', 'needs-gesture', 'not-revoked', 'failed'] as const;
export type ChatgptSignInResult = (typeof CHATGPT_SIGN_IN_RESULTS)[number];

/**
 * Whether `url` is a sign-in page frost may open in the system browser: the authorize endpoint
 * with a query, nothing else (main's opener refuses every other URL, even an allowlisted scheme).
 */
export function isChatgptAuthorizeUrl(url: unknown, authorize: string = CHATGPT_ENDPOINTS.authorize): url is string {
  return typeof url === 'string' && url.length <= 8192 && url.startsWith(`${authorize}?`);
}

/** `chatgptSignOut`'s answer: `signed-out` (revocation confirmed or nothing to revoke), `not-revoked` (forgotten here, but the server didn't confirm). */
export const CHATGPT_SIGN_OUT_RESULTS = ['signed-out', 'not-revoked'] as const;
export type ChatgptSignOutResult = (typeof CHATGPT_SIGN_OUT_RESULTS)[number];

// ---- Words (OpenAI's UI/UX guidelines, in frost's own sentences) -----------------------------

/** ChatGPT's usage settings, where the user reviews and limits plan usage. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

export const CHATGPT_UI = {
  routeLabel: 'ChatGPT plan',
  /** The sign-in button (the guidelines' wording). */
  continueButton: 'Continue with ChatGPT',
  settingsDescription: 'Run the agent on your ChatGPT Plus or Pro plan instead of an API key.',
  pending: 'Waiting for the browser…',
  cancel: 'Cancel',
  signOut: 'Sign out',
  /**
   * v1 keeps one ChatGPT account: this signs the current one out (revoking its tokens), forgets
   * frost's registration and signs in fresh, so another account can be used.
   */
  useDifferentAccount: 'Use a different account',
  signInAgain: 'Sign in again',
  signedInAs: 'Signed in as',
  planUsageOn: 'Plan usage is on: the agent runs on your ChatGPT plan.',
  needsGesture: 'Click the button to open your browser and sign in.',
  signInFailed: "frost couldn't start the sign-in. Try again.",
  expired: 'Your ChatGPT sign-in has ended. Sign in again to keep using your plan.',
  planUsageDeclined: "Plan usage is off for this sign-in, so the agent can't use your ChatGPT plan.",
  reconsentButton: 'Turn on plan usage',
  /** The one-time notice after the first sign-in with plan usage on. */
  noticeTitle: "You're using your ChatGPT plan",
  noticeBody: "The agent's requests now use your ChatGPT plan. You can review and limit that usage in ChatGPT's settings.",
  noticeButton: 'Got it',
  /** Near the composer while the route is active. */
  inUse: 'Using ChatGPT plan',
  manageUsage: 'Manage usage',
  usageLimitTitle: 'Usage limit reached',
  notRevoked: "Signed out here, but ChatGPT didn't confirm the sign-out. You can disconnect frost in ChatGPT's settings.",
  /** "Use a different account" when the held account's sign-out wasn't confirmed (`not-revoked`): nothing was switched. */
  switchNotRevoked: "ChatGPT didn't confirm the sign-out, so frost kept this account. Try again, or disconnect frost in ChatGPT's settings.",
  signedOut: 'Signed out of ChatGPT.',
  signOutFailed: "frost couldn't sign out of ChatGPT. Try again.",
  /** The one-time notice's "Got it" couldn't be stored. */
  acknowledgeFailed: "frost couldn't save that. Try again.",
  noKeychain: "No system keychain is available, so frost can't keep a ChatGPT sign-in here.",
  browserFailed: "frost couldn't open your browser to sign in.",
  /** The model select before the account listed any model. */
  signInToChooseModel: 'Sign in with ChatGPT to choose a model.',
  noModels: "ChatGPT hasn't listed any models for this account yet.",
  /** The setup checklist's sign-in line (in place of a key). */
  checklist: { 'signed-out': 'Not signed in', pending: 'Waiting for the browser…', 'signed-in': 'Signed in', expired: 'Sign-in ended', planUsageOff: 'Plan usage off' },
} as const;

/** What the panel says for each `ChatgptErrorReason` (`usage-limit` shows "Manage usage" as the primary action). */
export const CHATGPT_ERROR_MESSAGES: Readonly<Record<ChatgptErrorReason, string>> = {
  'usage-limit': 'Your ChatGPT plan, or its limit for frost, has reached its usage limit. Review it in ChatGPT settings.',
  'plan-unavailable': "ChatGPT couldn't check your plan just now. Try again in a little while.",
  'not-eligible': "This ChatGPT account can't use its plan in frost.",
  'plan-usage-off': 'Plan usage is off for this sign-in. Sign in again and allow it to use your ChatGPT plan.',
  unsupported: "ChatGPT refused part of frost's request. Please report this as a bug.",
  'signed-out': 'Your ChatGPT sign-in has ended. Sign in again.',
};

/** What the settings say for each `ChatgptSignInError`. */
export const CHATGPT_SIGN_IN_ERROR_MESSAGES: Readonly<Record<ChatgptSignInError, string>> = {
  cancelled: 'Sign-in cancelled.',
  declined: 'Sign-in was declined in the browser.',
  'timed-out': 'The browser did not finish signing in in time. Try again.',
  'browser-failed': "frost couldn't open your browser to sign in.",
  'registration-incomplete': "ChatGPT didn't finish registering frost. Try again.",
  'client-mismatch': 'ChatGPT answered for another registration. Try again.',
  'exchange-failed': "ChatGPT didn't accept the sign-in. Try again.",
  'id-token': "ChatGPT's answer couldn't be verified, so frost didn't use it.",
  'account-mismatch': 'That is a different ChatGPT account from the one frost is registered with. Choose "Use a different account" to switch.',
  'no-keychain': "No system keychain is available, so frost can't keep a ChatGPT sign-in here.",
  'store-failed': "frost couldn't save the sign-in. Try again.",
  'store-unreadable': "frost couldn't read the saved ChatGPT sign-in from the system keychain. Unlock the keychain, then try again.",
  network: "frost couldn't reach ChatGPT. Check your connection and try again.",
};

/**
 * Why a send on the `chatgpt` route can't start yet: its `setup-needed` notice says this instead of
 * `AGENT_NOTICE_MESSAGES['setup-needed']` (which is about keys). `choose-model`: models are listed,
 * but the chosen one isn't among them.
 */
export const CHATGPT_SETUP_REASONS = ['signed-out', 'pending', 'expired', 'plan-usage-off', 'no-models', 'choose-model'] as const;
export type ChatgptSetupReason = (typeof CHATGPT_SETUP_REASONS)[number];

export const CHATGPT_SETUP_MESSAGES: Readonly<Record<ChatgptSetupReason, string>> = {
  'signed-out': 'Sign in with ChatGPT in the agent settings first.',
  pending: 'Finish signing in with ChatGPT in your browser first.',
  expired: 'Your ChatGPT sign-in has ended. Sign in again in the agent settings.',
  'plan-usage-off': 'Plan usage is off for this sign-in. Turn on plan usage in the agent settings first.',
  'no-models': "ChatGPT hasn't listed any models for this account yet. Try again in a moment.",
  'choose-model': 'Choose a ChatGPT model in the agent settings first.',
};

/** The reason a `chatgpt` turn isn't ready, from the account's view and its last model list. */
export function chatgptSetupReason(account: Pick<ChatgptAccountView, 'state' | 'planUsage'>, models: readonly ChatgptModelView[]): ChatgptSetupReason {
  if (account.state === 'pending') return 'pending';
  if (account.state === 'expired') return 'expired';
  if (account.state !== 'signed-in') return 'signed-out';
  if (account.planUsage !== 'on') return 'plan-usage-off';
  return models.length === 0 ? 'no-models' : 'choose-model';
}
