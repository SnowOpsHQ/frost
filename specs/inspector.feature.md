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
`inspector.children` and `inspector.node` (queries), `inspector.pick`, `inspector.cancelPick`,
`inspector.highlight` and `inspector.clear` (mutations). Each starts `enforceSender`, then
`requireInspector` (fails closed without the service), takes a strict input (`tabId`, a path and its
expected tag, the `docToken`, an offset; never a selector, a script or page text; a `null` token or
tag only for `children` of `[]` from offset 0, and a `null` token for `pick`) and checks its answer
on the way out.

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

### Router (`packages/ipc-contract/src/__tests__/inspector-router.test.ts`)
- `every-inspector-procedure-enforces-sender`, `inspector-inputs-are-validated`,
  `inspector-procedures-call-service`.

### Panel helpers (`apps/desktop/src/renderer/__tests__/inspector-view.test.ts`)
- `inspector-row-labels`, `inspector-tree-model`, `inspector-tree-keys`, `inspector-details-text`,
  `inspector-palette-actions`.

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
