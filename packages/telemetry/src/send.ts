/**
 * Calling the injected transport: every request has a deadline and the channel's abort signal, and
 * settles (never rejects) once it answers, fails, times out or is aborted, whatever the transport does.
 */
import { TELEMETRY_LIMITS } from '@app/specs/telemetry-privacy.spec';
import type { Send, SendResponse } from './types';

export type SendOutcome = { kind: 'answered'; response: SendResponse } | { kind: 'failed' };

export function sendOnce(send: Send, url: string, headers: Record<string, string>, body: string | Uint8Array, abort: AbortSignal): Promise<SendOutcome> {
  const signal = AbortSignal.any([abort, AbortSignal.timeout(TELEMETRY_LIMITS.sendTimeoutMs)]);
  return new Promise<SendOutcome>((resolve) => {
    const onAbort = () => resolve({ kind: 'failed' });
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (outcome: SendOutcome) => {
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    let pending: Promise<SendResponse>;
    try {
      pending = send(url, { headers: { ...headers }, body, signal });
    } catch {
      return settle({ kind: 'failed' });
    }
    Promise.resolve(pending).then(
      (response) => settle(response && typeof response.status === 'number' ? { kind: 'answered', response } : { kind: 'failed' }),
      () => settle({ kind: 'failed' }),
    );
  });
}

/** An `http:` or `https:` URL, or `undefined`. */
export function httpUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
}
