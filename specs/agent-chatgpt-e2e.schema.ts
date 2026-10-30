/**
 * The ChatGPT plan route's e2e seam file (plan `docs/plans/agent-chatgpt-plan.md`, Task 6;
 * acceptance `agent-chatgpt.feature.md`, End to end). Unpackaged builds only: main reads the file
 * `--frost-e2e-chatgpt=<file>` names (`CHATGPT_E2E_SWITCH`) once, validates it here, and then
 *
 * - hands the sign-in service these `endpoints` (its injectable `endpoints` dependency) in place of
 *   `CHATGPT_ENDPOINTS`, so the authorize page, the token, revocation and key endpoints and the
 *   model list are a local fake's;
 * - has the model proxy **send** a plan request to `endpoints.responses`: what the runtime asks for
 *   is still checked against the unchanged allowlist (`MODEL_REQUESTS.chatgpt`, the real URL), so the
 *   runtime's provider is the shipped one and no rule is loosened; only the destination of a request
 *   that passed every check moves, and only under the seam;
 * - opens the authorize page with a stand-in "browser" in main (an HTTP `GET` of the authorize URL
 *   that follows its one redirect to the loopback callback), still only for `isChatgptAuthorizeUrl`
 *   URLs (against the seam's authorize endpoint) and only on a spent user gesture; no real browser;
 * - with `store: 'memory'`, keeps the sign-in in main's memory for the run (never on disk) instead
 *   of the OS keychain (`'keychain'`, the default). For a CI runner without a keychain (Linux under
 *   Playwright is `--password-store=basic`); the tokens still never leave main.
 *
 * A packaged build never reads it and refuses to start with the switch at all
 * (`PACKAGED_FORBIDDEN_SWITCHES`). Every URL must be the loopback address over `http:`
 * (`isChatgptE2eUrl`), so the seam can only ever point at a local fake. Main only (Zod).
 *
 * ```json
 * { "endpoints": {
 *     "issuer": "http://127.0.0.1:41234",
 *     "authorize": "http://127.0.0.1:41234/api/accounts/authorize",
 *     "token": "http://127.0.0.1:41234/api/accounts/oauth/token",
 *     "revoke": "http://127.0.0.1:41234/api/accounts/oauth/revoke",
 *     "jwks": "http://127.0.0.1:41234/.well-known/jwks.json",
 *     "models": "http://127.0.0.1:41234/v1/models",
 *     "responses": "http://127.0.0.1:41234/v1/responses" },
 *   "store": "memory" }
 * ```
 */
import { z } from 'zod';
import type { ChatgptEndpoints } from './agent-chatgpt.spec';

/** `--frost-e2e-chatgpt=<file>`: the seam's file (unpackaged builds only). */
export const CHATGPT_E2E_SWITCH = 'frost-e2e-chatgpt' as const;

/** The seam file's text, at most (characters). */
export const CHATGPT_E2E_SEAM_MAX_CHARS = 8 * 1024;

/**
 * Whether `url` is a URL the seam may name: `http://127.0.0.1:<port>` and a path, canonical
 * (`new URL(url).href === url`, or the bare origin for the issuer), with no credentials, query or
 * fragment. Never throws.
 */
export function isChatgptE2eUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 512) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '') return false;
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return false;
  return parsed.href === url || (parsed.pathname === '/' && parsed.origin === url);
}

const E2eUrl = z.string().refine(isChatgptE2eUrl, { message: 'not a loopback http URL' });

export const ChatgptE2eSeamSchema = z.strictObject({
  endpoints: z.strictObject({
    issuer: E2eUrl,
    authorize: E2eUrl,
    token: E2eUrl,
    revoke: E2eUrl,
    jwks: E2eUrl,
    models: E2eUrl,
    responses: E2eUrl,
  }) satisfies z.ZodType<ChatgptEndpoints>,
  /** Where the sign-in is kept: the OS keychain (default) or main's memory for the run. */
  store: z.enum(['keychain', 'memory']).default('keychain'),
});
export type ChatgptE2eSeam = z.output<typeof ChatgptE2eSeamSchema>;

/**
 * `text` (the seam file's JSON) as a validated seam, or `null`: longer than
 * `CHATGPT_E2E_SEAM_MAX_CHARS`, not JSON, or not a seam. Never throws.
 */
export function parseChatgptE2eSeam(text: unknown): ChatgptE2eSeam | null {
  if (typeof text !== 'string' || text.length > CHATGPT_E2E_SEAM_MAX_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ChatgptE2eSeamSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
