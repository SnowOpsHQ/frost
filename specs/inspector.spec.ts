/**
 * The DOM inspector (Phase 6 Task 8; acceptance `inspector.feature.md`). Plain values and types with
 * no Zod, so the chrome renderer can use them; the Zod schemas of the procedures' inputs and answers
 * are `inspector.schema.ts` (main and the IPC contract), each `satisfies` a type here.
 *
 * The inspector reads the active tab's DOM, one node at a time, from scripts that run only in
 * `INSPECTOR_WORLD_ID`. A node is named by its **path**: the child-element indices that lead to it
 * from `document.documentElement` (`[]` is `<html>` itself, `[1]` its second element child, …).
 * Every answer carries the document's `docToken`, a random token the inspector's isolated world keeps
 * on its own global (a new document has a new world, so a new token); each call passes the token it
 * was given back, and a call made for an older document is refused as `stale`.
 *
 * Read-only: the scripts never change a page element's attributes, styles or text. The hover
 * outline, the selection outline and a tree row's outline are drawn in a **closed** shadow root on one
 * host element of the inspector's own, appended to `<html>` while something is outlined and removed
 * once nothing is.
 *
 * Honesty note (`INSPECTOR_PICK_NOTE`): while an element is being picked, a transparent catcher in
 * the overlay's closed root covers the viewport, and the element under the pointer is found by
 * hit-testing (`elementsFromPoint`, the overlay's host left out). So no page element, and no frame,
 * receives the pointer, touch, click or context-menu events: nothing is hovered, followed, submitted
 * or opened. What the page can still see: the overlay's host element, and those events in its own
 * capture listeners on `window` registered before the picker's, with the **host** as their target
 * (never the element under the pointer); frost stops them there. The page cannot pick for the user:
 * only trusted input (`event.isTrusted`) picks or ends a pick, and main hears Esc first (its key-up
 * too).
 *
 * Search and sources (Phase 11 Task 5, SL-047): `inspector.search` finds elements by their own text
 * or a CSS selector, in `INSPECTOR_WORLD_ID`, and answers their paths (bounded by
 * `INSPECTOR_SEARCH_LIMITS`); `inspector.source` answers the **rendered** source (the document's
 * doctype and `<html>`'s `outerHTML`, serialised in that world, the inspector's own overlay host left
 * out) or the **served** source (the HTML as the server sent it to the audit's cookieless fetch,
 * decoded in the analysis worker, never in main), each capped at `INSPECTOR_SOURCE_MAX_CHARS`.
 * `inspector.copySource` has main write, with the clipboard main holds, the source it answered under
 * the `ref` the chrome names (rendered: the text main kept from that read; served: the served entry
 * that `ref` names, still the tab's for its current document and URL): the chrome never sends the text. The chrome shows a source as inert text lines (React text, never
 * markup), a page of rows at a time (`INSPECTOR_SOURCE_VIEW`).
 */
import { PAGE_REGIONS } from './capture.spec';
import type { ServedUnavailableReason } from './seo-javascript.spec';

/**
 * The isolated world the inspector's scripts run in (its token, children, node details, the picker,
 * the outlines). Phase 6 owns `1_600`–`1_602`; no other script uses this one.
 */
export const INSPECTOR_WORLD_ID = 1_602;

/** The bounds of every inspector answer and wait. */
export const INSPECTOR_LIMITS = {
  /** Most children one `inspector.children` answers, from its `offset`; past them `more` is true ("Show more" asks again). */
  maxChildren: 200,
  /** Longest path (levels below `<html>`); a picked element deeper than this is answered as its ancestor at this depth. */
  maxPathDepth: 256,
  /** Most attributes a node's details list, in attribute order; past them `attributesMore` is true. */
  maxAttributes: 50,
  /** Longest attribute name kept (characters); a longer one is cut. */
  maxAttributeNameChars: 100,
  /** Longest attribute value kept (characters); a longer one is cut (`truncated` on that attribute). */
  maxAttributeValueChars: 1_000,
  /** Longest text preview of a node (its own direct text, whitespace collapsed, characters). */
  maxTextPreviewChars: 200,
  /** Most class names a tree row shows; past them the list is cut. */
  maxClassNames: 20,
  /** Longest a pick waits for the user's click (ms); past it the pick ends with nothing picked. */
  pickTimeoutMs: 60_000,
  /** Longest main waits for any one inspector script to answer (ms); past it the call is refused (`failed`). */
  scriptTimeoutMs: 2_000,
  /** Longest tag name, id or class name kept (characters). */
  maxNameChars: 100,
  /** Longest URL kept in a node's SEO facts (characters). */
  maxUrlChars: 2_048,
  /** Longest computed style value or SEO text value kept (characters). */
  maxValueChars: 300,
  /** The computed styles a node's details show, in this order. */
  computedStyleProps: ['display', 'visibility', 'position', 'font-size', 'font-weight', 'color', 'background-color', 'width', 'height'],
} as const;

/** `INSPECTOR_LIMITS`' shape with any values (tests use tighter ones). */
export type InspectorLimits = { readonly [K in Exclude<keyof typeof INSPECTOR_LIMITS, 'computedStyleProps'>]: number } & { readonly computedStyleProps: readonly string[] };

/** A computed style the details show (`INSPECTOR_LIMITS.computedStyleProps`). */
export type InspectorStyleProp = (typeof INSPECTOR_LIMITS.computedStyleProps)[number];

/** How `inspector.search` matches: an element's own text (its child text nodes, case-insensitive), or a CSS selector (`querySelectorAll`). */
export const INSPECTOR_SEARCH_MODES = ['text', 'selector'] as const;
export type InspectorSearchMode = (typeof INSPECTOR_SEARCH_MODES)[number];

/**
 * The bounds of one search: the longest query (characters), the most matches answered (in document
 * order; past them `more` is true), and the most nodes (elements and text nodes; for a selector, the
 * selector's matches) looked at before the search stops (`more` true too).
 */
export const INSPECTOR_SEARCH_LIMITS = { maxQueryChars: 200, maxResults: 200, maxNodesVisited: 50_000 } as const;

/** Which source `inspector.source` reads: the page as it is now (`rendered`) or as the server sent it (`served`). */
export const INSPECTOR_SOURCE_KINDS = ['rendered', 'served'] as const;
export type InspectorSourceKind = (typeof INSPECTOR_SOURCE_KINDS)[number];

/** The most characters (UTF-16 code units) of a source answered; past them it is cut (`truncated`). */
export const INSPECTOR_SOURCE_MAX_CHARS = 2_000_000;

/**
 * How the panel shows a source (renderer only): split into lines, each long line wrapped into rows of
 * at most `rowChars` characters (the first row of a line carries its number), at most `maxRows` rows
 * (past them the view says so; Copy source still copies all of it). Only a window of rows is rendered:
 * `pageRows` at first, "Show more lines" / "Show earlier lines" add `pageRows` after or before it, never
 * more than `maxRendered` rows at once (the far end is dropped); moving to a find match outside the
 * window renders the `pageRows` rows around it instead. Find-in-view lists at most `maxFindMatches`
 * rows whose text holds the query (case-insensitive, within one row).
 */
export const INSPECTOR_SOURCE_VIEW = { rowChars: 500, maxRows: 100_000, pageRows: 500, maxRendered: 1_000, maxFindChars: 200, maxFindMatches: 10_000 } as const;

/** A document's token: 32 lowercase hex characters, made in the inspector's world. */
export const DOC_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Why an inspector call answered nothing:
 * - `no-tab`: the id names no open tab;
 * - `not-active`: only the tab in front is inspected;
 * - `no-page`: the tab shows no web page (`http(s)`);
 * - `stale`: the call was for a document the tab no longer shows (its token differs);
 * - `not-found`: no element is at that path any more (the page changed);
 * - `busy`: an element of this tab is already being picked;
 * - `cancelled`: the pick ended with nothing picked (Esc, Cancel, the timeout, the page moving on, the
 *   tab closing or leaving the front, the outline's host removed by the page);
 * - `failed`: the page did not answer in time, or answered something that is not an answer;
 * - `invalid-selector`: a selector search's query is not a selector the page's browser understands.
 */
export const INSPECTOR_REFUSALS = ['no-tab', 'not-active', 'no-page', 'stale', 'not-found', 'busy', 'cancelled', 'failed', 'invalid-selector'] as const;
export type InspectorRefusal = (typeof INSPECTOR_REFUSALS)[number];

/** How the Inspector panel explains a refusal (frost's own wording). */
export const INSPECTOR_REFUSAL_MESSAGES: Readonly<Record<InspectorRefusal, string>> = {
  'no-tab': 'That tab is no longer open.',
  'not-active': 'Only the tab in front can be inspected.',
  'no-page': 'Open a web page to inspect its elements.',
  stale: 'The page changed, so the tree was read again from the top.',
  'not-found': 'That element is no longer on the page.',
  busy: 'An element is already being picked on this page.',
  cancelled: 'Pick cancelled.',
  failed: 'The page did not answer. Reload it and try again.',
  'invalid-selector': 'That is not a CSS selector this page understands.',
};

/** Shown in the panel while an element is being picked. */
export const INSPECTOR_PICK_HINT = 'Click an element on the page · Esc to cancel';

/** Said beside Pick element: what the page itself can observe while picking. */
export const INSPECTOR_PICK_NOTE = 'While picking, frost covers the page: no element or frame under the pointer gets your clicks. The page can see that a cover is there, and its earliest listeners see the events on the cover, not on the element.';

/** The Inspector panel's words. */
export const INSPECTOR_LABELS = {
  panel: 'Inspector',
  tree: 'Page elements',
  pick: 'Pick element',
  cancelPick: 'Cancel',
  showMore: 'Show more',
  clear: 'Clear outline',
  details: 'Details',
  attributes: 'Attributes',
  box: 'Box',
  styles: 'Computed styles',
  region: 'Region',
  seo: 'SEO facts',
  empty: 'Select an element in the tree, or pick one on the page.',
  noAttributes: 'No attributes',
  loading: 'Reading the page…',
  shadow: 'shadow root (not entered)',
  views: 'Inspector view',
  viewTree: 'Tree',
  viewRendered: 'Rendered',
  viewServed: 'Served',
  search: 'Search elements',
  searchQuery: 'Text or selector to find',
  searchModeText: 'Text',
  searchModeSelector: 'CSS selector',
  searchRun: 'Search',
  searchResults: 'Matching elements',
  searchNone: 'No element matches.',
  searchMore: 'Only the first matches are listed. Narrow the search to see the rest.',
  copySource: 'Copy source',
  sourceCopied: 'Source copied.',
  readSource: 'Read again',
  findInSource: 'Find in source',
  findPrevious: 'Previous match',
  findNext: 'Next match',
  findNone: 'Not in this source.',
  showMoreLines: 'Show more lines',
  showEarlierLines: 'Show earlier lines',
  sourceLines: 'Source lines',
  sourceTruncated: 'The source is longer than frost keeps, so only its first part is shown and copied.',
  sourceRowsCut: 'The source has more lines than the panel lists. Copy source copies all of what frost kept.',
  servedPending: 'frost is still fetching the served HTML for this page.',
  sourceChanged: 'The page changed since this source was read, so it was read again. Copy it again if it is still what you want.',
} as const;

/** What each source view is (frost's own wording), shown above its lines. */
export const INSPECTOR_SOURCE_NOTES: Readonly<Record<InspectorSourceKind, string>> = {
  rendered: 'The page as it is now, after its scripts ran, serialised by the browser.',
  served: 'The HTML the server sent to frost’s own fetch (no cookies), before any script ran.',
};

/**
 * A node's region: its landmark region (the rules of `changes-diff.feature.md`, Regions), or `head`
 * for `<head>` and everything in it (not in the page body, so in no landmark).
 */
export const INSPECTOR_REGIONS = [...PAGE_REGIONS, 'head'] as const;
export type InspectorRegion = (typeof INSPECTOR_REGIONS)[number];

/** How a node's region is named in its details. */
export const INSPECTOR_REGION_LABELS: Readonly<Record<InspectorRegion, string>> = {
  main: 'Main content',
  nav: 'Navigation',
  header: 'Header',
  aside: 'Aside',
  footer: 'Footer',
  other: 'Outside the landmarks',
  head: 'Not in the page body',
};

// ---- Inputs ------------------------------------------------------------------------------------

/** A node's path: element-child indices from `document.documentElement` (at most `maxPathDepth`). */
export type NodePath = number[];

/**
 * `inspector.children`: the node at `path` (whose tag must be `tag`: another element there is
 * `not-found`) and up to `maxChildren` of its children from `offset`. `docToken` and `tag` may be
 * `null` only for the first read of a document: `<html>`'s children from offset 0.
 */
export interface InspectorChildrenInput {
  tabId: number;
  path: NodePath;
  tag: string | null;
  docToken: string | null;
  offset: number;
}

/** `inspector.node`: the details of the node at `path` (whose tag must be `tag`). */
export interface InspectorNodeInput {
  tabId: number;
  path: NodePath;
  tag: string;
  docToken: string;
}

/** `inspector.pick`: pick an element on the tab's page with the mouse (`docToken` `null`: whichever document is shown). */
export interface InspectorPickInput {
  tabId: number;
  docToken: string | null;
}

/** `inspector.highlight`: outline the node `{ path, tag }` on the page (`null`: hide that outline). */
export interface InspectorHighlightInput {
  tabId: number;
  node: { path: NodePath; tag: string } | null;
  docToken: string;
}

/** `inspector.search`: elements of the tab's document matching `query` (`mode`: own text, or a CSS selector). */
export interface InspectorSearchInput {
  tabId: number;
  docToken: string;
  mode: InspectorSearchMode;
  query: string;
}

/** `inspector.source`: the tab's `kind` source, for the document `docToken`. */
export interface InspectorSourceInput {
  tabId: number;
  docToken: string;
  kind: InspectorSourceKind;
}
/**
 * `inspector.copySource`: the source the panel shows, named by the `ref` its `inspector.source`
 * answer carried (never its text). Main copies only the text it answered under that `ref`, for that
 * document; anything else is `stale`.
 */
export interface InspectorCopySourceInput extends InspectorSourceInput {
  ref: number;
}

/** `inspector.cancelPick` and `inspector.clear`: the tab. */
export interface InspectorTabInput {
  tabId: number;
}

// ---- Answers -----------------------------------------------------------------------------------

export type InspectorRefused = { status: 'refused'; reason: InspectorRefusal };

/** A tree row: one element, as its parent's child. */
export interface InspectorChild {
  /** Its index among its parent's element children (the last step of its path; `0` for `<html>`). */
  index: number;
  /** `localName`, lowercased and capped. */
  tag: string;
  /** Its `id` (`''` if none), capped. */
  id: string;
  /** Its first `maxClassNames` class names, each capped. */
  classes: string[];
  /** How many element children it has. */
  childElementCount: number;
  /** Its own direct text (its child text nodes only), whitespace collapsed, capped. */
  textPreview: string;
  /** Whether it hosts an open shadow root (shown, not entered). */
  shadow: boolean;
}

export type InspectorChildrenAnswer = { status: 'ok'; docToken: string; path: NodePath; node: InspectorChild; offset: number; children: InspectorChild[]; more: boolean } | InspectorRefused;

/** A CSS px rectangle. */
export interface InspectorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The SEO facts of an element (each `null` where it does not apply). */
export interface InspectorSeoFacts {
  /** `h1`–`h6`: its level. */
  headingLevel: number | null;
  /** `a[href]` / `area[href]`: the resolved URL, `rel` and `target`. */
  link: { href: string; rel: string; target: string } | null;
  /** `img`: its current source (resolved; `null`: none), its `alt` (`null`: no attribute) and its natural size. */
  image: { src: string | null; alt: string | null; naturalWidth: number; naturalHeight: number } | null;
  /** `meta[name]` / `meta[property]`: the name and content. */
  meta: { name: string; content: string } | null;
  /** `link[rel]`: the `rel` and the resolved `href` (`''`: no `href`). */
  linkRel: { rel: string; href: string } | null;
  /** The element's language: its own or its nearest ancestor's `lang` (`null`: none set). */
  lang: string | null;
}

/** A node's details. */
export interface InspectorNode {
  tag: string;
  /** Its attributes, name and value, in attribute order (the first `maxAttributes`). */
  attributes: { name: string; value: string; truncated: boolean }[];
  /** Whether it has more attributes than are listed. */
  attributesMore: boolean;
  /** `getBoundingClientRect()`, in the viewport (CSS px). */
  box: InspectorBox;
  /** Its top-left corner in the document (the box plus the page's scroll position). */
  offset: { x: number; y: number };
  /** The computed styles of `computedStyleProps`, in that order. */
  styles: { name: InspectorStyleProp; value: string }[];
  /** Its landmark region (`changes-diff.feature.md`, Regions), or `head`. */
  region: InspectorRegion;
  seo: InspectorSeoFacts;
  childElementCount: number;
}

export type InspectorNodeAnswer = { status: 'ok'; docToken: string; path: NodePath; node: InspectorNode } | InspectorRefused;

/** A pick: the path of the element clicked (the selection outline stays on it), or why not. */
export type InspectorPickAnswer = { status: 'picked'; docToken: string; path: NodePath } | InspectorRefused;

/** A search match: its path and its tree row (the row's `index` is the path's last step). */
export interface InspectorSearchMatch {
  path: NodePath;
  node: InspectorChild;
}

/** A search's matches, in document order (at most `maxResults`; `more`: the search stopped before the end), or why not. */
export type InspectorSearchAnswer = { status: 'ok'; docToken: string; matches: InspectorSearchMatch[]; more: boolean } | InspectorRefused;

/**
 * A source: its text (at most `INSPECTOR_SOURCE_MAX_CHARS`; `truncated`: the document, or the bytes
 * frost fetched, were longer) and its `ref`, main's name for exactly this text (Copy source passes it
 * back). The served source can also be `pending` (its fetch or parse is under way) or `unavailable`
 * (the reason, and the HTTP status where known, as the JavaScript panel's).
 */
export type InspectorSourceAnswer =
  | { status: 'ok'; kind: InspectorSourceKind; docToken: string; ref: number; text: string; truncated: boolean }
  | { status: 'pending'; kind: 'served' }
  | { status: 'unavailable'; kind: 'served'; reason: ServedUnavailableReason; httpStatus: number | null }
  | InspectorRefused;

/** `inspector.copySource`: main wrote the source it answered under `ref` to the clipboard, or why not (`stale`: the page, its URL or that source changed since). */
export type InspectorCopySourceAnswer = { status: 'copied'; kind: InspectorSourceKind; truncated: boolean } | InspectorRefused;

/** `inspector.highlight` and `inspector.clear`: done, or why not. */
export type InspectorAck = { status: 'ok' } | InspectorRefused;
