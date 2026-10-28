# @app/telemetry

Consent-gated telemetry for the main process (Phase 4 Task 6). Spec:
`specs/telemetry-privacy.spec.ts`; acceptance: `specs/telemetry.feature.md`.

Two channels, both **off by default**:

| Channel | What | Wire format |
|---|---|---|
| `usage` | OpenTelemetry traces (`@opentelemetry/sdk-trace` `TracerProvider`) | OTLP/HTTP JSON, `POST <endpoint>` |
| `errors` | Sentry error events (`@sentry/core` only) | Sentry envelope, `POST <DSN's envelope endpoint>` |

Pure Node: no Electron import, no Node HTTP client, no `@sentry/node`/`@sentry/electron` (they
instrument the process and add their own IPC), no OpenTelemetry resource detectors. The host
injects the transport.

## API

```ts
import { createTelemetry } from '@app/telemetry';

const telemetry = createTelemetry({
  consent: { usage: false, errors: false },          // from main's consent store; default: both off
  resource: { serviceVersion: app.getVersion(), platform: process.platform,
              runtime: { name: 'electron', version: process.versions.electron } },
  otel: { endpoint: FROST_PUBLIC_OTEL_ENDPOINT, send },  // absent / not http(s) → channel is a no-op
  sentry: { dsn: FROST_PUBLIC_SENTRY_DSN, send },        // absent / invalid → channel is a no-op
  appRoot: app.getAppPath(),                         // stack frames under it become app:///…
  // redact: [...]                                   // default: os.hostname() and the login name
});

telemetry.span('app.start', { outcome: 'ok' }, (span) => { /* …; span.setAttributes({ duration_ms }) */ });
telemetry.captureException(error, { mechanism: 'onuncaughtexception', handled: false });
telemetry.setConsent('usage', true);   // or false: drops the queue, aborts the request in flight
telemetry.consent();                   // { usage, errors } (a copy)
telemetry.configured();                // { usage, errors }: whether this build has an endpoint / DSN
await telemetry.flush();               // sends what is queued on the channels that are on
await telemetry.shutdown();            // flushes the channels that are on, then stops
```

`send(url, { headers, body, signal }) => Promise<{ status, headers? }>` is the only door to the
network. Main passes a `net.fetch` wrapper (`method: 'POST'`, `credentials: 'omit'`, the given
`signal`); returning `retry-after` / `x-sentry-rate-limits` in `headers` lets Sentry back off.
`signal` aborts when the channel is turned off or after `TELEMETRY_LIMITS.sendTimeoutMs`. Neither
`send` failures nor anything else in this package throws into the app (except `setConsent` with an
unknown channel, and `createTelemetry` with malformed consent).

`span(name, attributes, fn)` returns `fn`'s result (a promise's too) and rethrows its error, marking
the span an error. `name` is a fixed identifier (`SPAN_NAME_PATTERN`, e.g. `seo.audit`); nested spans
(also across `await`) are children of the enclosing one.

## Privacy rules (what the tests hold)
- **Consent is checked where data leaves**: spans at their end; Sentry before capture, in
  `beforeSend`, when the transport gets an envelope, and when the request is about to go out.
- **Off means now**: turning a channel off empties its queue without sending it and aborts the
  request in flight; a span that ends later is dropped. On again starts from an empty queue.
- **Allowlisted span attributes only** (`SPAN_ATTRIBUTE_ALLOWLIST`, each with its value rule); no span
  events, links or status messages. A later phase adds its keys to the allowlist in the spec.
- **No identifier**: the trace resource is `service.name`, `service.version`, `os.type`. Error events
  are rebuilt from `SENTRY_EVENT_KEYS` (no `user`, `request`, `server_name`, `extra`, `breadcrumbs`,
  `tags`…), contexts `os.name`, `runtime`, `app.app_version`; only `event` envelope items, without the
  trace header.
- **Scrubbed**: messages, exception types, frame functions and modules, token attributes go through
  `SCRUB_RULES` plus host and user name redaction, then are capped (`TELEMETRY_LIMITS`). Frame files
  are app-relative (`app:///out/main/index.js`), `node_modules/…`, `node:…`, a base name, or `[url]`.

## Implementation notes
- The SDK's `BatchSpanProcessor` cannot discard its queue without exporting it, so a small gated
  processor (`src/otel.ts`) batches spans itself (`exportDelayMs`, `maxExportBatch`, `maxQueuedSpans`)
  and serialises OTLP/HTTP JSON directly; the exporter never reads a span's resource.
- The Sentry client (`src/sentry.ts`) subclasses `@sentry/core`'s `Client` with no integrations,
  `dataCollection` all off (Sentry 11's replacement for `sendDefaultPii`), no client reports, a private
  `Scope`, and `createTransport` over a queue drained on the next macrotask.
- Consumers bundle the TypeScript source (`exports` → `src/index.ts`); `build` only type-checks.
