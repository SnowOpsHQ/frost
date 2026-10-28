# Feature: screenshots

Spec: `specs/screenshot.spec.ts` (`SCREENSHOT_WORLD_ID`, `SCREENSHOTS_DIR_NAME`, `SCREENSHOT_LIMITS`, `SCREENSHOT_REFUSALS`,
`SCREENSHOT_REFUSAL_MESSAGES`, `FULL_PAGE_SCROLL_NOTE`, `AREA_SELECT_HINT`, `SCREENSHOT_KIND_LABELS`,
`SCREENSHOT_IMAGE_SIZES`, the input and answer types) and `specs/screenshot.schema.ts` (their Zod
schemas, and the `listScreenshots` read operation of `CHANGES_READ_API`); storage is the
`ci_screenshots` table and `CAPTURES_DIR_NAME` of `specs/capture-db.spec.ts`. Phase 6 Task 5.
Implemented by `apps/desktop/src/main/screenshots/` (`stitch.ts`, `page-script.ts`, `capture.ts`,
`imaging.ts`, `store.ts`, `service.ts`), the `screenshots` router in `packages/ipc-contract/src/changes-router.ts`
(`ScreenshotsService` in `changes-service.ts`), and the Changes panel
(`components/changes/Screenshots.tsx`, `changes-view.ts`, `changes-palette.ts`).

## Kinds
- **Viewport**: the tab's view as it is shown (`capturePage()`), scrollbar included.
- **Full page**: the whole document, stitched from viewport captures while the page is scrolled:
  1. measure the page in `SCREENSHOT_WORLD_ID` (`document.scrollingElement`'s height, the viewport,
     its client width and height without scrollbars, the scroll position, `devicePixelRatio`);
  2. capture the top of the page; the view's device rows per CSS pixel are that bitmap's height over
     `innerHeight` (a render profile's device emulation, or a fractionally scaled display, can make it
     differ from the display's reported scale factor);
  3. plan the segments (`planStitch`): one per viewport height, the last one scrolled to the bottom
     (`scrollHeight - clientHeight`) with its overlap cropped, so every document row is in the image
     exactly once; the right edge (the scrollbar) is cropped to `clientWidth`;
  4. for each segment: scroll (`behavior: 'instant'`), wait `segmentSettleFrames` animation frames
     (at most `segmentTimeoutMs`), capture, and place its rows from where the last segment really
     ended, cropped by the scroll position the page actually reached (so a row of rounding never
     leaves a gap; a page that stops scrolling early is cut there, `truncated`);
  5. compose the rows into one bitmap (`composeStitch`), and encode it;
  6. restore the original scroll position, always (also on a failure or a cancel).

  The whole run is bounded by `fullPageDeadlineMs`. A page taller than `maxStitchedHeightPx`, wider ×
  taller than `maxPixels`, or needing more than `maxSegments` captures is cut at the cap (the answer
  says `truncated`). Fixed and sticky elements appear in each segment, and lazy content appears as
  it is scrolled into view (Known limits). The page can see the scrolling: the UI says so
  (`FULL_PAGE_SCROLL_NOTE`).
- **Area**: the user drags a rectangle on the page:
  - an overlay in `SCREENSHOT_WORLD_ID`: one host element of its own appended to `<html>`, a
    **closed** shadow root, inline styles through the CSSOM only (`style.setProperty`), a crosshair
    cursor and a dimmed backdrop; no page element's attributes, styles or text change;
  - only **trusted** pointer events (`event.isTrusted`) start, move or end the drag, so a page cannot
    select for the user; a drag smaller than `minAreaCssPx` either way selects nothing and the
    selection goes on;
  - a trusted Esc, `screenshots.cancelArea`, a main-frame navigation, the tab closing, the tab no
    longer being the active one, and `areaTimeoutMs` all cancel it (`cancelled`);
  - when it ends, the host and every listener are removed, two animation frames pass (so the
    overlay is not captured), and main captures the view and crops the rectangle, scaled by the
    view's pixels per CSS pixel (captured width over `innerWidth`);
  - the selection is in CSS viewport px, stored as the row's `rect` (canonical JSON).

## Taking one
- `screenshots.take({ tabId, kind, projectId? })`: only the **active** tab, showing a web page; the
  project defaults to Unfiled. One screenshot per tab at a time (`busy`).
- It records the tab's render profile in effect (`TabState.renderProfile`, unless `failed`; as
  canonical JSON) and its search parameters (`searchParamsOf`; `null` until Phase 3,
  `TODO(phase-3-merge)`). Main-internal callers (Task 6's capture run) may pass a `captureId` and the
  query's search parameters.
- Main builds the PNG (`createFromBitmap` → `toPNG`); one over `maxPngBytes` is refused
  (`too-large`) and nothing is written.
- The file is written first, then the row (`appendScreenshot`, with `segments`, `rect`, the pixel
  size and the PNG's bytes). A row that fails after the file was written leaves the file for the
  orphan sweep (Task 7).
- The answer: `{ status: 'saved', id, kind, width, height, bytes, truncated }`, or a refusal. The
  service never rejects; a failure is one log line, never page text or a path beyond the
  profile-relative directory.

## Files (main only)
- The directory is `<userData>/frost-captures/screenshots/`, created `0700` (both directories;
  `mkdir`, then `chmod`).
- Before every write (and read), each of `frost-captures` and `screenshots` is `lstat`ed: anything but
  a real directory (a symlink above all) is refused, and nothing is written.
- A file is named `<sha256>.png`, the SHA-256 main computed of the PNG it encoded. `fileFor(sha)`
  accepts only `SHA256_HEX_PATTERN`, and the resolved path must be directly inside the directory.
- A write reuses an existing file whose bytes hash to its name; otherwise it writes
  `<sha>.png.tmp-<random>` (`wx`, `0600`) and renames it into place.
- A read opens the file without following a symlink, caps it at `maxPngBytes`, and checks its hash:
  a missing file or a mismatch answers `null`.
- No procedure takes a path, a file name or a hash; the chrome names a screenshot by its row id.

## Images, reveal, copy
- `screenshots.image({ id, size })`: a `data:` URL (the chrome's CSP allows `img-src data:`):
  - `thumb`: PNG, `thumbWidth` wide; a shot taller than `thumbMaxHeight` at that width shows its top;
  - `preview`: JPEG (`previewJpegQuality`), fit within `previewMaxWidth` × `previewMaxHeight`;
  - never upscaled; `null` for an unknown id, a missing file or a file that does not match its hash.
- `screenshots.reveal({ id })`: `shell.showItemInFolder` on the file (never `openPath` or
  `openExternal`); `false` when the file is missing.
- `screenshots.copy({ id })`: the image to the system clipboard (`clipboard.writeImage`), only after
  its hash checks.

## Listing
- `screenshots.list({ url?, projectId?, cursor?, limit? })` and the read API's `listScreenshots`:
  newest first, at most `MAX_HISTORY_PAGE` per page, with a cursor. Each entry is parsed with
  `ScreenshotEntrySchema` (a tampered row is skipped) and carries no path, file name or hash.

## The Changes panel
- A **Screenshot** group next to Capture now: Viewport, Full page (with `FULL_PAGE_SCROLL_NOTE` as
  its visible hint), Select area. Enabled for the active tab showing a web page (`canScreenshot`).
- While an area is selected, a hint row says `AREA_SELECT_HINT`, with a Cancel button
  (`screenshots.cancelArea`).
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
- **Scenario: compose-stitch-places-rows** — synthetic BGRA segments with row markers land at their
  destination rows; out-of-range crops are clipped; the right edge is cropped to the narrowest.
  Test: `stitch.test.ts`.
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
- **Scenario: screenshot-tabs-read-the-profile-in-effect** — a tab's render profile is recorded only
  while it is in effect (not `failed`). Test: `service.test.ts`.
- **Scenario: screenshot-paths-are-main-only** — file names come only from hashes; a symlinked
  `screenshots` or `frost-captures` directory is refused (nothing written through it); a non-hex or
  traversal-looking hash is rejected by `fileFor`; files are `0600` and directories `0700` (POSIX).
  Test: `apps/desktop/src/main/screenshots/__tests__/store.test.ts`.
- **Scenario: store-writes-by-rename-and-reuses** — a write leaves no temporary file, reuses a file
  that already matches, and replaces one that does not. Test: `store.test.ts`.
- **Scenario: image-checks-hash** — a file changed on disk answers `null` from `image` and `copy`.
  Test: `apps/desktop/src/main/screenshots/__tests__/service.test.ts`.
- **Scenario: take-records-profile-and-params** — the row holds the tab's render profile and the
  search parameters (canonical JSON), the project, the kind, `segments`, `rect` and the pixel size;
  the file is named by the PNG's hash. Test: `service.test.ts`.
- **Scenario: take-refuses-what-it-cannot-take** — no tab, not active, no web page, no project, too
  large, a capture failure and a store failure each answer their refusal, write nothing, and log no
  page text. Test: `service.test.ts`.
- **Scenario: one-screenshot-per-tab** — a second take of a tab while one runs answers `busy`;
  another tab is not held up. Test: `service.test.ts`.
- **Scenario: area-selection-cancels** — navigation, `cancelArea`, the tab closing, the tab no longer
  active and the timeout each end a pending area selection as `cancelled`, run the cancel script and
  write nothing. Test: `apps/desktop/src/main/screenshots/__tests__/capture.test.ts`.
- **Scenario: full-page-restores-scroll** — a full page captures each planned segment, composes
  them (every document row once, also at a fractional device ratio), is cut where a page stops
  scrolling, and restores the scroll after success, failure, a cancel and the deadline. Test:
  `capture.test.ts`.
- **Scenario: area-select-needs-trusted-events** — against jsdom: untrusted pointer events never
  select; a trusted drag resolves the rectangle; a click-sized drag does not. Test:
  `apps/desktop/src/main/screenshots/__tests__/page-script.test.ts`.
- **Scenario: area-select-leaves-page-dom-unchanged** — a trusted Esc, the cancel script and the
  timeout remove the host and every listener, and `document.documentElement.outerHTML` is what it
  was before. Test: `page-script.test.ts`.
- **Scenario: page-scripts-are-self-contained** — each script runs on its own (no module scope),
  only in `SCREENSHOT_WORLD_ID`. Test: `page-script.test.ts`.
- **Scenario: every-screenshots-procedure-enforces-sender**, **screenshots-inputs-are-validated**,
  **screenshots-procedures-call-service** — every `screenshots.*` procedure refuses a foreign sender
  before anything; inputs take only ids, `tabId`, `kind`, `projectId`, `size` and the cursor (a path,
  a hash or an unknown key is refused); without the service each fails closed. Test:
  `packages/ipc-contract/src/__tests__/screenshots-router.test.ts`.
- **Scenario: read-api-lists-screenshots** — `CHANGES_READ_API.listScreenshots`' schemas parse what
  main's `listScreenshots` answers. Test: `apps/desktop/src/main/screenshots/__tests__/service.test.ts`.
- **Scenario: screenshot-view-helpers** — sizes, bytes, kind labels, outcome wording and
  availability. Test: `apps/desktop/src/renderer/__tests__/changes-view.test.ts`.
- **Scenario: screenshot-palette-actions** — the three palette actions take their kind of the active
  tab, say the outcome, and tell the panel as they start and end. Test:
  `apps/desktop/src/renderer/__tests__/changes-palette.test.ts`.

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
