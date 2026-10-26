# Feature: Links, Images and Social panels, and highlight mode

Spec: `specs/seo-sidebar.spec.ts` (panels, `LINK_TYPE_FILTERS`, `LINK_REL_FLAGS`, `LINK_REL_FILTERS`,
`LINKS_CSV_COLUMNS`, `CSV_FORMULA_PREFIXES`, `IMAGE_FILTERS`, `SOCIAL_REMOTE_IMAGES`,
`HIGHLIGHT_MODES`, `HIGHLIGHT_STYLES`), `specs/seo-snapshot.spec.ts` (`LinkSchema.target`,
`ImageSchema` sizes, `SocialSchema`, `LinkFilterSchema`, the `seo.*` inputs), `specs/seo-limits.spec.ts`
(`SOCIAL_TAGS`, `SOCIAL_URL_TAGS`, `HIGHLIGHT_BUDGET_MS`, new caps), `specs/seo-rules.spec.ts` (the
image and social rules: `seo-rules.feature.md`) and `specs/browser.spec.ts` (`TabState.highlight`,
`OpenBackgroundTabInputSchema`). Phase 2 Task 2. Each line maps to one named test.

## Decisions
- **Copy as CSV goes through main.** `seo.copyLinksCsv({ tabId, audit, filter })` (`enforceSender`
  first, Zod input) filters the tab's ready audit with the same pure `filterLinks` the panel uses,
  formats it with `linksCsv` and writes it with Electron's `clipboard` in main. The chrome has no
  clipboard access at all (no `navigator.clipboard`, no clipboard permission for `app://app`), and
  what can reach the clipboard is only ever the audit's own rows, never a string the chrome made
  up. "Copy URL" is the same: `seo.copyUrl({ tabId, audit, url })` writes only a URL the ready audit
  lists, as its parsed `href` (`pageUrls`: the page, canonical, og:url, link hrefs, image sources,
  both cards' images; raw tag strings are not admitted). `audit` is the audit the panel rendered
  (`SeoAuditRefSchema`: its `url` and `takenAt`); when main's ready audit is another one, nothing
  is copied.
- **Remote images are never loaded into the chrome** (`SOCIAL_REMOTE_IMAGES = false`): the CSP stays
  `img-src 'self' data:`. The Images panel lists sources as text; the Social previews show a neutral
  placeholder graphic, the image URL and its declared size (`og:image:width` × `og:image:height`).
  A proxied thumbnail (fetched by main through the browse session, size-capped, re-encoded) could
  come later.
- **Opening a page link** is a button, never an `<a href>`: `browser.openBackgroundTab({ url })`
  (`enforceSender` first) opens an `http(s)` URL in a background tab right of the active tab, the
  way a page's own popup would; every other scheme opens nothing. The chrome also disables the
  button for non-`http(s)` URLs.
- **Image file sizes follow `srcset`.** `naturalWidth` is divided by the density the browser picked,
  so the extractor matches `currentSrc` against the `srcset` candidates (the image's own and its
  `<picture>`'s sources) and corrects it: a `w` descriptor is the file's width, an `x` descriptor a
  multiplier. The Images "File" column and `images-oversized` use the corrected size.
- **The overlay never outlives its toggle** (`HIGHLIGHT_PANELS`): the chrome turns it off when the
  sidebar collapses or the user leaves the panel that owns it; main turns it off on navigation,
  errors, crashes and tab changes; and when the page removes the overlay's host, the overlay stops
  and reports it (`watchHighlight` settles with `removed`), so the tab's mode is `off` again.
- **The highlight overlay is CSP-independent.** It is built in the isolated world with DOM APIs
  (`createElement`, `textContent`, `attachShadow`), inside a **closed** shadow root on one host
  element of its own appended to `<html>`, styled only through the CSSOM (`style.setProperty`).
  A page's CSP `style-src` governs stylesheets, `<style>` and `style` attributes parsed from markup
  or set with `setAttribute`, not CSSOM property writes, so the overlay looks the same under
  `style-src 'none'` (no `adoptedStyleSheets`, no `<style>`, no `unsafe-inline` needed). Trusted Types
  do not apply (no HTML or script sinks are used). Limits: the page can see that one host element
  (e.g. a `MutationObserver` on `<html>`) and could remove it (the overlay then stops); it cannot
  look inside it. Boxes are in document coordinates and redraw on layout changes, window resizes
  and any scroll (a passive capture-phase listener on the document, so inner scroll containers and
  fixed elements are followed), at most one pass per frame, measuring at most `HIGHLIGHT_FRAME_MS`
  per frame and reusing the box elements.

## Extraction (`extract-dom.test.ts`)
- **Scenario: extractor-reads-link-targets** — a link's `target` is read trimmed and capped at
  `maxTargetChars`; `null` without the attribute, `''` for an empty one.
- **Scenario: extractor-measures-images** — rendered size from `getBoundingClientRect()` (rounded),
  natural size from `naturalWidth` / `naturalHeight` (`null` while 0), both capped at
  `maxImagePixels`; a hidden image or a box with no area has no rendered size; `inFirstViewport` is
  measured in document coordinates (the scroll offset added), so it holds wherever the page is
  scrolled; a box right of the viewport is not in it.
- **Scenario: extractor-reads-social-tags** — each `SOCIAL_TAGS` value is the first meta whose
  `property` or `name` is the tag (any case); text values normalised and capped at `maxSocialChars`,
  URL values trimmed and capped at `maxUrlChars`; absent tags are `null`; `og:url` stays `ogUrl`.

- **Scenario: extractor-corrects-srcset-density** — `currentSrc` from a `w` candidate gives the
  descriptor as the file's width and the height from the natural aspect (1600w reported as 400 × 200
  is 1600 × 800); an `x` candidate multiplies (3x: 300 × 150 is 900 × 450); a `<picture><source>`
  candidate counts; without `srcset` the natural size is kept; a `data:` candidate with commas is
  parsed whole.
- **Scenario: extractor-reads-css-sizing** — an image without width/height attributes is `cssSized`
  with inline `width` and `height`, a stylesheet rule declaring both (also inside `@media`), or a
  computed `aspect-ratio`; one width alone, `auto`, or `maxSizingSelectors` 0 is not; an image with
  both attributes is not measured (`false`).
- **Scenario: extractor-link-kind-counts-the-port** — the same host name on another port is
  `external`; the default port and `www.` are the same host.

## Snapshot schema (`snapshot.test.ts`)
- `snapshot-caps-strings` covers link targets, social text and URL values, and image sizes at and
  one past their caps; `snapshot-is-strict` rejects fractional or negative sizes, an extra size key,
  a non-boolean `inFirstViewport` or `cssSized`, an unknown or missing social tag and a non-string social value.

## Rules (`packages/seo-core`, `seo-rules.feature.md`, Images and Social)
`images-missing-dimensions`, `images-oversized`, `images-lazy-in-first-viewport`, `og-title-missing`,
`og-description-missing`, `og-image-missing`, `og-image-not-https`, `twitter-card-missing`.

## Panel helpers (`packages/seo-core/src/__tests__/panels.test.ts`)
- **Scenario: link-rel-flags** — `nofollow`, `sponsored` and `ugc` are `rel` tokens (any case), not
  substrings.
- **Scenario: link-filter-by-type-rel-and-query** — the type filter keeps one kind; the rel filter
  one flag, or `followed` (none of them); the query matches the href or the anchor text,
  case-insensitively, trimmed; all three combine.
- **Scenario: link-counts** — counts per kind, per flag and `followed`.
- **Scenario: csv-header-and-columns** — the `LINKS_CSV_COLUMNS` header, one CRLF-ended line per
  row in the given order, `yes` / `no` flags, an empty target cell when there is none.
- **Scenario: csv-escapes-quotes-commas-newlines** — cells with `,`, `"`, CR or LF are quoted, `"`
  doubled.
- **Scenario: csv-guards-formulas** — a cell starting with `=`, `+`, `-`, `@`, tab or CR gets a
  leading `'` (then is quoted if needed); a `=` later in the cell is left alone.
- **Scenario: image-alt-state** — `null` alt is `missing`, `alt=""` `decorative`, else `present`.
- **Scenario: image-filters** — each `IMAGE_FILTERS` value selects exactly the images its rule
  would flag; counts match.
- **Scenario: social-preview-falls-back** — each card has its own chain: the large card's title and
  description come from Open Graph, then the page (never Twitter tags), its image from `og:image`;
  the summary card's from Twitter tags, then Open Graph, then the page, its image from
  `twitter:image`, then `og:image`; each value says where it came from, and with `twitter:title` ≠
  `og:title` the two cards differ; images resolved against the page; the declared size only when
  both are set; the domain from `og:url`, else the page (no `www.`).
- **Scenario: page-urls-are-parsed-hrefs** — `pageUrls` holds parsed `href`s only: a social image as
  written (` /img/share.png `, `HTTPS://Example.com/T.png`) is not in it, its resolved href is.

## Highlight (`highlight.test.ts`, jsdom)
- **Scenario: highlight-plan-is-pure** — `planHighlight` turns item rects into boxes in document
  coordinates (the scroll offset added, rounded) with the kind's colour and label, skips items with
  no finite, non-empty rect, stops at its cap and does not touch its input; every kind has its own
  colour.
- **Scenario: highlight-draws-in-closed-shadow-root** — on: exactly one new element (a `div`, last
  in `<html>`, `aria-hidden`), its shadow root closed (`shadowRoot` is `null` from outside), its
  styles CSSOM-set and `!important`; the body's markup, the stylesheets and the `<style>` / link
  elements are unchanged.
- **Scenario: highlight-kinds-and-labels** — links are `int` / `ext` / `nofollow` / `other` (a
  `nofollow` rel wins over the kind; hidden links are skipped), headings `H1`…`H6`; labels are text
  nodes.
- **Scenario: highlight-link-kind-counts-the-port** — as the extractor: another port is `ext`, the
  default port is `int`.
- **Scenario: highlight-switch-replaces-overlay** — another mode replaces the overlay (still one
  host).
- **Scenario: highlight-off-removes-everything** — off restores `<html>`'s markup exactly, clears
  the state, settles `ended` (`replaced`, then `off`) and removes every listener it added (window
  `resize` and `pagehide`, the document's passive capture-phase `scroll`); off with nothing drawn is
  a no-op.
- **Scenario: highlight-is-bounded** — at most the cap's boxes; past `HIGHLIGHT_BUDGET_MS` it stops
  measuring.
- **Scenario: highlight-measures-across-frames** — slow rect reads are spread over several frames
  (`HIGHLIGHT_FRAME_MS` each) and every box still lands.
- **Scenario: highlight-draws-once-per-toggle** — the `ResizeObserver`'s initial observations (one
  per target, even delivered separately) are skipped: one toggle, one drawing pass.
- **Scenario: highlight-reuses-boxes** — a burst of layout events makes one more pass, on the same
  box elements, rewriting the one that moved.
- **Scenario: highlight-follows-scrolling** — an inner scroll container's (non-bubbling) `scroll`
  and the page's scroll redraw: a box in the pane moves, a fixed element's box moves down the
  document; once off, scrolling draws nothing.
- **Scenario: highlight-stops-when-page-removes-host** — the page removing the host: the next redraw
  stops the overlay, clears its state and settles `ended` with `removed`.
- **Scenario: highlight-ends-with-the-page** — `pagehide` stops it (`gone`).
- **Scenario: highlight-ended-script-answers-the-reason** — `watchHighlight` runs
  `highlightEndedScript` in `SEO_WORLD_ID` and answers its reason.
- **Scenario: highlight-script-is-self-contained** — the script parses, embeds the mode and config,
  and uses no `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`, no
  `adoptedStyleSheets` / `CSSStyleSheet` / `<style>` / `style` attribute / `cssText`, no `eval`, Node
  or Electron.
- **Scenario: highlight-runs-in-seo-world** — `runHighlight` calls
  `executeJavaScriptInIsolatedWorld` once with `SEO_WORLD_ID`.

## Controller (`apps/desktop/src/main/seo/__tests__/panels.test.ts`, fakes)
- **Scenario: highlight-sets-tab-state** — `seo.setHighlight` on the active tab paints the mode and
  reports it in `TabState.highlight` (the version bumps); another mode replaces it; `off` turns it
  off.
- **Scenario: highlight-only-on-active-web-page** — an empty tab, an unknown id, a background tab
  and a non-`http(s)` page answer `false` and paint nothing.
- **Scenario: highlight-failure-turns-off** — a paint that fails, or answers that it drew nothing,
  leaves the state `off`.
- **Scenario: highlight-removed-by-page-turns-off** — once drawn, main waits for the overlay to end;
  `removed` turns the tab's mode off (the version bumps); an end of a superseded overlay, or
  `replaced`, changes nothing.
- **Scenario: highlight-resets-on-navigation** — a fragment-only change keeps it; an in-page
  navigation to another URL turns it off and removes the overlay; a new document turns it off
  (nothing to remove).
- **Scenario: highlight-late-paint-after-navigation-is-removed** — a paint that lands after the page
  moved on is removed again; a superseded request never removes a newer one's overlay.
- **Scenario: highlight-resets-on-tab-change** — a new tab or activating another tab turns the left
  tab's highlight off and removes its overlay.
- **Scenario: highlight-resets-on-error-and-crash** — a main-frame load error or a crash turns it
  off.
- **Scenario: open-background-tab** — an `http(s)` URL opens right of the active tab (after the tabs
  it opened), which stays active; the URL is loaded as given.
- **Scenario: open-background-tab-is-web-only** — `javascript:`, `file:`, `data:`, `app:`,
  `mailto:`, garbage and `''` open nothing.
- **Scenario: open-background-tab-respects-tab-limit** — at `MAX_TABS` nothing opens and the
  `tab-limit` notice is raised.
- **Scenario: copy-links-csv** — without a ready audit, or for another audit than the one shown
  (another `url` or `takenAt`), nothing is written (`null`); with it, the filtered rows are written
  as `linksCsv` and their count answered; the formula guard is on.
- **Scenario: copy-url-only-copies-audit-urls** — the audit's link, image, social image (parsed) and
  page URLs are written; any other string, a raw tag value, another audit than the one shown, or
  another tab's id, writes nothing (`false`).

## Router (`seo-router.test.ts`, `browser-router.test.ts`)
- `seo-procedures-reject-foreign-sender-first`, `seo-procedures-validate-input`,
  `seo-procedures-call-service` and `missing-seo-service-is-internal-error` cover
  `seo.setHighlight`, `seo.copyLinksCsv` and `seo.copyUrl` (unknown modes, filters with unknown
  values, an over-long query, a missing or malformed `audit` reference, extra keys, an empty or
  over-long URL are `BAD_REQUEST`).
- **Scenario: open-background-tab-calls-service** — `browser.openBackgroundTab` passes the URL to the
  service and answers its id or `null`; the browser router tests cover its sender check and input.

## Renderer helpers (`seo-view.test.ts`)
- **Scenario: rail-statuses** — Links, Images and Social dots come from their own categories;
  social findings colour Overview and Social, not On-Page.
- **Scenario: only-web-urls-are-openable** — only `http(s)` URLs get an enabled "Open in new tab".
- **Scenario: image-size-labels** — sizes as `w × h`, declared attributes with `?` for a missing one,
  the oversize ratio.
- **Scenario: highlight-follows-its-panel** — `highlightToClear`: an overlay is kept only while the
  sidebar is open on the panel that owns it (`HIGHLIGHT_PANELS`).
- **Scenario: link-query-is-capped** — the search is cut to `LINK_FILTER_QUERY_MAX_CHARS` without
  splitting a surrogate pair.

## Panels (renderer)
- The rail lists Overview, On-Page, Links, Images, Social, Schema (Task 3: `seo-schema.feature.md`), then the panels
  still to come.
  Links, Images and Social each start with their own ranked issues (expandable, as in Overview).
- Links: counts (internal, external, other; nofollow, sponsored, ugc), the highlight toggle, Copy as
  CSV (the rows shown), a search box, type buttons with counts, a rel select; each row shows the
  type, anchor text (or "No anchor text"), rel flags, target and href; clicking it offers "Open in
  new tab" (`http(s)` only) and "Copy URL". Capped: "Showing the first N of M links."
- Images: counts (missing alt, no width/height, oversized, lazy in the first screen), filter chips;
  each row shows the alt state, the source, declared attributes, the rendered and file sizes and
  flags; clicking it offers "Open image in new tab" (`http(s)` only) and "Copy URL".
- Social: the issues, a large-image card (Open Graph) and a summary card (Twitter card tags) drawn
  from the tags (placeholder image, declared size), where each card's title and description came
  from, each card's image URL with its actions, and every Open Graph and Twitter card field ("Not
  set" when absent).
- On-Page's Headings section has the headings highlight toggle.
- Everything page-derived is React text inside `<bdi>` (`PageText`): no `<a>`, no `<img>`, no
  `style=` props.

## End to end (`apps/desktop/e2e/seo-panels.e2e.ts`, loopback pages)
- **Scenario: links-table-and-filters** — counts per type and rel, seven rows, the target shown, the
  rail's Links dot; type, rel, `followed` and search filters narrow the rows; a page with more than
  `maxLinks` links says "Showing the first 1,000 of 1,100 links."
- **Scenario: links-copy-csv** — Copy as CSV with the external filter puts exactly the header and
  the two external rows on the system clipboard (read in main), quotes and the formula guard
  applied.
- **Scenario: links-open-in-new-tab** — a row's "Open in new tab" opens a background tab that loads
  the link while the page's tab stays active; "Copy URL" copies the href; `mailto:` and
  `javascript:` rows cannot be opened; the sidebar has no `<a>`.
- **Scenario: images-table** — an image shown at 100 × 50 from an 800 × 400 file is oversized (8×), a
  lazy image at the top is flagged, one without width/height and one without alt are flagged, a lazy
  image far below is not; `srcset` files are measured as files: a 1600w candidate shown at 400 × 200
  (1,600 × 800, 4×), a 3x candidate (900 × 450, 3×), a `<picture>` source (1,200 × 600, 4×); an image
  CSS sizes without attributes is not flagged; the filters select them; their rules are listed; the
  sidebar has no `<img>`.
- **Scenario: social-fields-without-remote-requests** — the Open Graph and Twitter fields, both
  cards from their own chains (the summary card's title from `twitter:title`, the large card's from
  `og:title`), the declared size and the `og-image-not-https` / `twitter-card-missing` issues are shown,
  and the loopback server's request log never sees the og:image or twitter:image URL.
- **Scenario: highlight-links-leaves-no-residue** — on: seven boxes with the right kinds (read in the
  isolated world), one drawing pass for the toggle, nothing visible in the page's own world
  (`window.__frostSeoHighlight` is undefined there), one extra element in the page's `<html>` with a
  closed shadow root and no page element changed; off: `<html>`'s markup is exactly what it was; on
  again then a navigation with the Links panel open: the toggle is off and the new page has no
  overlay; on then a new tab: the overlay is removed from the page it was on.
- **Scenario: highlight-follows-the-sidebar-and-the-page** — collapsing the sidebar, and opening
  another panel, each turn the overlay off and leave the page's `<html>` as it was; the page removing
  the overlay's host stops it and the toggle unpresses.
- **Scenario: highlight-headings-on-strict-csp-page** — a page served with `style-src 'none'`,
  `script-src 'none'` and Trusted Types (its own `setAttribute('style')` has no effect) gets three
  heading boxes whose CSSOM styles apply (absolute, solid border in the H1 colour, white 10 px
  labels); links mode too; off leaves no residue.
- **Scenario: page-text-is-inert-in-new-panels** (Review Focus `page-text-is-inert-in-sidebar`,
  extended) — markup, `javascript:` URLs and bidi overrides in anchor text, targets, alt text,
  `loading`, og and twitter values render as literal text in Links, Images and Social with every row
  and issue opened; the sidebar gains no `img`, `script`, `a`, `iframe` or `[style]`; nothing ran
  in the chrome; a `javascript:` link or og:image cannot be opened.
