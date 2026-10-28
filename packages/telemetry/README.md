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
await telemetry.flush();               // sends what is queued now on the channels that are on (≤ 10 s)
await telemetry.shutdown();            // flushes for up to 2 s, then drops the rest and stops
await telemetry.shutdown({ timeoutMs: 500 });   // either takes its own deadline
```

`send(url, { headers, body, signal }) => Promise<{ status, headers? }>` is the only door to the
network. Main passes a `net.fetch` wrapper (`method: 'POST'`, `credentials: 'omit'`, the given
`signal`); returning `retry-after` / `x-sentry-rate-limits` in `headers` lets Sentry back off.
`signal` aborts when the channel is turned off or after `TELEMETRY_LIMITS.sendTimeoutMs`. Neither
`send` failures nor anything else in this package throws into the app (except `setConsent` with an
unknown channel, and `createTelemetry` with malformed consent).

`span(name, attributes, fn)` returns `fn`'s result and rethrows its error, marking the span an error,
on or off. A plain `Promise` ends the span when it settles and comes back as a promise that settles
the same way (so an unhandled rejection is still reported as one); anything else (a thenable such as
a query builder, a promise subclass, any value) comes back unchanged and the span ends when `fn`
returns. `name` is a fixed identifier (`SPAN_NAME_PATTERN`, e.g. `seo.audit`); nested spans (also
across `await`) are children of the enclosing one.

`flush({ timeoutMs })` and `shutdown({ timeoutMs })` never wait past their deadline
(`TELEMETRY_LIMITS.flushTimeoutMs`, `shutdownTimeoutMs` by default): an unreachable collector cannot
hang quitting. A flush exports what was queued when it was called; at shutdown's deadline whatever is
still queued is dropped and requests in flight are aborted. A second `shutdown()` answers the first's
promise.

## Privacy rules (what the tests hold)
- **Consent is checked where data leaves**: spans at their end; Sentry before capture, in
  `beforeSend`, when the transport gets an envelope, and when the request is about to go out.
- **Off means now**: turning a channel off empties its queue without sending it and aborts the
  request in flight; a span that ends later is dropped. On again starts from an empty queue, and a
  span or event begun before the turn-off is dropped even if it ends after turning on again.
- **Allowlisted span attributes only** (`SPAN_ATTRIBUTE_ALLOWLIST`, each with its value rule); no span
  events, links or status messages. A later phase adds its keys to the allowlist in the spec.
- **No identifier**: the trace resource is `service.name`, `service.version`, `os.type`. Error events
  are rebuilt from `SENTRY_EVENT_KEYS` (no `user`, `request`, `server_name`, `extra`, `breadcrumbs`,
  `tags`…), contexts `os.name`, `runtime`, `app.app_version`; only `event` envelope items the channel
  rebuilt itself (Sentry's internal reports skip `beforeSend`, so the transport checks again), without
  the trace header.
- **Scrubbed**: messages, exception types, frame functions, modules and files, token attributes are
  cut to `maxScrubInputChars`, go through `SCRUB_RULES` plus host and user name redaction (a short
  login name only as a whole word), then are capped (`TELEMETRY_LIMITS`). The rules run in linear
  time. Besides URLs, addresses, tokens and IDs they remove bare host names (DNS and TLS errors name
  the sites frost visits) and absolute paths anywhere. Frame files are app-relative
  (`app:///out/main/index.js`), `node_modules/…`, `node:…`, a base name, or `[url]`.

### What the host rule keeps
A lower-case name is a host when it has two or more dots (`www.example.com`, `api.acme.co.uk`), or one
dot and a last label from `ONE_DOT_HOST_TLDS` (`com`, `corp`, `local`, `internal` …) or of two letters
(a country code). A last label in `HOST_FILE_EXTENSIONS` is never a host, so file names stay
(`index.ts`, `seo-analysis.cjs`, `vendor.min.js`). One-dot identifiers stay too (`page.reload`,
`console.log`, `net.fetch`): command IDs look like that, and a `command` attribute with two dots would
be dropped as a host. Mixed-case names (`Server.emit`) are code. The price: a one-dot host in a TLD
outside the list (`acme.agency`, `acme.law` are in it; `acme.museum` is not) is kept, and a lower-case
dotted identifier with two dots (`window.frost.invoke`) reads `[host]`.

## Implementation notes
- The SDK's `BatchSpanProcessor` cannot discard its queue without exporting it, so a small gated
  processor (`src/otel.ts`) batches spans itself (`exportDelayMs`, `maxExportBatch`, `maxQueuedSpans`)
  and serialises OTLP/HTTP JSON directly; the exporter never reads a span's resource. Spans come
  from `@opentelemetry/sdk-trace`'s `TracerProvider`.
- The Sentry client (`src/sentry.ts`) subclasses `@sentry/core`'s `Client` with no integrations,
  `dataCollection` all off (Sentry 11's replacement for `sendDefaultPii`), no client reports, a private
  `Scope`, and `createTransport` over a queue drained on the next macrotask.
- Consumers bundle the TypeScript source (`exports` → `src/index.ts`); `build` only type-checks.
