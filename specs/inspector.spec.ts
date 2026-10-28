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
 * Honesty note (`INSPECTOR_PICK_NOTE`): while an element is being picked, the page sees the pointer
 * moving over it (frost only listens), and the page's own capture listeners on `window` registered
 * before the picker's still see the click; frost stops it there, so no later listener, the target or
 * its default action (following a link, submitting a form) gets it. The page cannot pick for the
 * user: only trusted input (`event.isTrusted`) picks or ends a pick, and main hears Esc first.
 */
import type { PageRegion } from './capture.spec';

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
 * - `failed`: the page did not answer in time, or answered something that is not an answer.
 */
export const INSPECTOR_REFUSALS = ['no-tab', 'not-active', 'no-page', 'stale', 'not-found', 'busy', 'cancelled', 'failed'] as const;
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
};

/** Shown in the panel while an element is being picked. */
export const INSPECTOR_PICK_HINT = 'Click an element on the page · Esc to cancel';

/** Said beside Pick element: what the page itself can observe while picking. */
export const INSPECTOR_PICK_NOTE = 'While picking, the page can see the pointer move, and its earliest click listeners still see the click; frost stops the click there.';

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
} as const;

/** How a node's region is named in its details (the landmark rules of `changes-diff.feature.md`, Regions). */
export const INSPECTOR_REGION_LABELS: Readonly<Record<PageRegion, string>> = {
  main: 'Main content',
  nav: 'Navigation',
  header: 'Header',
  aside: 'Aside',
  footer: 'Footer',
  other: 'Outside the landmarks',
};

// ---- Inputs ------------------------------------------------------------------------------------

/** A node's path: element-child indices from `document.documentElement` (at most `maxPathDepth`). */
export type NodePath = number[];

/** `inspector.children`: the node at `path` and up to `maxChildren` of its children from `offset`. `docToken` `null`: the tab's current document, whichever it is. */
export interface InspectorChildrenInput {
  tabId: number;
  path: NodePath;
  docToken: string | null;
  offset: number;
}

/** `inspector.node`: the details of the node at `path`. */
export interface InspectorNodeInput {
  tabId: number;
  path: NodePath;
  docToken: string | null;
}

/** `inspector.pick`: pick an element on the tab's page with the mouse. */
export interface InspectorPickInput {
  tabId: number;
  docToken: string | null;
}

/** `inspector.highlight`: outline the node at `path` on the page (`null`: hide that outline). */
export interface InspectorHighlightInput {
  tabId: number;
  path: NodePath | null;
  docToken: string | null;
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
  /** `img`: its current source (resolved), its `alt` (`null`: no attribute) and its natural size. */
  image: { src: string; alt: string | null; naturalWidth: number; naturalHeight: number } | null;
  /** `meta[name]` / `meta[property]`: the name and content. */
  meta: { name: string; content: string } | null;
  /** `link[rel]`: the `rel` and the resolved `href`. */
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
  /** Its landmark region (`changes-diff.feature.md`, Regions). */
  region: PageRegion;
  seo: InspectorSeoFacts;
  childElementCount: number;
}

export type InspectorNodeAnswer = { status: 'ok'; docToken: string; path: NodePath; node: InspectorNode } | InspectorRefused;

/** A pick: the path of the element clicked (the selection outline stays on it), or why not. */
export type InspectorPickAnswer = { status: 'picked'; docToken: string; path: NodePath } | InspectorRefused;

/** `inspector.highlight` and `inspector.clear`: done, or why not. */
export type InspectorAck = { status: 'ok' } | InspectorRefused;
