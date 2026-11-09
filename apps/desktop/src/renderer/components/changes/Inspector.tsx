import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type Ref } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import {
  INSPECTOR_LABELS,
  INSPECTOR_PICK_HINT,
  INSPECTOR_PICK_NOTE,
  INSPECTOR_SEARCH_LIMITS,
  INSPECTOR_SOURCE_NOTES,
  INSPECTOR_SOURCE_VIEW,
  type InspectorChildrenAnswer,
  type InspectorCopySourceAnswer,
  type InspectorNode,
  type InspectorPickAnswer,
  type InspectorSearchMatch,
  type InspectorSearchMode,
  type InspectorSourceAnswer,
  type InspectorSourceKind,
  type NodePath,
} from '@app/specs/inspector.spec';
import { SERVED_UNAVAILABLE_MESSAGES } from '@app/specs/seo-javascript.spec';
import { inspectorPaletteSources } from '../../inspector-palette';
import {
  ROOT_KEY,
  canInspect,
  findRows,
  mergeChildren,
  moreKey,
  pathKey,
  pathsToReveal,
  pickOutcomeText,
  refusalText,
  rowLabel,
  seoRows,
  setExpanded,
  extendWindow,
  firstWindow,
  sourceRows,
  summaryRows,
  treeKeyAction,
  visibleRows,
  windowAround,
  type RowWindow,
  type SourceRow,
  type Tree,
  type TreeEntry,
} from '../../inspector-view';
import { ipc } from '../../ipc';
import { registerPaletteActions } from '../../palette/registry';
import { InspectorIcon, PickGlyph } from './changes-icons';

// The Inspector panel (acceptance `inspector.feature.md`, The panel): the active tab's DOM as a
// lazily read tree (the ARIA tree-view pattern: arrows, Home/End, roving tabIndex), "Pick element",
// and the selected node's details. Everything from the page is React text (never markup, never a
// link), and no inline styles (strict CSP). Hovering or focusing a row outlines its node on the page
// (`inspector.highlight`); leaving it removes the outline. Every new document or URL in the tab reads
// the top of the tree again: the same document keeps the tree (rows that changed start afresh), a new
// one (a `stale` answer) starts over, with a note.
//
// Phase 11 Task 5: a search form over the tree (own text or a CSS selector; a match opens the tree to
// it), and the Rendered and Served source views: numbered rows of plain text (`<bdi dir="auto">`,
// never markup), a page of rows at a time, find in source, and "Copy source" (main writes it).

/** Most pages of children read to reveal one picked node, over all its levels (`maxChildren` each). */
const MAX_REVEAL_PAGES = 100;

// ---- Pick runs (outside any component, so the palette and a remounted panel share them) ----------

const picking = new Set<number>();
const pickChanged = new Set<() => void>();
const pickFinished = new Set<(tabId: number, answer: InspectorPickAnswer | null) => void>();
const notifyPick = (): void => {
  for (const listener of [...pickChanged]) listener();
};

/** Picks an element on `tabId`'s page, recorded as running until it answers; the answer goes to every panel listening. */
async function startPick(tabId: number, docToken: string | null): Promise<InspectorPickAnswer | null> {
  const owner = !picking.has(tabId);
  if (owner) {
    picking.add(tabId);
    notifyPick();
  }
  let answer: InspectorPickAnswer | null = null;
  try {
    answer = await ipc.inspector.pick.mutate({ tabId, docToken }).catch(() => null);
  } finally {
    if (owner) {
      picking.delete(tabId);
      notifyPick();
    }
  }
  for (const listener of [...pickFinished]) listener(tabId, answer);
  return answer;
}

const subscribePick = (listener: () => void): (() => void) => {
  pickChanged.add(listener);
  return () => {
    pickChanged.delete(listener);
  };
};
const usePicking = (tabId: number): boolean => useSyncExternalStore(subscribePick, () => picking.has(tabId));

// The command palette's Inspector actions (`inspector-palette.ts`), once per module instance. Its pick
// is for whichever document the tab shows (`null`): the panel reads that document if it is not the one
// it shows.
const unregisterPaletteActions = registerPaletteActions(...inspectorPaletteSources({ pick: (tabId) => startPick(tabId, null) }));
import.meta.hot?.dispose(unregisterPaletteActions);

// ---- The panel -----------------------------------------------------------------------------------

type OkChildren = Extract<InspectorChildrenAnswer, { status: 'ok' }>;
type View = 'tree' | InspectorSourceKind;
const VIEWS: readonly { readonly view: View; readonly label: string }[] = [
  { view: 'tree', label: INSPECTOR_LABELS.viewTree },
  { view: 'rendered', label: INSPECTOR_LABELS.viewRendered },
  { view: 'served', label: INSPECTOR_LABELS.viewServed },
];
type Search = { readonly status: 'loading' } | { readonly status: 'ok'; readonly matches: readonly InspectorSearchMatch[]; readonly more: boolean } | { readonly status: 'refused'; readonly message: string };
/** A source view's state, for the document `token`. */
type Source = { readonly kind: InspectorSourceKind; readonly token: string } & ({ readonly status: 'loading' } | { readonly status: 'ok'; readonly ref: number; readonly text: string; readonly truncated: boolean } | { readonly status: 'pending' } | { readonly status: 'message'; readonly message: string });
/** How often, and how many times, a served source still being fetched is read again. */
const PENDING_RETRY_MS = 1_000;
const PENDING_RETRIES = 30;
/** Control characters (a pasted tab, a line separator) read as spaces in a query. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** What a source or copy answer that is not text says. */
function sourceMessage(answer: Exclude<InspectorSourceAnswer | InspectorCopySourceAnswer, { status: 'ok' } | { status: 'copied' }> | null): string {
  if (answer !== null && answer.status === 'refused' && answer.reason === 'stale') return INSPECTOR_LABELS.sourceChanged;
  if (answer === null) return refusalText('failed');
  if (answer.status === 'pending') return INSPECTOR_LABELS.servedPending;
  if (answer.status === 'unavailable') return SERVED_UNAVAILABLE_MESSAGES[answer.reason].replace('{status}', answer.httpStatus === null ? '' : String(answer.httpStatus));
  return refusalText(answer.reason);
}
type Details = { readonly key: string } & ({ readonly status: 'loading' } | { readonly status: 'ready'; readonly node: InspectorNode } | { readonly status: 'refused'; readonly message: string });

function Hint({ title, message, testId }: { readonly title: string; readonly message: string; readonly testId: string }) {
  return (
    <div className="seo-hint changes-hint" data-testid={testId}>
      <span className="seo-hint-art" aria-hidden="true">
        <InspectorIcon className="panel-art" />
      </span>
      <p className="seo-hint-title">{title}</p>
      <p className="seo-hint-message">{message}</p>
    </div>
  );
}

export function Inspector({ tab }: { readonly tab: TabState | undefined }) {
  if (!canInspect(tab)) return <Hint testId="inspector-empty" title="No page yet" message={refusalText('no-page')} />;
  // One panel per tab: another tab starts afresh (and the one left has its outlines cleared).
  return <InspectorTab key={tab.id} tab={tab} />;
}

function InspectorTab({ tab }: { readonly tab: TabState }) {
  const tabId = tab.id;
  const ids = useId();
  const [tree, setTree] = useState<Tree>(() => new Map());
  const treeRef = useRef<Tree>(tree);
  const tokenRef = useRef<string | null>(null);
  /** Bumped by each read of the tree's top: an older read's answers are dropped. */
  const generation = useRef(0);
  /** Bumped by each reveal, pick and read of the tree's top: a reveal under way stops. */
  const revealRun = useRef(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'refused'>('loading');
  const [message, setMessage] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(ROOT_KEY);
  const [details, setDetails] = useState<Details | null>(null);
  const [announce, setAnnounce] = useState('');
  const [outlined, setOutlined] = useState(false);
  const isPicking = usePicking(tabId);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const pendingFocus = useRef<string | null>(null);
  /** The row whose node the hover outline is on (`null`: none). */
  const hovered = useRef<string | null>(null);
  /** The document the panel shows (`tokenRef`, as state: a source view reads again when it changes). */
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>('tree');
  const [searchMode, setSearchMode] = useState<InspectorSearchMode>('text');
  const [searchQuery, setSearchQuery] = useState('');
  const [search, setSearch] = useState<Search | null>(null);
  const [source, setSourceState] = useState<Source | null>(null);
  const sourceRef = useRef<Source | null>(null);
  const setSource = useCallback((next: Source | null) => {
    sourceRef.current = next;
    setSourceState(next);
  }, []);
  /** The source view a pending read is for (`null`: none): a read again is dropped once another view shows. */
  const pendingRead = useRef<InspectorSourceKind | null>(null);

  const commit = useCallback((next: Tree) => {
    treeRef.current = next;
    setTree(next);
  }, []);

  /** Outlines the row `key`'s node on the page (`null`: takes that outline off, always, whatever the panel is doing). */
  const outline = useCallback(
    (key: string | null): void => {
      const token = tokenRef.current;
      if (key === null) {
        if (hovered.current !== null && token !== null) void ipc.inspector.highlight.mutate({ tabId, node: null, docToken: token }).catch(() => null);
        hovered.current = null;
        return;
      }
      const entry = treeRef.current.get(key);
      if (!entry || token === null || picking.has(tabId)) return;
      hovered.current = key;
      void ipc.inspector.highlight.mutate({ tabId, node: { path: entry.path, tag: entry.row.tag }, docToken: token }).catch(() => null);
    },
    [tabId],
  );

  /**
   * Reads the top of the tree. `again`: for the document the panel shows; the same one answering
   * keeps the tree (and its outlines), another one (`stale`) is cleared and read afresh, with a note.
   */
  const load = useCallback(
    async (again: boolean, staleNote: string | null = null): Promise<void> => {
      const run = ++generation.current;
      revealRun.current += 1;
      outline(null);
      const token = again ? tokenRef.current : null;
      const rootTag = treeRef.current.get(ROOT_KEY)?.row.tag ?? null;
      if (token === null || rootTag === null) setStatus('loading');
      const answer = await ipc.inspector.children
        .query(token === null || rootTag === null ? { tabId, path: [], tag: null, docToken: null, offset: 0 } : { tabId, path: [], tag: rootTag, docToken: token, offset: 0 })
        .catch(() => null);
      if (run !== generation.current) return;
      if (answer !== null && answer.status === 'refused' && token !== null && (answer.reason === 'stale' || answer.reason === 'not-found')) {
        // Another document (or another root): its outlines and any pick go, and it is read afresh.
        void ipc.inspector.clear.mutate({ tabId }).catch(() => null);
        return load(false, answer.reason === 'stale' ? refusalText('stale') : null);
      }
      if (answer === null || answer.status === 'refused') {
        setMessage(refusalText(answer === null ? 'failed' : answer.reason));
        setStatus('refused');
        return;
      }
      if (token !== null && rootTag !== null) {
        // The same document: the tree stays as it is, with the top read again.
        commit(mergeChildren(treeRef.current, answer));
        setStatus('ready');
        return;
      }
      tokenRef.current = answer.docToken;
      setToken(answer.docToken);
      setSearch(null);
      commit(mergeChildren(new Map(), answer));
      setFocusKey(ROOT_KEY);
      setDetails(null);
      setOutlined(false);
      setNote(staleNote);
      setStatus('ready');
    },
    [tabId, commit, outline],
  );

  // A new document, or a new URL in the same one, reads the top of the tree again. Loading is not
  // waited for: a page that never stops loading still shows its tree.
  useEffect(() => {
    void load(tokenRef.current !== null);
  }, [tab.documentSeq, tab.url, load]);

  // Leaving the tab (or closing the panel) ends a pick and takes every outline off its page.
  useEffect(
    () => () => {
      generation.current += 1;
      revealRun.current += 1;
      void ipc.inspector.clear.mutate({ tabId }).catch(() => null);
    },
    [tabId],
  );

  /** One page of the node's children from `offset`, or `null` (a `stale` answer reads the tree afresh; another refusal is announced). */
  const readChildren = useCallback(
    async (entry: Pick<TreeEntry, 'path' | 'row'>, offset: number): Promise<OkChildren | null> => {
      const run = generation.current;
      const token = tokenRef.current;
      if (token === null) return null;
      const answer = await ipc.inspector.children.query({ tabId, path: entry.path, tag: entry.row.tag, docToken: token, offset }).catch(() => null);
      if (run !== generation.current) return null;
      if (answer === null || answer.status === 'refused') {
        if (answer?.status === 'refused' && answer.reason === 'stale') {
          void ipc.inspector.clear.mutate({ tabId }).catch(() => null);
          void load(false, refusalText('stale'));
        } else setAnnounce(refusalText(answer === null ? 'failed' : answer.reason));
        return null;
      }
      return answer;
    },
    [tabId, load],
  );

  const expand = async (key: string): Promise<void> => {
    const entry = treeRef.current.get(key);
    if (!entry || entry.row.childElementCount === 0) return;
    if (entry.kids !== null) return commit(setExpanded(treeRef.current, key, true));
    const answer = await readChildren(entry, 0);
    if (answer) commit(mergeChildren(treeRef.current, answer));
  };
  const collapse = (key: string): void => commit(setExpanded(treeRef.current, key, false));
  /** Reads the node's next children; focus moves to the first of them (from the keyboard, or when "Show more" goes). */
  const showMore = async (key: string): Promise<void> => {
    const entry = treeRef.current.get(key);
    if (!entry || !entry.more) return;
    const from = entry.kids?.length ?? 0;
    const answer = await readChildren(entry, from);
    if (!answer) return;
    const next = mergeChildren(treeRef.current, answer);
    commit(next);
    const first = next.get(key)?.kids?.[from];
    if (first !== undefined && (focusKey === moreKey(key) || document.activeElement === rowRefs.current.get(moreKey(key)))) {
      pendingFocus.current = first;
      setFocusKey(first);
    }
  };

  const select = async (key: string): Promise<void> => {
    const entry = treeRef.current.get(key);
    const token = tokenRef.current;
    if (!entry || token === null) return;
    setFocusKey(key);
    setDetails({ key, status: 'loading' });
    const run = generation.current;
    const answer = await ipc.inspector.node.query({ tabId, path: entry.path, tag: entry.row.tag, docToken: token }).catch(() => null);
    if (run !== generation.current) return;
    if (answer !== null && answer.status === 'refused' && answer.reason === 'stale') {
      void ipc.inspector.clear.mutate({ tabId }).catch(() => null);
      return void load(false, refusalText('stale'));
    }
    setDetails((current) => (current?.key !== key ? current : answer === null || answer.status === 'refused' ? { key, status: 'refused', message: refusalText(answer === null ? 'failed' : answer.reason) } : { key, status: 'ready', node: answer.node }));
  };

  /** Opens the tree down to `path` (at most `MAX_REVEAL_PAGES` pages of children in all), then selects it; a new pick or read stops it. */
  const reveal = async (path: NodePath): Promise<void> => {
    const run = ++revealRun.current;
    let pages = 0;
    for (const prefix of pathsToReveal(path)) {
      const key = pathKey(prefix);
      const target = pathKey(path.slice(0, prefix.length + 1));
      while (!treeRef.current.get(key)?.kidSet?.has(target)) {
        const entry = treeRef.current.get(key);
        if (!entry || (entry.kids !== null && !entry.more) || pages >= MAX_REVEAL_PAGES) return;
        pages += 1;
        const answer = await readChildren(entry, entry.kids?.length ?? 0);
        if (!answer || run !== revealRun.current) return;
        commit(mergeChildren(treeRef.current, answer));
      }
      if (!treeRef.current.get(key)!.expanded) commit(setExpanded(treeRef.current, key, true));
    }
    if (run !== revealRun.current) return;
    const key = pathKey(path);
    pendingFocus.current = key;
    await select(key);
  };

  // A pick's answer (from the button or the palette): open the tree to the element and show it.
  const onPicked = useRef<(answer: InspectorPickAnswer | null) => void>(() => undefined);
  onPicked.current = (answer) => {
    setAnnounce(pickOutcomeText(answer));
    if (answer === null || answer.status === 'refused') {
      if (answer?.status === 'refused' && answer.reason === 'stale') void load(false, refusalText('stale'));
      return;
    }
    void (async () => {
      if (answer.docToken !== tokenRef.current) await load(false, tokenRef.current === null ? null : refusalText('stale'));
      if (answer.docToken !== tokenRef.current) return;
      setOutlined(true);
      await reveal(answer.path);
    })();
  };
  useEffect(() => {
    const listener = (id: number, answer: InspectorPickAnswer | null): void => {
      if (id === tabId) onPicked.current(answer);
    };
    pickFinished.add(listener);
    return () => {
      pickFinished.delete(listener);
    };
  }, [tabId]);

  // A new pick (from the button or the palette) starts with no outcome announced, and stops a reveal.
  useEffect(() => {
    if (!isPicking) return;
    setAnnounce('');
    revealRun.current += 1;
    hovered.current = null;
  }, [isPicking]);

  /** Searches the panel's document; a `stale` answer reads the tree afresh. */
  const runSearch = async (): Promise<void> => {
    const docToken = tokenRef.current;
    const query = searchQuery.replace(CONTROL, ' ');
    if (docToken === null || query.trim() === '') return;
    setSearch({ status: 'loading' });
    const answer = await ipc.inspector.search.query({ tabId, docToken, mode: searchMode, query }).catch(() => null);
    if (tokenRef.current !== docToken) return;
    if (answer?.status === 'refused' && answer.reason === 'stale') {
      void ipc.inspector.clear.mutate({ tabId }).catch(() => null);
      return void load(false, refusalText('stale'));
    }
    setSearch(answer === null || answer.status === 'refused' ? { status: 'refused', message: refusalText(answer === null ? 'failed' : answer.reason) } : { status: 'ok', matches: answer.matches, more: answer.more });
  };

  /** Reads the `kind` source of the panel's document (a served source still being fetched is read again, a few times). */
  const readSource = useCallback(
    async (kind: InspectorSourceKind, tries = 0): Promise<void> => {
      const docToken = tokenRef.current;
      if (docToken === null) return;
      if (tries === 0) setSource({ kind, token: docToken, status: 'loading' });
      const answer = await ipc.inspector.source.query({ tabId, docToken, kind }).catch(() => null);
      if (tokenRef.current !== docToken) return;
      if (answer?.status === 'refused' && answer.reason === 'stale') {
        void ipc.inspector.clear.mutate({ tabId }).catch(() => null);
        return void load(false, refusalText('stale'));
      }
      let next: Source;
      if (answer !== null && answer.status === 'ok') next = { kind, token: docToken, status: 'ok', ref: answer.ref, text: answer.text, truncated: answer.truncated };
      else if (answer !== null && answer.status === 'pending') next = { kind, token: docToken, status: 'pending' };
      else next = { kind, token: docToken, status: 'message', message: sourceMessage(answer) };
      // Only while that view still shows that document's source.
      const shown = sourceRef.current;
      if (shown === null || shown.kind !== kind || shown.token !== docToken) return;
      setSource(next);
      if (next.status === 'pending' && tries < PENDING_RETRIES)
        setTimeout(() => {
          if (pendingRead.current === kind && tokenRef.current === docToken && sourceRef.current?.status === 'pending') void readSource(kind, tries + 1);
        }, PENDING_RETRY_MS);
    },
    [tabId, load, setSource],
  );
  // A source view reads its source when shown, for a new document, and for a new URL in the same
  // document (an in-page move: the served HTML is the new URL's, and the page has likely changed).
  useEffect(() => {
    pendingRead.current = view === 'tree' ? null : view;
    if (view !== 'tree' && token !== null) void readSource(view);
  }, [view, token, tab.url, readSource]);
  useEffect(
    () => () => {
      pendingRead.current = null;
    },
    [],
  );

  const rows = visibleRows(tree);

  // The hovered row gone (closed, read again, the tree replaced): its outline goes too.
  useEffect(() => {
    if (hovered.current !== null && !rows.some((row) => row.key === hovered.current)) outline(null);
  });

  // Focus follows the keyboard (and a revealed node) once its row is rendered.
  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    const row = rowRefs.current.get(key);
    if (!row) return;
    pendingFocus.current = null;
    row.focus();
    row.scrollIntoView?.({ block: 'nearest' });
  }, [tree, focusKey]);

  const onTreeKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    // Tree keys belong to the rows only.
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'treeitem') return;
    const action = treeKeyAction(event.key, rows, focusKey);
    if (action === null) return;
    event.preventDefault();
    if (action.type === 'focus') {
      setFocusKey(action.key);
      rowRefs.current.get(action.key)?.focus();
    } else if (action.type === 'expand') void expand(action.key);
    else if (action.type === 'collapse') collapse(action.key);
    else if (action.type === 'more') void showMore(action.key);
    else void select(action.key);
  };

  /** One ref callback per row key (stable, so React calls it only when the row mounts or unmounts). */
  const refCallbacks = useRef(new Map<string, (el: HTMLLIElement | null) => void>());
  const refFor = (key: string): ((el: HTMLLIElement | null) => void) => {
    let callback = refCallbacks.current.get(key);
    if (!callback) {
      callback = (el) => {
        if (el) rowRefs.current.set(key, el);
        else {
          rowRefs.current.delete(key);
          refCallbacks.current.delete(key);
        }
      };
      refCallbacks.current.set(key, callback);
    }
    return callback;
  };

  const renderItem = (key: string, level: number) => {
    const entry = tree.get(key);
    if (!entry) return null;
    const expandable = entry.row.childElementCount > 0;
    const expanded = expandable && entry.expanded;
    const labelId = `${ids}-row-${key || 'root'}`;
    const label = `<${rowLabel(entry.row)}>`;
    const more = moreKey(key);
    return (
      <li
        key={key}
        role="treeitem"
        className="inspector-item"
        aria-level={level}
        aria-expanded={expandable ? expanded : undefined}
        aria-selected={details?.key === key}
        aria-labelledby={labelId}
        tabIndex={focusKey === key ? 0 : -1}
        data-testid="inspector-row"
        data-path={key}
        data-tag={entry.row.tag}
        ref={refFor(key)}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          setFocusKey(key);
          outline(key);
        }}
        onBlur={(event) => {
          if (event.target === event.currentTarget) outline(null);
        }}
      >
        <span className="inspector-row" data-selected={details?.key === key} onClick={() => void select(key)} onMouseEnter={() => outline(key)} onMouseLeave={() => outline(null)}>
          <span
            className="inspector-twisty"
            data-open={expanded}
            data-leaf={!expandable}
            aria-hidden="true"
            data-testid="inspector-twisty"
            onClick={(event) => {
              event.stopPropagation();
              if (expandable) void (expanded ? collapse(key) : expand(key));
            }}
          />
          <span className="inspector-tag" id={labelId}>
            {label}
          </span>
          {entry.row.shadow ? <span className="inspector-shadow">{INSPECTOR_LABELS.shadow}</span> : null}
          {entry.row.textPreview !== '' ? (
            <bdi className="inspector-preview" dir="auto">
              {entry.row.textPreview}
            </bdi>
          ) : null}
        </span>
        {expanded && entry.kids ? (
          <ul role="group" className="inspector-group">
            {entry.kids.map((kid) => renderItem(kid, level + 1))}
            {entry.more ? (
              <li
                key={more}
                role="treeitem"
                className="inspector-item inspector-more"
                aria-level={level + 1}
                tabIndex={focusKey === more ? 0 : -1}
                data-testid="inspector-show-more"
                data-path={more}
                ref={refFor(more)}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) setFocusKey(more);
                }}
                onClick={() => void showMore(key)}
              >
                <span className="inspector-row inspector-more-row">{INSPECTOR_LABELS.showMore}</span>
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="changes inspector" data-testid="inspector" data-state={status}>
      <div className="inspector-actions">
        <button type="button" className="panel-button panel-button-primary inspector-pick" data-testid="inspector-pick" disabled={isPicking || status !== 'ready'} aria-describedby={`${ids}-pick-note`} onClick={() => void startPick(tabId, tokenRef.current)}>
          <PickGlyph />
          <span>{INSPECTOR_LABELS.pick}</span>
        </button>
        {outlined && !isPicking ? (
          <button
            type="button"
            className="seo-action"
            data-testid="inspector-clear"
            onClick={() => {
              setOutlined(false);
              hovered.current = null;
              void ipc.inspector.clear.mutate({ tabId }).catch(() => null);
            }}
          >
            {INSPECTOR_LABELS.clear}
          </button>
        ) : null}
      </div>
      <p className="changes-note" id={`${ids}-pick-note`}>
        {INSPECTOR_PICK_NOTE}
      </p>
      {isPicking ? (
        <div className="changes-shot-selecting" role="status" aria-live="polite" data-testid="inspector-pick-hint">
          <span>{INSPECTOR_PICK_HINT}</span>
          <button type="button" className="seo-action" data-testid="inspector-pick-cancel" onClick={() => void ipc.inspector.cancelPick.mutate({ tabId }).catch(() => false)}>
            {INSPECTOR_LABELS.cancelPick}
          </button>
        </div>
      ) : null}
      <p className="changes-status" role="status" aria-live="polite" data-testid="inspector-status">
        {announce}
      </p>
      {note !== null ? (
        <p className="changes-note" data-tone="warn" data-testid="inspector-note">
          {note}
        </p>
      ) : null}
      <div className="inspector-views" role="group" aria-label={INSPECTOR_LABELS.views}>
        {VIEWS.map((entry) => (
          <button key={entry.view} type="button" className="seo-action inspector-view-button" aria-pressed={view === entry.view} data-testid="inspector-view" data-view={entry.view} onClick={() => setView(entry.view)}>
            {entry.label}
          </button>
        ))}
      </div>
      {status === 'refused' ? (
        <p className="changes-note" data-tone="warn" data-testid="inspector-refused">
          {message}
        </p>
      ) : status === 'loading' && tree.size === 0 ? (
        <p className="changes-note">{INSPECTOR_LABELS.loading}</p>
      ) : view === 'tree' ? (
        <>
          <form
            className="inspector-search"
            role="search"
            aria-label={INSPECTOR_LABELS.search}
            data-testid="inspector-search"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <select className="projects-select inspector-search-mode" aria-label={INSPECTOR_LABELS.search} data-testid="inspector-search-mode" value={searchMode} onChange={(event) => setSearchMode(event.target.value === 'selector' ? 'selector' : 'text')}>
              <option value="text">{INSPECTOR_LABELS.searchModeText}</option>
              <option value="selector">{INSPECTOR_LABELS.searchModeSelector}</option>
            </select>
            <input
              className="projects-input"
              type="search"
              spellCheck={false}
              autoComplete="off"
              aria-label={INSPECTOR_LABELS.searchQuery}
              placeholder={INSPECTOR_LABELS.searchQuery}
              maxLength={INSPECTOR_SEARCH_LIMITS.maxQueryChars}
              data-testid="inspector-search-query"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <button type="submit" className="seo-action" data-testid="inspector-search-run" disabled={status !== 'ready' || searchQuery.trim() === ''}>
              {INSPECTOR_LABELS.searchRun}
            </button>
          </form>
          <SearchResults search={search} onChoose={(match) => void reveal(match.path)} />
          <ul className="inspector-tree" role="tree" aria-label={INSPECTOR_LABELS.tree} data-testid="inspector-tree" onKeyDown={onTreeKey}>
            {renderItem(ROOT_KEY, 1)}
          </ul>
          <NodeDetails details={details} />
        </>
      ) : (
        <SourceView key={`${view}:${source?.token ?? ''}`} tabId={tabId} kind={view} source={source !== null && source.kind === view ? source : null} onReadAgain={() => void readSource(view)} />
      )}
    </div>
  );
}

function SearchResults({ search, onChoose }: { readonly search: Search | null; readonly onChoose: (match: InspectorSearchMatch) => void }) {
  if (search === null) return null;
  if (search.status === 'loading') return <p className="changes-note">{INSPECTOR_LABELS.loading}</p>;
  if (search.status === 'refused')
    return (
      <p className="changes-note" data-tone="warn" role="status" data-testid="inspector-search-status">
        {search.message}
      </p>
    );
  return (
    <>
      <p className="changes-note" role="status" data-testid="inspector-search-status">
        {search.matches.length === 0 ? INSPECTOR_LABELS.searchNone : `${search.matches.length} ${search.matches.length === 1 ? 'match' : 'matches'}`}
        {search.more ? ` · ${INSPECTOR_LABELS.searchMore}` : ''}
      </p>
      {search.matches.length > 0 ? (
        <ul className="inspector-matches" aria-label={INSPECTOR_LABELS.searchResults} data-testid="inspector-search-results">
          {search.matches.map((match) => (
            <li key={pathKey(match.path)}>
              <button type="button" className="inspector-row inspector-match" data-testid="inspector-search-match" data-path={pathKey(match.path)} data-tag={match.node.tag} onClick={() => onChoose(match)}>
                <span className="inspector-tag">{`<${rowLabel(match.node)}>`}</span>
                {match.node.textPreview !== '' ? (
                  <bdi className="inspector-preview" dir="auto">
                    {match.node.textPreview}
                  </bdi>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** A source view: what it is, Copy source, Read again, find in source and the numbered rows (a page at a time). */
function SourceView({ tabId, kind, source, onReadAgain }: { readonly tabId: number; readonly kind: InspectorSourceKind; readonly source: Source | null; readonly onReadAgain: () => void }) {
  const ids = useId();
  const text = source?.status === 'ok' ? source.text : null;
  const listing = useMemo(() => (text === null ? null : sourceRows(text)), [text]);
  const total = listing?.rows.length ?? 0;
  const [win, setWin] = useState<RowWindow>(() => firstWindow(total));
  // Another reading of the source starts at its top.
  useEffect(() => {
    setWin(firstWindow(listing?.rows.length ?? 0));
  }, [listing]);
  const [find, setFind] = useState('');
  const [at, setAt] = useState<number | null>(null);
  const [copied, setCopied] = useState('');
  const listRef = useRef<HTMLOListElement | null>(null);
  const matches = useMemo(() => (listing === null ? [] : findRows(listing.rows, find)), [listing, find]);
  const current = at === null || matches.length === 0 ? null : matches[Math.min(at, matches.length - 1)]!;

  /** Moves to the next (or previous) match; a match outside the rendered window renders the rows around it instead. */
  const step = (by: 1 | -1): void => {
    if (matches.length === 0) return;
    const next = at === null ? (by === 1 ? 0 : matches.length - 1) : (Math.min(at, matches.length - 1) + by + matches.length) % matches.length;
    setAt(next);
    setWin((shown) => windowAround(shown, matches[next]!, total));
  };
  // The current match is scrolled into view once rendered.
  useEffect(() => {
    if (current === null) return;
    listRef.current?.querySelector(`[data-row="${current}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [current, win]);

  /** Copy source: main writes the text it answered under this view's `ref`; if the page changed since, the source is read again. */
  const copy = async (): Promise<void> => {
    if (source === null || source.status !== 'ok') return;
    setCopied('');
    const answer = await ipc.inspector.copySource.mutate({ tabId, docToken: source.token, kind, ref: source.ref }).catch(() => null);
    setCopied(answer === null ? sourceMessage(null) : answer.status === 'copied' ? INSPECTOR_LABELS.sourceCopied : sourceMessage(answer));
    if (answer !== null && answer.status === 'refused' && answer.reason === 'stale') onReadAgain();
  };

  return (
    <section className="inspector-source" aria-label={kind === 'rendered' ? INSPECTOR_LABELS.viewRendered : INSPECTOR_LABELS.viewServed} data-testid="inspector-source" data-kind={kind} data-state={source?.status ?? 'loading'}>
      <p className="changes-note">{INSPECTOR_SOURCE_NOTES[kind]}</p>
      <div className="inspector-source-actions">
        <button type="button" className="seo-action" data-testid="inspector-copy-source" disabled={source?.status !== 'ok'} onClick={() => void copy()}>
          {INSPECTOR_LABELS.copySource}
        </button>
        <button type="button" className="seo-action" data-testid="inspector-read-source" disabled={source?.status === 'loading'} onClick={onReadAgain}>
          {INSPECTOR_LABELS.readSource}
        </button>
      </div>
      <p className="changes-status" role="status" aria-live="polite" data-testid="inspector-source-status">
        {copied}
      </p>
      {source === null || source.status === 'loading' ? (
        <p className="changes-note">{INSPECTOR_LABELS.loading}</p>
      ) : source.status === 'pending' ? (
        <p className="changes-note" data-testid="inspector-source-message">
          {INSPECTOR_LABELS.servedPending}
        </p>
      ) : source.status === 'message' ? (
        <p className="changes-note" data-tone="warn" data-testid="inspector-source-message">
          {source.message}
        </p>
      ) : listing === null ? null : (
        <>
          <form
            className="inspector-find"
            role="search"
            aria-label={INSPECTOR_LABELS.findInSource}
            onSubmit={(event) => {
              event.preventDefault();
              step(1);
            }}
          >
            <input
              className="projects-input"
              type="search"
              spellCheck={false}
              autoComplete="off"
              aria-label={INSPECTOR_LABELS.findInSource}
              aria-describedby={`${ids}-find-count`}
              placeholder={INSPECTOR_LABELS.findInSource}
              maxLength={INSPECTOR_SOURCE_VIEW.maxFindChars}
              data-testid="inspector-find"
              value={find}
              onChange={(event) => {
                setFind(event.target.value);
                setAt(null);
              }}
            />
            <button type="button" className="seo-action" aria-label={INSPECTOR_LABELS.findPrevious} data-testid="inspector-find-previous" disabled={matches.length === 0} onClick={() => step(-1)}>
              ↑
            </button>
            <button type="submit" className="seo-action" aria-label={INSPECTOR_LABELS.findNext} data-testid="inspector-find-next" disabled={matches.length === 0}>
              ↓
            </button>
            <span className="inspector-find-count" id={`${ids}-find-count`} data-testid="inspector-find-count">
              {find.trim() === '' ? '' : matches.length === 0 ? INSPECTOR_LABELS.findNone : `${at === null ? 0 : Math.min(at, matches.length - 1) + 1} / ${matches.length}`}
            </span>
          </form>
          {source.truncated ? (
            <p className="changes-note" data-tone="warn" data-testid="inspector-source-truncated">
              {INSPECTOR_LABELS.sourceTruncated}
            </p>
          ) : null}
          {listing.cut ? <p className="changes-note">{INSPECTOR_LABELS.sourceRowsCut}</p> : null}
          {win.start > 0 ? (
            <button type="button" className="seo-action inspector-more-lines" data-testid="inspector-earlier-lines" onClick={() => setWin((shown) => extendWindow(shown, 'before', total))}>
              {INSPECTOR_LABELS.showEarlierLines}
            </button>
          ) : null}
          <SourceLines rows={listing.rows} start={win.start} end={win.end} matches={matches} current={current} listRef={listRef} />
          {win.end < total ? (
            <button type="button" className="seo-action inspector-more-lines" data-testid="inspector-more-lines" onClick={() => setWin((shown) => extendWindow(shown, 'after', total))}>
              {INSPECTOR_LABELS.showMoreLines}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * A source's rows as a numbered list: each row's text is React text in `<bdi dir="auto">` (the
 * page's markup is never markup here), only the window `start`–`end` (`data-row` is the row's index
 * in the whole source); rows holding the find query are marked (`data-match`), the current one
 * `aria-current`. Memoised: typing elsewhere re-renders nothing here.
 */
export const SourceLines = memo(function SourceLines({
  rows,
  start,
  end,
  matches,
  current,
  listRef,
}: {
  readonly rows: readonly SourceRow[];
  readonly start: number;
  readonly end: number;
  readonly matches: readonly number[];
  readonly current: number | null;
  readonly listRef?: Ref<HTMLOListElement>;
}) {
  const marked = useMemo(() => new Set(matches), [matches]);
  return (
    <ol className="inspector-source-lines" aria-label={INSPECTOR_LABELS.sourceLines} data-testid="inspector-source-lines" ref={listRef}>
      {rows.slice(start, end).map((row, offset) => {
        const i = start + offset;
        return (
          <li key={i} className="inspector-source-row" data-testid="inspector-source-row" data-row={i} data-line={row.line ?? undefined} data-match={marked.has(i) ? 'true' : undefined} aria-current={current === i ? 'true' : undefined}>
            <span className="inspector-source-no" aria-hidden="true">
              {row.line ?? ''}
            </span>
            <bdi dir="auto">{row.text}</bdi>
          </li>
        );
      })}
    </ol>
  );
});

function NodeDetails({ details }: { readonly details: Details | null }) {
  if (details === null) return <p className="changes-note inspector-empty-details">{INSPECTOR_LABELS.empty}</p>;
  if (details.status === 'loading') return <p className="changes-note">{INSPECTOR_LABELS.loading}</p>;
  if (details.status === 'refused')
    return (
      <p className="changes-note" data-tone="warn" data-testid="inspector-details-refused">
        {details.message}
      </p>
    );
  const { node } = details;
  return (
    <section className="inspector-details" aria-label={INSPECTOR_LABELS.details} data-testid="inspector-details" data-tag={node.tag}>
      <h3 className="seo-section-title">{INSPECTOR_LABELS.details}</h3>
      <Facts rows={summaryRows(node)} testId="inspector-summary" />
      <h3 className="seo-section-title">{INSPECTOR_LABELS.attributes}</h3>
      {node.attributes.length === 0 ? (
        <p className="changes-note">{INSPECTOR_LABELS.noAttributes}</p>
      ) : (
        <table className="inspector-table" data-testid="inspector-attributes">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {node.attributes.map((attribute, i) => (
              <tr key={`${i}:${attribute.name}`}>
                <th scope="row">
                  <bdi dir="ltr">{attribute.name}</bdi>
                </th>
                <td>
                  <bdi dir="auto">{attribute.value}</bdi>
                  {attribute.truncated ? <span className="inspector-cut">(cut)</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {node.attributesMore ? <p className="changes-note">More attributes are not listed.</p> : null}
      <h3 className="seo-section-title">{INSPECTOR_LABELS.styles}</h3>
      <Facts rows={node.styles.map((style) => [style.name, style.value])} testId="inspector-styles" />
      <h3 className="seo-section-title">{INSPECTOR_LABELS.seo}</h3>
      <Facts rows={seoRows(node)} testId="inspector-seo" />
    </section>
  );
}

function Facts({ rows, testId }: { readonly rows: readonly (readonly [string, string])[]; readonly testId: string }) {
  return (
    <dl className="inspector-facts" data-testid={testId}>
      {rows.map(([name, value], i) => (
        <div key={`${i}:${name}`} className="inspector-fact" data-name={name}>
          <dt>{name}</dt>
          <dd>
            <bdi dir="auto">{value}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}
