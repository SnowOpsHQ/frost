import { useEffect, useState } from 'react';
// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { CrawlStructureAnswer, CrawlTreeNode } from '@app/specs/site-crawl.schema';
import { CRAWL_REFUSAL_TEXT, CRAWL_VIEW_TEXT } from '@app/specs/site-crawl.spec';
import { depthBars, treeNodeLabel } from '../../crawl-view';
import { crawlActions } from './crawl-actions';

// The crawl sheet's Site structure view (Phase 12 Task 7, SL-097; acceptance `site-crawl.feature.md`,
// Pages and Site structure: Site structure): the run's path tree, read from main one level at a time
// (`crawl.structure`, at most `CRAWL_TREE_LIMITS.maxChildren` nodes a level, the rest counted and said),
// the click-depth histogram (a `<progress>` per depth: no inline style), and the orphans (sitemap URLs no
// crawled page links to, from the frontier; the first `CRAWL_TREE_LIMITS.maxOrphansShown` and their
// total). A folder opens its level on a click; a node's own page opens in the active tab. Page text is
// React text in a `<bdi>`.

type Level = { readonly nodes: readonly CrawlTreeNode[]; readonly more: number } | 'loading' | 'failed';

function TreeLevel({ runId, level, levels, onToggle, onOpenUrl }: { readonly runId: string; readonly level: Level; readonly levels: ReadonlyMap<string, Level>; readonly onToggle: (prefix: string) => void; readonly onOpenUrl: (url: string) => void }) {
  if (level === 'loading') return <p className="crawl-note">Loading…</p>;
  if (level === 'failed') return <p className="crawl-note">{CRAWL_REFUSAL_TEXT['store-failed']}</p>;
  return (
    <ul className="crawl-tree-level" role="group">
      {level.nodes.map((node) => {
        const open = node.prefix !== null ? levels.get(node.prefix) : undefined;
        return (
          <li key={`${node.prefix ?? ''} ${node.url ?? ''} ${node.label}`} className="crawl-tree-node" data-testid="crawl-tree-node">
            <div className="crawl-tree-row">
              {node.prefix !== null ? (
                <button type="button" className="crawl-tree-toggle" aria-expanded={open !== undefined} data-testid="crawl-tree-toggle" onClick={() => onToggle(node.prefix!)}>
                  <bdi dir="auto">{treeNodeLabel(node)}</bdi>
                </button>
              ) : (
                <bdi className="crawl-tree-leaf" dir="auto">
                  {treeNodeLabel(node)}
                </bdi>
              )}
              <span className="crawl-count">{node.pages}</span>
              {node.url !== null ? (
                <button type="button" className="crawl-link-button" data-testid="crawl-tree-open" onClick={() => onOpenUrl(node.url!)}>
                  {CRAWL_VIEW_TEXT.openInTab}
                </button>
              ) : null}
            </div>
            {open !== undefined ? <TreeLevel runId={runId} level={open} levels={levels} onToggle={onToggle} onOpenUrl={onOpenUrl} /> : null}
          </li>
        );
      })}
      {level.more > 0 ? <li className="crawl-note">{CRAWL_VIEW_TEXT.treeMore(level.more)}</li> : null}
    </ul>
  );
}

export function SiteStructure({ runId, refreshKey, onOpenUrl }: { readonly runId: string; readonly refreshKey: string; readonly onOpenUrl: (url: string) => void }) {
  const [root, setRoot] = useState<CrawlStructureAnswer | null | 'loading'>('loading');
  // Opened folders' levels, by prefix (closed: absent).
  const [levels, setLevels] = useState<ReadonlyMap<string, Level>>(new Map());
  useEffect(() => setLevels(new Map()), [runId]);
  useEffect(() => {
    let live = true;
    void crawlActions.structure({ runId, prefix: null }).then((answer) => {
      if (live) setRoot(answer);
    });
    return () => {
      live = false;
    };
  }, [runId, refreshKey]);

  const toggle = (prefix: string) => {
    if (levels.has(prefix)) {
      setLevels((was) => {
        const next = new Map(was);
        // Closing a folder closes everything under it.
        for (const key of next.keys()) if (key.startsWith(prefix)) next.delete(key);
        return next;
      });
      return;
    }
    setLevels((was) => new Map(was).set(prefix, 'loading'));
    void crawlActions.structure({ runId, prefix }).then((answer) => {
      setLevels((was) => (was.has(prefix) ? new Map(was).set(prefix, answer?.status === 'ok' ? { nodes: answer.tree.nodes, more: answer.tree.more } : 'failed') : was));
    });
  };

  if (root === 'loading') return <p className="crawl-note">Loading the site structure…</p>;
  if (root === null || root.status === 'refused') return <p className="crawl-note">{root === null ? CRAWL_REFUSAL_TEXT['store-failed'] : CRAWL_REFUSAL_TEXT[root.reason]}</p>;
  const bars = depthBars(root.depths);
  return (
    <section className="crawl-structure" aria-label={CRAWL_VIEW_TEXT.structureTab}>
      <section className="crawl-structure-part" aria-labelledby="crawl-tree-title">
        <h3 className="crawl-subtitle" id="crawl-tree-title">
          {CRAWL_VIEW_TEXT.treeTitle}
        </h3>
        <div className="crawl-tree" data-testid="crawl-tree">
          <TreeLevel runId={runId} level={{ nodes: root.tree.nodes, more: root.tree.more }} levels={levels} onToggle={toggle} onOpenUrl={onOpenUrl} />
        </div>
      </section>
      <section className="crawl-structure-part" aria-labelledby="crawl-depths-title">
        <h3 className="crawl-subtitle" id="crawl-depths-title">
          {CRAWL_VIEW_TEXT.depthTitle}
        </h3>
        <dl className="crawl-depths" data-testid="crawl-depths">
          {bars.map((bar) => (
            <div key={bar.depth} className="crawl-depth">
              <dt className="crawl-depth-label">{bar.depth}</dt>
              <dd className="crawl-depth-bar">
                <progress className="crawl-depth-meter" max={100} value={bar.percent} aria-label={`Depth ${bar.depth}: ${bar.pages} pages`} />
                <span className="crawl-count">{bar.pages}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="crawl-structure-part" aria-labelledby="crawl-orphans-title">
        <h3 className="crawl-subtitle" id="crawl-orphans-title">
          {CRAWL_VIEW_TEXT.orphansTitle} <span className="crawl-count">{root.orphans.total}</span>
        </h3>
        <p className="crawl-note">{CRAWL_VIEW_TEXT.orphansNote}</p>
        <ul className="crawl-orphans" data-testid="crawl-orphans">
          {root.orphans.urls.map((url) => (
            <li key={url} className="crawl-orphan">
              <bdi className="crawl-url" dir="auto" title={url}>
                {url}
              </bdi>
              <button type="button" className="crawl-link-button" onClick={() => onOpenUrl(url)}>
                {CRAWL_VIEW_TEXT.openInTab}
              </button>
            </li>
          ))}
        </ul>
        {root.orphans.total > root.orphans.urls.length ? <p className="crawl-note">{CRAWL_VIEW_TEXT.treeMore(root.orphans.total - root.orphans.urls.length)}</p> : null}
      </section>
    </section>
  );
}
