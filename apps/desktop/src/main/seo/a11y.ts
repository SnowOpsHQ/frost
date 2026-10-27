import AXE_SOURCE from 'axe-core/axe.min.js?raw';
import { A11Y_DISABLED_RULES, A11Y_IMPACTS, A11Y_LIMITS, A11Y_PAGE_BUDGET_MS, A11Y_RULE_CHUNKS, A11Y_RUN_OPTIONS, A11Y_RUN_TAGS, A11Y_WORLD_ID, type A11yLimits } from '@app/specs/seo-compliance.spec';

// The accessibility check (spec `seo-compliance.spec.ts`, `A11Y_WORLD_ID`, `A11Y_RUN_TAGS`,
// `A11Y_DISABLED_RULES`, `A11Y_RUN_OPTIONS`, `A11Y_LIMITS`; acceptance `seo-compliance.feature.md`,
// Accessibility check). `axe-core` (MPL-2.0, unmodified) is bundled into main as a string
// (`axe.min.js?raw`) and injected, on request only, into the tab's own accessibility world
// (`executeJavaScriptInIsolatedWorld`), never the page's main world: the page cannot see `axe`, and
// its own globals and prototype changes (`Element.prototype.matches`, `document.querySelectorAll`
// …) never reach it, since the world has its own. It is injected once per document (a probe asks
// whether the world already has it). The run script (`runAxe` with `summariseAxe`, both
// self-contained and serialised) calls `axe.run` with frost's options and answers a capped summary;
// main then checks its size (`withinSize`) before keeping it, and the analysis worker validates it
// (`AccessibilityResultSchema`).

/** The parts of a tab's WebContents the check needs. */
export interface A11yTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

/**
 * The summary of `axe.run`'s `results` the panel needs, every list and string capped by `L`: the
 * violations worst impact first (an unknown impact is the mildest), each with its first elements
 * (selector and failure summary) and their count, and how many rules passed, were incomplete or
 * did not apply. Self-contained: it is serialised into the run script.
 */
export function summariseAxe(results: unknown, L: A11yLimits, impacts: readonly string[], url: string, ranAt: number, durationMs: number, partial = false): unknown {
  const cut = (s: string, max: number): string => {
    if (s.length <= max) return s;
    let end = max;
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return s.slice(0, end);
  };
  const str = (value: unknown, max: number): string => (typeof value === 'string' ? cut(value, max) : '');
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const field = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined);
  const count = (value: unknown): number => Math.min(list(value).length, L.maxRuleCount);
  const webUrl = (value: unknown): string => {
    const text = str(value, L.maxUrlChars);
    try {
      const parsed = new URL(text);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? text : '';
    } catch {
      return '';
    }
  };
  const impactOf = (rule: unknown): string => {
    const impact = field(rule, 'impact');
    return typeof impact === 'string' && impacts.includes(impact) ? impact : impacts[impacts.length - 1]!;
  };
  /** A node's target: its selectors, shadow-root steps joined with ` >>> `, frames with ` ⟫ `. */
  const selectorOf = (target: unknown): string =>
    list(target)
      .slice(0, 8)
      .map((part) => (Array.isArray(part) ? part.slice(0, 8).map((step) => str(step, L.maxSelectorChars)).join(' >>> ') : str(part, L.maxSelectorChars)))
      .join(' ⟫ ');
  const all = list(field(results, 'violations'));
  const ranked = all
    .map((rule, index) => ({ rule, index, rank: impacts.indexOf(impactOf(rule)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, L.maxRules);
  const violations = ranked.map(({ rule }) => {
    const nodes = list(field(rule, 'nodes'));
    return {
      id: str(field(rule, 'id'), L.maxIdChars) || 'unknown-rule',
      impact: impactOf(rule),
      help: str(field(rule, 'help'), L.maxHelpChars),
      description: str(field(rule, 'description'), L.maxDescriptionChars),
      helpUrl: webUrl(field(rule, 'helpUrl')),
      tags: list(field(rule, 'tags'))
        .slice(0, L.maxTags)
        .map((tag) => str(tag, L.maxTagChars)),
      nodes: nodes.slice(0, L.maxNodesPerRule).map((node) => ({ selector: cut(selectorOf(field(node, 'target')), L.maxSelectorChars), summary: str(field(node, 'failureSummary'), L.maxSummaryChars) })),
      nodeTotal: nodes.length,
    };
  });
  return {
    url: cut(url, L.maxUrlChars),
    axeVersion: str(field(field(results, 'testEngine'), 'version'), L.maxVersionChars),
    ranAt,
    durationMs: Math.max(0, durationMs),
    partial: partial === true,
    violations,
    violationTotal: Math.min(all.length, L.maxRuleCount),
    passes: count(field(results, 'passes')),
    incomplete: count(field(results, 'incomplete')),
    inapplicable: count(field(results, 'inapplicable')),
  };
}

/**
 * Runs axe on the world's `document` with frost's rules and options, and answers `summarise`'s
 * summary; `{ busy: true }` when an earlier, abandoned run is still going in this document.
 * Self-contained: it is serialised into the run script.
 */
export async function runAxe(
  L: A11yLimits,
  tags: readonly string[],
  disabled: readonly string[],
  options: Record<string, unknown>,
  impacts: readonly string[],
  chunks: number,
  budgetMs: number,
  summarise: typeof summariseAxe,
): Promise<unknown> {
  type AxeResults = { violations?: unknown[]; passes?: unknown[]; incomplete?: unknown[]; inapplicable?: unknown[]; testEngine?: unknown };
  const axe = (
    globalThis as {
      axe?: { run: (context: unknown, options: unknown) => Promise<AxeResults>; configure: (spec: unknown) => void; getRules: (tags?: string[]) => { ruleId: string; tags: string[] }[]; _running?: boolean };
    }
  ).axe;
  if (!axe || typeof axe.run !== 'function') throw new Error('axe is not loaded');
  if (axe._running === true) return { busy: true };
  axe.configure({ noHtml: true });
  const ranAt = Date.now();
  const started = performance.now();
  // The rules the tags select, as a tag run would (experimental and deprecated ones stay off), minus
  // the disabled ones, run a chunk at a time: axe cannot be stopped, so the deadline is checked between chunks.
  const ids = axe
    .getRules([...tags])
    .filter((rule) => !rule.tags.includes('experimental') && !rule.tags.includes('deprecated') && !disabled.includes(rule.ruleId))
    .map((rule) => rule.ruleId);
  const size = Math.max(1, Math.ceil(ids.length / Math.max(1, chunks)));
  const merged: Required<AxeResults> = { violations: [], passes: [], incomplete: [], inapplicable: [], testEngine: undefined };
  let partial = false;
  for (let from = 0; from < ids.length; from += size) {
    if (from > 0 && performance.now() - started >= budgetMs) {
      partial = true;
      break;
    }
    let results: AxeResults;
    try {
      results = await axe.run(document, { ...options, runOnly: { type: 'rule', values: ids.slice(from, from + size) } });
    } catch (error) {
      if (String(error).includes('already running')) return { busy: true };
      throw error;
    }
    for (const key of ['violations', 'passes', 'incomplete', 'inapplicable'] as const) {
      const list = results[key];
      if (Array.isArray(list)) for (const item of list) merged[key].push(item);
    }
    merged.testEngine = results.testEngine;
  }
  return summarise(merged, L, impacts, document.URL, ranAt, performance.now() - started, partial);
}

/**
 * Whether the world already has axe (answers `true` or `false`). The page's scripts cannot reach this
 * world, but its DOM can still put a named property there (an element with `id="axe"`); that one has
 * no `run` function, so the probe says no and axe is injected over it.
 */
export const AXE_PROBE = "typeof axe === 'object' && axe !== null && typeof axe.run === 'function'";

/** axe's source as injected: its value is never read back (`void 0`: no large result to convert). */
export const AXE_SCRIPT = `${AXE_SOURCE}\n;void 0;`;

/** The run script: `runAxe` with frost's limits, tags, disabled rules, options and impacts. */
/** The run script: `runAxe` with frost's limits, tags, disabled rules, options, impacts, chunks and its own deadline (`budgetMs`). */
export function buildRunScript(budgetMs: number = A11Y_PAGE_BUDGET_MS): string {
  return `(${runAxe.toString()})(${JSON.stringify(A11Y_LIMITS)}, ${JSON.stringify(A11Y_RUN_TAGS)}, ${JSON.stringify(A11Y_DISABLED_RULES)}, ${JSON.stringify(A11Y_RUN_OPTIONS)}, ${JSON.stringify(A11Y_IMPACTS)}, ${A11Y_RULE_CHUNKS}, ${budgetMs}, (${summariseAxe.toString()}))`;
}
export const A11Y_RUN_SCRIPT = buildRunScript();

/**
 * Runs the check in `contents`' accessibility world (axe injected first if the world lacks it);
 * resolves the run script's (untrusted, unvalidated) answer, or rejects if a script failed.
 */
export async function runAccessibilityCheck(contents: A11yTarget, stillCurrent: () => boolean = () => true): Promise<unknown> {
  // Each step answers asynchronously: the page may have moved on to another document meanwhile.
  const check = (): void => {
    if (!stillCurrent()) throw new Error('the document changed: check aborted');
  };
  const loaded = await contents.executeJavaScriptInIsolatedWorld(A11Y_WORLD_ID, [{ code: AXE_PROBE }]);
  check();
  if (loaded !== true) {
    await contents.executeJavaScriptInIsolatedWorld(A11Y_WORLD_ID, [{ code: AXE_SCRIPT }]);
    check();
  }
  return contents.executeJavaScriptInIsolatedWorld(A11Y_WORLD_ID, [{ code: A11Y_RUN_SCRIPT }]);
}

/**
 * Main's size check of a raw answer before it keeps it (it never parses it): a bounded walk that
 * stops as soon as more than `maxNodes` values (objects, arrays, strings, numbers …) or `maxChars`
 * characters of strings (keys included) have been seen. `false` past either.
 */
export function withinSize(value: unknown, maxChars: number = A11Y_LIMITS.maxResultChars, maxNodes: number = A11Y_LIMITS.maxResultNodes): boolean {
  const stack: unknown[] = [value];
  let nodes = 0;
  let chars = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    nodes += 1;
    if (nodes > maxNodes) return false;
    if (typeof next === 'string') {
      chars += next.length;
      if (chars > maxChars) return false;
    } else if (Array.isArray(next)) {
      if (nodes + stack.length + next.length > maxNodes) return false;
      for (const item of next) stack.push(item);
    } else if (typeof next === 'object' && next !== null) {
      const keys = Object.keys(next);
      if (nodes + stack.length + keys.length > maxNodes) return false;
      for (const key of keys) {
        chars += key.length;
        stack.push((next as Record<string, unknown>)[key]);
      }
      if (chars > maxChars) return false;
    }
  }
  return true;
}
