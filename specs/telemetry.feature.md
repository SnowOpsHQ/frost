# Feature: consent-gated telemetry

Spec: `specs/telemetry-privacy.spec.ts` (`TELEMETRY_CHANNELS`, `TELEMETRY_CHANNEL_BACKENDS`,
`TelemetryConsentSchema`, `DEFAULT_CONSENT`, `TELEMETRY_SERVICE_NAME`, `RESOURCE_ATTRIBUTE_KEYS`,
`FORBIDDEN_RESOURCE_PREFIXES`, `OS_TYPE_BY_PLATFORM`, `SPAN_ATTRIBUTE_ALLOWLIST`, `SPAN_NAME_PATTERN`,
`SPAN_NAME_FALLBACK`, `TELEMETRY_LIMITS`, `SCRUB_RULES`, `HOST_FILE_EXTENSIONS`, `ONE_DOT_HOST_TLDS`,
`MIN_LITERAL_REDACTION_CHARS`, `MIN_UNBOUNDED_LITERAL_CHARS`, `SENTRY_EVENT_KEYS`, `SENTRY_CONTEXT_ALLOWLIST`, `SENTRY_FRAME_KEYS`, `APP_FRAME_PREFIX`,
`SENTRY_ENVELOPE_ITEM_TYPES`). Phase 4 Task 6 (`@app/telemetry`); Task 7 adds the Desktop section.
Review focus "Telemetry UI matches behaviour". Each line maps to one named test.

## Decisions
- **Off by default, and nothing before consent.** Both channels start off (`DEFAULT_CONSENT`). With a
  channel off nothing of it is sent: not at the span's end, not on `flush()`, not on `shutdown()`.
- **Off means now.** Turning a channel off discards what it has queued without sending it (no final
  flush), aborts a request in flight, and drops a span or event that finishes later. Turning it on
  again starts with an empty queue: a span or event begun before turning off is dropped even when it
  ends after turning on again (each turn-off starts a new consent epoch).
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
- **Scrubbed.** Every string that leaves is cut to `maxScrubInputChars`, goes through `SCRUB_RULES`
  and the host and user name redaction, then is capped. Every rule runs in linear time. A browser's
  errors name the sites it visits, so bare host names and absolute paths anywhere (not only in the
  home folder) are scrubbed. Stack frame files become app-relative (`APP_FRAME_PREFIX`).
- **Only rebuilt events.** The Sentry transport sends only `event` items the channel rebuilt in
  `beforeSend` (Sentry skips `beforeSend` for its own internal error reports), cut back to
  `SENTRY_EVENT_KEYS`; any other item is dropped.
- **Quitting does not hang.** `flush()` and `shutdown()` take a `timeoutMs` (defaults
  `flushTimeoutMs` and `shutdownTimeoutMs`); at the deadline they resolve, and shutdown drops what is
  left and aborts what is in flight. A flush exports what was queued when it was called.
- **`span` hands back what `fn` returned.** A plain promise is followed to its end (and comes back as
  a promise that settles the same way); anything else, thenables included, comes back unchanged.
- **Not configured is off.** A channel without an endpoint (or DSN), or with one that does not parse
  as `http(s)`, sends nothing whatever its consent.

## Package (`packages/telemetry/src/__tests__/telemetry.test.ts`)
- `nothing-sent-before-consent` — with the defaults, spans and exceptions make no `send` call, also
  after `flush()` and `shutdown()`.
- `off-stops-export-immediately` — spans and events queued before turning off are never sent; no
  flush on turn-off; a request in flight is aborted; a span ending after turn-off is dropped; an
  event already past `beforeSend` and waiting in the transport's queue is dropped (also once turned
  on again).
- `on-again-resumes` — off then on: only what came after the second on is sent, from a fresh queue;
  a span started before turning off and ending after turning on again is dropped.
- `events-are-scrubbed` — a URL, an email, home paths, a bearer token, a JWT, the host name, bare
  host names (`getaddrinfo ENOTFOUND client-private-site.com`, `Host: acme-intranet.corp.`,
  `www.example.com/alice/profile`) and absolute paths outside the home folder (`D:\…`, UNC,
  `/mnt/…`, `/Volumes/…`, `/run/media/…`) in an error's message, its stack frames and span
  attributes never leave; token attributes that pass their pattern but carry an ID, a host or a
  redacted name are dropped while plain ones are kept; frames are app-relative; the event has none
  of the dropped fields even when the process's Sentry scopes carry them.
- `only-allowlisted-attributes-leave` — other keys, out-of-range values and free text are dropped;
  long tokens are capped; no events, links or status message; a throw sets only the error status
  code; a data-built name is `span`.
- `resource-has-no-identifier` — exactly `RESOURCE_ATTRIBUTE_KEYS`, no forbidden prefix, and neither
  the host name (nor its first label), user name nor pid appears in what is sent, also when an
  error's message carries the machine's real names (the default redaction).
- `missing-endpoint-is-noop` — no endpoint, an empty or non-`http(s)` one, or a bad DSN sends nothing
  with consent on, and `configured()` says so; `span` still runs its function.
- `otlp-json-export` — OTLP/HTTP JSON to the endpoint: hex IDs, nanosecond strings, a child shares its
  parent's trace; batches are capped and the queue is bounded.
- `otlp-export-is-scheduled` — a batch leaves `exportDelayMs` after its first span, not before.
- `sentry-sends-only-events` — envelopes go to the DSN's envelope endpoint and carry only `event` items,
  without a trace header; an attachment from a shared scope is dropped; an event that skipped
  `beforeSend` (Sentry's internal report) never leaves; the filter drops non-event items and events
  it did not rebuild, and cuts what it keeps back to `SENTRY_EVENT_KEYS`.
- `span-runs-the-function` — sync and async values come back and throws are rethrown, on or off; a
  thenable, a promise subclass, a promise with its own fields and an object come back unchanged.
- `flush-and-shutdown-have-deadlines` — with a collector and a Sentry endpoint that never answer,
  `flush({ timeoutMs })` and `shutdown({ timeoutMs })` resolve at the deadline, shutdown aborts what
  is in flight and nothing leaves afterwards; the defaults are `shutdownTimeoutMs` and
  `flushTimeoutMs`; concurrent `shutdown()` calls share one promise; a flush while spans keep ending
  exports only what was queued when it was called.
- `send-failures-are-swallowed` — a rejected or failing `send` never reaches the app.
- `consent-is-validated` — an unknown channel or a non-boolean is refused; `consent()` is a copy.

## Scrubbing (`packages/telemetry/src/__tests__/scrub.test.ts`)
- `scrub-rules` — every `SCRUB_RULES` rule removes its examples (quoted secrets whole, paths with
  spaces, bare hosts with their port and path).
- `scrub-keeps-plain-text` — ordinary error text, line numbers, `a::b`, identifiers (`page.reload`,
  `console.log`, `Server.emit`), file names (`index.ts`, `seo-analysis.cjs`), relative paths, media
  types and dates are left alone.
- `scrubbing-is-linear` — each rule on 1 MB of hostile text of each shape (`aaa…`, `???…`,
  `eyJ-eyJ-…`, `a.a.…`, `/a/a…` …) stays well under a quarter second; the scrubber, which cuts first, faster still.
- `scrubbing-cuts-before-and-after` — a secret split by the input cut leaves no half behind; a cut
  never splits a code point.
- `host-rule-lists` — `HOST_FILE_EXTENSIONS` and `ONE_DOT_HOST_TLDS` do not overlap; a file with each
  extension is kept, a one-dot name in each TLD is a host.
- `literal-redaction` — the given names are replaced; ones shorter than `MIN_LITERAL_REDACTION_CHARS`
  are not; ones shorter than `MIN_UNBOUNDED_LITERAL_CHARS` only as whole words (`ann` leaves
  `Cannot`); by default the host name, its first label and the login name.
- `frames-are-app-relative` — app root, `app.asar`, `app://`, `node_modules`, `node:`, `<…>` (scrubbed),
  other files and URLs; a file is capped and a hostile one handled in linear time.
