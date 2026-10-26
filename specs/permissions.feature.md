# Feature: per-origin permission prompts

Spec: `specs/permissions.spec.ts` (`PROMPTABLE_PERMISSIONS`, `SILENTLY_ALLOWED_PERMISSIONS`,
`MEDIA_TYPES`, `SITE_PERMISSIONS`, `MEDIA_TYPE_PERMISSION`, `PERMISSION_DECISIONS`,
`PERMISSION_PROMPT_TIMEOUT_MS`, `MAX_PENDING_PROMPTS_PER_TAB`, `PROMPTABLE_ORIGIN_SCHEMES`,
`PERMISSION_PROMPT_ACTIONS`, `PERMISSION_PROMPT_LABELS`; Zod-free so the chrome can import it) and
`specs/browser.spec.ts` (`PermissionPromptSchema`, `TabStateSchema.permissionPrompt`,
`AnswerPermissionInputSchema`). Design doc §3. Phase 1 Task 4; builds on `browser-chrome.feature.md`
(the browse session), `tabs.feature.md` and `browse-guard.feature.md`. Each scenario maps to one
named test.

## Behaviour
- **Which permissions.** On the browse session, a request for one of `PROMPTABLE_PERMISSIONS`
  (`geolocation`, `notifications`, `media`, `clipboard-read`) from a tab may prompt;
  `SILENTLY_ALLOWED_PERMISSIONS` (`fullscreen`, `clipboard-sanitized-write`) are granted without a
  prompt; **every other permission is denied silently** (no prompt, nothing remembered). Device
  permissions (`setDevicePermissionHandler`: HID, serial, USB) stay deny-all.
- **Requesting origin.** A prompt names, and a decision is remembered against, the origin of the
  **frame that asked**: `details.requestingUrl` (its last committed URL), else
  `details.securityOrigin` (media requests), parsed to a serialized origin. A cross-origin iframe's
  request names the iframe's origin, never the top-level page's. A requesting origin that is not
  `http:` / `https:` (`PROMPTABLE_ORIGIN_SCHEMES`: opaque `about:blank`, `data:`, `file:` …), or
  that cannot be parsed, is denied silently. A request whose WebContents is not an open tab's is
  denied.
- **Media.** A `media` request is split by `details.mediaTypes`: `video` → camera, `audio` →
  microphone (`MEDIA_TYPE_PERMISSION`). The prompt names exactly the devices asked for (and still
  undecided); a `media` request with no known media type is denied.
- **Remembered decisions.** Allow and Block are remembered per (origin, `SitePermission`) for the
  app session, in memory (`createMemoryDecisionStore`; Task 5 swaps in a persistent store behind
  the same `PermissionDecisionStore` interface). A request is answered from what is remembered,
  with no prompt: any asked-for permission Blocked → denied; all Allowed → granted; otherwise the
  prompt asks for the undecided ones only.
- **Queue.** Each tab has its own queue; the chrome shows its head. Identical requests (same tab,
  origin, permission and devices) **coalesce** into the pending prompt and get the same answer. An
  Allow / Block also settles every other pending request it now decides, in any tab. At most
  `MAX_PENDING_PROMPTS_PER_TAB` distinct prompts wait per tab; one more is denied at once.
- **Answers** (`browser.answerPermission({ promptId, decision })`): `allow` grants, `block` denies;
  both are remembered. `dismiss` (the × or Esc) denies this request only, remembering nothing, so
  the page may ask again. Only the prompt the **active** tab shows can be answered: another tab's
  prompt id, a queued (not yet shown) one, an answered one (ids are single-use), a timed-out one or
  an unknown one is a no-op answering `false`. Prompt ids are opaque, unguessable UUIDs
  (`crypto.randomUUID`), validated by `AnswerPermissionInputSchema` (a malformed one is
  `BAD_REQUEST`).
- **Lifetime.** A tab's pending prompts are all **denied** (nothing remembered) when the tab
  closes, its WebContents is destroyed, its main frame commits another document (`did-navigate`,
  or a main-frame load failure that commits an error page), or its renderer crashes. A
  same-document navigation (`did-navigate-in-page`) keeps them. A prompt nobody answers is denied
  after `PERMISSION_PROMPT_TIMEOUT_MS` (5 minutes).
- **Check handler.** `setPermissionCheckHandler` on the browse session answers `true` only for
  `SILENTLY_ALLOWED_PERMISSIONS` and for a remembered Allow of (origin, permission). Electron
  passes the checking frame's origin as `requestingOrigin` (with a trailing `/`), and for `media`
  `details.securityOrigin` and `details.mediaType` (`video` / `audio`; `unknown` → `false`). Note
  that Electron's check is two-state: before any decision, a page reads `denied` (not `default`)
  from `Notification.permission` and `navigator.permissions.query`, though a request still prompts.
- **App session.** The app UI's default session stays deny-all (Phase 0 `isPermissionGranted`,
  `GRANTED_PERMISSIONS = []`): no request from the chrome ever prompts.
- **HTML fullscreen.** While a tab is in HTML fullscreen (`enter-html-full-screen` until
  `leave-html-full-screen`), its view covers the whole window content area; otherwise the page
  area.
- **Prompt bar.** For the active tab's prompt the chrome shows a bar under the toolbar (the page
  area, and so the tab's view, moves down to make room): a frost-drawn icon per permission,
  "<origin's host> wants to <`PERMISSION_PROMPT_ACTIONS`>" (the full origin as its tooltip), then
  **Allow**, **Block** and a dismiss **×** (`PERMISSION_PROMPT_LABELS`). It is a labelled
  `role="dialog"` (non-modal) that does not take focus from the page; Tab reaches its buttons and
  Esc inside it dismisses. A background tab with a pending prompt shows a small indicator dot in the
  strip (and says so to assistive technology). Light and dark follow `styles.css`; no `style=`
  attribute, no `innerHTML`.

## Decisions (`apps/desktop/src/main/browser/__tests__/permissions.test.ts`, "decisions")
- **Scenario: promptable-permissions-prompt** — `classifyPermissionRequest(permission, details)`
  for `geolocation`, `notifications`, `clipboard-read` and `media` (with media types) from an
  `https:` frame → `prompt` with that permission and origin.
- **Scenario: silently-allowed-permissions** — `fullscreen` and `clipboard-sanitized-write` →
  `allow`, from any origin.
- **Scenario: other-permissions-denied-silently** — `midi`, `midiSysex`, `hid`, `serial`, `usb`,
  `pointerLock`, `keyboardLock`, `openExternal`, `display-capture`, `idle-detection`,
  `window-management`, `persistent-storage`, `automatic-fullscreen`, `storage-access`,
  `mediaKeySystem`, `unknown`, `''` and a made-up name → `deny`.
- **Scenario: media-split-into-camera-and-microphone** — `mediaTypes: ['audio', 'video']` →
  permissions `camera`, `microphone` and prompt media types `['video', 'audio']`; `['video']` →
  camera only; `['audio']` → microphone only; missing or empty media types → `deny`.
- **Scenario: requesting-origin-from-requesting-url** — the origin is `requestingUrl`'s (a
  subframe's own, path and query dropped), else `securityOrigin`'s; `about:blank`, `data:`,
  `file:`, `app:`, an unparseable or missing URL → `deny`.

## Broker (`permissions.test.ts`, "broker")
- **Scenario: prompt-queues-per-tab** — two different requests in a tab: the first is its prompt,
  the second shows after the first is answered; another tab's queue is independent.
- **Scenario: duplicate-requests-coalesce** — the same (origin, permission) asked twice in a tab
  makes one prompt; answering it calls both callbacks with the same answer.
- **Scenario: allow-is-remembered** — Allow grants, the next identical request is granted at once
  with no prompt, and a pending identical request in another tab is granted too.
- **Scenario: block-is-remembered** — Block denies, the next identical request is denied at once
  with no prompt.
- **Scenario: dismiss-denies-once** — dismiss denies; the next identical request prompts again.
- **Scenario: remembered-per-origin-and-permission** — an Allow for (A, notifications) does not
  answer (B, notifications) or (A, geolocation).
- **Scenario: media-remembers-each-device** — Allow for camera + microphone, then a camera-only
  request is granted at once; after Block for an origin's microphone, a camera + microphone request
  is denied at once; with only the camera allowed, a camera + microphone request prompts for the
  microphone only.
- **Scenario: check-reflects-remembered-allow** — `check(origin, permission)` is `true` only after
  an Allow of that pair (not after Block, dismiss or for another origin).
- **Scenario: prompt-times-out** — (fake timers) an unanswered prompt is denied after
  `PERMISSION_PROMPT_TIMEOUT_MS`, not before; nothing is remembered and the next prompt shows.
- **Scenario: prompt-ids-are-opaque-and-single-use** — ids are UUIDs, distinct per prompt;
  answering an id a second time, or an unknown id, answers `false` and calls nothing.
- **Scenario: answer-needs-the-tabs-shown-prompt** — answering with another tab's id, or with the
  id of a queued (not head) prompt, answers `false` and changes nothing.
- **Scenario: deny-tab-denies-pending** — `denyTab(tabId)` denies every pending request of that
  tab (nothing remembered), leaving other tabs' prompts.
- **Scenario: pending-prompts-capped-per-tab** — beyond `MAX_PENDING_PROMPTS_PER_TAB` distinct
  prompts a request is denied at once.
- **Scenario: decision-store-is-swappable** — a broker given another `PermissionDecisionStore`
  reads and writes decisions through it only.

## Session wiring (`permissions.test.ts`, "browse session", via the Electron fake)
- **Scenario: browse-session-prompts-for-tabs** — with the handlers installed by
  `hardenBrowseSession`, a `notifications` request from a tab's WebContents creates that tab's
  prompt; one from a WebContents that is no tab's is denied; `fullscreen` is granted and `midi`
  denied with no prompt.
- **Scenario: prompt-names-requesting-origin** (Review Focus) — a subframe request
  (`isMainFrame: false`, `requestingUrl` on another origin) prompts for the subframe's origin;
  after Allow, a check for that origin is `true` and for the top-level page's origin `false`.
- **Scenario: check-handler-uses-requesting-origin** — `requestingOrigin` with a trailing `/` is
  normalized; `media` checks use `securityOrigin` and `mediaType` (`unknown` → `false`); silently
  allowed permissions check `true`; everything else `false`.
- **Scenario: device-permissions-stay-denied** — the device permission handler answers `false`
  for HID, serial and USB, with or without permission handlers.
- **Scenario: app-session-stays-deny-all** — `registerSecurity`'s (default) session denies
  `notifications`, `geolocation`, `media`, `clipboard-read`, `fullscreen` requests and checks, and
  never reaches the broker.

## Controller (`apps/desktop/src/main/browser/__tests__/controller.test.ts`, "permissions")
- **Scenario: prompt-in-tab-state** — a broker prompt for a tab appears as that tab's
  `permissionPrompt` (others `null`), bumps the version, and the state parses with
  `BrowserStateSchema`.
- **Scenario: answer-applies-to-active-tab-only** — `answerPermission` answers the active tab's
  prompt; a background tab's prompt id answers `false` and stays pending.
- **Scenario: tab-id-of-contents** — `tabIdOf(contents)` names the tab of a live view's
  WebContents, `null` for anything else.
- **Scenario: prompts-denied-when-tab-goes** — closing the tab, its WebContents being destroyed,
  a main-frame `did-navigate`, a main-frame load failure and `render-process-gone` each deny the
  tab's pending prompts; `did-navigate-in-page` does not.
- **Scenario: html-fullscreen-fills-window** — after `enter-html-full-screen` the active tab's
  view gets the whole content area (also on later bounds reports); after
  `leave-html-full-screen` the page area again.

## Router (`packages/ipc-contract/src/__tests__/browser-router.test.ts`)
- **Scenario: answer-permission-enforces-sender** — a rejected sender is refused before the
  service is called.
- **Scenario: answer-permission-validates-input** — a non-UUID id, an unknown decision, or extra
  keys are `BAD_REQUEST`; the service is not called.
- **Scenario: answer-permission-calls-service** — a valid input reaches
  `answerPermission(promptId, decision)` and answers its boolean.

## Renderer (`apps/desktop/src/renderer/__tests__/permission-prompt.test.ts`)
- **Scenario: prompt-copy-per-permission** — `promptView(prompt)`: the host (with port) of the
  origin and `PERMISSION_PROMPT_ACTIONS` by kind (`media` → camera, microphone, or both).

## End to end (`apps/desktop/e2e/permissions.e2e.ts`, real Electron, loopback pages)
Each scenario uses fresh loopback origins (decisions are remembered for the app session).
- **Scenario: allow-grants-and-is-remembered-e2e** — `Notification.requestPermission()` shows the
  prompt bar naming the page's origin (a labelled `dialog`), with the tab's view laid out below it;
  Allow resolves it `granted` in the page; a second request resolves `granted` with no prompt, and
  `Notification.permission` reads `granted`.
- **Scenario: block-denies-and-is-remembered-e2e** — Block resolves `denied`; a second request
  resolves `denied` with no prompt.
- **Scenario: dismiss-denies-and-asks-again-e2e** — × resolves `denied`; a second request prompts
  again.
- **Scenario: prompt-names-requesting-origin-e2e** (Review Focus) — a cross-origin iframe (second
  loopback port, `allow="geolocation"`) asking for geolocation: the prompt names the iframe's
  origin, not the page's; Block fails the iframe's request with `PERMISSION_DENIED`; the page's own
  geolocation request then still prompts (nothing was remembered for it).
- **Scenario: navigate-away-denies-pending-e2e** — with a prompt showing, the page navigates
  elsewhere: the prompt bar goes away, and the new page's request prompts afresh (a new id).
- **Scenario: non-promptable-denied-without-prompt-e2e** — `navigator.requestMIDIAccess()` rejects
  and `navigator.storage.persist()` resolves `false`, with no prompt bar ever shown.
- **Scenario: background-tab-prompt-shows-dot-e2e** — a prompt in a background tab shows its strip
  dot, not the bar; activating the tab shows the bar.
- **Scenario: app-session-stays-deny-all-e2e** — the chrome page's own
  `Notification.requestPermission()` resolves `denied`, its notifications permission queries
  `denied`, and no prompt bar appears.
- **Scenario: html-fullscreen-fills-window-e2e** — a real click calling `requestFullscreen()` is
  granted with no prompt; the tab's view then covers the whole content area; after
  `exitFullscreen()` it is back under the toolbar and the window is no longer fullscreen.
