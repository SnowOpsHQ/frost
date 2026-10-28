import type { TabState } from '@app/specs/browser.spec';
import {
  INSPECTOR_REFUSAL_MESSAGES,
  INSPECTOR_REGION_LABELS,
  type InspectorBox,
  type InspectorChild,
  type InspectorChildrenAnswer,
  type InspectorNode,
  type InspectorPickAnswer,
  type InspectorRefusal,
  type NodePath,
} from '@app/specs/inspector.spec';
import { isWebUrl } from '@app/specs/web-url.spec';

// The Inspector panel's pure helpers (acceptance `inspector.feature.md`, The panel): the tree's
// model (loaded lazily, one page of children at a time), its keyboard navigation (the ARIA tree-view
// pattern), row labels and the details' text. Page text stays plain strings here; the panel renders
// it as React text only.

/** A tree entry: the element's row, its loaded children (`null`: not read yet), whether more are left, and whether it is open. */
export interface TreeEntry {
  readonly path: NodePath;
  readonly row: InspectorChild;
  readonly kids: readonly string[] | null;
  readonly more: boolean;
  readonly expanded: boolean;
}
export type Tree = ReadonlyMap<string, TreeEntry>;

/** A tree row as shown: its key, path, level (1 for `<html>`), and whether it can open. */
export interface VisibleRow {
  readonly key: string;
  readonly path: NodePath;
  readonly level: number;
  readonly row: InspectorChild;
  readonly expanded: boolean;
  readonly expandable: boolean;
}

/** The root's key (`<html>`, path `[]`). */
export const ROOT_KEY = '';

/** A path's key in the tree (`1.0.3`; `''` for `<html>`). */
export const pathKey = (path: NodePath): string => path.join('.');

/** Whether the tab shows a page the inspector can read (main still decides). */
export function canInspect(tab: TabState | undefined): tab is TabState {
  return tab !== undefined && !tab.crashed && isWebUrl(tab.url);
}

/** A row's label: `tag#id.class.class` (the panel wraps it in angle brackets). */
export function rowLabel(row: Pick<InspectorChild, 'tag' | 'id' | 'classes'>): string {
  return `${row.tag}${row.id === '' ? '' : `#${row.id}`}${row.classes.map((name) => `.${name}`).join('')}`;
}

/**
 * `tree` with a children answer merged in: the node's row (the root's too), its children (appended
 * after the ones already loaded when `offset` continues them, else replacing them), `more`, and the
 * node opened. A child already in the tree keeps its own loaded children and state.
 */
export function mergeChildren(tree: Tree, answer: Extract<InspectorChildrenAnswer, { status: 'ok' }>): Map<string, TreeEntry> {
  const next = new Map(tree);
  const key = pathKey(answer.path);
  const known = next.get(key);
  const kept = known?.kids && answer.offset > 0 && answer.offset === known.kids.length ? known.kids : [];
  const kids = [...kept];
  for (const child of answer.children) {
    const path = [...answer.path, child.index];
    const childKey = pathKey(path);
    const had = next.get(childKey);
    next.set(childKey, had ? { ...had, row: child } : { path, row: child, kids: null, more: false, expanded: false });
    if (!kids.includes(childKey)) kids.push(childKey);
  }
  next.set(key, { path: answer.path, row: answer.node, kids, more: answer.more, expanded: true });
  return next;
}

/** `tree` with the node at `key` opened or closed (its loaded children kept). */
export function setExpanded(tree: Tree, key: string, expanded: boolean): Map<string, TreeEntry> {
  const next = new Map(tree);
  const entry = next.get(key);
  if (entry) next.set(key, { ...entry, expanded });
  return next;
}

/** The rows shown, in document order: each open node's loaded children under it. */
export function visibleRows(tree: Tree): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (key: string, level: number): void => {
    const entry = tree.get(key);
    if (!entry) return;
    const expandable = entry.row.childElementCount > 0;
    rows.push({ key, path: entry.path, level, row: entry.row, expanded: expandable && entry.expanded, expandable });
    if (expandable && entry.expanded && entry.kids) for (const kid of entry.kids) walk(kid, level + 1);
  };
  walk(ROOT_KEY, 1);
  return rows;
}

/** What a key does in the tree (the ARIA tree-view pattern): focus a row, open or close one, or select it. */
export type TreeKeyAction = { readonly type: 'focus'; readonly key: string } | { readonly type: 'expand'; readonly key: string } | { readonly type: 'collapse'; readonly key: string } | { readonly type: 'select'; readonly key: string };

/**
 * The action of `key` pressed on the row `current`: ↓/↑ the next/previous row, Home/End the first
 * and last; → opens a closed row, or moves into an open one's first child; ← closes an open row, or
 * moves to its parent; Enter and Space select. `null`: not a tree key (or nothing to do).
 */
export function treeKeyAction(key: string, rows: readonly VisibleRow[], current: string): TreeKeyAction | null {
  const at = rows.findIndex((row) => row.key === current);
  if (at < 0 || rows.length === 0) return null;
  const row = rows[at]!;
  const focus = (index: number): TreeKeyAction | null => (index === at || index < 0 || index >= rows.length ? null : { type: 'focus', key: rows[index]!.key });
  switch (key) {
    case 'ArrowDown':
      return focus(at + 1);
    case 'ArrowUp':
      return focus(at - 1);
    case 'Home':
      return focus(0);
    case 'End':
      return focus(rows.length - 1);
    case 'ArrowRight':
      if (!row.expandable) return null;
      if (!row.expanded) return { type: 'expand', key: row.key };
      return rows[at + 1] && rows[at + 1]!.level > row.level ? focus(at + 1) : null;
    case 'ArrowLeft': {
      if (row.expanded) return { type: 'collapse', key: row.key };
      if (row.path.length === 0) return null;
      const parent = pathKey(row.path.slice(0, -1));
      return focus(rows.findIndex((r) => r.key === parent));
    }
    case 'Enter':
    case ' ':
      return { type: 'select', key: row.key };
    default:
      return null;
  }
}

/** The paths to open, top down, to show the node at `path` (`[]`, `[a]`, `[a, b]`, … its parent's). */
export function pathsToReveal(path: NodePath): NodePath[] {
  return Array.from({ length: path.length }, (_, i) => path.slice(0, i));
}

/** How a refusal reads in the panel. */
export const refusalText = (reason: InspectorRefusal): string => INSPECTOR_REFUSAL_MESSAGES[reason];

/** A pick's outcome for the palette's status line and the panel's live region (`null`: the IPC failed). */
export function pickOutcomeText(answer: InspectorPickAnswer | null): string {
  if (answer === null) return INSPECTOR_REFUSAL_MESSAGES.failed;
  return answer.status === 'picked' ? 'Element picked.' : refusalText(answer.reason);
}

const round = (n: number): string => String(Math.round(n * 100) / 100);

/** A box as `width × height at (x, y)`, CSS px. */
export function boxText(box: InspectorBox): string {
  return `${round(box.width)} × ${round(box.height)} at (${round(box.x)}, ${round(box.y)})`;
}

/** A node's details as label/value rows (box, document offset, region, child count), in the panel's order. */
export function summaryRows(node: InspectorNode): [string, string][] {
  return [
    ['Tag', `<${node.tag}>`],
    ['Box', boxText(node.box)],
    ['In the document', `(${round(node.offset.x)}, ${round(node.offset.y)})`],
    ['Region', INSPECTOR_REGION_LABELS[node.region]],
    ['Child elements', String(node.childElementCount)],
  ];
}

/** A node's SEO facts as label/value rows (only the ones that apply). */
export function seoRows(node: InspectorNode): [string, string][] {
  const { seo } = node;
  const rows: [string, string][] = [];
  if (seo.headingLevel !== null) rows.push(['Heading level', `H${seo.headingLevel}`]);
  if (seo.link) {
    rows.push(['Link', seo.link.href]);
    rows.push(['rel', seo.link.rel === '' ? '(none)' : seo.link.rel]);
    if (seo.link.target !== '') rows.push(['target', seo.link.target]);
  }
  if (seo.image) {
    rows.push(['Image', seo.image.src]);
    rows.push(['alt', seo.image.alt === null ? '(missing)' : seo.image.alt === '' ? '(empty)' : seo.image.alt]);
    rows.push(['Natural size', `${seo.image.naturalWidth} × ${seo.image.naturalHeight}`]);
  }
  if (seo.meta) rows.push([`meta ${seo.meta.name}`, seo.meta.content]);
  if (seo.linkRel) rows.push([`link rel=${seo.linkRel.rel}`, seo.linkRel.href]);
  rows.push(['Language', seo.lang ?? '(not set)']);
  return rows;
}
