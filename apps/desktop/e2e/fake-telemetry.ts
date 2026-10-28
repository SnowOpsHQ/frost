// Test-only: an in-process OTLP/HTTP traces collector and Sentry envelope endpoint on 127.0.0.1
// (`specs/telemetry-consent.schema.ts`, `TELEMETRY_CONFIG_ENV`; `specs/telemetry.feature.md`, Desktop,
// End to end). It records every request it gets and answers 200; the DSN's public key is made up per
// run. Nothing here is a real endpoint or DSN.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedTelemetryRequest {
  readonly method: string;
  /** The path and query, as sent. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface FakeTelemetry {
  /** `http://127.0.0.1:<port>` (a cookie set for it must never be sent). */
  readonly origin: string;
  /** `FROST_PUBLIC_OTEL_ENDPOINT`. */
  readonly otelEndpoint: string;
  /** `FROST_PUBLIC_SENTRY_DSN` (`http://<key>@127.0.0.1:<port>/1`). */
  readonly sentryDsn: string;
  /** Every request, in order (another local process may probe the port: assert on `posts()`). */
  readonly requests: readonly RecordedTelemetryRequest[];
  /** Every `POST` (what frost sends), in order. */
  posts(): RecordedTelemetryRequest[];
  /** The OTLP requests (`POST /v1/traces`). */
  traces(): RecordedTelemetryRequest[];
  /** The Sentry envelope requests (`POST /api/1/envelope/`). */
  envelopes(): RecordedTelemetryRequest[];
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_048_576;

export async function startFakeTelemetry(): Promise<FakeTelemetry> {
  const requests: RecordedTelemetryRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const publicKey = randomBytes(16).toString('hex');
  return {
    origin,
    otelEndpoint: `${origin}/v1/traces`,
    sentryDsn: `http://${publicKey}@127.0.0.1:${port}/1`,
    requests,
    posts: () => requests.filter((r) => r.method === 'POST'),
    traces: () => requests.filter((r) => r.method === 'POST' && r.url === '/v1/traces'),
    envelopes: () => requests.filter((r) => r.method === 'POST' && r.url.startsWith('/api/1/envelope/')),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The Sentry event payloads in an envelope request (a header line, then a header and a payload line per item). */
export function envelopeEvents(request: RecordedTelemetryRequest): Record<string, unknown>[] {
  const lines = request.body.split('\n').filter((line) => line.length > 0);
  const events: Record<string, unknown>[] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    if ((JSON.parse(lines[i]!) as { type?: string }).type === 'event') events.push(JSON.parse(lines[i + 1]!) as Record<string, unknown>);
  }
  return events;
}

/** The span names in an OTLP/HTTP JSON request. */
export function spanNames(request: RecordedTelemetryRequest): string[] {
  const body = JSON.parse(request.body) as { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] };
  return body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans.map((span) => span.name)));
}
