# Feature: consent-gated telemetry

Spec: `specs/telemetry-privacy.spec.ts` (`TELEMETRY_CHANNELS`, `TELEMETRY_CHANNEL_BACKENDS`,
`TelemetryConsentSchema`, `DEFAULT_CONSENT`, `TELEMETRY_SERVICE_NAME`, `RESOURCE_ATTRIBUTE_KEYS`,
`FORBIDDEN_RESOURCE_PREFIXES`, `OS_TYPE_BY_PLATFORM`, `SPAN_ATTRIBUTE_ALLOWLIST`, `SPAN_NAME_PATTERN`,
`SPAN_NAME_FALLBACK`, `TELEMETRY_LIMITS`, `SCRUB_RULES`, `MIN_LITERAL_REDACTION_CHARS`,
`SENTRY_EVENT_KEYS`, `SENTRY_CONTEXT_ALLOWLIST`, `SENTRY_FRAME_KEYS`, `APP_FRAME_PREFIX`,
`SENTRY_ENVELOPE_ITEM_TYPES`). Phase 4 Task 6 (`@app/telemetry`); Task 7 adds the Desktop section.
Review focus "Telemetry UI matches behaviour". Each line maps to one named test.

## Decisions
- **Off by default, and nothing before consent.** Both channels start off (`DEFAULT_CONSENT`). With a
  channel off nothing of it is sent: not at the span's end, not on `flush()`, not on `shutdown()`.
- **Off means now.** Turning a channel off discards what it has queued without sending it (no final
  flush), aborts a request in flight, and drops a span or event that finishes later. Turning it on
  again starts with an empty queue.
- **Consent is checked where data leaves.** Spans are dropped at their end when `usage` is off; Sentry's
  `beforeSend` returns `null` when `errors` is off and its transport checks consent again before every
  request.
- **One door per channel.** Both channels send through a `send(url, { headers, body, signal })`
  function the host injects (main passes `net.fetch`). The package imports no Electron, no Node HTTP
  client, no Sentry Node SDK (which instruments the process on its own), and runs no resource detector.
- **No identifier.** A trace's resource has `service.name`, `service.version` and `os.type` only. An
  error event is rebuilt from `SENTRY_EVENT_KEYS`: no `request`, `user`, `server_name`, `extra`,
  `breadcrumbs`, `tags`, `modules` or `debug_meta`, whatever else in the process set them; contexts are
  `os.name`, `runtime` and `app.app_version` only. Span and event IDs are random per span and event.
- **Allowlisted attributes only.** A span exports `SPAN_ATTRIBUTE_ALLOWLIST` keys whose values pass
  their rule; nothing else (no events, links or status messages). A name that is not
  `SPAN_NAME_PATTERN` is exported as `span`.
- **Scrubbed.** Every string that leaves goes through `SCRUB_RULES` and the host and user name
  redaction, then is capped. Stack frame files become app-relative (`APP_FRAME_PREFIX`).
- **Not configured is off.** A channel without an endpoint (or DSN), or with one that does not parse
  as `http(s)`, sends nothing whatever its consent.

## Package (`packages/telemetry/src/__tests__/telemetry.test.ts`)
- `nothing-sent-before-consent` — with the defaults, spans and exceptions make no `send` call, also
  after `flush()` and `shutdown()`.
- `off-stops-export-immediately` — spans and events queued before turning off are never sent; no
  flush on turn-off; a request in flight is aborted; a span ending after turn-off is dropped.
- `on-again-resumes` — off then on: only what came after the second on is sent, from a fresh queue.
- `events-are-scrubbed` — a URL, an email, home paths, a bearer token, a JWT and the host name in an
  error's message, its stack frames and span attributes never leave; frames are app-relative; the
  event has none of the dropped fields even when the process's Sentry scopes carry them.
- `only-allowlisted-attributes-leave` — other keys, out-of-range values and free text are dropped;
  long tokens are capped; no events, links or status message; a data-built name is `span`.
- `resource-has-no-identifier` — exactly `RESOURCE_ATTRIBUTE_KEYS`, no forbidden prefix, and neither
  the host name, user name nor pid appears in what is sent.
- `missing-endpoint-is-noop` — no endpoint, an empty or non-`http(s)` one, or a bad DSN sends nothing
  with consent on, and `configured()` says so; `span` still runs its function.
- `otlp-json-export` — OTLP/HTTP JSON to the endpoint: hex IDs, nanosecond strings, a child shares its
  parent's trace, an error status for a throw; batches are capped and the queue is bounded.
- `otlp-export-is-scheduled` — a batch leaves `exportDelayMs` after its first span, not before.
- `sentry-sends-only-events` — envelopes go to the DSN's envelope endpoint and carry only `event` items,
  without a trace header.
- `span-runs-the-function` — sync and async values come back and throws are rethrown, on or off.
- `send-failures-are-swallowed` — a rejected or failing `send` never reaches the app.
- `consent-is-validated` — an unknown channel or a non-boolean is refused; `consent()` is a copy.

## Scrubbing (`packages/telemetry/src/__tests__/scrub.test.ts`)
- `scrub-rules` — every `SCRUB_RULES` rule removes its examples.
- `scrub-keeps-plain-text` — ordinary error text, line numbers and `a::b` are left alone.
- `literal-redaction` — the given names are replaced; ones shorter than `MIN_LITERAL_REDACTION_CHARS` are not.
- `frames-are-app-relative` — app root, `app.asar`, `app://`, `node_modules`, `node:`, other files and URLs.
