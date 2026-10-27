import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { formatJson, panelStatus, type SchemaBlock, type SchemaEntity, type SchemaIssue, type SchemaValue, type SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { SCHEMA_PANEL_LIMITS, SCHEMA_SYNTAX_LABELS, SCHEMA_URL_PROPERTIES, type SchemaView } from '@app/specs/schema-types.spec';
import { SEO_RULE_SPECS, SEO_SEVERITIES, type SeoSeverity } from '@app/specs/seo-rules.spec';
import { ChevronIcon, CodeIcon, CopyIcon, OpenTabIcon, RefIcon, SchemaArt, TreeIcon } from '../../icons';
import { actions } from '../../ipc';
import { entityIndex, errorExcerpt, firstShown, formatCount, moreShown, openableUrl, openByDefault, schemaTypeSummary, UNTYPED_LABEL } from '../../seo-view';
import { auditRef, Flash, PanelIssues, useFlash } from './actions';
import { PageText, RawText, SEVERITY_LABEL, SeverityGlyph } from './parts';

// Schema (acceptance `seo-schema.feature.md`, Panel): the page's structured data as main read it
// (`audit.schema`): a summary, the ranked `schema` issues, then one card per JSON-LD block and one per
// markup syntax, each an expandable entity tree with its issues on its nodes. Everything from the
// page is React text (`PageText`, `<pre>`); URLs are text with an "Open in new tab" button (main
// opens http(s) only); "Copy JSON" asks main to copy the block from its own audit.

const RULE_TITLES = new Map<string, string>(SEO_RULE_SPECS.map((spec) => [spec.id, spec.title]));
const URL_PROPERTIES: ReadonlySet<string> = new Set(SCHEMA_URL_PROPERTIES);
const SEVERITY_ORDER: Readonly<Record<SeoSeverity, number>> = { error: 0, warning: 1, info: 2 };
const STATUS_LABEL = { error: 'Errors to fix', warn: 'Warnings to review', pass: 'Structured data looks valid' } as const;
const BLOCK_STATUS_LABEL: Readonly<Record<SchemaBlock['status'], string>> = { valid: 'Valid JSON', invalid: 'Invalid JSON', cut: 'Too large to read' };

/** What every node of the tree needs: the whole tree by key and its issues by node. */
interface TreeContext {
  readonly index: ReadonlyMap<number, SchemaEntity>;
  readonly issues: ReadonlyMap<number, readonly SchemaIssue[]>;
  readonly flash: (message: string) => void;
}
const Tree = createContext<TreeContext | null>(null);
const useTree = (): TreeContext => useContext(Tree)!;

const plural = (n: number, one: string, many: string): string => `${formatCount(n)} ${n === 1 ? one : many}`;
const worstOf = (issues: readonly SchemaIssue[]): SeoSeverity | undefined => SEO_SEVERITIES.find((severity) => issues.some((issue) => issue.severity === severity));

/** An entity's label for its row: its `name`, else its `headline`, `alternateName`, `text`, `url` or `contentUrl`, else its `@id`. */
function nameOf(entity: SchemaEntity): string | null {
  for (const key of ['name', 'headline', 'alternateName', 'text', 'url', 'contentUrl']) {
    for (const property of entity.properties) {
      if (property.name !== key) continue;
      for (const value of property.values) if (value.kind === 'text' && value.json !== 'null' && value.text.trim() !== '') return value.text;
    }
  }
  return entity.id;
}

/** The first rows of a long list, and "Show more" for the next `step` (`SCHEMA_PANEL_LIMITS`). */
function useShown(total: number, step: number): [number, () => void] {
  const [shown, setShown] = useState(() => firstShown(total, step));
  return [Math.min(shown, total), () => setShown(moreShown(shown, total, step))];
}

function ShowMore({ shown, total, onMore, noun }: { readonly shown: number; readonly total: number; readonly onMore: () => void; readonly noun: string }) {
  if (shown >= total) return null;
  return (
    <button type="button" className="seo-show-more" data-testid="seo-schema-show-more" onClick={onMore}>
      Show more {noun} ({formatCount(total - shown)} hidden)
    </button>
  );
}

function TypeBadges({ types }: { readonly types: readonly string[] }) {
  if (types.length === 0) return <span className="seo-type-badge" data-untyped="true">{UNTYPED_LABEL}</span>;
  return (
    <>
      {types.slice(0, 3).map((type, i) => (
        <PageText key={i} value={type} className="seo-type-badge" testId="seo-entity-type" />
      ))}
      {types.length > 3 ? <span className="seo-type-badge seo-type-more">+{types.length - 3}</span> : null}
    </>
  );
}

/** A node's own issues, shown inline: severity, the rule's title and what is wrong. */
function NodeIssues({ issues }: { readonly issues: readonly SchemaIssue[] }) {
  if (issues.length === 0) return null;
  const sorted = [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return (
    <ul className="seo-node-issues" aria-label="Issues on this node">
      {sorted.map((issue, i) => (
        <li key={i} className="seo-node-issue" data-testid="seo-entity-issue" data-rule-id={issue.ruleId} data-severity={issue.severity}>
          <SeverityGlyph severity={issue.severity} />
          <span className="seo-node-issue-text">
            <span className="seo-node-issue-title">{RULE_TITLES.get(issue.ruleId) ?? issue.ruleId}</span>
            <PageText value={issue.detail} className="seo-node-issue-detail" lines={3} testId="seo-entity-issue-detail" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A text value; a URL (by property or by scheme) gets an "Open in new tab" button, enabled for http(s) only. */
function TextValue({ property, value }: { readonly property: string; readonly value: Extract<SchemaValue, { kind: 'text' }> }) {
  const { flash } = useTree();
  const text = value.text;
  // A URL property's value, an absolute URL (`scheme://`), or a script / data URL (shown, never openable).
  const urlLike = URL_PROPERTIES.has(property) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text.trim()) || /^(javascript|vbscript|data):/i.test(text.trim());
  const shown = value.length > text.length ? `${text}…` : text;
  if (!urlLike || value.json !== 'string') {
    return <PageText value={shown} className={`seo-value${value.json === 'string' ? '' : ' seo-value-literal seo-mono'}`} lines={3} testId="seo-prop-value" />;
  }
  const openable = openableUrl(text.trim());
  return (
    <span className="seo-value-url">
      <PageText value={shown} className="seo-value seo-mono" lines={2} testId="seo-prop-value" />
      <button
        type="button"
        className="seo-icon-action"
        data-testid="seo-schema-open-url"
        disabled={!openable}
        aria-label="Open in new tab"
        title={openable ? 'Open in new tab' : 'Only http and https addresses open in a tab'}
        onClick={() => void actions.openBackgroundTab(text.trim(), { inherit: true }).then((id) => flash(id === null ? 'Could not open a tab' : 'Opened in a background tab'))}
      >
        <OpenTabIcon />
      </button>
    </span>
  );
}

/** A reference by `@id`: its target's type and name; opening it shows the target here, unless it is already open above. */
function RefValue({ value, path }: { readonly value: Extract<SchemaValue, { kind: 'ref' }>; readonly path: readonly number[] }) {
  const { index } = useTree();
  const [open, setOpen] = useState(false);
  const target = value.target === null ? undefined : index.get(value.target);
  const above = target !== undefined && path.includes(target.key);
  const label = target ? [target.types.join(', ') || UNTYPED_LABEL, nameOf(target)].filter(Boolean).join(' · ') : 'Not on this page';
  return (
    <span className="seo-ref" data-testid="seo-ref" data-target={value.target ?? 'none'}>
      <button type="button" className="seo-ref-head" aria-expanded={target && !above ? open : undefined} disabled={!target || above} onClick={() => setOpen(!open)}>
        <RefIcon />
        <PageText value={value.id} className="seo-ref-id seo-mono" />
        <span className="seo-ref-target">{above ? 'Shown above' : label}</span>
      </button>
      {open && target && !above ? (
        <ul className="seo-entity-list seo-entity-nested">
          <EntityNode entity={target} path={path} defaultOpen />
        </ul>
      ) : null}
    </span>
  );
}

/** A property's values (`valuesShown` at first): text, references, and nested entities (closed). */
function PropValues({ name, values, path }: { readonly name: string; readonly values: readonly SchemaValue[]; readonly path: readonly number[] }) {
  const [shown, more] = useShown(values.length, SCHEMA_PANEL_LIMITS.valuesShown);
  return (
    <dd className="seo-prop-values">
      {values.slice(0, shown).map((value, j) =>
        value.kind === 'text' ? (
          <TextValue key={j} property={name} value={value} />
        ) : value.kind === 'ref' ? (
          <RefValue key={j} value={value} path={path} />
        ) : (
          <ul key={j} className="seo-entity-list seo-entity-nested">
            <EntityNode entity={value.entity} path={path} defaultOpen={false} />
          </ul>
        ),
      )}
      <ShowMore shown={shown} total={values.length} onMore={more} noun="values" />
    </dd>
  );
}

function EntityNode({ entity, path, defaultOpen }: { readonly entity: SchemaEntity; readonly path: readonly number[]; readonly defaultOpen: boolean }) {
  const { issues: byNode, index } = useTree();
  const [open, setOpen] = useState(defaultOpen);
  const issues = byNode.get(entity.key) ?? [];
  const worst = worstOf(issues);
  // A node describing part of a typed one (the same @id) is shown as adding to it.
  const extended = entity.extends === null ? undefined : index.get(entity.extends);
  const name = nameOf(entity) ?? (extended ? nameOf(extended) : null);
  const [rows, moreRows] = useShown(entity.properties.length, SCHEMA_PANEL_LIMITS.rowsShown);
  const inner = [...path, entity.key];
  return (
    <li className="seo-entity" data-testid="seo-entity" data-key={entity.key} data-types={entity.types.join(' ')} data-extends={entity.extends ?? undefined} data-syntax={entity.syntax} data-top={entity.topLevel} data-open={open} data-status={worst ?? 'pass'}>
      <button type="button" className="seo-entity-head" data-testid="seo-entity-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronIcon className="seo-chevron" />
        <span className="seo-entity-types">
          {extended ? (
            <span className="seo-type-badge seo-type-extends" data-testid="seo-entity-extends" title="Adds properties to the node with the same @id">
              + {extended.types.join(', ')}
            </span>
          ) : (
            <TypeBadges types={entity.types} />
          )}
        </span>
        {name !== null ? (
          <PageText value={name} className="seo-entity-name" testId="seo-entity-name" />
        ) : (
          <span className="seo-entity-name seo-missing">{entity.topLevel ? 'No name' : ''}</span>
        )}
        {issues.length > 0 ? (
          <span className="seo-badge" data-severity={worst} data-testid="seo-entity-issue-count" aria-label={plural(issues.length, 'issue', 'issues')}>
            {formatCount(issues.length)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="seo-entity-body">
          <NodeIssues issues={issues} />
          <dl className="seo-props">
            {entity.id !== null ? (
              <div className="seo-prop" data-testid="seo-prop" data-name="@id">
                <dt className="seo-prop-name seo-mono">@id</dt>
                <dd className="seo-prop-values">
                  <TextValue property="@id" value={{ kind: 'text', text: entity.id, length: entity.id.length, json: 'string' }} />
                </dd>
              </div>
            ) : null}
            {entity.properties.slice(0, rows).map((property, i) => (
              <div key={i} className="seo-prop" data-testid="seo-prop" data-name={property.name}>
                <dt className="seo-prop-name seo-mono">
                  <PageText value={property.name} />
                  {property.values.length > 1 ? <span className="seo-prop-count">{formatCount(property.values.length)}</span> : null}
                </dt>
                <PropValues name={property.name} values={property.values} path={inner} />
              </div>
            ))}
          </dl>
          <ShowMore shown={rows} total={entity.properties.length} onMore={moreRows} noun="properties" />
          {entity.properties.length === 0 && entity.id === null ? <p className="seo-empty-line">No properties.</p> : null}
        </div>
      ) : null}
    </li>
  );
}

/** A card's top-level nodes: the first `entitiesShown` (the first `openTopLevel` of them open), then "Show more". */
function EntityList({ entities, testId }: { readonly entities: readonly SchemaEntity[]; readonly testId?: string }) {
  const [shown, more] = useShown(entities.length, SCHEMA_PANEL_LIMITS.entitiesShown);
  if (entities.length === 0) return <p className="seo-empty-line">No nodes in it.</p>;
  return (
    <>
      <ul className="seo-entity-list" data-testid={testId}>
        {entities.slice(0, shown).map((entity, i) => (
          <EntityNode key={entity.key} entity={entity} path={[]} defaultOpen={openByDefault(i)} />
        ))}
      </ul>
      <ShowMore shown={shown} total={entities.length} onMore={more} noun="nodes" />
    </>
  );
}

/** A block's text: pretty-printed when it parsed; as written otherwise, with the error's character marked. */
function RawView({ block }: { readonly block: SchemaBlock }) {
  const pre = useRef<HTMLPreElement>(null);
  const mark = useRef<HTMLElement>(null);
  const pretty = useMemo(() => (block.status === 'valid' ? formatJson(block.text) : null), [block]);
  const error = block.status === 'invalid' ? block.error : null;
  // Bring the error into view inside the <pre> (not the whole panel).
  useEffect(() => {
    if (pre.current && mark.current) pre.current.scrollTop = Math.max(0, mark.current.offsetTop - pre.current.clientHeight / 2);
  }, [block]);
  if (pretty) {
    return (
      <>
        <pre className="seo-raw" data-testid="seo-schema-raw" ref={pre}>
          <RawText text={pretty.text} />
        </pre>
        {pretty.cut ? <p className="seo-note">Shortened for display; Copy JSON copies the same text.</p> : null}
      </>
    );
  }
  if (error) {
    const excerpt = errorExcerpt(block.text, error.offset);
    return (
      <>
        <p className="seo-raw-error" data-testid="seo-schema-error-location">
          <span className="seo-raw-error-at">
            Line {formatCount(error.line)}, column {formatCount(error.column)}
          </span>
          <PageText value={error.message} lines={2} />
        </p>
        <pre className="seo-raw" data-testid="seo-schema-raw" data-invalid="true" ref={pre}>
          <RawText text={excerpt.before} />
          <mark className="seo-raw-mark" data-testid="seo-schema-error-mark" data-end={excerpt.at === '' || excerpt.at === '\n'} ref={mark}>
            {excerpt.at === '' || excerpt.at === '\n' ? ' ' : <RawText text={excerpt.at} />}
          </mark>
          {excerpt.at === '\n' ? '\n' : null}
          <RawText text={excerpt.after} />
        </pre>
      </>
    );
  }
  return (
    <>
      <p className="seo-note">frost read the first {formatCount(block.text.length)} of its {formatCount(block.length)} characters and did not parse it.</p>
      {block.text !== '' ? (
        <pre className="seo-raw" data-testid="seo-schema-raw" ref={pre}>
          <RawText text={block.text} />
        </pre>
      ) : null}
    </>
  );
}

function BlockCard({ block, entities, issues, tab, audit }: { readonly block: SchemaBlock; readonly entities: readonly SchemaEntity[]; readonly issues: readonly SchemaIssue[]; readonly tab: TabState; readonly audit: SeoAudit }) {
  const { flash } = useTree();
  const [view, setView] = useState<SchemaView>(block.status === 'valid' ? 'tree' : 'raw');
  const own = issues.filter((issue) => issue.block === block.index && issue.entity === null);
  const types = schemaTypeSummary(entities);
  return (
    <section className="seo-section seo-schema-card" data-testid="seo-schema-block" data-block={block.index} data-status={block.status} data-view={view}>
      <header className="seo-section-head">
        <h3 className="seo-section-title">JSON-LD · Block {formatCount(block.index + 1)}</h3>
        <span className="seo-block-status" data-status={block.status} data-testid="seo-schema-block-status">
          {BLOCK_STATUS_LABEL[block.status]}
        </span>
      </header>
      {types.length > 0 ? (
        <p className="seo-block-types">
          {types.map((t) => `${t.type}${t.count > 1 ? ` ×${t.count}` : ''}`).join(' · ')} · {plural(block.length, 'character', 'characters')}
        </p>
      ) : null}
      <div className="seo-panel-tools seo-block-tools">
        <div className="seo-segmented seo-view-switch" role="group" aria-label="View">
          <button type="button" className="seo-segment" data-testid="seo-schema-view" data-view="tree" aria-pressed={view === 'tree'} disabled={block.status !== 'valid'} onClick={() => setView('tree')}>
            <TreeIcon />
            Tree
          </button>
          <button type="button" className="seo-segment" data-testid="seo-schema-view" data-view="raw" aria-pressed={view === 'raw'} onClick={() => setView('raw')}>
            <CodeIcon />
            Raw
          </button>
        </div>
        <button
          type="button"
          className="seo-toggle"
          data-testid="seo-schema-copy"
          disabled={block.text === ''}
          onClick={() =>
            void actions.copySchemaJson(tab.id, auditRef(audit), block.index).then((ok) => flash(!ok ? 'Nothing to copy' : block.status === 'cut' ? 'Partial text copied (the block was cut)' : 'JSON copied'))
          }
        >
          <CopyIcon />
          <span>Copy JSON</span>
        </button>
      </div>
      <NodeIssues issues={own} />
      {view === 'tree' && block.status === 'valid' ? <EntityList entities={entities} testId="seo-schema-tree" /> : <RawView block={block} />}
      {block.droppedKeys > 0 ? (
        <p className="seo-note" data-testid="seo-schema-dropped">
          Ignored {plural(block.droppedKeys, 'key', 'keys')} named __proto__, constructor or prototype.
        </p>
      ) : null}
    </section>
  );
}

function MarkupCard({ syntax, entities, read, total }: { readonly syntax: 'microdata' | 'rdfa'; readonly entities: readonly SchemaEntity[]; readonly read: number; readonly total: number }) {
  return (
    <section className="seo-section seo-schema-card" data-testid="seo-schema-markup" data-syntax={syntax}>
      <header className="seo-section-head">
        <h3 className="seo-section-title">{SCHEMA_SYNTAX_LABELS[syntax]}</h3>
        <span className="seo-badge">{plural(total, 'item', 'items')}</span>
      </header>
      {total > read ? <p className="seo-note seo-block-note">Showing the first {formatCount(read)} items of {formatCount(total)}.</p> : null}
      <EntityList entities={entities} testId={`seo-schema-tree-${syntax}`} />
    </section>
  );
}

/** The summary card: the panel's verdict and dot, entities by type, counts by syntax and by severity. */
function Summary({ audit }: { readonly audit: SeoAudit }) {
  const report = audit.schema;
  const status = panelStatus(audit.findings, ['schema']);
  const types = schemaTypeSummary(report.entities);
  const bySyntax = (['json-ld', 'microdata', 'rdfa'] as const).map((syntax) => [syntax, report.entities.filter((e) => e.syntax === syntax).length] as const);
  const severities = SEO_SEVERITIES.map((severity) => [severity, report.issues.filter((issue) => issue.severity === severity).length] as const);
  return (
    <section className="seo-section seo-schema-summary" data-testid="seo-schema-summary" data-status={status}>
      <div className="seo-schema-verdict">
        <span className="seo-status-dot" data-status={status} data-testid="seo-schema-status" aria-hidden="true" />
        <span className="seo-schema-verdict-text">{STATUS_LABEL[status]}</span>
        <span className="seo-badge" data-testid="seo-schema-entity-count" data-count={report.entityCount}>
          {plural(report.entityCount, 'node', 'nodes')}
        </span>
      </div>
      <ul className="seo-type-list" aria-label="Top-level nodes by type">
        {types.map((t) => (
          <li key={t.type} className="seo-type-count" data-testid="seo-schema-type" data-type={t.type} data-count={t.count}>
            <PageText value={t.type} className="seo-type-badge" />
            <span className="seo-type-count-n">{formatCount(t.count)}</span>
          </li>
        ))}
      </ul>
      <div className="seo-schema-meta">
        <span className="seo-schema-syntaxes" data-testid="seo-schema-syntaxes">
          {bySyntax.map(([syntax, n]) => `${SCHEMA_SYNTAX_LABELS[syntax]} ${formatCount(n)}`).join(' · ')}
        </span>
        <span className="seo-schema-severities">
          {severities.map(([severity, n]) => (
            <span key={severity} className="seo-schema-severity" data-severity={severity} data-testid={`seo-schema-count-${severity}`} data-count={n}>
              <SeverityGlyph severity={severity} />
              {formatCount(n)}
              <span className="visually-hidden"> {n === 1 ? SEVERITY_LABEL[severity][0] : SEVERITY_LABEL[severity][1]}</span>
            </span>
          ))}
        </span>
      </div>
    </section>
  );
}

export function Schema({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const [message, flash] = useFlash();
  const report = audit.schema;
  const tree = useMemo(() => {
    const issues = new Map<number, SchemaIssue[]>();
    for (const issue of report.issues) {
      if (issue.entity === null) continue;
      const list = issues.get(issue.entity);
      if (list) list.push(issue);
      else issues.set(issue.entity, [issue]);
    }
    return { index: entityIndex(report.entities), issues };
  }, [report]);
  const context: TreeContext = { ...tree, flash };
  const byBlock = (index: number) => report.entities.filter((entity) => entity.syntax === 'json-ld' && entity.block === index);
  const markup = (syntax: 'microdata' | 'rdfa') => report.entities.filter((entity) => entity.syntax === syntax);
  const none = report.blockTotal === 0 && report.markup.microdata.total === 0 && report.markup.rdfa.total === 0;
  return (
    <Tree.Provider value={context}>
      <div className="seo-schema" data-testid="seo-schema">
        {none ? (
          <div className="seo-hint seo-schema-empty" data-testid="seo-schema-none">
            <span className="seo-hint-art" aria-hidden="true">
              <SchemaArt />
            </span>
            <p className="seo-hint-title">No structured data</p>
            <p className="seo-hint-message">This page has no JSON-LD, microdata or RDFa. Describing its main entity with schema.org lets search engines show richer results.</p>
          </div>
        ) : (
          <Summary audit={audit} />
        )}
        <PanelIssues audit={audit} categories={['schema']} clean="No structured data issues found." />
        {report.blocks.map((block) => (
          <BlockCard key={`${audit.takenAt}:${block.index}`} block={block} entities={byBlock(block.index)} issues={report.issues} tab={tab} audit={audit} />
        ))}
        {report.blockTotal > report.blocks.length ? (
          <p className="seo-note" data-testid="seo-schema-blocks-capped">
            Showing the first {formatCount(report.blocks.length)} of {formatCount(report.blockTotal)} JSON-LD blocks.
          </p>
        ) : null}
        {report.markup.microdata.total > 0 ? <MarkupCard syntax="microdata" entities={markup('microdata')} read={report.markup.microdata.read} total={report.markup.microdata.total} /> : null}
        {report.markup.rdfa.total > 0 ? <MarkupCard syntax="rdfa" entities={markup('rdfa')} read={report.markup.rdfa.read} total={report.markup.rdfa.total} /> : null}
        <Flash message={message} testId="seo-schema-flash" />
      </div>
    </Tree.Provider>
  );
}
