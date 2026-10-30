import { CHATGPT_LIMITS } from '@app/specs/agent-chatgpt.spec';

// One call to the ChatGPT auth server or the model list (spec `agent-chatgpt.spec.ts`,
// `CHATGPT_LIMITS`; acceptance `agent-chatgpt.feature.md`, Decisions, "Network"). No Electron import:
// main injects the `agent-chatgpt` session's `fetch`. Every call: `credentials: 'omit'` (no cookie
// jar), `cache: 'no-store'`, `redirect: 'error'` (an auth endpoint is never followed elsewhere), a
// timeout and a capped body. What it answers is the status and the body text; nothing is logged.

/** What the service uses of `fetch` (Electron's session `fetch` in main; a fake server in tests). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * - `answer`: the server answered `status`; `text` is the body, or `null` when longer than the cap;
 * - `network`: no answer (refused, DNS, TLS, a redirect, the timeout).
 */
export type HttpOutcome = { readonly kind: 'answer'; readonly status: number; readonly text: string | null } | { readonly kind: 'network' };

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  /** A form body (`application/x-www-form-urlencoded`). */
  readonly form?: URLSearchParams;
}

export interface HttpOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
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

/** Sends `request` to `url`; never throws. */
export async function send(fetch: FetchLike, url: string, request: HttpRequest, options: HttpOptions = {}): Promise<HttpOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CHATGPT_LIMITS.requestTimeoutMs);
  try {
    const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
    if (request.form !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.form === undefined ? null : request.form.toString(),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readCapped(response, options.maxBytes ?? CHATGPT_LIMITS.maxResponseBytes);
    return { kind: 'answer', status: response.status, text };
  } catch {
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** `text` parsed as JSON, or `undefined`. */
export function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
