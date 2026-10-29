# Feature: screenshots

Spec: `specs/screenshot.spec.ts` (`SCREENSHOT_WORLD_ID`, `SCREENSHOTS_DIR_NAME`, `SCREENSHOT_LIMITS`, `SCREENSHOT_REFUSALS`,
`SCREENSHOT_REFUSAL_MESSAGES`, `FULL_PAGE_SCROLL_NOTE`, `AREA_SELECT_HINT`, `SCREENSHOT_KIND_LABELS`,
`SCREENSHOT_IMAGE_SIZES`, the input and answer types) and `specs/screenshot.schema.ts` (their Zod
schemas, and the `listScreenshots` read operation of `CHANGES_READ_API`); storage is the
`ci_screenshots` table and `CAPTURES_DIR_NAME` of `specs/capture-db.spec.ts`. Phase 6 Task 5.
Implemented by `apps/desktop/src/main/screenshots/` (`stitch.ts`, `page-script.ts`, `capture.ts`,
`imaging.ts`, `store.ts`, `service.ts`, `electron.ts`), the `screenshots` router in `packages/ipc-contract/src/changes-router.ts`
(`ScreenshotsService` in `changes-service.ts`), and the Changes panel
(`components/changes/Screenshots.tsx`, `components/changes/screenshot-runs.ts`, `changes-view.ts`,
`changes-palette.ts`).

## Kinds
- **Viewport**: the tab's view as it is shown (`capturePage()`), scrollbar included; within
  `segmentTimeoutMs`.
- **Full page**: the whole document, stitched from viewport captures while the page is scrolled:
  1. measure the page in `SCREENSHOT_WORLD_ID` (`document.scrollingElement`'s height, the viewport,
     its client width and height without scrollbars, the scroll position, `devicePixelRatio`); a
     height past any sane size is taken as `MAX_CSS_PX` tall and cut at the caps (`truncated`),
     never refused;
  2. capture the top of the page; the view's device rows per CSS pixel (`deviceScale`) are the
     page's `devicePixelRatio` when `round(innerHeight × ratio)` is within 1 px of the capture's
     height, else the capture's height over `innerHeight` (a render profile's device emulation scales
     the view);
  3. size the image (`planStitch`): the document's rows, cut at `maxStitchedHeightPx`, `maxPixels`
     (for its width) or `maxSegments` viewports (`truncated`); the right edge (the scrollbar) is
     cropped to `clientWidth`;
  4. segment by segment: scroll (`behavior: 'instant'`) to where the rows placed so far end (so no
     row is missed however the page snaps its scroll position to device pixels), wait
     `segmentSettleFrames` animation frames (at most `segmentTimeoutMs`), capture, and place the new
     rows (`composeStitch`, one segment at a time, so only one capture is held), cropped by the
     position the page actually reached; a page that stops scrolling early is cut there
     (`truncated`); at most `maxSegments` captures;
  5. encode the PNG;
  6. restore the original scroll position, always (also on a failure, a cancel or the deadline),
     waiting at most `segmentTimeoutMs` for the page to answer.

  The whole run is bounded by `fullPageDeadlineMs` (`capture-failed`). Fixed and sticky elements
  appear in each segment, and lazy content appears as it is scrolled into view (Known limits). The
  page can see the scrolling: the UI says so (`FULL_PAGE_SCROLL_NOTE`).
- **Area**: the user drags a rectangle on the page:
  - an overlay in `SCREENSHOT_WORLD_ID`: one host element of its own appended to `<html>`, a
    **closed** shadow root, inline styles through the CSSOM only (`style.setProperty`), a crosshair
    cursor, a dimmed backdrop and frost's hint; no page element's attributes, styles or text change;
  - only **trusted** pointer events (`event.isTrusted`) start, move or end the drag, so a page cannot
    select for the user; a drag smaller than `minAreaCssPx` either way selects nothing and the
    selection goes on;
  - **what the page can see:** the host element (not inside its closed root), and the pointer events
    of the drag in their capture phase (retargeted to the host) before the overlay stops them; the
    overlay stops them from bubbling and from clicking anything under it. The page cannot select,
    move or end a selection;
  - Esc is heard by main (`before-input-event` on the tab, while an area is pending) before the page
    gets it, so a page cannot block it; the overlay's own trusted-Esc listener stays as a fallback.
    `screenshots.cancelArea`, any main-frame navigation, the tab closing, the tab no longer being the
    active one, the page taking the host out of the document (a `MutationObserver` in world 1601),
    and `areaTimeoutMs` all cancel it (`cancelled`); the cancel script is given at most
    `segmentTimeoutMs`;
  - when it ends, the host and every listener are removed, and the host is made inert (its shadow
    root emptied, `display: none`, no pointer events), so a page that appends it again gets an empty,
    hidden element; two animation frames pass (so the overlay is not captured), and main captures the
    view and crops the rectangle at the view's pixels per CSS pixel (`deviceScale` of `innerWidth`),
    the measure and the capture within `segmentTimeoutMs` (`capture-failed`);
  - the selection is in CSS viewport px, stored as the row's `rect` (canonical JSON).

## Taking one
- `screenshots.take({ tabId, kind, projectId? })`: only the **active** tab, showing a web page; the
  project defaults to Unfiled. One screenshot per tab at a time (`busy`).
- Any main-frame navigation while it runs, an in-page one (`#fragment`, `history.pushState`) too,
  cancels it (`cancelled`): the screenshot would otherwise be recorded under a URL the tab no longer
  shows.
- It records the tab's render profile by the rule captures follow too
  (`changes-capture.feature.md`, The render profile recorded): the profile set on the tab as it
  captures (`TabState.renderProfile`), whatever its status, as canonical JSON; one that does not fit
  its schema is recorded as none, with a log line. `ci_screenshots` has no `partial` column: a
  partial one (`needsReload`, `applying` or `failed`) is recorded as the profile, with a log line
  saying it was partial. It also records its
  search parameters (`searchParamsOf(tabId, page)`: Phase 3's for the tab's result page, `null` for
  any other page; `changes-diff.feature.md`, Search parameters). Main-internal
  callers (Task 6's capture run) may pass a `captureId` and the query's search parameters.
- Main builds the PNG (`createFromBitmap` → `toPNG`); one over `maxPngBytes` is refused
  (`too-large`) and nothing is written. The encode is synchronous on main's thread and bounded by the
  caps; measured on this project's Linux desktop (Electron 45): about 215 ms for a typical
  1,280 × 16,384 page, 410 ms at 2,560 × 16,384, 600 ms at the 64-megapixel cap (3,904 × 16,384), and
  1.4 s for the worst case (1,280 × 16,384 of noise: 63 MB, then refused as `too-large`).
- Its thumbnail is made then, from the bitmap in hand (no decode), and kept in main's memory
  (`thumbnailCacheEntries`, least recently used dropped).
- The file is written first, then the row (`appendScreenshot`, with `segments`, `rect`, the pixel
  size and the PNG's bytes). A row that fails after the file was written leaves the file for the
  orphan sweep (Task 7).
- The answer: `{ status: 'saved', id, kind, width, height, bytes, truncated }`, or a refusal. The
  service never rejects; a failure is one log line, never page text or a path beyond the
  profile-relative directory.

## Files (main only)
- A screenshot holds its hash's lock (`ScreenshotFiles.lock`, per hash) from its file's write until
  its row is written, so retention's purge and orphan sweep never unlink a file it is reusing
  (`retention.feature.md`, Files and their lock).
- The directory is `<userData>/frost-captures/screenshots/`, created `0700` (both directories;
  `mkdir`, then `chmod` through a handle opened without following a symlink).
- Before every write and read, each of `frost-captures` and `screenshots` is `lstat`ed: anything but
  a real directory (a symlink above all) is refused, and nothing is written.
- A file is named `<sha256>.png`, the SHA-256 main computed of the PNG it encoded. `fileFor(sha)`
  accepts only `SHA256_HEX_PATTERN`, and the resolved path must be directly inside the directory.
  Files in the directory are only ever `<sha256>.png`, and, after a crash mid-write,
  `<sha256>.png.tmp-<16 hex>` (Task 7's sweep may remove both kinds when no row names the hash).
- A write reuses an existing file whose bytes hash to its name (and sets it `0600` through the
  no-follow handle it read it with); otherwise it writes `<sha>.png.tmp-<16 hex>` (`wx`, `0600`) and
  renames it into place.
- **What is guaranteed:** the directories are private to the user, but another process of the same
  user could swap one for a symlink between two checks. So a write goes through the screenshot
  directory's own no-follow handle (on Linux by its `/proc/self/fd/<fd>` name: the temporary file and
  the rename land in that directory whatever its path names by then), and after the rename it checks
  again: both directories are real directories, the screenshot directory's device and inode are the
  handle's, and the file's are the ones written. On a mismatch it removes the file it wrote (through
  the handle on Linux; elsewhere by path, only if it is that file) and fails (`store-failed`): frost
  detects the race and refuses, it does not prevent it.
- A read opens the file without following a symlink, caps it at `maxPngBytes`, and checks its hash:
  a missing file or a mismatch answers `null`.
- No procedure takes a path, a file name or a hash; the chrome names a screenshot by its row id.

## Images, reveal, copy
- `screenshots.image({ id, size })`: a `data:` URL of at most `maxImageDataUrlChars` (the chrome's
  CSP allows `img-src data:`; the router checks it on the way out, `ScreenshotImageAnswerSchema`):
  - the file is read and its hash checked every time;
  - `thumb`: PNG, `thumbWidth` wide; a shot taller than `thumbMaxHeight` at that width shows its top;
    served from the in-memory cache when it is there, else rendered once and kept;
  - `preview`: JPEG (`previewJpegQuality`), fit within `previewMaxWidth` × `previewMaxHeight`; one
    over the cap is encoded again at quality 50, then 30% smaller each time (at most six tries),
    else `null`;
  - never upscaled; `null` for an unknown id, a missing file or a file that does not match its hash.
- `screenshots.reveal({ id })`: `shell.showItemInFolder` on the file (never `openPath` or
  `openExternal`); `false` when the file is missing.
- `screenshots.copy({ id })`: the PNG to the system clipboard (`clipboard.write` with one
  `ClipboardItem` of `image/png`), only after its hash checks and it decodes.

## Listing
- `screenshots.list({ url?, projectId?, cursor?, limit? })` and the read API's `listScreenshots`:
  newest first, at most `MAX_HISTORY_PAGE` per page, with a cursor. Each entry is parsed with
  `ScreenshotEntrySchema` (a tampered row is skipped) and carries no path, file name or hash.

## The Changes panel
- A **Screenshot** group next to Capture now: Viewport, Full page (with `FULL_PAGE_SCROLL_NOTE` as
  its visible hint), Select area. Enabled for the active tab showing a web page (`canScreenshot`).
- While an area is selected, a hint row (a polite live region) says `AREA_SELECT_HINT`, with a
  Cancel button (`screenshots.cancelArea`).
- What runs is kept per tab outside the panel (`components/changes/screenshot-runs.ts`): the panel
  and the palette start screenshots there, so a panel that remounts while one runs still shows Cancel
  and announces the outcome.
- The outcome is announced in the panel's live region (`screenshotOutcomeText`).
- **Screenshots** lists this page's screenshots, newest first, with Load more. Each shows its
  thumbnail (`<img>` with a `data:` URL), kind, time, pixel size, file size (`formatBytes`), a
  profile chip, Preview (a larger inline image, with a close button), Reveal in folder and Copy image.
- It uses the panel's project seam (`capture-project.ts`), as Capture now does. No inline styles.
- Palette actions: Screenshot viewport, Screenshot full page, Screenshot an area.

## Scenarios
- **Scenario: plan-stitch-covers-page-once** — for several page and viewport sizes and scales, the
  planned segments cover rows `0 … height` exactly once, in order; the last segment scrolls to the
  bottom and crops its overlap; an exact multiple needs no overlap; a page shorter than the
  viewport is one segment. Test: `apps/desktop/src/main/screenshots/__tests__/stitch.test.ts`.
- **Scenario: plan-stitch-respects-caps** — a page past `maxStitchedHeightPx`, `maxPixels` or
  `maxSegments` is cut at the cap and `truncated`. Test: `stitch.test.ts`.
- **Scenario: compose-stitch-places-rows** — synthetic BGRA segments with row markers, composed one by
  one with `composeStitch` (as a full page does), land at their destination rows; out-of-range crops
  are clipped; the right edge is cropped to the narrowest. Test: `stitch.test.ts`.
- **Scenario: crop-area-maps-css-to-pixels** — an area in CSS px is cropped from the view's bitmap at
  its pixels-per-CSS-pixel ratio, clamped to the bitmap. Test: `stitch.test.ts`.
- **Scenario: bitmap-of-a-captured-image** — a capture's pixels are read at its highest scale factor
  (its DIP size × that factor, checked against the bitmap's length); an empty or mismatched image is
  nothing. Test: `capture.test.ts`.
- **Scenario: viewport-and-area-capture-the-view** — the viewport is the whole view; an area is the
  view cropped to the rectangle; a selection that ends with nothing is `cancelled`, a non-rectangle
  `capture-failed`. Test: `capture.test.ts`.
- **Scenario: page-measure-reads-the-viewport** — the measure and scroll scripts read the scrolling
  element and viewport, scroll instantly, settle on a timeout when no frame comes, and an answer that
  is not sane numbers is refused. Test: `page-script.test.ts`.
- **Scenario: image-sizes-fit-their-limits** — thumbnails and previews fit their limits, never
  upscaled, a tall thumbnail showing the top. Test: `service.test.ts`.
- **Scenario: screenshot-tabs-read-the-profile-in-effect** — a tab's render profile is read by the
  rule captures follow: an `active` loaded one is not partial; `needsReload`, `applying` and `failed`
  ones are partial and still recorded (the row cannot say partial; the log does). Test:
  `service.test.ts`.
- **Scenario: screenshot-paths-are-main-only** — file names come only from hashes; a symlinked
  `screenshots` or `frost-captures` directory is refused (nothing written through it); a non-hex or
  traversal-looking hash is rejected by `fileFor`; files are `0600` and directories `0700` (POSIX).
  Test: `apps/desktop/src/main/screenshots/__tests__/store.test.ts`.
- **Scenario: store-writes-by-rename-and-reuses** — a write leaves no temporary file, reuses a file
  that already matches, and replaces one that does not. Test: `store.test.ts`.
- **Scenario: store-refuses-a-swapped-directory** — a reused file is set `0600`; the screenshot
  directory swapped for a symlink between the rename and the checks after it makes the write fail,
  with nothing in the link's target and the written file removed (with and without the `/proc` handle
  path). Test: `store.test.ts`.
- **Scenario: image-checks-hash** — a file changed on disk answers `null` from `image` and `copy`.
  Test: `apps/desktop/src/main/screenshots/__tests__/service.test.ts`.
- **Scenario: take-records-profile-and-params** — the row holds the tab's render profile and the
  search parameters (canonical JSON), the project, the kind, `segments`, `rect` and the pixel size;
  the file is named by the PNG's hash. Test: `service.test.ts`.
- **Scenario: take-records-the-serp-tabs-params** — a screenshot of a tab whose SERP state reads its
  page records Phase 3's parameters (`searchParamsOf` asked with the tab and its stored page URL); one
  of a tab that is not a result page records `null`. Test: `service.test.ts`.
- **Scenario: navigation-during-the-project-lookup-cancels** — the tab is watched from before its
  project is read: a main-frame navigation while that is pending answers `cancelled`, captures
  nothing, writes no row and leaves no listener (the pixels would be the new page's, filed under the
  old URL).
- **Scenario: take-refuses-what-it-cannot-take** — no tab, not active, no web page, no project, too
  large, a capture failure and a store failure each answer their refusal, write nothing, and log no
  page text. Test: `service.test.ts`.
- **Scenario: one-screenshot-per-tab** — a second take of a tab while one runs answers `busy`;
  another tab is not held up. Test: `service.test.ts`.
- **Scenario: thumbnails-are-made-once** — a thumbnail is made when the shot is taken and served from
  a bounded cache; one that fell out is rendered once again; previews are never cached and fit
  `maxImageDataUrlChars` (else `null`). Test: `service.test.ts`.
- **Scenario: bad-profile-records-none** — a render profile that does not fit its schema is recorded as
  `null`, with a log line; the screenshot is still taken. Test: `service.test.ts`.
- **Scenario: area-selection-cancels** — a main-frame navigation (an in-page one too; not a
  subframe's), Esc heard by main (`before-input-event`, its default prevented), `cancelArea`, the tab
  no longer active, the timeout and the tab closing each end a pending area selection as
  `cancelled`, run the cancel script and write nothing; no listener is left on the tab; an in-page
  navigation cancels a full page too, and its scroll is restored. Test:
  `apps/desktop/src/main/screenshots/__tests__/service.test.ts`.
- **Scenario: full-page-skips-the-horizontal-scrollbar** — a page with a horizontal scrollbar under it
  (`clientHeight` below `innerHeight`): only each capture's rows above the scaled `clientHeight` are
  placed, so every document row appears once and no scrollbar row does, at whole and fractional
  ratios. Test: `capture.test.ts`.
- **Scenario: full-page-rows-at-any-ratio** — a 10,000 CSS px page in a 653 px viewport at whole and
  fractional ratios (0.8 to 2.25, sizes rounded, scroll positions snapped to device pixels) gives
  exactly `round(10,000 × ratio)` rows (or the cap), each document row once, in order. Test:
  `capture.test.ts`.
- **Scenario: deadlines-bound-every-step** — with 100 ms deadlines, a page that never answers (its
  captures, measure, restore, selector or cancel script) ends a full page, an area (before and after
  its selection) and a viewport within a second. Test: `capture.test.ts`.
- **Scenario: full-page-restores-scroll** — a full page captures each planned segment, composes
  them (every document row once, also at a fractional device ratio), is cut where a page stops
  scrolling, and restores the scroll after success, failure, a cancel and the deadline. Test:
  `capture.test.ts`.
- **Scenario: area-select-needs-trusted-events** — against jsdom: untrusted pointer events never
  select; a trusted drag resolves the rectangle; a click-sized drag does not. Test:
  `apps/desktop/src/main/screenshots/__tests__/page-script.test.ts`.
- **Scenario: area-select-leaves-page-dom-unchanged** — a trusted Esc, the cancel script, the timeout
  and the page taking the host out (no Esc) remove the host and every listener, and
  `document.documentElement.outerHTML` is what it was before; a host the page appends again is
  hidden, empty and deaf to input. Test: `page-script.test.ts`.
- **Scenario: page-scripts-are-self-contained** — each script runs on its own (no module scope),
  only in `SCREENSHOT_WORLD_ID`. Test: `page-script.test.ts`.
- **Scenario: every-screenshots-procedure-enforces-sender**, **screenshots-inputs-are-validated**,
  **screenshots-procedures-call-service** — every `screenshots.*` procedure refuses a foreign sender
  before anything; inputs take only ids, `tabId`, `kind`, `projectId`, `size` and the cursor (a path,
  a hash or an unknown key is refused); `take` and `image` answers are checked on the way out (a data
  URL over the cap fails); without the service each fails closed. Test:
  `packages/ipc-contract/src/__tests__/screenshots-router.test.ts`.
- **Scenario: read-api-lists-screenshots** — `CHANGES_READ_API.listScreenshots`' schemas parse what
  main's `listScreenshots` answers. Test: `apps/desktop/src/main/screenshots/__tests__/service.test.ts`.
- **Scenario: screenshot-view-helpers** — sizes, bytes, kind labels, outcome wording and
  availability. Test: `apps/desktop/src/renderer/__tests__/changes-view.test.ts`.
- **Scenario: screenshot-palette-actions** — the three palette actions take their kind of the active
  tab and say the outcome. Test: `apps/desktop/src/renderer/__tests__/changes-palette.test.ts`.
- **Scenario: screenshot-runs-outlive-the-panel** — a tab's running screenshot is kept outside the
  panel until it answers, a second one does not clobber it, and the answer reaches every listener.
  Test: `apps/desktop/src/renderer/__tests__/screenshot-runs.test.ts`.

### End to end (`apps/desktop/e2e/screenshots.e2e.ts`, a loopback page about three viewports tall, coloured bands, a fixed header)
- **screenshot-viewport** — saved; the gallery shows it; the file is
  `<userData>/frost-captures/screenshots/<sha>.png` (`0600`, its directory `0700`), its SHA-256 is its
  name, and its pixel size is the view's size × its device scale factor (the page's
  `devicePixelRatio` over its zoom).
- **screenshot-full-page** — taller than the viewport, the scroll position restored, the hash matches.
- **screenshot-area** — a mouse drag on the tab's page selects an area; the image is about that size.
- **screenshot-area-esc-cancels** — Esc on the page cancels; nothing is saved.
- **screenshot-area-ignores-synthetic-events** — the page's own synthetic pointer events select
  nothing; Cancel ends it.
- **screenshot-leaves-page-dom-unchanged** — `document.documentElement.outerHTML` is the same before
  and after each kind.
