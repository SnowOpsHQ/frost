# Feature: DOM inspector

Spec: `specs/inspector.spec.ts` (`INSPECTOR_WORLD_ID`, `INSPECTOR_LIMITS`, `DOC_TOKEN_PATTERN`,
`INSPECTOR_REFUSALS`, `INSPECTOR_REFUSAL_MESSAGES`, `INSPECTOR_PICK_HINT`, `INSPECTOR_PICK_NOTE`,
`INSPECTOR_LABELS`, `INSPECTOR_REGION_LABELS`, the input and answer types) and
`specs/inspector.schema.ts` (their Zod schemas). Phase 6 Task 8. Implemented by
`apps/desktop/src/main/inspector/` (`page-script.ts`, `service.ts`), the `inspector` router in
`packages/ipc-contract/src/inspector-router.ts` (`InspectorService` there too), and the Inspector
panel (`components/changes/Inspector.tsx`, `inspector-view.ts`, `inspector-palette.ts`).

## Page scripts
One self-contained function (`inspectPage`), serialised with its request and limits and run with
`executeJavaScriptInIsolatedWorld(INSPECTOR_WORLD_ID, …)`. Nothing the page defines reaches it; its
state lives on the isolated world's own global.
- **Token**: the first call in a document makes a random 32-hex token on that global; every answer
  carries it as `docToken`. A call passing another document's token answers `stale` and does nothing.
  `null` means "whichever document is shown", and is taken only for the first read of a document
  (`<html>`'s children from offset 0) and a pick.
- **Paths**: a node is the list of element-child indices from `document.documentElement`, at most
  `maxPathDepth` long, with the tag the caller expects there (`null` only with a `null` token).
  The inspector's own host is never a child (left out of indices and counts). No element at a path,
  or another tag there (within one document a path can come to name another element): `not-found`.
- **Children** (`children(path, token, offset)`): the node's own row and up to `maxChildren` of its
  element children from `offset`, with `more` past them. A row is the index, the lowercased
  `localName`, the `id`, the first `maxClassNames` class names, the element-child count, its own
  direct text (child text nodes only, whitespace collapsed, at most `maxTextPreviewChars`) and
  whether it hosts an open shadow root (shown, not entered). Names are cut at `maxNameChars`.
- **Details** (`node(path, token)`): the tag; the first `maxAttributes` attributes in attribute
  order (names cut at `maxAttributeNameChars`, values at `maxAttributeValueChars`, each marked
  `truncated`), `attributesMore`; `getBoundingClientRect()` and the document offset (plus the
  scroll position); the computed styles of `computedStyleProps`, in order; the landmark region (the
  rules of `changes-diff.feature.md`, Regions, as `changes/regions.ts` applies them, inlined), or
  `head` ("Not in the page body") for `<head>` and what is in it; the SEO facts (heading level; a
  link's resolved `href`, `rel` and `target`; an image's source, `null` when it has none, its `alt`
  and natural size; a meta's name or property and content; a `link[rel]`'s `rel` and resolved
  `href`, `''` when it has none: a missing URL is never reported as the page's own; the element's own
  or nearest ancestor's `lang`); and the element-child count.
- **Pick** (`pick(token)`): a transparent **cover** in the overlay's closed root
  (`pointer-events: auto`) takes the whole viewport, so no page element and no frame receives the
  pointer. The element under the pointer is found by hit-testing (`document.elementsFromPoint`, the
  overlay's host left out); a hover outline with a small tag label follows it, and the user's click
  picks it and resolves its path (an element deeper than `maxPathDepth` is answered as its ancestor
  at that depth; over a frame, the frame itself). Afterwards a **selection outline** stays on it
  until `clear` or a new pick; the cover goes.
  - Only trusted input (`event.isTrusted`) moves the outline, picks or ends a pick.
  - Every pointer, mouse and touch event, the click and the context menu are stopped in the capture
    phase on `window` (`preventDefault`, `stopPropagation`): nothing later hears them, nothing is
    focused, followed, submitted or opened (Chromium shows no context menu, the page's or frost's,
    for a cancelled `contextmenu`). Touch listeners are not passive, so a tap does not scroll or click.
  - **What the page can see** (`INSPECTOR_PICK_NOTE`): the overlay's host element (not inside its
    closed root), and those events in its own capture listeners on `window` registered before the
    picker's, with the **host** as their target, never the element under the pointer.
  - Esc (the page's, and main's: see the service), `cancelPick`, `pickTimeoutMs`, a trusted
    `pagehide` (the page's own does nothing), a new pick, `clear`, or the page removing the overlay's
    host (seen by an observer, and checked by every handler and redraw) end it with nothing (`null`).
- **Highlight** (`highlight(path, token)`): outlines one node (a tree row hovered or focused);
  `path` `null` takes that outline off. **Clear** ends any pick and takes every outline off.
- **The overlay**: one host element of the inspector's own appended to `<html>`, a closed shadow
  root, styles set through the CSSOM only (`style.setProperty`), `pointer-events: none`; outlines
  follow scrolling and resizing. The host is removed as soon as nothing is outlined; a host the page
  appends again is inert (empty, hidden, no listener). Nothing is ever written to a page element.

## Search and sources (Phase 11 Task 5, SL-047)
Spec: `INSPECTOR_SEARCH_MODES`, `INSPECTOR_SEARCH_LIMITS`, `INSPECTOR_SOURCE_KINDS`,
`INSPECTOR_SOURCE_MAX_CHARS`, `INSPECTOR_SOURCE_VIEW`, `INSPECTOR_SOURCE_NOTES`, the refusal
`invalid-selector`; `seo-javascript.spec.ts` `SERVED_SOURCE_MAX_CHARS`, `SERVED_SOURCE_KEEP`.
- **Search** (`search(token, mode, query)`, in `INSPECTOR_WORLD_ID`, read-only): `text` walks the
  document's elements in document order (the overlay's host left out) and matches an element whose
  own text (its child text nodes) holds the query, case-insensitive; `selector` hands the query to
  `querySelectorAll` (a query it throws on answers `invalid-selector`). It answers each match's path
  and tree row, at most `maxResults`; it looks at no more than `maxNodesVisited` nodes (text mode:
  `<html>` and every child node it walks, of any kind (element, text, comment), each once; selector
  mode: the selector's matches). Stopping at either cap sets `more`. A match deeper than
  `maxPathDepth` is left out (a selector match's ancestor chain is checked before its path is made). The query is data in the script's request (JSON), never code; it is
  1–`maxQueryChars` characters, not blank, with no control character.
- **Rendered source** (`source(token)`, in `INSPECTOR_WORLD_ID`, read-only): the doctype (its
  name, public and system ids), a line break, and `<html>`'s `outerHTML`; nodes outside `<html>`
  (comments before or after it) are left out. The overlay's host is left out: while it is in the
  page the top level is serialised child by child, `<html>`'s start tag written from its attributes
  with HTML attribute escaping (`&`, U+00A0, `"`), never by cloning it (a clone of a customised
  built-in would run the page's constructor); the host itself is never touched. Cut at
  `INSPECTOR_SOURCE_MAX_CHARS` without splitting a surrogate pair (`truncated`). Bounded by
  `scriptTimeoutMs` like every inspector call. Main keeps the last rendered source it answered (one,
  over all tabs) under a fresh `ref`.
- **Served source**: main never fetches for it and never decodes. The served HTML the audit fetched
  (`seo-javascript.feature.md`, Fetching) is decoded in the analysis worker with its parse, which
  answers `sourceText` (cut at `SERVED_SOURCE_MAX_CHARS`, `sourceTruncated`); main checks it and
  keeps it for the `SERVED_SOURCE_KEEP` most recent documents, each answer with a serial (`ref`). The
  service reads the tab document's generation (bumped by each new document) and URL, has the page
  confirm its token, and reads both again: the page not the panel's, or either changed meanwhile, is
  `stale`. Then it answers the tab's served state for its URL, user agent and scripting: `pending`,
  `unavailable` (the reason and HTTP status), `not-fetched` when nothing was fetched or its source is
  no longer kept, or the text and its `ref` (`truncated` when the text or the fetched bytes were cut).
- **Copy source** (`copySource(tabId, docToken, kind, ref)`): the chrome names the `ref` of the
  source it shows, never its text. Rendered: main writes the text it kept under that `ref`, if it is
  the last one it answered, for that tab and document, and the page still shows that document.
  Served: main writes the served entry that `ref` names, if it is still the tab's for its current
  document and URL (checked as above). Anything else is `stale` and nothing is written. Main keeps
  one rendered text at a time and drops it on `clear` of its tab, when its tab's WebContents is
  destroyed, and on Clear Browsing Data (whole-branch review).

## The service
`createInspectorService(deps)` (main):
- only the active tab (`not-active`), an open one (`no-tab`), showing an `http(s)` page (`no-page`);
  `clear` works on any open tab (the panel clears the one it leaves);
- every script call has a deadline (`scriptTimeoutMs`; a pick `pickTimeoutMs` more), past which the
  call is `failed` (a pick is then ended in the page too);
- every answer is checked with `inspector.schema.ts` (strict, capped); one for another path,
  offset or document than asked is refused; the page may not answer a refusal of its own;
- one pick per tab (`busy`); a main-frame navigation, the tab closing or leaving the front, Esc
  (`before-input-event`: main hears it before the page, which never gets it, nor its key-up, as
  `browser/tab-events.ts` does for fullscreen), `cancelPick` or `clear` end it (`cancelled`); the
  page gets keyboard focus while picking, so the user's Esc reaches it;
- never rejects; one log line per failure in frost's own words, never page text or a URL.

## Router
`inspector.children`, `inspector.node`, `inspector.search` and `inspector.source` (queries),
`inspector.pick`, `inspector.cancelPick`, `inspector.highlight`, `inspector.clear` and
`inspector.copySource` (mutations). Each starts `enforceSender`, then `requireInspector` (fails
closed without the service), takes a strict input (`tabId`, a path and its expected tag, the
`docToken`, an offset, a search mode and query, a source kind; never a script or page text, and a
selector only as `search`'s capped query; a `null` token or tag only for `children` of `[]` from
offset 0, and a `null` token for `pick`) and checks its answer on the way out.

## The panel
An Inspector rail item after Changes (`SEO_PANELS`, no rules, no status dot).
- A lazily read tree: `<html>` open at first; a row opens on its twisty, → or a pick, reading its
  children then; "Show more" (a tree row of its own, last in its group) reads the next
  `maxChildren`. The ARIA tree-view pattern: `tree`, `treeitem` with `aria-level`, `aria-expanded`
  and `aria-selected`, `group`; ↓/↑, Home/End, → opens or moves in, ← closes or moves up,
  Enter/Space selects (on "Show more": reads more, and focus moves to the first new row); roving
  `tabIndex`. Tree keys are taken only from a row.
- A row read again keeps what was read under it only while it is the same element's row (tag, id,
  classes, child count); otherwise it, and everything under it, start afresh.
- A row shows `<tag#id.class>` and its text preview, as inert text. Hovering or focusing it outlines
  its node on the page; leaving it, the row going away, or a read of the tree's top take the outline
  off (always sent, whatever the panel is doing).
- "Pick element" shows `INSPECTOR_PICK_HINT` with Cancel in a polite live region; a pick opens the
  tree down to the element (at most 100 pages of children in all; a new pick or read of the tree
  stops it), selects it and shows its details; "Clear outline" takes the selection outline off.
- **Details**: tag, box, document offset, region, child count; the attributes as a name/value table;
  the computed styles; the SEO facts. All inert text.
- A new document (`documentSeq`) or a new URL in the same one (`did-navigate-in-page`) reads the
  top of the tree again with the panel's token, without waiting for the page to finish loading: the
  same document answering keeps the tree and its outlines; a `stale` answer clears the tab and reads
  the tree afresh, with a note. Another tab starts afresh.
- **Views**: Tree, Rendered and Served (a toggle of pressed buttons). The Tree view has a search
  form (mode Text or CSS selector, the query, Search); its matches are a list of rows
  (`<tag#id.class>` and the text preview, inert text); choosing one opens the tree down to it and
  selects it, as a pick does. A source view reads its source for the panel's document when shown
  (and again on "Read again" or a new document), says what it is (`INSPECTOR_SOURCE_NOTES`), and
  lists it as numbered text rows (`INSPECTOR_SOURCE_VIEW`: long lines wrapped into rows, a page of
  rows rendered at a time, "Show more lines" / "Show earlier lines", never more than `maxRendered`),
  each row React text in `<bdi dir="auto">`, never markup. Find in source searches the source itself
  and marks the rows a match covers (a match across a wrapped row's boundary marks each row it
  covers; council round 1, `find-across-row-boundary`), and moves between them (Enter, Previous,
  Next); a match outside the rendered rows renders the
  page of rows around it instead. Copy source asks main with the view's `ref`; a `stale` answer reads
  the source again and says so. A source view reads again on a new URL in the same document (an
  in-page move). The served view says when the served HTML is still being fetched (it reads again
  every second, a few times) or why there is none (`SERVED_UNAVAILABLE_MESSAGES`).
- **Command palette** (`inspector-palette.ts`): "Open Inspector" (its own jump, in
  `FEATURE_PANEL_JUMPS`) and "Pick an element" (on a web page; opens the panel and picks, for
  whichever document is shown: a `null` token).

## Known limits
- Shadow DOM: an open shadow root is marked, not entered; a closed one is invisible. A click inside a
  shadow tree picks its host.
- Frames: the tree and the picker cover the top document only; an iframe is a leaf, and a pick over
  one picks the frame.
- The page can see the overlay's host element, and the pick's events, targeted at that host, in
  capture listeners it registered on `window` before the picker's.

## Scenarios
### Page scripts (`apps/desktop/src/main/inspector/__tests__/page-script.test.ts`)
- `inspector-paths-resolve`: the token is made once per document; children of `<html>`, `<body>`
  and `<main>` resolve by path with their rows (direct text only, classes, open shadow marked); a
  path naming nothing, or another tag than expected, is `not-found`.
- `inspector-answers-are-capped`: children page at `maxChildren` with `more` and `offset`; classes,
  text previews, attribute counts, names and values are capped; a path past `maxPathDepth` names nothing.
- `inspector-stale-token`: another document's token answers `stale` for children, node, highlight and pick.
- `inspector-node-details`: an H1's tag, attributes, styles, region and SEO facts; a link's, an
  image's, a meta's, a `link[rel]`'s; `lang` inherited; `<head>`'s region; a missing `src` / `href`
  reported missing.
- `inspector-region-agrees-with-regions`: on the landmark fixtures, every heading and link has the
  region `changes/regions.ts` gives it.
- `inspector-pick-needs-trusted-click`: the page's synthetic click, pointer move and Esc do nothing
  (and are left alone); the user's pointer moves the outline and the user's click picks, with nothing
  after the picker hearing it; the selection outline stays until `clear`; the DOM is as it was.
- `inspector-pick-hit-tests-under-the-cover`: the element under the cover is found by hit-testing
  (a frame picks the frame); a right-click and a touch are cancelled and keep the pick going; no page
  listener hears any of it; the cover is down afterwards.
- `inspector-pick-ends-without-picking`: Esc, `cancelPick`, the timeout, a trusted `pagehide` (not
  the page's own), a second pick and the host's removal (also a click before any observer ran) each
  end it with nothing; a host the page appends again is inert.
- `inspector-outline-lifecycle`: a highlight adds the host (left out of paths and counts); `null`
  removes it once nothing is outlined.
- `inspector-leaves-dom-unchanged`: after reading, outlining, picking and clearing, `outerHTML` is
  as it was and no element has a `style` attribute.
- `inspector-scripts-are-self-contained`: every script compiles and runs in a fresh context; it
  runs in `INSPECTOR_WORLD_ID`.

- `search-text-finds-paths`: text search finds elements by their own text, case-insensitive, in
  document order, with paths that resolve and rows; the overlay's host is never a match.
- `search-selector-invalid-refused`: a selector search answers matching paths; a query
  `querySelectorAll` throws on answers `invalid-selector`.
- `search-capped`: at most `maxResults` matches (`more`), and at most `maxNodesVisited` nodes
  looked at, comments and empty elements included (`more`); a selector match deeper than
  `maxPathDepth` is left out; a stale token is `stale`.
- `serialize-capped-and-truncated-flag`: the rendered source is the doctype, a line break and
  `<html>`'s `outerHTML`, the overlay's host left out (`<html>`'s start tag from its attributes,
  escaped, and no node cloned); past the cap it is cut (`truncated`), never splitting a surrogate
  pair; the answer validates.
- `scripts-never-write-dom`: after searches (both modes, an invalid selector included) and source
  reads, with and without an outline showing, `outerHTML` is as it was and no element has a `style`.

### Service (`apps/desktop/src/main/inspector/__tests__/service.test.ts`)
- `inspector-service-refusals`: `no-tab`, `not-active`, `no-page`; `clear` on another open tab.
- `inspector-service-deadlines`: a page that never answers is `failed` after the deadline (the pick
  ended in the page too); a rejecting script is `failed`; no page text in the log.
- `inspector-service-validates-answers`: garbage, over-long, extra-key, wrong-path, wrong-offset,
  wrong-document and self-refusing answers are refused.
- `inspector-one-pick-per-tab`: a second pick is `busy`; `cancelPick`; picked answers are checked.
- `inspector-pick-cancel-paths`: navigation, closing, tab switch, `clear` and main's Esc cancel (its
  key-up kept from the page once); a subframe navigation or another key does not.
- `inspector-tabs-follow-the-browser`.
- `search-stale-doc-refused`: a search or rendered-source answer for another document is `stale`;
  `invalid-selector` passes through for a search only; answers are checked (over-long, extra keys).
- `served-source-unavailable-reason`: the served source is `stale` for another document, or when the
  tab's document generation or URL changed while the page was asked; then `pending`, `unavailable`
  with the reason and status, `not-fetched` without a source, or the text and its `ref`.
- `copy-source-from-main`: Copy source writes the rendered text main kept under the `ref` (not a
  newer reading of the page), or the served entry the `ref` names; another `ref`, document, tab,
  generation or URL, or a served source no longer ready is `stale` and writes nothing.
- `rendered-source-dropped-on-clear-close-and-clear-browsing-data`: the kept rendered text goes on
  `clear` of its tab (not another's), when its WebContents is destroyed (the listener goes too), and
  on Clear Browsing Data (`forget`).

### Router (`packages/ipc-contract/src/__tests__/inspector-router.test.ts`)
- `every-inspector-procedure-enforces-sender` (the new `search`, `source` and `copySource` too),
  `inspector-inputs-are-validated`, `inspector-procedures-call-service`.

### Panel helpers (`apps/desktop/src/renderer/__tests__/inspector-view.test.ts`)
- `inspector-row-labels`, `inspector-tree-model`, `inspector-tree-keys`, `inspector-details-text`,
  `inspector-palette-actions`, `source-lines-are-text` (a source's rows are plain strings, numbered
  and wrapped, capped, found case-insensitively; the line list renders markup as text, only its
  window), `source-window-bounded` (the first window, a far match's window, and showing more lines
  after or before never render more than `maxRendered` rows).

### End to end (`apps/desktop/e2e/inspector.e2e.ts`, a loopback page)
- `inspector-tree-expands-to-h1`: the keyboard opens `<html>` → `<body>` → `<main>` and selects the H1.
- `inspector-pick-by-mouse`: the trusted mouse on the tab's page picks the H1; its details show
  heading level H1 and the Main content region.
- `inspector-pick-covers-frames-and-menus`: a right-click while picking opens neither the page's
  nor frost's menu; a click over the frame picks the frame, and its link is not followed; afterwards
  the page's right-click is its own again.
- `inspector-ignores-synthetic-click`: the page's own click picks nothing; Esc then cancels.
- `inspector-leaves-page-dom-unchanged`: after a pick and Clear outline, the page's `outerHTML` is as
  it was.
- `inspector-stale-after-navigation`: after the tab moves to another page, the tree is read again
  from the top with the note, and shows the new page.
- `inspector-search-selects-node`: a CSS-selector search lists the H1; choosing it opens the tree to it
  and shows its details; a text search finds the link; an invalid selector says so.
- `rendered-and-served-source`: the Rendered view lists the page's markup as text (the doctype, a
  script's source as text, the H1 after the page's script changed it); the Served view lists the HTML
  as served (the H1 as the server sent it); find marks a row; Copy source writes main's text.
