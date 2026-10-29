import { GSC_LIMITS } from '@app/specs/gsc.spec';

// One outbound call to Google (spec `gsc.spec.ts`, `GSC_LIMITS`; acceptance `gsc.feature.md`,
// Decisions, "Outbound calls"; plan Global Constraint "Outbound calls"). No Electron import: main
// injects `net.fetch`. Every call: `credentials: 'omit'` (no cookie jar), `cache: 'no-store'`,
// `redirect: 'error'` (a token endpoint is never followed elsewhere), a timeout and a capped body.
// What it answers is the status and the body text; nothing here is logged.

/** What the client uses of `net.fetch` (Electron) / `fetch`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * - `answer`: Google answered `status`; `text` is the body, or `null` when it was longer than the cap.
 * - `network`: no answer (refused, DNS, TLS, the timeout).
 */
export type HttpOutcome = { readonly kind: 'answer'; readonly status: number; readonly text: string | null } | { readonly kind: 'network' };

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Headers;
  readonly body?: string;
}

/** The body as text, or `null` when it is longer than `maxBytes`. */
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
export async function send(fetch: FetchLike, url: string, request: HttpRequest, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<HttpOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? GSC_LIMITS.timeoutMs);
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body ?? null,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readCapped(response, options.maxBytes ?? GSC_LIMITS.maxBodyBytes);
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
