# Feature: the Settings view (account, plan, telemetry and Search Console)

Spec: `specs/account-settings.spec.ts` (`SETTINGS_SECTIONS`, `SETTINGS_TITLE`, `SETTINGS_MENU`,
`SETTINGS_PALETTE_ACTIONS`, `FEATURE_LABELS`, `SETTINGS_CONFIRM_ARM_MS`, `SETTINGS_RETRY`,
`SPAN_ATTRIBUTE_WORDS`, `SCRUB_RULE_WORDS`, `ACCOUNT_SETTINGS_TEXT`, `TELEMETRY_SETTINGS_TEXT`,
`GSC_SETTINGS_TEXT`, `MAX_PENDING_SETTINGS_WATCHES`) and `specs/account-settings.schema.ts`
(`SettingsViewWatchInputSchema`, `SettingsViewStateSchema`), driving the main-side contracts
`specs/account-state.schema.ts`, `specs/telemetry-consent.schema.ts`, `specs/telemetry-privacy.spec.ts`
and `specs/gsc.spec.ts`. Phase 4 Task 9. Review focus "Telemetry UI matches behaviour" and "A website or
another app cannot sign the user in to someone else's account" (the in-app confirmation). Each line maps
to one named test.

## Decisions
- **A sheet over the page column, like History.** While Settings shows it fills the page column and the
  page area is laid out zero-high, so the tab's view (drawn above the chrome) never covers it; the find
  bar's row is hidden too (as for History). At most one of History and Settings shows: opening one
  closes the other. It closes on Close, Esc, another tab shown or a new document in this one (as
  History). **While a sign-in waits for its confirmation** page changes and History do not close it
  (History is closed instead), and Close or Esc cancel the sign-in (main revokes the exchanged token)
  before closing: a waiting confirmation is never hidden. When the sheet closes with focus inside it,
  focus goes to the page, else to the address bar.
- **Opening.** The palette ("Settings", "Sign in to frost" while signed out, "Search Console
  settings", "Telemetry settings", each on its section) and the menu item "Settings…" (`SETTINGS_MENU`,
  Mod+,: the macOS app menu, elsewhere the end of Edit). The menu is main's, so main signals the chrome
  through the account's `account.settingsWatch` long-poll: a counter **per app window**
  (`SettingsViewStateSchema`; the window the menu acted on, else the focused one), not `BrowserState`
  (the request belongs to Settings alone, and a field there would change a shared, strictly-validated
  state every feature parses). Main also gives that window's chrome keyboard focus. A sign-in that
  reaches `confirming` opens Settings on Account by itself (main has focused the window) and focuses the
  question, so the confirmation is in view and announced.
- **The confirmation cannot be clicked by accident.** Its button says "Confirm sign-in" (not "Sign in"),
  sits inside the confirmation card after Cancel (not where Sign in was), and takes no activation for
  `SETTINGS_CONFIRM_ARM_MS` after it appears and again after the window regains focus or becomes
  visible (`aria-disabled`, so it keeps focus; the click handler checks too).
- **The UI shows what main answers, never a guess.** Account and Search Console follow `account.watch`
  and `gsc.watch` (one shared watch each for the whole chrome, retried with `SETTINGS_RETRY` backoff); a
  telemetry switch shows `telemetry.state` and then each `setConsent` answer. Until main has answered the
  section says "Loading…" (no switches); a failed read says so and is retried with backoff. A button
  whose call runs is `aria-disabled` (focus stays on it); nothing changes on screen until main answered.
- **Telemetry copy is derived from what can be sent.** Usage lists every `SPAN_ATTRIBUTE_ALLOWLIST` key
  in plain words (`SPAN_ATTRIBUTE_WORDS`); errors list what `SCRUB_RULES` remove (`SCRUB_RULE_WORDS`).
  Both say the receiving server sees the IP address, as with any request.
- **Gestures.** Sign in, the confirmation's button and Connect call `account.signIn`,
  `account.confirmSignIn` and `gsc.connect` from the click itself (main needs a live user gesture in
  the window). A `needs-gesture` answer asks to click again.
- **No secret reaches the chrome**, so none is shown: the account is its email, name and plan; Search
  Console is "Connected" with no Google account name (by design: frost never asks Google for one).
- **Renderer constraints.** Strict CSP and Trusted Types: no `style=` attribute, no Zod (types only from
  `*.schema.ts`; values from this Zod-free spec and `gsc.spec.ts`). Its own stylesheet
  (`settings.css`); the page-area and find-bar rules use `:has()` there instead of shared hooks.

## View models (`apps/desktop/src/renderer/__tests__/account-view.test.ts`)
- `account-view-unconfigured` — `unconfigured` says accounts aren't configured in this build and offers no button.
- `account-view-signed-out` — `signed-out` offers Sign in; each `ACCOUNT_ERRORS` value has its own message.
- `account-view-awaiting-browser` — shows the fingerprint with "Your browser should show the same code" and Cancel.
- `account-view-confirming` — asks "Sign in to frost as <email>?" with the fingerprint, Cancel then "Confirm sign-in".
- `account-view-signed-out-says-free` — signed out says frost is free and open source, that the agent and Search Console need no account, and that signing in is only for sync; no copy anywhere in the section mentions Pro or upgrading (2026-10-29).
- `account-view-signed-in-plan` — email, name, plan badge, what the account adds (`ACCOUNT_FEATURES`: sync) in plain words (included or not), Refresh and Sign out; the initial is the name's first character (a whole grapheme).
- `account-view-entitlement-status` — active, grace ("Offline — your account's features stay available until <date and time>"), expired and invalid (sync is off, with a reason that does not claim it is only offline), none (checking); no line names a plan to buy.
- `account-view-keychain-notice` — memory-only shows the no-keychain notice while a sign-in or account exists.
- `account-view-sign-in-results` — each `SignInResult` but `started` has a message.

## Confirmation arming (`apps/desktop/src/renderer/__tests__/settings-arming.test.ts`)
- `confirm-arms-after-delay` — the button arms `SETTINGS_CONFIRM_ARM_MS` after it appears, not before.
- `confirm-disarms-on-focus` — the window regaining focus or becoming visible starts the delay again; dispose stops it.

## Telemetry (`apps/desktop/src/renderer/__tests__/settings-telemetry-view.test.ts`)
- `telemetry-view-two-toggles-default-off` — usage and errors, each with what is sent, off by default; both say the server sees the IP address.
- `telemetry-view-copy-follows-allowlist` — the usage copy names every `SPAN_ATTRIBUTE_ALLOWLIST` key's words and the errors copy every `SCRUB_RULE_IDS` value's; the word tables have exactly those keys.
- `telemetry-view-reflects-main` — the switches show `consent` exactly; before main's first answer the section is "Loading…" with no switches.
- `telemetry-view-read-failure` — a failed read shows an error with no switches; retries back off (`settingsRetryDelay`).
- `telemetry-view-not-configured` — a channel this build has no endpoint for says nothing is sent (the switch still works, the note describes it).
- `telemetry-view-run-only` — `persisted: false` says the choice is saved for this run only.

## Search Console (`apps/desktop/src/renderer/__tests__/settings-gsc-view.test.ts`)
- `gsc-view-unconfigured` — not configured in this build, no button.
- `gsc-view-never-needs-an-account` — Search Console is not gated (2026-10-29): whatever `entitled` says, the section offers Connect, Cancel or Disconnect as for any status, never a link to Account, and no copy mentions Pro.
- `gsc-view-connect-disconnect` — not connected offers Connect and explains read-only access; connecting offers Cancel; connected offers Disconnect.
- `gsc-view-errors-and-keychain` — each `GSC_ERRORS` value and each `GscConnectResult` but `started` has a message; memory-only shows the keychain notice only while connected or connecting.

## Shared watches (`apps/desktop/src/renderer/__tests__/settings-store.test.ts`)
- `watch-store-shares-one-poll` — two subscribers share one long-poll; each answer reaches both; the last unsubscribe stops it.
- `watch-store-backs-off` — failed polls are retried after `settingsRetryDelay` delays; a success resets them.

## Opening and closing (`apps/desktop/src/renderer/__tests__/settings-open.test.ts`)
- `settings-opens-on-request` — a request opens Settings on its section and asks for focus each time.
- `settings-closes` — Close and Esc close it; History opening closes it; opening it closes History.
- `settings-closes-with-the-page` — another tab or a new document closes it, unless a sign-in waits for its confirmation.
- `settings-hold-keeps-confirmation` — while a confirmation waits, History opening does not close it, and Close / Esc cancel the sign-in before closing.
- `settings-opens-for-confirmation` — the account entering `confirming` opens it on Account; staying there does not re-open it.
- `settings-menu-seq` — main's counter opens it on each change after the first value seen.

## Palette (`apps/desktop/src/renderer/__tests__/settings-palette.test.ts`)
- `settings-palette-actions` — the four actions, in the Browser group, each open its section and move focus themselves; "Sign in to frost" is offered only while signed out.
- `settings-palette-registers-with-others` — they register beside the built-in and browser-polish actions with no duplicate ID.

## Main (`apps/desktop/src/main/account/__tests__/settings-requests.test.ts`)
- `settings-requests-show-bumps-and-focuses` — `show(windowId)` raises that window's counter only, answers its waiting watches and focuses its chrome; without a window ID the focused app window's; no app window, nothing.
- `settings-requests-watch-long-polls` — `watch` answers at once for an older counter, else at the next change; aborting releases it; more than `MAX_PENDING_SETTINGS_WATCHES` answer the oldest early.
- `settings-menu-item` — the menu has "Settings…" with Mod+, (the app menu on macOS, Edit elsewhere) and its click calls `showSettings` with the window it acted on.

## Router (`packages/ipc-contract/src/__tests__/account-router.test.ts`)
- `settings-watch-passes-window-id` — `account.settingsWatch` hands the service the sender's `windowId`; without the account's settings requests it is a masked internal error; it long-polls (`WATCH_TIMEOUT_MS`).
- `settings-watch-output-is-strict` — the answer is exactly `{ seq }`; anything else is a masked internal error; the input is strict.

## End to end (`apps/desktop/e2e/settings.e2e.ts`, fakes `fake-backend.ts`, `fake-telemetry.ts`, `fake-google.ts`)
- `settings-opens-from-palette-and-menu` — the palette's "Settings" and the menu item (its accelerator Mod+,: a synthetic key never reaches the native menu, so the item is clicked) open the sheet on Account with focus there; Esc and Close close it; History and Settings never show together; "Sign in to frost" is offered while signed out.
- `settings-sheet-not-covered-by-page` — while Settings shows, the tab's view is zero-high (nothing drawn over the sheet).
- `settings-sign-in-needs-confirmation` — Sign in opens the authorize page; after the browser leg the view asks "Sign in to frost as <email>?" with the fingerprint the browser shows, the question focused; an immediate click and Enter on "Confirm sign-in" do nothing; Esc does not hide it silently (it cancels, tested in the unit tests); a deliberate click after the delay signs in; then the account shows as active.
- `settings-telemetry-toggles-follow-main` — the switches start off, show main's answers, and keep their state across a restart on the same profile.
- `settings-search-console-connect-disconnect` — Connect (no plan needed: on the default `free` plan as on any) opens Google's read-only consent; after the browser leg the view shows Connected; Disconnect revokes and shows Connect again.
