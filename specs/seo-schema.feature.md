# Feature: structured data (Schema panel)

Spec: `specs/schema-types.spec.ts` (syntaxes, `SCHEMA_PARSE_LIMITS`, `SCHEMA_DROPPED_KEYS`,
`SCHEMA_ORG_HOSTS`, the common types and their parents, `SCHEMA_TYPE_RULES`, the URL, date and
duration property sets, `SCHEMA_SINGLETON_TYPES`), `specs/seo-limits.spec.ts` (the JSON-LD and markup
caps in `SNAPSHOT_LIMITS`), `specs/seo-snapshot.spec.ts` (`JsonLdBlockSchema`, `MarkupItemSchema`,
`SeoCopySchemaInputSchema`), `specs/seo-rules.spec.ts` (the `schema` rules) and
`specs/seo-sidebar.spec.ts` (the Schema panel). Phase 2 Task 3. Each line maps to one named test.

## Decisions
- **The page only hands over text.** The extractor (isolated world, the same deadline and caps as
  the rest of the snapshot) reads each JSON-LD block's text with bounded `substringData` reads, never
  `textContent` of a huge block, and never parses it. Microdata and RDFa Lite come as flat item
  lists (a nested item is a property holding a later index), so the snapshot's Zod schema can check
  them without recursion: indices point forward and each item is held once, so the items form a
  forest (no cycle, no shared subtree to blow up).
- **Parsing happens in main, in `@app/seo-core`** (`analyseSchema`, pure, memoised per snapshot so
  the rules and the audit share one pass): `JSON.parse` in `try`/`catch` on a block kept whole; on a
  failure frost's own scanner finds the first error's offset (its line and column) and says what was
  expected there. The parsed value is then read with explicit bounds (`SCHEMA_PARSE_LIMITS`: depth,
  values, entities, text length). Page keys never index a plain object: properties are lists of
  `{ name, values }`, `@id`s go in a `Map`, and `__proto__`, `constructor` and `prototype` keys are
  dropped and counted (`SCHEMA_DROPPED_KEYS`). A block cut by the extractor is not parsed at all.
- **One tree for three syntaxes.** Every node becomes an entity: its types (schema.org IRIs and the
  `schema:` prefix shortened to the term), `@id`, properties (names shortened the same way) whose
  values are text, a nested entity, or a reference; its syntax and block. JSON-LD `@graph`, top-level
  arrays, `@list` / `@set`, `@value` objects and `@type` as a string or an array are read; other `@`
  keywords are skipped; context-defined term aliases are not expanded.
- **`@id` references stay references.** An object holding only `@id` is a reference to the entity
  with that `@id` on the page (any syntax, the first one). It is never copied into the tree, so a
  cycle (`a → b → a`) cannot loop, and since a reference is never an entity, references never chain:
  a check looks through one in one step. The panel opens a reference's target in place unless it is
  already open above it. Required properties count the properties of every entity sharing the
  node's `@id` (a `@graph` often splits one node).
- **Issues belong to nodes.** Each check produces issues tied to an entity (or a block); a rule fails
  when it has any, its finding counting them with their messages as samples. The Schema panel shows
  each issue on its node.
- **Copy JSON goes through main.** `seo.copySchemaJson({ tabId, audit, block })` (`enforceSender`
  first, Zod input) writes block `block` of the tab's ready audit, if that is the audit the panel
  shows: pretty-printed by `formatJson` when it parsed, its text as kept otherwise. The chrome never
  hands main any text to copy.
- **Page text stays inert.** Values, types, names and raw JSON are React text in `<bdi>` / `<pre>`,
  never markup; URL values are text with an "Open in new tab" button (`browser.openBackgroundTab`,
  `http(s)` only, disabled otherwise). The panel draws its own icons (inline SVG), adds no `style=`
  props and loads nothing.

## Extraction (`extract-dom.test.ts`, jsdom)
- **Scenario: extractor-reads-json-ld-text** — each `script[type="application/ld+json" i]` block's
  text as written (whitespace kept), in order; other script types are skipped.
- **Scenario: extractor-caps-json-ld** — a block over `maxJsonLdChars` is cut with its full length;
  once `maxJsonLdTotalChars` are used, later blocks are empty with their length; past
  `maxJsonLdBlocks` blocks are counted only; the snapshot still parses.
- **Scenario: extractor-reads-microdata** — an item's types, `itemid` and properties; values from
  `content`, `href` / `src` (resolved), `datetime`, `value` and the text; a nested `itemscope` with
  `itemprop` is a property holding the nested item's index; an `itemprop` outside any item is
  dropped.
- **Scenario: extractor-reads-rdfa** — `typeof`, `vocab` (inherited), `resource` / `about`,
  `property` values from `content`, `href` and the text; a nested `typeof` with `property` is held
  by its parent.
- **Scenario: extractor-bounds-markup** — items past `maxMarkupItems`, properties past
  `maxItemProperties` and items deeper than `maxMarkupDepth` are dropped (totals still count them),
  and so is a nested item whose holder has no room left (never turned into a top-level item); long
  values are cut; past `maxMarkupElements` nothing more is looked at; the snapshot parses.

## Snapshot schema (`snapshot.test.ts`)
- **Scenario: snapshot-validates-structured-data** — blocks, items and properties at their caps
  parse, one over is rejected; a block whose length is below its text, JSON-LD over the total cap,
  a property with both or neither of `value` / `item`, an `item` pointing back, past the list or
  held twice, and a total below its list are rejected.

## Parsing (`packages/seo-core/src/__tests__/schema-parse.test.ts`)
- **Scenario: json-error-location** — a trailing comma, a missing comma, an unterminated string, a
  bad token, an empty block and a truncated document each report the offset, line and column of the
  first error; valid JSON reports none.
- **Scenario: json-ld-malformed-is-reported** — a malformed block is `invalid` with its error, the
  page's other blocks still read.
- **Scenario: json-ld-huge-nesting-is-bounded** — 10 000 nested arrays and objects parse and read
  only `maxDepth` levels (`over-limit`), with no stack overflow.
- **Scenario: json-ld-proto-keys-are-dropped** — `__proto__`, `constructor` and `prototype` keys
  (top level and nested) are dropped and counted; `Object.prototype` is untouched and no entity has
  those properties.
- **Scenario: json-ld-graph-and-arrays** — `@graph` members and top-level array entries are
  top-level entities; `@type` arrays, nested objects, `@list` / `@value` objects and compact or full
  schema.org IRIs are read.
- **Scenario: json-ld-cyclic-ids-terminate** — `a → b → a` and a self-reference resolve as
  references (each to its target's key) without looping; a reference to an unknown `@id` has no
  target.
- **Scenario: json-ld-node-limit** — more than `maxNodes` values stop being read (`over-limit`).
- **Scenario: markup-normalises-to-entities** — microdata and RDFa items become entities of their
  syntax, nested items as nested entities, types and names shortened.
- **Scenario: format-json-is-bounded** — `formatJson` indents two spaces per level up to
  `maxPrettyIndent`, keeps strings (escapes, braces inside) as written, and stops at
  `maxPrettyChars`.

## Rules (`packages/seo-core/src/__tests__/schema-rules.test.ts`, a passing and a failing fixture each)
- **Scenario: schema-none** — fails with no block and no item; passes with any one.
- **Scenario: schema-json-invalid** — fails for a malformed or empty block (facts: block, line and
  column); passes for valid JSON; not reported for a cut block.
- **Scenario: schema-over-limit** — fails for a cut block, nesting past `maxDepth` and too many
  values; passes for an ordinary page.
- **Scenario: schema-context-missing** — fails for a JSON-LD node without `@context` (its own or
  its block's) and an RDFa bare type without `vocab`; passes for `@graph` members under the block's
  context and microdata.
- **Scenario: schema-context-not-schema-org** — fails for another vocabulary in `@context`, a
  microdata `itemtype` or an RDFa `vocab`; passes for http / https / www. / trailing-slash /
  `/docs/jsonldcontext.json` / array / `@vocab` forms.
- **Scenario: schema-type-missing** — fails for an untyped top-level node; passes for typed nodes,
  untyped nested objects, `@id`-only references, and an untyped node adding properties to a typed
  node with the same `@id` (it `extends` it; the panel shows it as such and counts it once).
- **Scenario: schema-type-unknown** — fails for `product` and `Organisation`; passes for common
  types, known subtypes and non-schema.org IRIs.
- **Scenario: schema-required-missing** — fails for each checked type missing a required property
  (Product without offers, review or aggregateRating; a subtype like `Restaurant`); passes when an
  alternative is present, through `item.name`, and through another node with the same `@id`.
- **Scenario: schema-recommended-missing** — fails for a top-level node missing a recommended
  property; passes for a nested node.
- **Scenario: schema-url-not-absolute** — fails for relative, protocol-relative, `javascript:` and
  `data:` values; passes for absolute `http(s)` and for node values.
- **Scenario: schema-date-invalid** — fails for "May 1, 2024", `2024-13-01`, `2024-02-30`, a space
  before the time and `90 minutes`; passes for dates, date-times with zones and durations.
- **Scenario: schema-breadcrumb-positions** — fails for a gap, a repeat, a missing or non-integer
  position; passes for 1…n in any listed order, numeric strings and items given by reference.
- **Scenario: schema-price-invalid** — fails for "$19.99", "1,299", a missing price or currency;
  passes for numbers, numeric strings, a priceSpecification and an AggregateOffer's lowPrice.
- **Scenario: schema-entity-conflict** — fails for two Organizations with different names; passes
  for one, for two sharing an `@id`, and when only one has the value.
- **Scenario: schema-issues-belong-to-nodes** — every issue names its entity or block, and a
  finding's count is its issues'.

## Controller and router
- **Scenario: copy-schema-json** (`panels.test.ts`) — with the shown audit, a valid block is written
  pretty-printed, an invalid one as kept; another audit, a missing block, no ready audit or another
  tab writes nothing (`false`).
- `seo-router.test.ts` covers `seo.copySchemaJson` in `seo-procedures-reject-foreign-sender-first`,
  `seo-procedures-validate-input` (a negative, fractional or too-large block, a missing audit, extra
  keys are `BAD_REQUEST`), `seo-procedures-call-service` and `missing-seo-service-is-internal-error`.

## Renderer helpers (`seo-view.test.ts`)
- **Scenario: rail-statuses** — the Schema dot comes from the `schema` category; schema findings
  colour Overview and Schema, not On-Page.
- **Scenario: schema-type-summary** — top-level entities counted by type, most first, untyped ones
  as "Untyped".
- **Scenario: schema-error-excerpt** — the raw text split around the error offset (before, the
  character at it, after), clamped to the text, never half a surrogate pair.
- **Scenario: schema-entity-index** — every entity of the tree by key, nested ones too (a reference
  is not followed).

## Panel (renderer)
- The rail's Schema item is a panel like the others, with its status dot.
- Header: the panel's dot and verdict, entities by type, the counts by syntax and the panel's error,
  warning and notice counts; then the ranked `schema` issues.
- One card per JSON-LD block (its status: valid, invalid JSON, too large), then one per syntax for
  microdata and RDFa. A block card has Tree / Raw toggles and "Copy JSON". Raw shows the
  pretty-printed JSON as text; for an invalid block, the text as written with the error's line and
  column and the character at the error marked.
- The tree: each entity a row with its type badges, its name, its issue count; top-level entities
  start open. An open entity shows its issues (severity, title, detail) and its properties: names,
  text values (clamped, full value in the tooltip), URLs with "Open in new tab", nested entities
  indented (closed), references with their target's type (opening one shows the target, unless it
  is already open above it: "Shown above").

## End to end (`apps/desktop/e2e/seo-schema.e2e.ts`, loopback pages)
- **Scenario: schema-valid-page-shows-clean-tree** — Organization, BreadcrumbList and Product
  JSON-LD give no schema issue, a passing dot, the three types in the header, the entities and
  their values in the tree (the breadcrumb's three items, the product's offer); Raw shows the
  pretty-printed JSON, and Copy JSON puts exactly that on the system clipboard (read in main).
- **Scenario: schema-syntax-error-shows-location** — a block with a missing comma shows
  `schema-json-invalid` with its line and column, the rail's Schema dot `error`, and its raw view
  marks the character at the error; Copy JSON copies the text as written.
- **Scenario: schema-microdata-product-tree** — a microdata Product with a nested Offer, Brand and
  AggregateRating shows as a microdata tree with those values (the price from `content`, the URL
  resolved).
- **Scenario: schema-hostile-page-is-bounded** — a 5 MB JSON-LD block, 10 000 nested levels, a
  `__proto__` / `constructor` payload and 10 000 nested microdata items give a ready audit within
  `EXTRACT_TIMEOUT_MS`: the cut block and the deep one are `schema-over-limit`, the payload block's
  entity has no `__proto__` property, `Object.prototype` is clean in main and in the chrome, and the
  chrome stays responsive (a new tab opens and closes).
- **Scenario: schema-values-are-inert** — `<script>`, `<img onerror>`, a bidi override and
  `javascript:` in JSON-LD values, types and names render as literal text, with every entity open
  and the raw view shown; the sidebar gains no `img`, `script`, `a`, `iframe` or `[style]`; the
  `javascript:` URL cannot be opened; nothing ran in the chrome.
