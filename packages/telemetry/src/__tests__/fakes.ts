// Fake transports for the telemetry tests: they record every request and can hold one open.
import type { Send, SendRequest, SendResponse } from '../index';

export const OTEL_ENDPOINT = 'https://otel.example.test/v1/traces';
export const SENTRY_DSN = 'https://publickey@errors.example.test/42';
export const RESOURCE = { serviceVersion: '1.4.0', platform: 'linux' } as const;

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface FakeTransport {
  send: Send;
  calls: RecordedRequest[];
  /** Hold every later request open until `release()` (or until its signal aborts). */
  hold(): void;
  release(response?: SendResponse): void;
  /** Answer every later request with this status, or reject when `'reject'`. */
  answer(status: number | 'reject'): void;
}

export function fakeTransport(): FakeTransport {
  const calls: RecordedRequest[] = [];
  let holding = false;
  let status: number | 'reject' = 200;
  const held: ((response: SendResponse) => void)[] = [];
  const send: Send = (url: string, request: SendRequest) => {
    const body = typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body);
    calls.push({ url, headers: { ...request.headers }, body, signal: request.signal });
    if (holding) {
      return new Promise<SendResponse>((resolve, reject) => {
        held.push(resolve);
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    if (status === 'reject') return Promise.reject(new Error('network down'));
    return Promise.resolve({ status });
  };
  return {
    send,
    calls,
    hold: () => {
      holding = true;
    },
    release: (response = { status: 200 }) => {
      holding = false;
      for (const resolve of held.splice(0)) resolve(response);
    },
    answer: (next) => {
      status = next;
    },
  };
}

// ---- Reading what was sent --------------------------------------------------------------------

export interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
  events?: unknown[];
  links?: unknown[];
}
export interface OtlpBody {
  resourceSpans: { resource: { attributes: OtlpAttribute[] }; scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[] }[];
}

export function otlpBodies(transport: FakeTransport): OtlpBody[] {
  return transport.calls.map((call) => JSON.parse(call.body) as OtlpBody);
}

export function otlpSpans(transport: FakeTransport): OtlpSpan[] {
  return otlpBodies(transport).flatMap((body) => body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
}

/** An attribute list as a plain object (`intValue` as a number). */
export function attributeMap(attributes: OtlpAttribute[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const { key, value } of attributes) {
    if (value.stringValue !== undefined) out[key] = value.stringValue;
    else if (value.intValue !== undefined) out[key] = Number(value.intValue);
    else if (value.doubleValue !== undefined) out[key] = value.doubleValue;
    else if (value.boolValue !== undefined) out[key] = value.boolValue;
  }
  return out;
}

export interface SentryEnvelope {
  header: Record<string, unknown>;
  items: { header: { type: string } & Record<string, unknown>; payload: Record<string, unknown> }[];
}

/** A Sentry envelope: a header line, then a header line and a payload line per item. */
export function parseEnvelope(body: string): SentryEnvelope {
  const lines = body.split('\n').filter((line) => line.length > 0);
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  const items: SentryEnvelope['items'] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    items.push({ header: JSON.parse(lines[i]!) as SentryEnvelope['items'][number]['header'], payload: JSON.parse(lines[i + 1]!) as Record<string, unknown> });
  }
  return { header, items };
}

export function sentryEvents(transport: FakeTransport): Record<string, unknown>[] {
  return transport.calls.flatMap((call) => parseEnvelope(call.body).items.filter((item) => item.header.type === 'event').map((item) => item.payload));
}

/** Let queued macrotasks (the error queue's drain) run. */
export const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds, or 3 s pass (a fixed wait can end first on a loaded CI runner). */
export async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3_000;
  while (!check() && Date.now() < end) await tick(10);
}
