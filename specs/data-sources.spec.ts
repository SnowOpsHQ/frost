/**
 * Bring-your-own data sources: their keys and the one reviewed client that calls their APIs
 * (Phase 12 Task 1; plan `docs/plans/phase-12-big-bets.md`, Decision 4, Global constraints
 * "Secrets" and "Third-party requests", and the lead's legal-gate rulings in "As built"; acceptance
 * `data-sources.feature.md`; shapes `data-sources.schema.ts`).
 *
 * - Every paid source runs on the user's own key. Main keeps the keys in `DATA_CREDENTIALS_FILE`
 *   through the agent's `createCredentialStore` (`os` protection only, each blob sealed to its slot,
 *   atomic 0600 writes, write-only to the renderer): one slot per secret (`DATA_CREDENTIAL_SLOTS`),
 *   DataForSEO two (`DATA_PROVIDER_SLOTS`).
 * - Requests go out from main only, on the in-memory `DATA_API_PARTITION`, `redirect: 'error'`,
 *   `credentials: 'omit'`, to one exact method and canonical URL per provider and purpose
 *   (`DATA_API_REQUESTS`, `isAllowedDataRequest`), under `DATA_API_LIMITS`. Error bodies are
 *   withheld (the status only). The request is built **and sent** inside the credential store's
 *   `withKey` closure; what leaves it is the capped response and the key-less URL.
 * - Nothing spends the user's credit in the background: every request follows a user action or an
 *   approved agent call (`DATA_SPEND_NOTE`).
 * - Legal gates (plan Decision 2, L4/L5/L6; lead ruling): every gated feature is built and tested
 *   but ships **off**. Main reads each gate through `legalGates.isOpen(id)`
 *   (`apps/desktop/src/main/data-sources/gates.ts`) and refuses a closed one with `unavailable`
 *   (`LEGAL_GATE_NOTE`) before any request and before reading a key.
 *
 * Vendor endpoints (plan Q1, Q4, Q5), read from the public API references on 2026-11-10:
 * - SerpApi: https://serpapi.com/search-api — `GET https://serpapi.com/search` with the key in the
 *   `api_key` query parameter, JSON by default; `https://serpapi.com/search.json` is the JSON form
 *   the same page uses in its `serpapi_link`s. Pinned: `search.json` (the plan's value).
 * - DataForSEO: https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/ —
 *   `POST https://api.dataforseo.com/v3/serp/google/organic/live/advanced`, a JSON array of one task;
 *   https://docs.dataforseo.com/v3/auth/ — HTTP Basic with the API login and password.
 * - Serper: `POST https://google.serper.dev/search` with `X-API-KEY`. **Unverified**: serper.dev's
 *   pages carried no API reference that could be fetched; the plan's value is kept.
 * - Perplexity: https://docs.perplexity.ai/api-reference/sonar-post — Sonar is
 *   `POST https://api.perplexity.ai/v1/sonar` (Bearer), answering top-level `citations` and
 *   `search_results`. The plan's `/chat/completions` no longer appears in the reference, so the
 *   documented Sonar path is pinned (the same page recommends moving to its Agent API, `/v1/agent`,
 *   whose sources come back in `output`; Task 8 decides, Q4).
 * - OpenAI: Responses `POST https://api.openai.com/v1/responses` (Bearer). **Unverified**: the API
 *   reference answered 403; the plan's value is kept (the same URL `MODEL_REQUESTS['byok-openai']`
 *   already allows).
 * Prices and rate limits are never stated (Q5): the UI says the provider bills the user's account.
 */
import { isCanonicalUrl } from './agent-tools.spec';
import { CREDENTIAL_LIMITS, normalizeKey } from './agent-proxy.spec';

// ---- Providers and purposes -------------------------------------------------------------------

/** The data sources frost can call with the user's key (plan Decision 4). */
export const DATA_PROVIDERS = ['serpapi', 'dataforseo', 'serper', 'perplexity', 'openai-search'] as const;
export type DataProvider = (typeof DATA_PROVIDERS)[number];

export function isDataProvider(value: unknown): value is DataProvider {
  return typeof value === 'string' && (DATA_PROVIDERS as readonly string[]).includes(value);
}

/** What a request is for: Google web results (bet A) or an AI search answer (bet C1). */
export const DATA_PROVIDER_PURPOSES = ['serp', 'ai-search'] as const;
export type DataProviderPurpose = (typeof DATA_PROVIDER_PURPOSES)[number];

/** Each provider's one purpose. */
export const DATA_PROVIDER_PURPOSE: Readonly<Record<DataProvider, DataProviderPurpose>> = {
  serpapi: 'serp',
  dataforseo: 'serp',
  serper: 'serp',
  perplexity: 'ai-search',
  'openai-search': 'ai-search',
};

/** Text labels only (L7: nominative use, no logos or icons). */
export const DATA_PROVIDER_LABELS: Readonly<Record<DataProvider, string>> = {
  serpapi: 'SerpApi',
  dataforseo: 'DataForSEO',
  serper: 'Serper',
  perplexity: 'Perplexity',
  'openai-search': 'OpenAI web search',
};

// ---- Credentials --------------------------------------------------------------------------------

/**
 * One slot per secret. DataForSEO signs in with a login and a password (HTTP Basic), each its own
 * slot; the client builds the header from both inside nested `withKey` closures. OpenAI web search
 * has its own slot: the agent's `openai` slot is read only by the model proxy (plan Decision 4).
 */
export const DATA_CREDENTIAL_SLOTS = ['serpapi', 'serper', 'perplexity', 'openai-search', 'dataforseo-login', 'dataforseo-password'] as const;
export type DataCredentialSlot = (typeof DATA_CREDENTIAL_SLOTS)[number];

export function isDataCredentialSlot(value: unknown): value is DataCredentialSlot {
  return typeof value === 'string' && (DATA_CREDENTIAL_SLOTS as readonly string[]).includes(value);
}

/** Each provider's slots, in the order the client reads them. A provider `hasKey` only when all are set. */
export const DATA_PROVIDER_SLOTS: Readonly<Record<DataProvider, readonly DataCredentialSlot[]>> = {
  serpapi: ['serpapi'],
  dataforseo: ['dataforseo-login', 'dataforseo-password'],
  serper: ['serper'],
  perplexity: ['perplexity'],
  'openai-search': ['openai-search'],
};

/** The encrypted data keys' file in `userData` (mode 0600, written atomically). */
export const DATA_CREDENTIALS_FILE = 'data-credentials.json';

export const DATA_CREDENTIAL_LIMITS = {
  /** A DataForSEO login (an email address) after trimming (characters). */
  minLoginChars: 3,
  maxLoginChars: 256,
} as const;

/**
 * A secret as stored in `slot`: trimmed, printable ASCII with no space or line break. API keys and
 * the DataForSEO password follow the agent's key rule (`normalizeKey`,
 * `CREDENTIAL_LIMITS.minKeyChars`–`maxKeyChars`); the DataForSEO login may be shorter
 * (`DATA_CREDENTIAL_LIMITS`). `null` when refused.
 */
export function normalizeDataSecret(slot: DataCredentialSlot, value: unknown): string | null {
  if (slot !== 'dataforseo-login') return normalizeKey(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < DATA_CREDENTIAL_LIMITS.minLoginChars || trimmed.length > DATA_CREDENTIAL_LIMITS.maxLoginChars) return null;
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : null;
}

/** The longest secret any slot holds (the IPC input's bound is twice this, for whitespace). */
export const DATA_SECRET_MAX_CHARS = Math.max(CREDENTIAL_LIMITS.maxKeyChars, DATA_CREDENTIAL_LIMITS.maxLoginChars);

// ---- Legal gates (plan Decision 2; lead ruling in "As built") -----------------------------------

/** Every legal gate main reads through `legalGates.isOpen(id)`. Provider ids are their own gate ids. */
export const LEGAL_GATE_IDS = ['serpapi', 'dataforseo', 'serper', 'perplexity', 'openai-search', 'crawl'] as const;
export type LegalGateId = (typeof LEGAL_GATE_IDS)[number];

export function isLegalGateId(value: unknown): value is LegalGateId {
  return typeof value === 'string' && (LEGAL_GATE_IDS as readonly string[]).includes(value);
}

/**
 * Whether each SERP vendor is offered (L4: its terms allow keeping results locally without an
 * expiry, in an open-source client run by the key's owner). While `false`: setting its key and
 * every request to it are refused in main (`unavailable`), and the renderer hides or disables it
 * with `LEGAL_GATE_NOTE` (from `DataSourcesView.available`). Flipped to `true` only by the change
 * that adds the owner's written L4 note for that vendor under `docs/research/`.
 */
export const SERP_API_VENDOR_AVAILABLE: Readonly<Record<'serpapi' | 'dataforseo' | 'serper', boolean>> = {
  serpapi: false as boolean,
  dataforseo: false as boolean,
  serper: false as boolean,
};

/**
 * Whether each AI search provider is offered (L5: its API terms allow storing answers and
 * citations locally). Same rules as `SERP_API_VENDOR_AVAILABLE`; flipped only by the change that
 * adds the owner's written L5 note under `docs/research/`.
 */
export const AI_SEARCH_PROVIDER_AVAILABLE: Readonly<Record<'perplexity' | 'openai-search', boolean>> = {
  perplexity: false as boolean,
  'openai-search': false as boolean,
};

/** What a closed gate says, in main's refusal and beside the renderer's disabled control. */
export const LEGAL_GATE_NOTE = 'Not available in this build yet: its terms are still under review.';

/**
 * `--frost-e2e-open-gates=<id,id,…>`: opens the listed gates for the e2e suite and the lead's UI
 * pass. Unpackaged builds only (`PACKAGED_FORBIDDEN_SWITCHES`); unknown ids are ignored.
 */
export const LEGAL_GATES_E2E_SWITCH = 'frost-e2e-open-gates' as const;

// ---- Requests -----------------------------------------------------------------------------------

/** The in-memory session data API requests go out on (no `persist:`: nothing written to disk). */
export const DATA_API_PARTITION = 'frost-data-api';

export const DATA_API_METHODS = ['GET', 'POST'] as const;
export type DataApiMethod = (typeof DATA_API_METHODS)[number];

/** One allowed request: its method, canonical URL (no query), and the query names it may carry. */
export interface DataApiRequestTarget {
  readonly purpose: DataProviderPurpose;
  readonly method: DataApiMethod;
  readonly url: string;
  /** Query parameter names allowed (each at most once); absent: no query at all. */
  readonly query?: readonly string[];
}

/**
 * SerpApi's query names: its key (`api_key`, stripped from every URL that leaves the request) and
 * the search's own fields. Nothing else (no `no_cache`, which re-spends credit, no `async`).
 */
export const SERPAPI_QUERY_NAMES = ['api_key', 'engine', 'q', 'location', 'gl', 'hl', 'google_domain', 'device', 'start', 'output'] as const;

/** The query parameter that carries a provider's key, removed from the key-less URL. */
export const DATA_API_KEY_QUERY_NAME: Readonly<Partial<Record<DataProvider, string>>> = { serpapi: 'api_key' };

/**
 * The exact requests per provider (doc URLs and dates in this file's header). Adding a vendor or
 * an endpoint is a reviewed change to this table.
 */
export const DATA_API_REQUESTS: Readonly<Record<DataProvider, readonly DataApiRequestTarget[]>> = {
  serpapi: [{ purpose: 'serp', method: 'GET', url: 'https://serpapi.com/search.json', query: SERPAPI_QUERY_NAMES }],
  dataforseo: [{ purpose: 'serp', method: 'POST', url: 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced' }],
  serper: [{ purpose: 'serp', method: 'POST', url: 'https://google.serper.dev/search' }],
  perplexity: [{ purpose: 'ai-search', method: 'POST', url: 'https://api.perplexity.ai/v1/sonar' }],
  'openai-search': [{ purpose: 'ai-search', method: 'POST', url: 'https://api.openai.com/v1/responses' }],
};

/** Request header names main may send (lower case); anything else is refused (`not-allowed`). */
export const DATA_API_REQUEST_HEADERS = ['accept', 'authorization', 'content-type', 'x-api-key'] as const;

/**
 * Whether `method` and `url` are one of `provider`'s `DATA_API_REQUESTS` for `purpose`: the URL is
 * canonical (`isCanonicalUrl`), has no credentials or fragment, and its origin and path equal the
 * target's exactly (so no other scheme, host, port or path). A query is allowed only where the
 * target lists names, and then only those names, each at most once. Never throws.
 */
export function isAllowedDataRequest(provider: unknown, purpose: unknown, method: unknown, url: unknown): boolean {
  if (!isDataProvider(provider) || typeof method !== 'string' || !isCanonicalUrl(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '' || url.includes('#')) return false;
  return DATA_API_REQUESTS[provider].some((target) => {
    if (target.purpose !== purpose || target.method !== method) return false;
    if (`${parsed.origin}${parsed.pathname}` !== target.url) return false;
    if (parsed.search === '') return !url.includes('?');
    if (target.query === undefined) return false;
    const names = [...parsed.searchParams.keys()];
    return names.length > 0 && new Set(names).size === names.length && names.every((name) => target.query!.includes(name));
  });
}

export const DATA_API_LIMITS = {
  /** A whole request, headers and body read, at most (ms); then `timeout`. */
  timeoutMs: 30_000,
  /** A response body, at most (bytes); one byte more is `too-large` and the body is not read further. */
  maxResponseBytes: 2 * 1024 * 1024,
  /** A request body main builds, at most (bytes); more is `not-allowed`. */
  maxRequestBytes: 64 * 1024,
  /**
   * Requests to one provider waiting for their turn, at most; one more is refused (`busy`) before a
   * key is read. A waiting request holds no key: its turn is reserved before the key is opened.
   */
  maxWaitingPerProvider: 4,
  /** The least time between two requests' starts to one provider (ms); a later request waits. */
  minIntervalMs: { serpapi: 1_000, dataforseo: 1_000, serper: 1_000, perplexity: 1_000, 'openai-search': 1_000 } satisfies Record<DataProvider, number>,
} as const;

/**
 * Why `dataApiRequest` did not answer the provider's body:
 * - `unavailable`: the provider's legal gate is closed (`LEGAL_GATE_NOTE`); nothing was read or sent;
 * - `busy`: `maxWaitingPerProvider` requests to the provider are already waiting; nothing was read or sent;
 * - `no-key`: one of the provider's slots is empty;
 * - `no-keychain`: no OS keychain protects keys here, so a stored key is not used;
 * - `key-failed`: a stored key could not be read;
 * - `not-allowed`: the request is not in `DATA_API_REQUESTS` (or its headers or body are refused,
 *   or, for SerpApi, `api_key` is not exactly the key once, or the key shows anywhere else in the
 *   URL); nothing was sent;
 * - `redirect`: the provider answered with a redirect (never followed);
 * - `timeout`, `network`: no complete answer in `timeoutMs`, or none at all;
 * - `too-large`: the body was longer than `maxResponseBytes`;
 * - `http-error`: a status outside 2xx; the status is kept, the body withheld.
 */
export const DATA_API_REFUSALS = ['unavailable', 'busy', 'no-key', 'no-keychain', 'key-failed', 'not-allowed', 'redirect', 'timeout', 'network', 'too-large', 'http-error'] as const;
export type DataApiRefusal = (typeof DATA_API_REFUSALS)[number];

/** What each refusal says (never a key, a URL or the provider's error text). */
export const DATA_API_REFUSAL_MESSAGES: Readonly<Record<DataApiRefusal, string>> = {
  unavailable: LEGAL_GATE_NOTE,
  busy: 'Too many requests to this data source are waiting. Try again in a moment.',
  'no-key': 'No key is set for this data source. Add one in Settings › Data sources.',
  'no-keychain': 'No OS keychain protects keys on this computer, so frost won’t use a stored key.',
  'key-failed': 'The stored key could not be read. Enter it again in Settings › Data sources.',
  'not-allowed': 'This request is not one frost sends to this data source.',
  redirect: 'The data source answered with a redirect, which frost doesn’t follow.',
  timeout: 'The data source didn’t answer in time.',
  network: 'The data source couldn’t be reached.',
  'too-large': 'The data source’s answer was too large to read.',
  'http-error': 'The data source answered with an error. Its details are not shown.',
};

/** `--frost-e2e-data-api=<file>`: the seam mapping providers to loopback fakes (`data-sources.schema.ts`). */
export const DATA_API_E2E_SWITCH = 'frost-e2e-data-api' as const;

/** The cost note every surface that spends shows. Never a price frost cannot keep current (Q5). */
export const DATA_SPEND_NOTE = 'Each request is billed by the provider to your account. frost sends one only when you ask.';
