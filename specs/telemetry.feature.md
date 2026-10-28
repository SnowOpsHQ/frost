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
- `token-shapes-are-scrubbed-whole` — thousands of random desktop tokens (`frost_dt_…`), Google access
  tokens (`ya29.…`), refresh tokens (`1//…`), authorization codes (`4/0…`) and client secrets
  (`GOCSPX-…`) each become `[token]`, and PKCE verifiers and codes of 43 to 128 characters after
  `code=` / `code_verifier=` (or quoted, as JSON) become `[redacted]`, whatever their letters; a short
  `code=1` is kept.
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

## Desktop (Phase 4 Task 7)

Spec: `specs/telemetry-consent.schema.ts` (`TELEMETRY_CONFIG_ENV`, `UNPACKAGED_HTTP_TELEMETRY_HOSTS`,
`DSN_PUBLIC_KEY_PATTERN`, `DSN_PROJECT_ID_PATTERN`, `TELEMETRY_CONSENT_FILE`,
`TELEMETRY_CONSENT_FILE_VERSION`, `TELEMETRY_CONSENT_FILE_MAX_BYTES`, `TelemetryConsentFileSchema`,
`TelemetryStateSchema`, `SetConsentInputSchema`, `RENDERER_ERROR_MECHANISMS`, `RendererErrorInputSchema`,
`RendererErrorResultSchema`) and, without Zod for the renderer, `specs/telemetry-consent.spec.ts`
(`RENDERER_ERROR_SOURCES`, `RENDERER_ERROR_LIMITS`, `RENDERER_ERROR_RATE_LIMIT`). Main wires `@app/telemetry` (`apps/desktop/src/main/telemetry/`); the
chrome reaches it only through `telemetry.*` (`packages/ipc-contract/src/telemetry-router.ts`).

### Decisions
- **Consent is known before anything could leave.** `userData/telemetry-consent.json` is read
  synchronously when main starts, before any window opens and before telemetry is created. Missing,
  unreadable, larger than `TELEMETRY_CONSENT_FILE_MAX_BYTES` (checked with `stat` before reading, and
  in bytes after), not JSON, another version or any other shape reads as both off. Writes are atomic
  (a temporary file renamed over it, `0600`); if a write fails the file is removed or, if it cannot be
  (a locked file on Windows), overwritten in place with both off, so the next start is off (fail
  closed: a turn-off never survives as on). The state then says `persisted: false` (Settings: "for
  this run only") until a later write succeeds.
- **Startup never stops the window.** Any exception while telemetry is set up in main
  (`createTelemetryMain`: the consent file, the configuration, the package) falls back to telemetry
  that is unconfigured and off (`span` runs its function and sends nothing, `captureException` does
  nothing, `setConsent` changes nothing), logged with a fixed message, so the first window always opens.
- **Toggling is synchronous.** `telemetry.setConsent` changes main's telemetry and writes the file
  before it answers; off drops what is queued at once (no flush).
- **Configured, not revealed.** The build's DSN and OTLP endpoint (`FROST_PUBLIC_SENTRY_DSN`,
  `FROST_PUBLIC_OTEL_ENDPOINT`) are read like the account's configuration (build time; one rule for
  every public value, `build-config.spec.ts`: only an unpackaged build with no `FROST_PUBLIC_*` value
  baked in at all reads the run-time environment; packaged requires `https:`, unpackaged may use
  `http://127.0.0.1`). The chrome sees only whether each is configured, as a boolean.
- **One door: `net.fetch`.** `POST`, `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`,
  the package's abort signal passed through, and not before the app is ready. `net.fetch` would add
  Chromium's detailed `user-agent` and the user's locale in `accept-language`; both are replaced
  (`TELEMETRY_REQUEST_HEADERS`: `user-agent: frost-telemetry`, `accept-language` empty). What else a
  request carries is Chromium's transport: `host`, `connection`, `content-length`, `content-type`,
  `accept-encoding` and `sec-fetch-site: none`, `sec-fetch-mode: no-cors`, `sec-fetch-dest: empty`
  (the same on every machine). No cookie, even with one stored for the collector's origin.
- **No identifier.** The resource is the app's version and platform (and the runtime's name and
  version for error events); stack frames are relative to the app's root.
- **Crashes behave as before.** Main's uncaught exceptions are observed with Node's
  `uncaughtExceptionMonitor`, which does not replace Electron's default handler (its error dialog
  stays). Electron's main runs Node's `warn` mode for unhandled rejections; an `unhandledRejection`
  listener would silence that warning, so main's listener emits the same
  `UnhandledPromiseRejectionWarning` itself, and the process keeps running as before. An error seen by
  both is reported once.
- **One `app.start` span** from telemetry's creation to the first window (`platform`, `outcome: ok`,
  `duration_ms`). Main's startup promise never rejects: a startup that does not complete leaves the
  span open, and it is never sent. (One that rejected would end it with the error status only.)
- **Quitting is bounded.** On `will-quit`, with a channel on, the quit waits for `shutdown()` (at most
  `shutdownTimeoutMs`) and then goes on; with both off it is not held.
- **Renderer errors** are the chrome's `error` and `unhandledrejection` events, cut to
  `RENDERER_ERROR_LIMITS`, at most `RENDERER_ERROR_RATE_LIMIT` per window of time (in the chrome and
  again in the router), scrubbed by the package and dropped when `errors` is off.

### Startup (`apps/desktop/src/main/__tests__/startup-fallback.test.ts`, faked Electron)
- `telemetry-start-failure-is-unconfigured` — an exception while telemetry is set up answers telemetry that is unconfigured and off: `span` runs its function, nothing is sent, `setConsent` leaves both off; logged with a fixed message only.

### Residual risks (accepted)
- **Free text in renderer errors.** The scrub rules remove patterns (URLs, hosts, emails, paths, tokens,
  IDs, the machine's names). A message that quotes free text, such as a tab's title or a query the user
  typed, keeps that text (cut to `maxMessageChars`) when `errors` is on.
- **Node's rejection mode.** The `unhandledRejection` listener assumes Electron's `warn` mode. Under
  `--unhandled-rejections=throw` or `strict` (not used by frost) a listener stops Node from raising the
  rejection as an uncaught exception, so such a rejection would no longer end in Electron's error
  dialog; only its warning is printed.
- **Version in the resource.** The app's version (and platform) is sent, as the plan allows; it is the
  same for every install of a release.

### Spec schema (`apps/desktop/src/main/telemetry/__tests__/telemetry-consent-spec.test.ts`)
- `telemetry-state-is-strict` — a state with an endpoint, DSN or any other member, or without
  `persisted`, is refused; `configured` is booleans only.
- `telemetry-inputs-are-strict` — `SetConsentInputSchema` and `RendererErrorInputSchema` refuse
  unknown channels, extra members, non-booleans and fields over `RENDERER_ERROR_LIMITS`.
- `consent-file-schema-is-strict` — another `v`, an extra member or a wrong type is refused.
- `renderer-limits-match-the-package` — `RENDERER_ERROR_LIMITS`' name and message caps are
  `TELEMETRY_LIMITS.maxTypeChars` and `maxMessageChars`.

### Consent store (`apps/desktop/src/main/telemetry/__tests__/consent-store.test.ts`, fake fs)
- `consent-store-defaults` — no file: both off, nothing written.
- `consent-store-corrupt-is-default` — not JSON, another version, an extra member, a wrong type, an
  over-large file (not even read: its size comes first) and a read error all read as both off.
- `consent-store-reads-sync` — the file is stat'ed and read once, synchronously, when the store is created.
- `consent-store-writes-atomically` — a write goes to a temporary file (`0600`) renamed over the
  file, valid against `TelemetryConsentFileSchema` with `decidedAt`; a failed write removes the
  temporary file and the file, and answers `false`; a file that can be neither replaced nor removed is
  overwritten with both off; a store created afterwards reads what was written.

### Configuration (`apps/desktop/src/main/telemetry/__tests__/config.test.ts`)
- `telemetry-config-missing-is-not-configured` — no value, or an empty one, is `null` per channel.
- `telemetry-config-packaged-requires-https` — packaged: `http:` (even loopback) is refused.
- `telemetry-config-unpackaged-allows-loopback-http` — unpackaged: `http://127.0.0.1` is accepted,
  other `http:` hosts refused.
- `telemetry-config-runtime-env-only-unpackaged` — the run-time environment is read only unpackaged.
- `telemetry-config-baked-build-ignores-runtime` — a build with either value baked in ignores the
  run-time environment for both, packaged or not (a renamed executable reads as unpackaged); so does a
  build with only another module's value baked in (the account's, Search Console's).
- `telemetry-config-shapes` — an endpoint with credentials, a query or a fragment is refused; a DSN
  needs a public key (`DSN_PUBLIC_KEY_PATTERN`), no password, a project (`DSN_PROJECT_ID_PATTERN`),
  no query or fragment.

### Main wiring (`apps/desktop/src/main/telemetry/__tests__/install.test.ts`, fake app, process and fetch)
- `consent-off-sends-nothing` — with the defaults, the `app.start` span, a main uncaught exception, an
  unhandled rejection and a renderer error make no fetch, also after flush and quit; quitting is not held.
- `set-consent-is-synchronous` — `setConsent` has changed the telemetry and written the store when it
  returns; turning `errors` off drops a queued event (no fetch afterwards); the state's version goes up;
  a failed write still applies the consent and answers `persisted: false` until a write succeeds.
- `off-drops-queued-span` — the `app.start` span queued with `usage` on is never sent once `usage` is
  turned off before its batch leaves, nor after turning on again.
- `transport-is-net-fetch` — `POST` with `credentials: 'omit'`, `cache: 'no-store'`,
  `redirect: 'error'`, the abort signal and `TELEMETRY_REQUEST_HEADERS`, only after the app is ready;
  `retry-after` is passed back.
- `crash-behaviour-is-unchanged` — no `uncaughtException` listener is added (the monitor is used); an
  unhandled rejection still emits `UnhandledPromiseRejectionWarning`; with `errors` on both are
  reported (an error seen twice once), unhandled, with their mechanism.
- `app-start-span` — one `app.start` span ends when startup completes, with `platform`, `outcome` and
  `duration_ms`; the resource carries the version and platform only; a rejected startup ends it with
  the error status and no outcome, and is not an unhandled rejection.
- `shutdown-on-will-quit-is-bounded` — with a channel on, the first `will-quit` is held until
  `shutdown` finishes (at most `shutdownTimeoutMs` with a collector that never answers), then the app
  quits again and that `will-quit` passes.
- `renderer-errors-are-reported` — with `errors` on, a renderer error is captured with its source's
  mechanism, its stack frames parsed and scrubbed; `dropped` when off or not configured.

### Router (`packages/ipc-contract/src/__tests__/telemetry-router.test.ts`)
- `telemetry-procedures-enforce-sender` — every `telemetry.*` procedure rejects a foreign sender before
  the service is called; each is the right type.
- `telemetry-answers-carry-no-secret` — answers never carry the DSN or endpoint; a service answer with
  any other member is a masked internal error.
- `telemetry-inputs-are-validated` — malformed `setConsent` and `reportError` inputs are `BAD_REQUEST`
  before the service is called.
- `report-error-is-rate-limited` — after `RENDERER_ERROR_RATE_LIMIT.maxReports` within `windowMs` the
  rest answer `rate-limited` without reaching the service; a new window resumes.

### Renderer (`apps/desktop/src/renderer/__tests__/settings-telemetry-errors.test.ts`)
- `renderer-errors-are-sent` — `error` and `unhandledrejection` events are reported with their source,
  name, message and stack cut to `RENDERER_ERROR_LIMITS` (never splitting a surrogate pair); a
  non-error reason is reported as text; a failing report never throws or reports itself; after
  `maxReports` in a window nothing more is sent until the next.

### End to end (`apps/desktop/e2e/telemetry.e2e.ts`, a fake OTLP collector and Sentry endpoint)
- `telemetry-nothing-before-consent` — with the defaults, the startup span, a renderer error and a
  main unhandled rejection send nothing; the state says both off and both configured.
- `telemetry-errors-on-sends-scrubbed` — after `setConsent` on, a renderer error and a main rejection
  arrive at the Sentry endpoint without the URL, host, email, paths (the checkout's too), the
  machine's host name, its first label or the login name they carried; no request carries the cookie
  stored for the collector's origin, a detailed user agent or a locale.
- `telemetry-off-stops-at-once` — after `setConsent` off, nothing more arrives; started with `usage` on
  (a consent file written before launch) and turned off before the startup span's batch leaves, the
  `app.start` span never reaches the collector.
- `telemetry-consent-persists` — consent survives a restart on the same profile (the file is
  `TelemetryConsentFileSchema`), and with `usage` on the `app.start` span arrives at the collector.
