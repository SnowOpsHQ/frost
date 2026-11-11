# Feature: Export Diagnostics

Spec: `specs/diagnostics.spec.ts` (`DIAGNOSTICS_LOG_RING`, `DIAGNOSTICS_LIMITS`, `DIAGNOSTICS_FIELDS`,
`DIAGNOSTICS_FEATURES`, `DIAGNOSTICS_FORBIDDEN`, `DIAGNOSTICS_SCRUB_RULES`, `DIAGNOSTICS_RESULTS`,
`DIAGNOSTICS_SAVE_DIALOG`, `DIAGNOSTICS_TEXT`), `specs/help.spec.ts` (`HELP_MENU` += Export
Diagnostics…, `HELP_SHEETS` += `diagnostics`, `HELP_PALETTE_ACTIONS` += `help.diagnostics`) and
`specs/whats-new.schema.ts` (`DiagnosticsInputSchema`, `DiagnosticsReportSchema`,
`SaveDiagnosticsInputSchema`, `DiagnosticsResultSchema`). Phase 11 Task 12 (SL-125; plan Decision 14,
Global constraints: Secrets). Each line maps to one named test.

## Decisions
- **Never sent anywhere.** The report is shown in a Help sheet for review and saved only by main, in
  its own save dialog, to the file the user picks. No procedure sends it, no URL is opened with it.
- **What a report holds:** frost's, Electron's, Chromium's and Node's versions; the platform, the
  architecture and the OS release (no host or user name); whether the build is packaged; the applied
  migration ids; feature booleans (`DIAGNOSTICS_FEATURES`: configured or on, never a value); and the
  ring of main's own warnings and errors. Nothing else (`DIAGNOSTICS_FIELDS`).
- **What a report never holds** (`DIAGNOSTICS_FORBIDDEN`): URLs of any scheme (and bare `www.` or
  host-with-path names), email addresses, file paths (POSIX and Windows, `\\?\`, UNC), keys and
  tokens, IP addresses, the host and user names, page text. In practice no `/`, `\` or `@` survives.
- **The ring** (`DIAGNOSTICS_LOG_RING`: 500 lines of at most 500 characters) is installed from
  `index.ts` at startup, before anything else runs. It wraps `console.warn` and `console.error` (every
  main logger calls them) without changing what they print; each call's text is cut, split into
  lines, scrubbed and only then kept, so raw text never sits in the ring. A warning raised while the
  ring handles one is printed, not recorded (no recursion); a failure inside the ring is swallowed.
- **Scrubbing, twice.** Telemetry's scrubber (`createScrubber`, `SCRUB_RULES`) with `machineLiterals`
  plus the home, temp and app folders as literals, then `DIAGNOSTICS_SCRUB_RULES`; each line when it
  enters the ring, and every line of the report again when it is built.
- **Sources.** Only main's own console calls. Page console messages (the devtools drawer's per-tab
  log) are never added. The agent utility process and the SEO worker threads write to their own
  stdout and stderr (inherited file descriptors, or ignored when packaged), not through main's
  `console`, so they never reach the ring; main's own lines about them (`log` callbacks) do, scrubbed.
  Node's process warnings are printed through `console.error` and kept, among them telemetry's
  re-emitted unhandled rejections (`process.emitWarning(reason, 'UnhandledPromiseRejectionWarning')`,
  the reason's stack or text). **Limit:** free text in a rejection reason or an error message (a
  name, a sentence) has no shape a pattern can match; the review step is where it is caught.
- **Formatting.** An `Error` argument is written as `name: message`, its stack frames and an Error
  cause's `name: message`, never its own properties. Where `util.inspect` cuts a string inside an
  object, the token the cut went through is dropped before scrubbing.
- **Disguised text.** Each line is scrubbed in NFKC (full-width `．` `／` `＠`); a token holding a
  percent-escape is decoded on the side and redacted whole if the decoded form would be scrubbed;
  encoded `/ \ @ :` (`%2F %5C %40 %3A`, double-encoded too) are redacted whole. After
  `authorization`, `proxy-authorization`, `cookie` or `set-cookie` and `:`/`=`, the rest of the line
  goes; so does the value after a `--password`/`--token`/`--secret`/`--api-key` flag and after the
  words `password`, `passwd`, `token`.
- **Main writes what it showed.** `help.diagnostics` builds a report, keeps it under a fresh id
  (at most `maxKeptReports`) and answers the id and the text. `help.saveDiagnostics` takes only the
  id, never text: main writes its kept copy byte for byte. Cancel writes nothing; one diagnostics save
  dialog at a time (`busy`); a forgotten id is `stale`.

## Report (`apps/desktop/src/main/diagnostics/__tests__/report.test.ts`)
- **Scenario: report-has-no-urls-emails-paths-or-keys** — one test per `DIAGNOSTICS_FORBIDDEN` class:
  every example line logged through the ring, the report built, and none of its secrets left; the
  class's `detect` pattern finds nothing; the report has no `/`, `\` or `@`; the header fields are
  present and their values intact. Page text: the ring's module never listens for `console-message`.
- **Scenario: ring-capped-and-scrubbed** — more than `maxLines` lines keep the newest `maxLines`; a
  long line is cut to `maxLineChars`; a huge argument never reaches the scrubber whole; each kept line
  equals its scrubbed form (telemetry's scrubber with literals, then the diagnostics pass), and the
  raw text is not held anywhere in the ring; a string `util.inspect` cut inside an object loses the
  token the cut went through; cookie strings, short `Authorization` values, percent-encoded and
  full-width URLs and addresses, and flag-style secrets are gone; an Error argument shows no own
  properties.
- **Scenario: ring-keeps-warn-and-error-only** — `log`, `info` and `debug` are not kept; `warn` and
  `error` are; what the console prints is unchanged; a warning raised inside the ring's handler is
  printed but not recorded; an argument that throws when formatted is recorded as unprintable; the
  ring never throws.
- **Scenario: save-writes-what-main-built** — the file written is exactly the text `report()`
  answered; saving takes an id only; a second save while the dialog is open answers `busy`; an
  unknown or forgotten id answers `stale` with no dialog.
- **Scenario: cancelled-writes-nothing** — a cancelled dialog writes nothing and answers `cancelled`;
  a failed write answers `failed` and logs a fixed message (no path).

## Router (`packages/ipc-contract/src/__tests__/help-router.test.ts`)
- **Scenario: help-router-enforces-sender** — `help.diagnostics` and `help.saveDiagnostics` refuse
  any sender but the app's own windows (nothing called).
- **Scenario: help-router-validates** — `saveDiagnostics` takes `{ reportId }` (a UUID) only; text,
  a path or extra fields are refused; the answer must pass `DiagnosticsReportSchema` (bounded, no
  `/`, `\` or `@`) and `DiagnosticsResultSchema`, else the chrome gets an internal error.

## Menu (`apps/desktop/src/main/__tests__/menu.test.ts`)
- **Scenario: help-menu-items** — Export Diagnostics… is the last Help item, in its own group, and its
  click asks for the diagnostics sheet in the window the menu acted on.

## End to end (`apps/desktop/e2e/settings.e2e.ts`, save dialog stubbed)
- **Scenario: export-diagnostics-saves-reviewed-report** — main logs lines with a URL, an address and
  the profile's path; Help › Export Diagnostics… shows the report; Save… writes a file (mode 0600, also over an existing file: a new owner-only file renamed over it) equal to the
  shown text, with no `http`, no address and no profile path.
