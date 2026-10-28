import { createHash } from 'node:crypto';
import { defaultTreeAdapter, Parser, type DefaultTreeAdapterMap, type TreeAdapter } from 'parse5';
import { parseLinkHeader } from '@app/seo-core';
import { SERVED_PARSE_LIMITS } from '@app/specs/seo-javascript.spec';
import { ROBOTS_META_NAMES, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { RobotsFetchSchema } from '@app/specs/seo-snapshot.spec';
import { PROBE_AGENTS, probeAgent } from '@app/specs/visibility-probes.spec';
import { ProbeJobSchema, ProbePageAnswerSchema, ProbeRobotsAnswerSchema, type ProbeJobResult, type ProbePageAnswer, type ProbePageJob } from '@app/specs/visibility-probes.schema';
import { decodeServed, parseServedHtml } from '../seo/served-parse';
import { agentDirectives, robotsVerdicts, xRobotsTags, type ProbeMeta } from './probe-compare';

// The SERP worker's probe jobs (spec `visibility-probes.spec.ts`, How a run goes and Reading an
// agent's answer; acceptance `visibility-probes.feature.md`, `probes-page-facts`). Runs only in the
// SERP worker (`serp-worker.ts`, `kind: 'probe'`), never on main's thread: every job is validated with
// `ProbeJobSchema` first and every answer with its schema before it leaves.
// - `robots`: the page origin's robots.txt as main's cached fetcher answered it (checked as
//   `RobotsFetchSchema`), decided for every agent's token (`robotsVerdicts`).
// - `page`: one agent's answer. Its headers are read for every answer (`X-Robots-Tag`, a `Link`
//   canonical); a 2xx HTML body (`html`) is also parsed twice, each bounded by `SERVED_PARSE_LIMITS`:
//   by the served-HTML parse (`parseServedHtml`, so the title, canonical and word count are the
//   JavaScript panel's), and by a walk of this file's own over a `parse5` tree for the visible text
//   (hashed) and the `<meta name>` values of every probed agent (the served snapshot keeps only the
//   search engines'). The walk reads the text exactly as the served word count does: the body, the
//   same subtrees left out (`script`, `style`, `noscript`, `template`, `svg`, `math`, `iframe`,
//   `object`, `[hidden]`), the same node and character budgets; the text nodes are joined with
//   spaces, whitespace collapsed and trimmed, and hashed with sha256.

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type ChildNode = DefaultTreeAdapterMap['childNode'];

const XHTML = 'http://www.w3.org/1999/xhtml';
const STOP = Symbol('probe-parse-cap');
/** The subtrees the served word count leaves out (`served-parse.ts`). */
const SKIP = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object'];
/** The meta names read by this walk: every probed agent's that the served snapshot does not keep. */
const EXTRA_META_NAMES: ReadonlySet<string> = new Set(PROBE_AGENTS.flatMap((agent) => agent.metaNames).filter((name) => !(ROBOTS_META_NAMES as readonly string[]).includes(name)));
/** `<meta>` tags kept per name (as the served snapshot's `maxRepeated`). */
const MAX_METAS = SNAPSHOT_LIMITS.maxRepeated * EXTRA_META_NAMES.size;

interface Budget {
  nodes: number;
  hit: boolean;
}

/** `defaultTreeAdapter`, counting the nodes it creates and how deep it attaches them; past either cap the parse stops (`STOP`). */
function boundedAdapter(budget: Budget): TreeAdapter<DefaultTreeAdapterMap> {
  const depth = new WeakMap<object, number>();
  const templateOf = new WeakMap<object, object>();
  const levelOf = (node: object): number => depth.get(node) ?? (templateOf.has(node) ? levelOf(templateOf.get(node)!) : 0);
  const count = (): void => {
    budget.nodes += 1;
    if (budget.nodes > SERVED_PARSE_LIMITS.maxNodes) {
      budget.hit = true;
      throw STOP;
    }
  };
  const attach = (parent: ParentNode, child: ChildNode): void => {
    const level = levelOf(parent) + 1;
    if (level > SERVED_PARSE_LIMITS.maxDepth) {
      budget.hit = true;
      throw STOP;
    }
    depth.set(child, level);
  };
  const endsWithText = (parent: ParentNode, before?: ChildNode): boolean => {
    const nodes = parent.childNodes;
    const prev = before === undefined ? nodes[nodes.length - 1] : nodes[nodes.indexOf(before) - 1];
    return prev !== undefined && defaultTreeAdapter.isTextNode(prev);
  };
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      count();
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs.length > SERVED_PARSE_LIMITS.maxAttributes ? attrs.slice(0, SERVED_PARSE_LIMITS.maxAttributes) : attrs);
    },
    setTemplateContent(template, content) {
      templateOf.set(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
    createCommentNode(data) {
      count();
      return defaultTreeAdapter.createCommentNode(data);
    },
    appendChild(parent, node) {
      attach(parent, node);
      defaultTreeAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, reference) {
      attach(parent, node);
      defaultTreeAdapter.insertBefore(parent, node, reference);
    },
    insertText(parent, text) {
      if (!endsWithText(parent)) count();
      defaultTreeAdapter.insertText(parent, text);
    },
    insertTextBefore(parent, text, reference) {
      if (!endsWithText(parent, reference)) count();
      defaultTreeAdapter.insertTextBefore(parent, text, reference);
    },
  };
}

/** Keeps at most `maxAttributes` attributes of a tag in the tokenizer (as the served parse does; parse5 internals, checked at runtime). */
function capAttributes(parser: Parser<DefaultTreeAdapterMap>): void {
  const tokenizer = parser.tokenizer as unknown as { currentToken: { readonly attrs?: readonly unknown[] } | null; _leaveAttrName(): void };
  const leave = tokenizer._leaveAttrName;
  if (typeof leave !== 'function') return;
  tokenizer._leaveAttrName = function (this: typeof tokenizer) {
    if ((this.currentToken?.attrs?.length ?? 0) >= SERVED_PARSE_LIMITS.maxAttributes) return;
    leave.call(this);
  };
}

const isElement = (node: Node): node is Element => 'tagName' in node;
const childrenOf = (node: Node): readonly ChildNode[] => ('childNodes' in node ? node.childNodes : []);
const attr = (el: Element, name: string): string | null => {
  for (const a of el.attrs) if (a.name === name && !a.namespace) return a.value;
  return null;
};
const childNamed = (node: Node | null, name: string): Element | null => (node ? (childrenOf(node).find((child): child is Element => isElement(child) && child.namespaceURI === XHTML && child.tagName === name) ?? null) : null);

function* walk(root: Node, skip?: (el: Element) => boolean): Generator<Node> {
  const stack: Node[] = [...childrenOf(root)].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node) && skip?.(node)) continue;
    yield node;
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
}

/** The body's visible text (as the served word count reads it), whitespace collapsed, and the extra agents' meta tags. */
export function readVisible(html: string): { text: string; truncated: boolean; partial: boolean; metas: ProbeMeta[] } {
  const budget: Budget = { nodes: 0, hit: false };
  const adapter = boundedAdapter(budget);
  let document: Node | null = null;
  const parser = new Parser<DefaultTreeAdapterMap>({
    treeAdapter: {
      ...adapter,
      createDocument() {
        const created = adapter.createDocument();
        document = created;
        return created;
      },
    },
    scriptingEnabled: true,
  });
  capAttributes(parser);
  try {
    parser.tokenizer.write(html, true);
  } catch (error) {
    if (error !== STOP) throw error;
  }
  const root = document as Node | null;
  if (root === null) return { text: '', truncated: false, partial: budget.hit, metas: [] };
  const metas: ProbeMeta[] = [];
  for (const node of walk(root)) {
    if (metas.length >= MAX_METAS) break;
    if (!isElement(node) || node.namespaceURI !== XHTML || node.tagName !== 'meta') continue;
    const raw = attr(node, 'name');
    const name = raw === null ? '' : raw.toLowerCase();
    if (raw !== null && EXTRA_META_NAMES.has(name)) metas.push({ name, content: (attr(node, 'content') ?? '').slice(0, SNAPSHOT_LIMITS.maxAttributeChars * 4).toLowerCase() });
  }
  const body = childNamed(childNamed(root, 'html'), 'body');
  const L = SNAPSHOT_LIMITS;
  const parts: string[] = [];
  let truncated = false;
  if (body) {
    let textNodes = 0;
    let scanned = 0;
    let visited = 0;
    const skipped = (el: Element): boolean => SKIP.includes(el.tagName) || attr(el, 'hidden') !== null;
    for (const node of walk(body, skipped)) {
      visited += 1;
      if (textNodes >= L.maxTextNodes || scanned >= L.maxTextScanChars || visited > L.maxTextNodes * 4) {
        truncated = true;
        break;
      }
      if (node.nodeName !== '#text') continue;
      const value = (node as DefaultTreeAdapterMap['textNode']).value;
      textNodes += 1;
      const take = Math.min(value.length, L.maxTextScanChars - scanned);
      scanned += take;
      parts.push(value.slice(0, take));
    }
  }
  return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), truncated, partial: budget.hit, metas };
}

/** sha256 (hex) of `text` as UTF-8. */
export const textHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The canonical a `Link` header names (resolved against `url`), if any. */
function headerCanonical(link: string | null, url: string): string | null {
  if (link === null) return null;
  const value = parseLinkHeader(link, SNAPSHOT_LIMITS.maxHreflang).find((candidate) => candidate.rel.includes('canonical'));
  if (!value) return null;
  try {
    const href = new URL(value.target, url).href;
    return href.length <= SNAPSHOT_LIMITS.maxUrlChars ? href : null;
  } catch {
    return null;
  }
}

/** One agent's answer read (`ProbePageAnswer`); `null` when its body could not be parsed. */
function readPage(job: ProbePageJob): ProbePageAnswer | null {
  const agent = probeAgent(job.agent);
  const tags = xRobotsTags(job.xRobotsTag);
  const fromHeader = headerCanonical(job.link, job.url);
  if (!job.html) {
    const verdicts = agentDirectives(agent, null, tags);
    return { kind: 'page', ...verdicts, canonical: null, title: null, wordCount: null, textHash: null, textTruncated: false, partial: false };
  }
  const served = parseServedHtml({ url: job.url, contentType: job.contentType, body: job.body, scriptingEnabled: true });
  if (!served.ok) return null;
  const visible = readVisible(decodeServed(job.body, job.contentType, SERVED_PARSE_LIMITS.prescanBytes));
  const snapshot = served.snapshot;
  // The served snapshot's robots metas for the names it keeps, this walk's for the rest.
  const metas: ProbeMeta[] = [...snapshot.metaRobots.map((meta) => ({ name: meta.name, content: meta.content })), ...visible.metas];
  const verdicts = agentDirectives(agent, metas, tags);
  const first = snapshot.canonicals[0];
  const canonical = first ? (first.resolved ?? (first.href === '' ? null : first.href)) : fromHeader;
  // The hash covers the text the word count read (`countWords` over the same walk and budgets).
  return {
    kind: 'page',
    ...verdicts,
    canonical,
    title: snapshot.titles[0]?.text ?? null,
    wordCount: snapshot.wordCount,
    textHash: textHash(visible.text),
    textTruncated: snapshot.textTruncated || visible.truncated,
    partial: snapshot.partial || visible.partial,
  };
}

/** Validates and runs one probe job (`ProbeJobSchema`). Never throws. */
export function runProbeJob(raw: unknown): ProbeJobResult {
  let job;
  try {
    const parsed = ProbeJobSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'invalid-job' };
    job = parsed.data;
  } catch {
    return { ok: false, reason: 'invalid-job' };
  }
  try {
    if (job.kind === 'robots') {
      const fetched = RobotsFetchSchema.safeParse(job.robots);
      const answer = ProbeRobotsAnswerSchema.safeParse(robotsVerdicts(fetched.success ? fetched.data : null, job.url));
      return answer.success ? { ok: true, answer: answer.data } : { ok: false, reason: 'parse-failed' };
    }
    const read = readPage(job);
    if (read === null) return { ok: false, reason: 'parse-failed' };
    const answer = ProbePageAnswerSchema.safeParse(read);
    return answer.success ? { ok: true, answer: answer.data } : { ok: false, reason: 'parse-failed' };
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
}
