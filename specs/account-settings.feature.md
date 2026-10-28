# Feature: the Settings view (account, plan, telemetry and Search Console)

Spec: `specs/account-settings.spec.ts` (`SETTINGS_SECTIONS`, `SETTINGS_TITLE`, `SETTINGS_MENU`,
`SETTINGS_PALETTE_ACTIONS`, `FEATURE_LABELS`, `ACCOUNT_SETTINGS_TEXT`, `TELEMETRY_SETTINGS_TEXT`,
`GSC_SETTINGS_TEXT`, `MAX_PENDING_SETTINGS_WATCHES`) and `specs/account-settings.schema.ts`
(`SettingsViewWatchInputSchema`, `SettingsViewStateSchema`), driving the main-side contracts
`specs/account-state.schema.ts`, `specs/telemetry-consent.schema.ts` and `specs/gsc.spec.ts`. Phase 4
Task 9. Review focus "Telemetry UI matches behaviour" and "A website or another app cannot sign the user
in to someone else's account" (the in-app confirmation). Each line maps to one named test.

## Decisions
- **A sheet over the page column, like History.** While Settings shows it fills the page column and the
  page area is laid out zero-high, so the tab's view (drawn above the chrome) never covers it. At most
  one of History and Settings shows: opening one closes the other. It closes on Close, Esc, another tab
  shown or a new document in this one (as History), except while a sign-in waits for its confirmation.
- **Opening.** The palette ("Settings", "Sign in to frost", "Search Console settings", "Telemetry
  settings", each on its section) and the menu item "Settings…" (`SETTINGS_MENU`, Mod+,: the macOS app
  menu, elsewhere the end of Edit). The menu is main's, so main signals the chrome through its own
  `settingsView.watch` long-poll (a counter, `SettingsViewStateSchema`), not `BrowserState`: the request
  belongs to Settings alone, and a field there would change a shared, strictly-validated state every
  feature parses. Main also gives the chrome keyboard focus. A sign-in that reaches `confirming` opens
  Settings on Account by itself (main has focused the window), so the confirmation is in view.
- **The UI shows what main answers, never a guess.** Account and Search Console follow `account.watch`
  and `gsc.watch`; a telemetry toggle shows `telemetry.state` and then each `setConsent` answer. A
  button is disabled while its call runs; nothing changes on screen until main has answered.
- **Gestures.** Sign in, the confirmation's Sign in, and Connect call `account.signIn`,
  `account.confirmSignIn` and `gsc.connect` from the click itself (main needs a live user gesture in
  the window). A `needs-gesture` answer (a keyboard-less synthetic call) asks to click again.
- **No secret reaches the chrome**, so none is shown: the account is its email, name and plan; Search
  Console is "Connected" with no Google account name (frost never asks Google for one).
- **Renderer constraints.** Strict CSP and Trusted Types: no `style=` attribute, no Zod (types only from
  `*.schema.ts`; values from this Zod-free spec and `gsc.spec.ts`). Its own stylesheet
  (`settings.css`); the page-area rule uses `:has()` there instead of a shared hook.

## View models (`apps/desktop/src/renderer/__tests__/account-view.test.ts`)
- `account-view-unconfigured` — `unconfigured` says accounts aren't configured in this build and offers no button.
- `account-view-signed-out` — `signed-out` offers Sign in; each `ACCOUNT_ERRORS` value has its own message.
- `account-view-awaiting-browser` — shows the fingerprint with "Your browser should show the same code" and Cancel.
- `account-view-confirming` — asks "Sign in to frost as <email>?" with the fingerprint, Sign in and Cancel.
- `account-view-signed-in-plan` — email, name, plan badge, every feature in plain words (included or not), Refresh and Sign out.
- `account-view-entitlement-status` — active, grace ("Offline — Pro stays available until <date>"), expired and invalid (Free, with a reason), none (checking).
- `account-view-keychain-notice` — memory-only shows the no-keychain notice while a sign-in or account exists.
- `account-view-sign-in-results` — each `SignInResult` but `started` has a message.

## Telemetry (`apps/desktop/src/renderer/__tests__/settings-telemetry-view.test.ts`)
- `telemetry-view-two-toggles-default-off` — usage and errors, each with what is sent and what is not, off by default.
- `telemetry-view-reflects-main` — the toggles show `consent` exactly; nothing before main's first answer.
- `telemetry-view-not-configured` — a channel this build has no endpoint for says nothing is sent (the toggle still works).
- `telemetry-view-run-only` — `persisted: false` says the choice is saved for this run only.

## Search Console (`apps/desktop/src/renderer/__tests__/settings-gsc-view.test.ts`)
- `gsc-view-unconfigured` — not configured in this build, no button.
- `gsc-view-needs-pro` — not entitled explains Pro and links to the Account section (Disconnect still offered if connected).
- `gsc-view-connect-disconnect` — not connected offers Connect and explains read-only access; connecting offers Cancel; connected offers Disconnect.
- `gsc-view-errors-and-keychain` — each `GSC_ERRORS` value and each `GscConnectResult` but `started` has a message; memory-only shows the keychain notice.

## Opening and closing (`apps/desktop/src/renderer/__tests__/settings-open.test.ts`)
- `settings-opens-on-request` — a request opens Settings on its section and asks for focus each time.
- `settings-closes` — Close and Esc close it; History opening closes it; opening it closes History.
- `settings-closes-with-the-page` — another tab or a new document closes it, unless a sign-in waits for its confirmation.
- `settings-opens-for-confirmation` — the account entering `confirming` opens it on Account; staying there does not re-open it.
- `settings-menu-seq` — main's counter opens it on each change after the first value seen.

## Palette (`apps/desktop/src/renderer/__tests__/settings-palette.test.ts`)
- `settings-palette-actions` — the four actions, in the Browser group, each open its section and move focus themselves.
- `settings-palette-registers-with-others` — they register beside the built-in and browser-polish actions with no duplicate ID.

## Main (`apps/desktop/src/main/__tests__/settings-view.test.ts`)
- `settings-view-show-bumps-and-focuses` — `show` raises the counter, answers waiting watches and focuses the chrome of the focused app window.
- `settings-view-watch-long-polls` — `watch` answers at once for an older counter, else at the next change; aborting releases it; more than `MAX_PENDING_SETTINGS_WATCHES` answer the oldest early.
- `settings-menu-item` — the menu has "Settings…" with Mod+, (the app menu on macOS, Edit elsewhere) and its click calls `showSettings`.

## Router (`packages/ipc-contract/src/__tests__/settings-view-router.test.ts`)
- `settings-view-procedures-enforce-sender` — `settingsView.watch` refuses a foreign sender before the service is touched; without the service it is a masked internal error.
- `settings-view-watch-output-is-strict` — the answer is exactly `{ seq }`; anything else is a masked internal error; the input is strict.

## End to end (`apps/desktop/e2e/settings.e2e.ts`, fakes `fake-backend.ts`, `fake-telemetry.ts`, `fake-google.ts`)
- `settings-opens-from-palette-and-menu` — the palette's "Settings" and the menu item (its accelerator Mod+,: a synthetic key never reaches the native menu, so the item is clicked) open the sheet on Account with focus there; Esc and Close close it; History and Settings never show together.
- `settings-sheet-not-covered-by-page` — while Settings shows, the tab's view is zero-high (nothing drawn over the sheet).
- `settings-sign-in-needs-confirmation` — Sign in opens the authorize page; after the browser leg the view asks "Sign in to frost as <email>?" with the fingerprint the browser shows; nothing is signed in until the Sign in click; then the plan shows Pro.
- `settings-telemetry-toggles-follow-main` — the toggles start off, show main's answers, and keep their state across a restart on the same profile.
- `settings-search-console-connect-disconnect` — signed in as Pro, Connect opens Google's read-only consent; after the browser leg the view shows Connected; Disconnect revokes and shows Connect again.
