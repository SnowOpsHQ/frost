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
 * - `http-error`: a status outside 2xx; the status is kept, the body withheld;
 * - `aborted` (Phase 12 Task 8 review): the caller's `signal` aborted (Stop, or its own deadline)
 *   while the request waited for its turn or before it was sent (nothing sent), or while it was in
 *   flight (the fetch is aborted, the body not read);
 * - `cancelled` (Phase 12 Task 8 review): the caller's `beforeSend` check, run once the turn is
 *   granted and before any key is read, said the request is no longer wanted (what it was for
 *   changed while it waited); nothing was read or sent.
 */
export const DATA_API_REFUSALS = ['unavailable', 'busy', 'no-key', 'no-keychain', 'key-failed', 'not-allowed', 'redirect', 'timeout', 'network', 'too-large', 'http-error', 'aborted', 'cancelled'] as const;
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
  aborted: 'The request was stopped.',
  cancelled: 'The request was not sent: what it was for changed while it waited.',
};

/** `--frost-e2e-data-api=<file>`: the seam mapping providers to loopback fakes (`data-sources.schema.ts`). */
export const DATA_API_E2E_SWITCH = 'frost-e2e-data-api' as const;

/** The cost note every surface that spends shows. Never a price frost cannot keep current (Q5). */
export const DATA_SPEND_NOTE = 'Each request is billed by the provider to your account. frost sends one only when you ask.';

// ---- Settings › Data sources and the usage counter (Task 2) -------------------------------------

/** The SERP vendors (purpose `serp`), in the order Settings lists them under "Search results". */
export const DATA_SERP_PROVIDERS = ['serpapi', 'dataforseo', 'serper'] as const;
export type DataSerpProvider = (typeof DATA_SERP_PROVIDERS)[number];

export function isDataSerpProvider(value: unknown): value is DataSerpProvider {
  return typeof value === 'string' && (DATA_SERP_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Which SERP vendor "Check via API" uses (Task 2; lead ruling), given the stored choice and the
 * vendors main offers (`choices`: legal gate open and key set): the stored one while it is offered;
 * otherwise, when exactly one is offered, that one (a stored choice that is no longer offered counts
 * as none); otherwise `null`. Main answers it in `DataSerpProviderView.provider`; Task 4 uses the same.
 */
export function resolveDataSerpProvider(stored: DataSerpProvider | null, choices: readonly DataSerpProvider[]): DataSerpProvider | null {
  if (stored !== null && choices.includes(stored)) return stored;
  return choices.length === 1 ? choices[0]! : null;
}

/** The AI search providers (purpose `ai-search`), listed under "AI search". */
export const DATA_AI_SEARCH_PROVIDERS = ['perplexity', 'openai-search'] as const;

/**
 * The `app_settings` key (`0005_app_settings`; no migration) holding which SERP vendor "Check via
 * API" uses (Task 4): one `DATA_SERP_PROVIDERS` id. Main stores one only while its legal gate is open
 * and its key is set; a missing or unknown value reads as none.
 */
export const DATA_SERP_PROVIDER_KEY = 'data_serp_provider' as const;

/**
 * The local usage counter (`0243_data_api_usage`, table `data_api_usage`): one row per provider and
 * UTC month (`YYYY-MM`), counting the requests the client actually sent (after the allowlist, before
 * the fetch; a refused request never counts). Nothing leaves the device.
 */
export const DATA_USAGE_TABLES = ['data_api_usage'] as const;
export const DATA_USAGE_MIGRATION_IDS = ['0243_data_api_usage'] as const;

export const DATA_USAGE_LIMITS = {
  /** Months kept per provider, the current one included; older rows are deleted on each write. */
  monthsKept: 12,
  /** The largest count stored or shown (a counter at it stays there). */
  maxRequests: 2_147_483_647,
} as const;

/** Whether `value` is a usage month: `YYYY-MM`, month 01–12. */
export function isDataUsageMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** The UTC month (`YYYY-MM`) of `at` (Unix ms). */
export function dataUsageMonth(at: number): string {
  const date = new Date(at);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month `count` months before `month` (`YYYY-MM`). */
export function dataUsageMonthBefore(month: string, count = 1): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (mon - 1) - count;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The oldest month kept when writing in `month` (`DATA_USAGE_LIMITS.monthsKept`, `month` included). */
export function oldestDataUsageMonthKept(month: string): string {
  return dataUsageMonthBefore(month, DATA_USAGE_LIMITS.monthsKept - 1);
}

/**
 * Settings › Data sources (Task 2; `data-sources.feature.md`, Settings). Text labels only (L7). The
 * renderer shows what main's views say (`DataSourcesView`, `DataUsageView`, `DataSerpProviderView`)
 * and never decides a gate itself.
 */
export const DATA_SOURCES_SETTINGS_TEXT = {
  intro: 'Bring your own key to fetch search results or AI search answers from a data provider. Keys stay on this computer, in your system keychain, and are never shown again.',
  groups: { serp: 'Search results', 'ai-search': 'AI search' } satisfies Record<DataProviderPurpose, string>,
  keySet: 'Key set',
  noKey: 'No key',
  keyLabel: 'API key',
  loginLabel: 'Login',
  passwordLabel: 'Password',
  keyPlaceholder: 'Paste a key',
  replacePlaceholder: 'Replace the saved key',
  save: 'Save',
  clear: 'Clear',
  /** The buttons' accessible names (each starts with its visible word). */
  saveName: (label: string) => `Save ${label} key`,
  clearName: (label: string) => `Clear ${label} key`,
  clearQuestion: (label: string) => `Remove the saved key for ${label}? frost can’t use ${label} until you add one again.`,
  clearConfirm: 'Remove key',
  cancel: 'Cancel',
  pasteFirst: 'Paste a key first.',
  cleared: 'Key removed.',
  clearFailed: 'The key could not be removed. Try again.',
  /** What Save says for each `dataSources.setKey` answer (`DATA_SET_KEY_RESULTS`); never the key. */
  setKeyResults: {
    stored: 'Key saved.',
    invalid: 'That doesn’t look like a key. Paste it again.',
    'no-keychain': 'No system keychain protects keys on this computer, so the key was not saved.',
    failed: 'The key could not be saved. Try again.',
    unavailable: LEGAL_GATE_NOTE,
  },
  /** Why a field is disabled when keys can't be protected here (`KEY_PROTECTIONS` other than `os`). */
  protection: {
    weak: 'No system keychain protects keys on this computer, so frost won’t store a data source key here.',
    unavailable: 'No system keychain is available on this computer, so frost can’t store a data source key here.',
  },
  /** DataForSEO signs in with both (`DATA_PROVIDER_SLOTS`); each is saved on its own. */
  dataForSeoBoth: 'DataForSEO needs both its API login and password.',
  /** A DataForSEO row with one of its two slots set (`partial`); the view never says which. */
  partial: 'Only one of the login and password is saved. Add the other, or Clear it.',
  /** After a DataForSEO Save answered `stored` while the row still has no key: the field not sent. */
  savedAddOther: { login: 'Saved. Add the login too.', password: 'Saved. Add the password too.' },
  /** OpenAI web search has its own key (plan Decision 4). */
  openAiSeparateKey: 'This key is separate from the agent’s OpenAI key, which frost doesn’t reuse here. Paste a key again to use OpenAI web search.',
  usageLabel: 'Requests sent',
  usage: (thisMonth: number, lastMonth: number) => `This month: ${thisMonth} · Last month: ${lastMonth}`,
  usageNote: 'Counted on this computer, per calendar month (UTC). Your provider’s own dashboard is the bill.',
  serpProviderLabel: 'Check via API uses',
  serpProviderPlaceholder: 'Choose a provider',
  serpProviderNone: 'Add a key for an available search results provider to choose one.',
  /** What the select says for a `dataSources.setSerpProvider` answer other than `stored`. */
  setSerpProviderResults: {
    unavailable: LEGAL_GATE_NOTE,
    'no-key': 'Add a key for that provider first.',
    failed: 'That choice could not be saved.',
  },
  loading: 'Loading…',
  readFailed: 'Couldn’t read the data source settings.',
  retry: 'Try again',
} as const;

// ---- "Check via API" into a project's readings (Task 4) -----------------------------------------

/**
 * Why `dataSources.checkPlan` or `dataSources.checkProjectSearches` sends nothing
 * (`data-sources.feature.md`, Check via API):
 * - `unavailable`: no SERP vendor's legal gate is open, or the vendor's gate closed (`LEGAL_GATE_NOTE`);
 * - `no-key`: a vendor's gate is open but no vendor has every key slot set;
 * - `no-provider`: several vendors are offered and none is chosen (`resolveDataSerpProvider`);
 * - `not-found`: the project is not live;
 * - `no-searches`: the project (or the searches asked for) has no saved search to check;
 * - `busy`: a check is already under way (one at a time);
 * - `changed`: the vendor or the number of requests is not the one the user confirmed.
 */
export const DATA_CHECK_REFUSALS = ['unavailable', 'no-key', 'no-provider', 'not-found', 'no-searches', 'busy', 'changed'] as const;
export type DataCheckRefusal = (typeof DATA_CHECK_REFUSALS)[number];

export const DATA_CHECK_REFUSAL_MESSAGES: Readonly<Record<DataCheckRefusal, string>> = {
  unavailable: LEGAL_GATE_NOTE,
  'no-key': 'Add a key in Settings › Data sources.',
  'no-provider': 'Choose a provider in Settings › Data sources.',
  'not-found': 'This project is no longer there.',
  'no-searches': 'This project has no saved searches to check.',
  busy: 'A check via API is already under way.',
  changed: 'The provider or the searches changed. Check again.',
};

/**
 * What happened to one search of a check: `stored` (its reading was written), `failed` (the vendor
 * check failed: `SERP_API_OUTCOMES`), `not-stored` (the write was refused), `skipped` (not sent; why:
 * `DATA_CHECK_SKIP_REASONS`).
 */
export const DATA_CHECK_SEARCH_RESULTS = ['stored', 'failed', 'not-stored', 'skipped'] as const;
export type DataCheckSearchResult = (typeof DATA_CHECK_SEARCH_RESULTS)[number];

/** Client refusals that would refuse every request of a check alike: the rest of the check is not sent. */
export const DATA_CHECK_STOP_REFUSALS = ['unavailable', 'no-key', 'no-keychain', 'key-failed'] as const satisfies readonly DataApiRefusal[];

/**
 * Vendor statuses (`http-error`) that are about the account, not the search (a bad key, no credit, no
 * access, rate-limited): the rest of the check is not sent either.
 */
export const DATA_CHECK_STOP_STATUSES: readonly number[] = [401, 402, 403, 429];

/**
 * Why a search of a check was not sent:
 * - `stopped`: an earlier search was refused for the account or the key (`DATA_CHECK_STOP_REFUSALS`,
 *   `DATA_CHECK_STOP_STATUSES`), the project went away, or the check failed after it began;
 * - `unsupported`: the vendor can't take it (its engine, device, country or language);
 * - `other-series`: what the vendor would be asked is not exactly the saved search's parameters, so
 *   its reading would be filed under another search key (never paid for: it is not counted or sent).
 */
export const DATA_CHECK_SKIP_REASONS = ['stopped', 'unsupported', 'other-series'] as const;
export type DataCheckSkipReason = (typeof DATA_CHECK_SKIP_REASONS)[number];

export const DATA_CHECK_SKIP_MESSAGES: Readonly<Record<DataCheckSkipReason, string>> = {
  stopped: 'Not sent: the check stopped before it.',
  unsupported: 'Not sent: this provider can’t run this search.',
  'other-series': 'Not sent: this provider would check a different search than the one saved.',
};

const requestsText = (n: number): string => `${n} ${n === 1 ? 'request' : 'requests'}`;

/** "Check via API" in words (text labels only, L7). */
export const DATA_CHECK_TEXT = {
  button: 'Check via API',
  /** The confirm, before anything is sent (with `DATA_SPEND_NOTE`). */
  confirm: (requests: number, provider: string) => `This sends ${requestsText(requests)} to ${provider}.`,
  send: (requests: number) => `Send ${requestsText(requests)}`,
  cancel: 'Cancel',
  checking: (provider: string) => `Checking via ${provider}…`,
  /** The palette command (the project last opened). */
  palette: (provider: string) => `Check searches via ${provider}`,
  /** After a check: how many readings were stored. */
  done: (stored: number, total: number, provider: string) =>
    stored === total ? `Checked ${total} ${total === 1 ? 'search' : 'searches'} via ${provider}.` : `Checked ${stored} of ${total} searches via ${provider}; the others could not be checked.`,
  failed: 'The check could not be run. Try again.',
  /** A rank point's source: a tab capture, or a vendor's API (`<Vendor> API`). */
  sourceCapture: 'Tab capture',
  sourceApi: (provider: string) => `${provider} API`,
  sourceApiUnknown: 'Data API',
} as const;
