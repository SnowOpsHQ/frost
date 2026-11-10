import {
  DATA_API_KEY_QUERY_NAME,
  DATA_API_LIMITS,
  DATA_API_REFUSAL_MESSAGES,
  DATA_API_REQUEST_HEADERS,
  DATA_PROVIDER_SLOTS,
  isAllowedDataRequest,
  isDataProvider,
  type DataApiMethod,
  type DataApiRefusal,
  type DataCredentialSlot,
  type DataProvider,
  type DataProviderPurpose,
  type LegalGateId,
} from '@app/specs/data-sources.spec';
import type { DataApiE2eSeam } from '@app/specs/data-sources.schema';
import type { CredentialStore, WithKeyResult } from '../agent/credentials';

// The one place frost calls a data provider's API with the user's key (Phase 12 Task 1; plan
// Decision 4, Global constraints "Secrets" and "Third-party requests"; spec `data-sources.spec.ts`;
// acceptance `data-sources.feature.md`, Requests and Legal gates).
//
// `dataApiRequest(provider, purpose, build)`:
// 1. refuses a provider whose legal gate is closed (`unavailable`) before reading a key or sending;
// 2. opens each of the provider's slots with nested `withKey` closures (DataForSEO has two) and,
//    inside the innermost one, calls `build` with the secrets, checks what it built against
//    `isAllowedDataRequest` (and the header and body rules), and **sends the request there**, on the
//    in-memory `frost-data-api` session (`redirect: 'error'`, `credentials: 'omit'`), reading the
//    body up to `maxResponseBytes` under one `timeoutMs` cap;
// 3. returns only what the closure returned: the capped body (2xx) or the status (anything else,
//    its body withheld), and the key-less URL. The keyed URL, the headers and the secrets never
//    leave the closure; logs carry the provider, method, origin and path only.
// It never throws: a `build` that throws is `not-allowed` (its error, which may hold a key, is dropped).
//
// Requests to one provider start at least `minIntervalMs` apart: after the gate, and before any key
// is opened, a request reserves its turn and waits for it (so no key is held while waiting); with
// `maxWaitingPerProvider` already waiting it is refused `busy`. Each request that is sent is counted
// (`countRequest`, Task 2) just before its fetch; a refused one never is. Nothing runs in the background:
// every call follows a user action or an approved agent call. For SerpApi the closure also checks
// that `api_key` holds exactly the key, once, and that no other part of the URL shows a secret
// (else `not-allowed`), so the key-less URL is the URL with that one parameter removed.

/** What main's `session.fromPartition(DATA_API_PARTITION).fetch` is used as. */
export type DataApiFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The provider's secrets, by slot, inside the closure only. */
export type DataSecrets = Readonly<Partial<Record<DataCredentialSlot, string>>>;

/** What `build` makes from the secrets: the exact request to send. */
export interface DataApiRequestInit {
  readonly method: DataApiMethod;
  /** The canonical URL (`DATA_API_REQUESTS`), with the query for SerpApi. */
  readonly url: string;
  /** Names from `DATA_API_REQUEST_HEADERS` only (any case). */
  readonly headers?: Readonly<Record<string, string>>;
  /** A body main built from validated fields (POST only). */
  readonly body?: string;
}

export type DataApiBuild = (secrets: DataSecrets) => DataApiRequestInit;

/**
 * - `ok`: a 2xx answer, its body (at most `maxResponseBytes`, UTF-8) and the key-less URL;
 * - otherwise the refusal and its message; `status` for `http-error`; `url` (key-less) once the
 *   request passed the allowlist.
 */
export type DataApiOutcome =
  | { readonly ok: true; readonly status: number; readonly body: string; readonly url: string }
  | { readonly ok: false; readonly refusal: DataApiRefusal; readonly message: string; readonly status?: number; readonly url?: string };

export interface DataApiClientDeps {
  /** The data key store (only this client calls `withKey`). */
  readonly store: Pick<CredentialStore<DataCredentialSlot>, 'withKey'>;
  /** The legal gates (`gates.ts`; tests open them by injection). */
  readonly isOpen: (id: LegalGateId) => boolean;
  readonly fetch: DataApiFetch;
  /** The e2e seam (unpackaged only; `e2e-seam.ts`): providers sent to a loopback base. */
  readonly seam?: DataApiE2eSeam | null;
  /** One line per request (never a key, a query or a body). */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The time cap (default `DATA_API_LIMITS.timeoutMs`; tests shorten it). */
  readonly timeoutMs?: number;
  /**
   * The usage counter (Task 2; `data_api_usage`): called once per request the client sends, after
   * every check and before the fetch; never for a refused one. A failure is logged and the request
   * still goes (the counter is a record, not a gate). Setup wires it; tests pass a fake.
   */
  readonly countRequest?: (provider: DataProvider) => Promise<void> | void;
}

export interface DataApiClient {
  dataApiRequest(provider: DataProvider, purpose: DataProviderPurpose, build: DataApiBuild): Promise<DataApiOutcome>;
}

const refused = (refusal: DataApiRefusal, extra: { readonly status?: number; readonly url?: string } = {}): DataApiOutcome => ({ ok: false, refusal, message: DATA_API_REFUSAL_MESSAGES[refusal], ...extra });

const WITH_KEY_REFUSAL: Readonly<Record<'no-key' | 'unavailable' | 'failed', DataApiRefusal>> = { 'no-key': 'no-key', unavailable: 'no-keychain', failed: 'key-failed' };

/** A `fetch` rejection from a redirect (Electron 45's `redirect: 'error'` message, or undici's cause). */
function isRedirectError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    if (/redirect/i.test(current.message)) return true;
  }
  return false;
}

/** Whether `text`, raw or percent-decoded (with `+` as a space), shows `secret`. */
function shows(text: string, secret: string): boolean {
  if (text.includes(secret) || text.includes(encodeURIComponent(secret))) return true;
  try {
    return decodeURIComponent(text.replace(/\+/g, ' ')).includes(secret);
  } catch {
    return false;
  }
}

/**
 * The key-less URL of an allowed request, or `null` (refused `not-allowed`): for a provider that
 * takes its key in the query (SerpApi's `api_key`), that parameter must hold exactly the key, once;
 * and after it is removed, no other query name or value and no part of the path may show any secret.
 */
function keylessUrl(provider: DataProvider, url: string, secrets: DataSecrets): string | null {
  const parsed = new URL(url);
  const name = DATA_API_KEY_QUERY_NAME[provider];
  if (name !== undefined) {
    const key = secrets[DATA_PROVIDER_SLOTS[provider][0]!];
    const values = parsed.searchParams.getAll(name);
    if (key === undefined || values.length !== 1 || values[0] !== key) return null;
    parsed.searchParams.delete(name);
  }
  const out = parsed.searchParams.size === 0 ? `${parsed.origin}${parsed.pathname}` : parsed.href;
  const values = Object.values(secrets).filter((value): value is string => typeof value === 'string' && value !== '');
  for (const secret of values) {
    if (shows(out, secret) || shows(parsed.pathname, secret)) return null;
    for (const [key, value] of parsed.searchParams) if (key.includes(secret) || value.includes(secret)) return null;
  }
  return out;
}

/** The request's headers if every name is allowed and no value holds a line break; else `null`. */
function allowedHeaders(headers: Readonly<Record<string, string>> | undefined): Headers | null {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!(DATA_API_REQUEST_HEADERS as readonly string[]).includes(name.toLowerCase()) || typeof value !== 'string' || /[\r\n\0]/.test(value)) return null;
    try {
      out.set(name, value);
    } catch {
      // Not a ByteString (a character above U+00FF): refused, never surfaced as a key failure.
      return null;
    }
  }
  return out;
}

/** The body, or `null` once more than `maxBytes` arrived (the rest is not read). */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (response.headers.has('content-length') && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createDataApiClient(deps: DataApiClientDeps): DataApiClient {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? DATA_API_LIMITS.timeoutMs;
  /** When each provider's next request may start. */
  const nextStart = new Map<DataProvider, number>();
  /** Requests per provider waiting for their turn (none holds a key). */
  const waiting = new Map<DataProvider, number>();

  /**
   * Reserves the provider's next turn (synchronously, so requests made at once are spaced too) and
   * waits for it, before any key is opened; `false` (`busy`) when `maxWaitingPerProvider` already wait.
   */
  const takeTurn = async (provider: DataProvider): Promise<boolean> => {
    const at = now();
    const start = Math.max(at, nextStart.get(provider) ?? 0);
    if (start <= at) {
      nextStart.set(provider, at + DATA_API_LIMITS.minIntervalMs[provider]);
      return true;
    }
    const count = waiting.get(provider) ?? 0;
    if (count >= DATA_API_LIMITS.maxWaitingPerProvider) return false;
    nextStart.set(provider, start + DATA_API_LIMITS.minIntervalMs[provider]);
    waiting.set(provider, count + 1);
    try {
      await sleep(start - at);
    } finally {
      waiting.set(provider, (waiting.get(provider) ?? 1) - 1);
    }
    return true;
  };

  /** Runs `fn` with all of `provider`'s secrets, each slot opened by its own nested `withKey`. */
  const withSecrets = async <T>(provider: DataProvider, fn: (secrets: DataSecrets) => Promise<T>): Promise<WithKeyResult<T>> => {
    const slots = DATA_PROVIDER_SLOTS[provider];
    const open = async (index: number, secrets: DataSecrets): Promise<WithKeyResult<T>> => {
      if (index === slots.length) return { ok: true, value: await fn(secrets) };
      const slot = slots[index]!;
      const inner = await deps.store.withKey(slot, (secret) => open(index + 1, { ...secrets, [slot]: secret }));
      return inner.ok ? inner.value : inner;
    };
    return open(0, {});
  };

  /** Sends the checked request; `url` is the key-less form for the outcome. Inside the closure only. */
  const send = async (provider: DataProvider, request: DataApiRequestInit, headers: Headers, url: string): Promise<DataApiOutcome> => {
    // The e2e seam moves only the destination of a request that passed every check.
    const base = deps.seam?.[provider];
    let target = request.url;
    if (base !== undefined) {
      const parsed = new URL(request.url);
      target = `${base}${parsed.pathname}${parsed.search}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await deps.fetch(target, {
        method: request.method,
        headers,
        body: request.body ?? null,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        return refused('redirect', { url });
      }
      if (response.status < 200 || response.status >= 300) {
        // The body is withheld: never read, never logged.
        await response.body?.cancel().catch(() => undefined);
        return refused('http-error', { status: response.status, url });
      }
      const body = await readCapped(response, DATA_API_LIMITS.maxResponseBytes);
      if (body === null) return refused('too-large', { url });
      return { ok: true, status: response.status, body, url };
    } catch (error) {
      if (controller.signal.aborted) return refused('timeout', { url });
      if (isRedirectError(error)) return refused('redirect', { url });
      return refused('network', { url });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async dataApiRequest(provider, purpose, build) {
      // The gate first: nothing is read or sent for a provider that isn't offered.
      if (!isDataProvider(provider) || !deps.isOpen(provider)) {
        log(`data api: ${String(provider)} refused (unavailable)`);
        return refused('unavailable');
      }
      // The turn next, so no key is held while a request waits.
      if (!(await takeTurn(provider))) {
        log(`data api: ${provider} refused (busy)`);
        return refused('busy');
      }
      const opened = await withSecrets(provider, async (secrets): Promise<DataApiOutcome> => {
        // Inside the closure: the secrets, the keyed URL and the headers stay here.
        let request: DataApiRequestInit;
        try {
          request = build(secrets);
        } catch {
          return refused('not-allowed');
        }
        const headers = allowedHeaders(request.headers);
        const body = request.body;
        const bodyAllowed = body === undefined || (request.method === 'POST' && typeof body === 'string' && Buffer.byteLength(body, 'utf8') <= DATA_API_LIMITS.maxRequestBytes);
        if (!isAllowedDataRequest(provider, purpose, request.method, request.url) || headers === null || !bodyAllowed) return refused('not-allowed');
        const url = keylessUrl(provider, request.url, secrets);
        if (url === null) return refused('not-allowed');
        // Counted now: the request passed every check and is sent next, whatever it answers.
        try {
          await deps.countRequest?.(provider);
        } catch {
          log(`data api: ${provider} usage not counted`);
        }
        const outcome = await send(provider, request, headers, url);
        const parsed = new URL(url);
        log(`data api: ${provider} ${request.method} ${parsed.origin}${parsed.pathname} ${outcome.ok ? outcome.status : outcome.refusal}${!outcome.ok && outcome.status !== undefined ? ` ${outcome.status}` : ''}`);
        return outcome;
      }).catch((): WithKeyResult<DataApiOutcome> => ({ ok: false, reason: 'failed' }));
      if (!opened.ok) {
        log(`data api: ${provider} refused (${WITH_KEY_REFUSAL[opened.reason]})`);
        return refused(WITH_KEY_REFUSAL[opened.reason]);
      }
      if (!opened.value.ok && opened.value.refusal === 'not-allowed') log(`data api: ${provider} refused (not-allowed)`);
      return opened.value;
    },
  };
}
