/**
 * Per-origin permission prompts for browsed content (design doc §3 "deny-by-default permissions
 * with per-origin prompts"; Phase 1 Task 4). Acceptance: `permissions.feature.md`. Implemented by
 * `apps/desktop/src/main/browser/permissions.ts` (decisions, the prompt broker and the browse
 * session's handlers), `browser/controller.ts` (per-tab prompt state and its lifetime),
 * `browser/guard.ts` (`hardenBrowseSession` installs the handlers) and the chrome's prompt bar
 * (`renderer/permission-prompt.ts`, `App.tsx`). The schemas that use these values
 * (`PermissionPromptSchema`, `AnswerPermissionInputSchema`) are in `browser.spec.ts`.
 *
 * Plain values with no imports, so the chrome renderer can use them without bundling Zod (whose
 * eval probe the app's strict Trusted Types CSP blocks).
 *
 * Only the browse session (`BROWSE_PARTITION`) ever prompts. The app UI's default session stays
 * deny-all (Phase 0 `GRANTED_PERMISSIONS = []` in `security-policy.spec.ts`).
 */

/**
 * Electron permission names (`setPermissionRequestHandler`) a tab may ask the user for. Each one
 * is a capability a mainstream browser asks about and that real sites use:
 * - `geolocation` — `navigator.geolocation` (local-SEO checks, store locators).
 * - `notifications` — `Notification.requestPermission()` / push.
 * - `media` — `getUserMedia` camera and/or microphone (video calls). Electron reports both under
 *   one name; `details.mediaTypes` says which (`video` = camera, `audio` = microphone), and the
 *   prompt names exactly the devices asked for (`MEDIA_TYPE_PERMISSION`).
 * - `clipboard-read` — `navigator.clipboard.read()` / `readText()` (reading what the user copied
 *   is sensitive: passwords, tokens).
 *
 * Deliberately **not** promptable (denied silently, see `SILENTLY_ALLOWED_PERMISSIONS` for the
 * two exceptions): `midi` / `midiSysex` (device access and a fingerprinting surface; no SEO use),
 * `idle-detection` (tracks user presence), `window-management` (multi-screen layout, a
 * fingerprinting surface), `pointerLock` and `keyboardLock` (capture input; games only),
 * `display-capture` (screen sharing needs a picker frost does not have), `hid` / `serial` /
 * `usb` / `nfc` / `smart-card` (device access), `openExternal` (Phase 0: external apps go through
 * the gesture-checked allowlist only), `automatic-fullscreen` (fullscreen without a gesture),
 * `persistent-storage`, `storage-access`, `top-level-storage-access`, `background-sync`,
 * `periodic-background-sync`, `background-fetch`, `screen-wake-lock`, `system-wake-lock`,
 * `local-fonts`, `local-network-access`, `mediaKeySystem`, `speaker-selection`, `sensors`,
 * `fileSystem`, `geolocation-approximate`, `deprecated-sync-clipboard-read` and `unknown`.
 */
export const PROMPTABLE_PERMISSIONS = ['geolocation', 'notifications', 'media', 'clipboard-read'] as const;
export type PromptablePermission = (typeof PROMPTABLE_PERMISSIONS)[number];

/**
 * Electron permission names granted **without a prompt**, as mainstream browsers do:
 * - `fullscreen` — `Element.requestFullscreen()`. Chromium only lets a page ask from a user
 *   gesture. Against UI spoofing, frost keeps its own notice on screen first: for
 *   `FULLSCREEN_NOTICE_MS` the chrome shows a banner (`FULLSCREEN_BANNER_HEIGHT` high, "<host>
 *   `FULLSCREEN_NOTICE_TEXT`") above the page, then the page's view covers the whole window. Esc
 *   (`FULLSCREEN_EXIT_KEY`) always leaves fullscreen: main takes it in `before-input-event`, so a
 *   page cannot swallow it, and leaves at once from main, whether or not the page cooperates. Switching away from, or closing, a fullscreen tab leaves fullscreen
 *   too. While a tab is fullscreen, its permission requests are denied at once (a prompt would be
 *   hidden behind the page). `automatic-fullscreen` (no gesture) stays denied.
 * - `clipboard-sanitized-write` — `navigator.clipboard.writeText()` / `write()` of sanitized
 *   data ("copy" buttons). Chromium only allows it from a focused document; writing what the page
 *   chose is what every copy button does, and reading it back stays behind `clipboard-read`.
 *
 * `pointerLock` was considered and is **denied** (input capture; no use in an SEO browser).
 */
export const SILENTLY_ALLOWED_PERMISSIONS = ['fullscreen', 'clipboard-sanitized-write'] as const;
export type SilentlyAllowedPermission = (typeof SILENTLY_ALLOWED_PERMISSIONS)[number];

/** `details.mediaTypes` of a `media` request, in the order a prompt names them (camera first). */
export const MEDIA_TYPES = ['video', 'audio'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/**
 * What a decision is remembered against, per **scope** — (requesting origin, top-level origin), as
 * Chrome keys embedded permissions: a third-party iframe's decision applies only under the same
 * top-level site, never wherever that iframe is embedded. A top-level page (or a same-origin frame)
 * has scope (origin, origin). Per scope, one entry per promptable permission, with `media` split
 * per device. A `media` request for both devices asks once and an Allow / Block
 * remembers both; a later request is answered from what is remembered for each device it asks for
 * (any device Blocked → denied; every device Allowed → granted; otherwise the prompt names only the
 * devices still undecided).
 */
export const SITE_PERMISSIONS = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read'] as const;
export type SitePermission = (typeof SITE_PERMISSIONS)[number];
export const MEDIA_TYPE_PERMISSION = { video: 'camera', audio: 'microphone' } as const satisfies Record<MediaType, SitePermission>;

/**
 * The chrome's answers to a prompt (`browser.answerPermission`):
 * - `allow` / `block` — grant / deny this request, every coalesced duplicate, and every other
 *   pending request (any tab) this decision now settles; remembered per (origin, `SitePermission`)
 *   for the rest of the app session, and across relaunches (`REMEMBERED_DECISIONS`; persisted by
 *   Task 5, `browser-session-db.feature.md`).
 * - `dismiss` (the prompt's ×, or Esc in the bar) — deny this request only; nothing is
 *   remembered, so the page may ask again.
 */
export const PERMISSION_DECISIONS = ['allow', 'block', 'dismiss'] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];
export const REMEMBERED_DECISIONS = ['allow', 'block'] as const;
export type RememberedDecision = (typeof REMEMBERED_DECISIONS)[number];

/**
 * A prompt nobody answers is denied after this long (nothing remembered), so a page's request
 * never waits forever and an abandoned prompt does not linger: 5 minutes, long enough to find the
 * bar after switching back to the tab.
 */
export const PERMISSION_PROMPT_TIMEOUT_MS = 5 * 60_000;

/**
 * Back-off: once a (scope, permission) prompt has been dismissed or has timed out this many times
 * in the app session, further requests for it are denied silently for the rest of the session
 * (nothing is remembered beyond the session).
 */
export const MAX_PROMPT_IGNORES = 3;

/**
 * At most this many identical requests coalesce into one pending prompt; more are denied at once,
 * so a page calling `Notification.requestPermission()` in a loop cannot grow main's memory.
 */
export const MAX_COALESCED_REQUESTS = 16;

/**
 * Against clickjacking, the prompt bar's Allow and Block ignore activation for this long after the
 * bar appears, after the shown tab (or prompt) changes, and after the chrome's window regains focus
 * or becomes visible. The buttons are rendered but disabled meanwhile; the dismiss × (which only
 * denies) is always live.
 */
export const PROMPT_ARMING_DELAY_MS = 750;

/**
 * At most this many distinct prompts wait per tab (duplicates coalesce into one); a request beyond
 * it is denied at once, so a page cannot grow main's queue without bound.
 */
export const MAX_PENDING_PROMPTS_PER_TAB = 8;

/**
 * Origins that may be prompted for: the requesting frame's origin must be `http:` or `https:`
 * (`BROWSABLE_SCHEMES`). Opaque origins (`about:blank`, `data:`, documents sandboxed by a CSP
 * `sandbox` header or an `<iframe sandbox>`) and anything else are denied silently. The origin is
 * the **requesting frame's own** (`WebFrameMain.origin`), never just its URL's: a sandboxed
 * document at `https://a.example/` has an opaque origin and gets none of `https://a.example`'s
 * decisions. Chromium itself only lets secure contexts (`https:`, loopback `http:`) ask.
 */
export const PROMPTABLE_ORIGIN_SCHEMES = ['http:', 'https:'] as const;

/**
 * The prompt bar's sentence: `<origin> wants to <action>`. `media` names the devices asked for
 * (`camera`, `microphone`, or both).
 */
export const PERMISSION_PROMPT_ACTIONS = {
  geolocation: 'use your location',
  notifications: 'show notifications',
  camera: 'use your camera',
  microphone: 'use your microphone',
  'camera-microphone': 'use your camera and microphone',
  'clipboard-read': 'see text and images you copy to the clipboard',
} as const;
export type PromptKind = keyof typeof PERMISSION_PROMPT_ACTIONS;

/** Button labels of the prompt bar (the dismiss × is labelled for assistive technology). */
export const PERMISSION_PROMPT_LABELS = { allow: 'Allow', block: 'Block', dismiss: 'Dismiss' } as const;

/**
 * How the prompt names an embedded requester: "<host> (embedded in <top-level host>) wants to …".
 */
export const PERMISSION_PROMPT_EMBEDDED_IN = 'embedded in' as const;

/** How long the fullscreen notice stays above a page that just entered HTML fullscreen. */
export const FULLSCREEN_NOTICE_MS = 3_000;
/** Height in DIP of the chrome's fullscreen notice banner (the view sits below it meanwhile). */
export const FULLSCREEN_BANNER_HEIGHT = 40;
/** The notice follows the page's host: "<host> is now full screen — press Esc to exit". */
export const FULLSCREEN_NOTICE_TEXT = 'is now full screen \u2014 press Esc to exit' as const;
/** The key that always leaves HTML fullscreen (`before-input-event` `input.key`). */
export const FULLSCREEN_EXIT_KEY = 'Escape' as const;
/**
 * After frost or Electron leaves a tab's HTML fullscreen, its page is asked to leave too
 * (`document.exitFullscreen()`), but only once the window is out of OS fullscreen and has had no
 * fullscreen event (its own or a tab's) for this long. On macOS a request made while the native
 * fullscreen animation is running, or about to run, is never completed and blocks every later
 * one; the animation takes about 600 ms and queued transitions follow each other at that pace.
 */
export const FULLSCREEN_EXIT_SETTLE_MS = 1_000;
