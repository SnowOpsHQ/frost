# Feature: Links, Images and Social panels, and highlight mode

Spec: `specs/seo-sidebar.spec.ts` (panels, `LINK_TYPE_FILTERS`, `LINK_REL_FLAGS`, `LINK_REL_FILTERS`,
`LINKS_CSV_COLUMNS`, `CSV_FORMULA_PREFIXES`, `IMAGE_FILTERS`, `SOCIAL_REMOTE_IMAGES`,
`HIGHLIGHT_MODES`, `HIGHLIGHT_STYLES`), `specs/seo-snapshot.spec.ts` (`LinkSchema.target`,
`ImageSchema` sizes, `SocialSchema`, `LinkFilterSchema`, the `seo.*` inputs), `specs/seo-limits.spec.ts`
(`SOCIAL_TAGS`, `SOCIAL_URL_TAGS`, `HIGHLIGHT_BUDGET_MS`, new caps), `specs/seo-rules.spec.ts` (the
image and social rules: `seo-rules.feature.md`) and `specs/browser.spec.ts` (`TabState.highlight`,
`OpenBackgroundTabInputSchema`). Phase 2 Task 2. Each line maps to one named test.

## Decisions
- **Copy as CSV goes through main.** `seo.copyLinksCsv({ tabId, filter })` (`enforceSender` first,
  Zod input) filters the tab's ready audit with the same pure `filterLinks` the panel uses, formats
  it with `linksCsv` and writes it with Electron's `clipboard` in main. The chrome has no clipboard
  access at all (no `navigator.clipboard`, no clipboard permission for `app://app`), and what can
  reach the clipboard is only ever the audit's own rows, never a string the chrome made up. "Copy
  URL" is the same: `seo.copyUrl({ tabId, url })` writes only a URL the ready audit lists
  (`pageUrls`: the page, canonical, og:url, link hrefs, image sources, the social image).
- **Remote images are never loaded into the chrome** (`SOCIAL_REMOTE_IMAGES = false`): the CSP stays
  `img-src 'self' data:`. The Images panel lists sources as text; the Social previews show a neutral
  placeholder graphic, the image URL and its declared size (`og:image:width` × `og:image:height`).
  A proxied thumbnail (fetched by main through the browse session, size-capped, re-encoded) could
  come later.
- **Opening a page link** is a button, never an `<a href>`: `browser.openBackgroundTab({ url })`
  (`enforceSender` first) opens an `http(s)` URL in a background tab right of the active tab, the
  way a page's own popup would; every other scheme opens nothing. The chrome also disables the
  button for non-`http(s)` URLs.
- **The highlight overlay is CSP-independent.** It is built in the isolated world with DOM APIs
  (`createElement`, `textContent`, `attachShadow`), inside a **closed** shadow root on one host
  element of its own appended to `<html>`, styled only through the CSSOM (`style.setProperty`).
  A page's CSP `style-src` governs stylesheets, `<style>` and `style` attributes parsed from markup
  or set with `setAttribute`, not CSSOM property writes, so the overlay looks the same under
  `style-src 'none'` (no `adoptedStyleSheets`, no `<style>`, no `unsafe-inline` needed). Trusted Types
  do not apply (no HTML or script sinks are used). Limits: the page can see that one host element
  (e.g. a `MutationObserver` on `<html>`) and could remove it; it cannot look inside it. Boxes are
  in document coordinates, so content inside inner scroll containers that scrolls does not move them
  until the next redraw (they redraw on layout changes and window resizes).

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

## Snapshot schema (`snapshot.test.ts`)
- `snapshot-caps-strings` covers link targets, social text and URL values, and image sizes at and
  one past their caps; `snapshot-is-strict` rejects fractional or negative sizes, an extra size key,
  a non-boolean `inFirstViewport`, an unknown or missing social tag and a non-string social value.

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
- **Scenario: social-preview-falls-back** — title and description come from Open Graph, then
  Twitter tags, then the page's title and description, and say which; the image from `og:image`,
  then `twitter:image`, resolved against the page; the declared size only when both are set; the
  domain from `og:url`, else the page (no `www.`).

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
- **Scenario: highlight-switch-replaces-overlay** — another mode replaces the overlay (still one
  host).
- **Scenario: highlight-off-removes-everything** — off restores `<html>`'s markup exactly, clears
  the state and removes every listener it added; off with nothing drawn is a no-op.
- **Scenario: highlight-is-bounded** — at most the cap's boxes; past `HIGHLIGHT_BUDGET_MS` it stops
  measuring.
- **Scenario: highlight-follows-layout** — a resize redraws (once per frame) from the new layout.
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
- **Scenario: highlight-failure-turns-off** — a paint that fails leaves the state `off`.
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
- **Scenario: copy-links-csv** — without a ready audit nothing is written (`null`); with one, the
  filtered rows are written as `linksCsv` and their count answered; the formula guard is on.
- **Scenario: copy-url-only-copies-audit-urls** — the audit's link, image, social image and page
  URLs are written; any other string, or another tab's id, writes nothing (`false`).

## Router (`seo-router.test.ts`, `browser-router.test.ts`)
- `seo-procedures-reject-foreign-sender-first`, `seo-procedures-validate-input`,
  `seo-procedures-call-service` and `missing-seo-service-is-internal-error` cover
  `seo.setHighlight`, `seo.copyLinksCsv` and `seo.copyUrl` (unknown modes, filters with unknown
  values, an over-long query, extra keys, an empty or over-long URL are `BAD_REQUEST`).
- **Scenario: open-background-tab-calls-service** — `browser.openBackgroundTab` passes the URL to the
  service and answers its id or `null`; the browser router tests cover its sender check and input.

## Renderer helpers (`seo-view.test.ts`)
- **Scenario: rail-statuses** — Links, Images and Social dots come from their own categories;
  social findings colour Overview and Social, not On-Page.
- **Scenario: only-web-urls-are-openable** — only `http(s)` URLs get an enabled "Open in new tab".
- **Scenario: image-size-labels** — sizes as `w × h`, declared attributes with `?` for a missing one,
  the oversize ratio.
- **Scenario: link-query-is-capped** — the search is cut to `LINK_FILTER_QUERY_MAX_CHARS` without
  splitting a surrogate pair.

## Panels (renderer)
- The rail lists Overview, On-Page, Links, Images, Social, then the four panels still to come.
  Links, Images and Social each start with their own ranked issues (expandable, as in Overview).
- Links: counts (internal, external, other; nofollow, sponsored, ugc), the highlight toggle, Copy as
  CSV (the rows shown), a search box, type buttons with counts, a rel select; each row shows the
  type, anchor text (or "No anchor text"), rel flags, target and href; clicking it offers "Open in
  new tab" (`http(s)` only) and "Copy URL". Capped: "Showing the first N of M links."
- Images: counts (missing alt, no width/height, oversized, lazy in the first screen), filter chips;
  each row shows the alt state, the source, declared attributes, the rendered and file sizes and
  flags; clicking it offers "Open image in new tab" (`http(s)` only) and "Copy URL".
- Social: the issues, a large-image card and a summary card drawn from the tags (placeholder image,
  declared size), where the title and description came from, the image URL with its actions, and
  every Open Graph and Twitter card field ("Not set" when absent).
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
  image far below is not; the filters select them; their rules are listed; the sidebar has no
  `<img>`.
- **Scenario: social-fields-without-remote-requests** — the Open Graph and Twitter fields, both
  cards, the declared size and the `og-image-not-https` / `twitter-card-missing` issues are shown,
  and the loopback server's request log never sees the og:image or twitter:image URL.
- **Scenario: highlight-links-leaves-no-residue** — on: seven boxes with the right kinds (read in the
  isolated world), one extra element in the page's `<html>` with a closed shadow root and no page
  element changed; off: `<html>`'s markup is exactly what it was; on again then a navigation: the
  toggle is off and the new page has no overlay; on then a new tab: the overlay is removed from the
  page it was on.
- **Scenario: highlight-headings-on-strict-csp-page** — a page served with `style-src 'none'`,
  `script-src 'none'` and Trusted Types (its own `setAttribute('style')` has no effect) gets three
  heading boxes whose CSSOM styles apply (absolute, solid border in the H1 colour, white 10 px
  labels); links mode too; off leaves no residue.
- **Scenario: page-text-is-inert-in-new-panels** (Review Focus `page-text-is-inert-in-sidebar`,
  extended) — markup, `javascript:` URLs and bidi overrides in anchor text, targets, alt text,
  `loading`, og and twitter values render as literal text in Links, Images and Social with every row
  and issue opened; the sidebar gains no `img`, `script`, `a`, `iframe` or `[style]`; nothing ran
  in the chrome; a `javascript:` link or og:image cannot be opened.
