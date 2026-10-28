import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import {
  INSPECTOR_LABELS,
  INSPECTOR_PICK_HINT,
  INSPECTOR_PICK_NOTE,
  type InspectorChildrenAnswer,
  type InspectorNode,
  type InspectorPickAnswer,
  type NodePath,
} from '@app/specs/inspector.spec';
import { inspectorPaletteSources } from '../../inspector-palette';
import {
  ROOT_KEY,
  canInspect,
  mergeChildren,
  pathKey,
  pathsToReveal,
  pickOutcomeText,
  refusalText,
  rowLabel,
  seoRows,
  setExpanded,
  summaryRows,
  treeKeyAction,
  visibleRows,
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
// (`inspector.highlight`); leaving it removes the outline. A `stale` answer, and every new document
// in the tab, reads the tree again from the top.

/** Most pages of children read to reveal one picked node at one level (`maxChildren` each). */
const MAX_REVEAL_PAGES = 50;

// ---- Pick runs (outside any component, so the palette and a remounted panel share them) ----------

const picking = new Set<number>();
const pickChanged = new Set<() => void>();
const pickFinished = new Set<(tabId: number, answer: InspectorPickAnswer | null) => void>();
/** The document token each tab's panel last read (the palette's pick passes it). */
const docTokens = new Map<number, string>();
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

// The command palette's Inspector actions (`inspector-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(...inspectorPaletteSources({ pick: (tabId) => startPick(tabId, docTokens.get(tabId) ?? null) }));
import.meta.hot?.dispose(unregisterPaletteActions);

// ---- The panel -----------------------------------------------------------------------------------

type OkChildren = Extract<InspectorChildrenAnswer, { status: 'ok' }>;
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
  /** Bumped by each fresh read of the tree: an older read's answers are dropped. */
  const generation = useRef(0);
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

  const commit = useCallback((next: Tree) => {
    treeRef.current = next;
    setTree(next);
  }, []);

  /** Reads the tree from the top (`token`: the document it was for; a new one is `stale`, and read afresh with `staleNote`). */
  const load = useCallback(
    async (token: string | null, staleNote: string | null = null): Promise<void> => {
      const run = ++generation.current;
      setStatus('loading');
      const answer = await ipc.inspector.children.query({ tabId, path: [], docToken: token, offset: 0 }).catch(() => null);
      if (run !== generation.current) return;
      if (answer !== null && answer.status === 'refused' && answer.reason === 'stale' && token !== null) return load(null, refusalText('stale'));
      if (answer === null || answer.status === 'refused') {
        setMessage(refusalText(answer === null ? 'failed' : answer.reason));
        setStatus('refused');
        return;
      }
      tokenRef.current = answer.docToken;
      docTokens.set(tabId, answer.docToken);
      commit(mergeChildren(new Map(), answer));
      setFocusKey(ROOT_KEY);
      setDetails(null);
      setOutlined(false);
      setNote(staleNote);
      setStatus('ready');
    },
    [tabId, commit],
  );

  // A new document (or its load ending) reads the tree again; the token tells whether the page changed.
  useEffect(() => {
    if (tab.loading) return;
    void load(tokenRef.current);
  }, [tab.documentSeq, tab.loading, load]);

  // Leaving the tab (or closing the panel) ends a pick and takes every outline off its page.
  useEffect(
    () => () => {
      generation.current += 1;
      void ipc.inspector.clear.mutate({ tabId }).catch(() => null);
    },
    [tabId],
  );

  /** One page of `path`'s children from `offset`, or `null` (a `stale` answer reads the tree again; another refusal is announced). */
  const readChildren = useCallback(
    async (path: NodePath, offset: number): Promise<OkChildren | null> => {
      const run = generation.current;
      const answer = await ipc.inspector.children.query({ tabId, path, docToken: tokenRef.current, offset }).catch(() => null);
      if (run !== generation.current) return null;
      if (answer === null || answer.status === 'refused') {
        if (answer?.status === 'refused' && answer.reason === 'stale') void load(null, refusalText('stale'));
        else setAnnounce(refusalText(answer === null ? 'failed' : answer.reason));
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
    const answer = await readChildren(entry.path, 0);
    if (answer) commit(mergeChildren(treeRef.current, answer));
  };
  const collapse = (key: string): void => commit(setExpanded(treeRef.current, key, false));
  const showMore = async (entry: TreeEntry): Promise<void> => {
    const answer = await readChildren(entry.path, entry.kids?.length ?? 0);
    if (answer) commit(mergeChildren(treeRef.current, answer));
  };

  const select = async (key: string): Promise<void> => {
    const entry = treeRef.current.get(key);
    if (!entry) return;
    setFocusKey(key);
    setDetails({ key, status: 'loading' });
    const run = generation.current;
    const answer = await ipc.inspector.node.query({ tabId, path: entry.path, docToken: tokenRef.current }).catch(() => null);
    if (run !== generation.current) return;
    if (answer !== null && answer.status === 'refused' && answer.reason === 'stale') return void load(null, refusalText('stale'));
    setDetails((current) => (current?.key !== key ? current : answer === null || answer.status === 'refused' ? { key, status: 'refused', message: refusalText(answer === null ? 'failed' : answer.reason) } : { key, status: 'ready', node: answer.node }));
  };

  /** Opens the tree down to `path` (reading as many pages of children as it takes), then selects it. */
  const reveal = async (path: NodePath): Promise<void> => {
    for (const prefix of pathsToReveal(path)) {
      const key = pathKey(prefix);
      const target = pathKey(path.slice(0, prefix.length + 1));
      for (let pages = 0; !treeRef.current.get(key)?.kids?.includes(target); pages++) {
        const entry = treeRef.current.get(key);
        if (!entry || (entry.kids !== null && !entry.more) || pages >= MAX_REVEAL_PAGES) return;
        const answer = await readChildren(prefix, entry.kids?.length ?? 0);
        if (!answer) return;
        commit(mergeChildren(treeRef.current, answer));
      }
      if (!treeRef.current.get(key)!.expanded) commit(setExpanded(treeRef.current, key, true));
    }
    const key = pathKey(path);
    pendingFocus.current = key;
    await select(key);
  };

  // A pick's answer (from the button or the palette): open the tree to the element and show it.
  const onPicked = useRef<(answer: InspectorPickAnswer | null) => void>(() => undefined);
  onPicked.current = (answer) => {
    setAnnounce(pickOutcomeText(answer));
    if (answer === null || answer.status === 'refused') {
      if (answer?.status === 'refused' && answer.reason === 'stale') void load(null, refusalText('stale'));
      return;
    }
    setOutlined(true);
    void (async () => {
      if (answer.docToken !== tokenRef.current) await load(null, tokenRef.current === null ? null : refusalText('stale'));
      if (answer.docToken === tokenRef.current) {
        await reveal(answer.path);
        setOutlined(true);
      }
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

  // A new pick (from the button or the palette) starts with no outcome announced.
  useEffect(() => {
    if (isPicking) setAnnounce('');
  }, [isPicking]);

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

  /** Outlines `path` on the page while its row is hovered or focused (`null`: off). Not while picking. */
  const outline = (path: NodePath | null): void => {
    if (picking.has(tabId) || status !== 'ready') return;
    void ipc.inspector.highlight.mutate({ tabId, path, docToken: tokenRef.current }).catch(() => null);
  };

  const rows = visibleRows(tree);
  const onTreeKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const action = treeKeyAction(event.key, rows, focusKey);
    if (action === null) return;
    event.preventDefault();
    if (action.type === 'focus') {
      setFocusKey(action.key);
      rowRefs.current.get(action.key)?.focus();
    } else if (action.type === 'expand') void expand(action.key);
    else if (action.type === 'collapse') collapse(action.key);
    else void select(action.key);
  };

  const renderItem = (key: string, level: number) => {
    const entry = tree.get(key);
    if (!entry) return null;
    const expandable = entry.row.childElementCount > 0;
    const expanded = expandable && entry.expanded;
    const labelId = `${ids}-row-${key || 'root'}`;
    const label = `<${rowLabel(entry.row)}>`;
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
        ref={(el) => {
          if (el) rowRefs.current.set(key, el);
          else rowRefs.current.delete(key);
        }}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          setFocusKey(key);
          outline(entry.path);
        }}
        onBlur={(event) => {
          if (event.target === event.currentTarget) outline(null);
        }}
      >
        <span className="inspector-row" data-selected={details?.key === key} onClick={() => void select(key)} onMouseEnter={() => outline(entry.path)} onMouseLeave={() => outline(null)}>
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
              <li role="none" className="inspector-more">
                <button type="button" className="seo-action" data-testid="inspector-show-more" onClick={() => void showMore(entry)}>
                  {INSPECTOR_LABELS.showMore}
                </button>
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
      {status === 'refused' ? (
        <p className="changes-note" data-tone="warn" data-testid="inspector-refused">
          {message}
        </p>
      ) : status === 'loading' && tree.size === 0 ? (
        <p className="changes-note">{INSPECTOR_LABELS.loading}</p>
      ) : (
        <ul className="inspector-tree" role="tree" aria-label={INSPECTOR_LABELS.tree} data-testid="inspector-tree" onKeyDown={onTreeKey}>
          {renderItem(ROOT_KEY, 1)}
        </ul>
      )}
      <NodeDetails details={details} />
    </div>
  );
}

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
