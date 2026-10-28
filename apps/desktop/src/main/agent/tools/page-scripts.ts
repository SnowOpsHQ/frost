import { AGENT_JS_WORLD_ID, AGENT_PAGE_WORLD_ID, CLICK_LIMITS, CLICKABLE_SELECTOR, EXECUTE_JS_LIMITS, EXECUTE_JS_MARK_KEY, PAGE_TITLE_MAX_CHARS } from '@app/specs/agent-page-tools.spec';

// The agent's in-page scripts (Phase 5 Task 5; spec `specs/agent-page-tools.spec.ts`, acceptance
// `specs/agent-page-tools.feature.md`). Each is one self-contained function, serialised with
// `toString()` into a fixed template and run with `executeJavaScriptInIsolatedWorld`: `click` and
// `page_text` in `AGENT_PAGE_WORLD_ID`, `execute_javascript` in `AGENT_JS_WORLD_ID`. Never the main
// world: the page's scripts can't see or change them, and they read only the DOM (no cookies, no
// storage, no page globals).
//
// Rules every script keeps:
// - Its arguments are data: one JSON object literal (`JSON.stringify`) after the function, so a
//   selector, a text or code holding quotes, backslashes or `</script>` is a string value, never
//   source. Nothing model- or user-written is concatenated into code.
// - Its first act is the page check (`location.origin`, and for an approved call
//   `location.origin + location.pathname + location.search`, against what the broker decided on).
//   It reads only `Location`'s unforgeable own attributes and compares with `===` and `+`, so
//   nothing earlier in the same world can fake it. A mismatch reads and does nothing.
// - It answers one JSON string (built in-page, bounded), so its answer is always cloneable;
//   main parses and checks it (`parsePageAnswer`).

// ---- Structural DOM types (main has no DOM lib) -----------------------------------------------

interface PageLocation {
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
}
interface PageElement {
  readonly localName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  closest(selectors: string): PageElement | null;
  querySelector(selectors: string): PageElement | null;
  scrollIntoView?(options?: unknown): void;
  click?(): void;
  dispatchEvent(event: unknown): boolean;
  checkVisibility?(): boolean;
  readonly href?: unknown;
  readonly value?: unknown;
  readonly innerText?: unknown;
}
interface PageTreeWalker {
  nextNode(): { readonly nodeValue: string | null } | null;
}
interface PageDocument {
  readonly body: PageElement | null;
  readonly title: string;
  readonly defaultView: { MouseEvent: new (type: string, init: unknown) => unknown } | null;
  querySelector(selectors: string): PageElement | null;
  querySelectorAll(selectors: string): { readonly length: number; item(index: number): PageElement | null };
  createTreeWalker(root: PageElement, whatToShow: number): PageTreeWalker;
}

/** What every script is told about the page it must find. */
export interface PageExpectation {
  /** `location.origin` must equal it. */
  readonly origin: string;
  /** `null`: the origin is enough (`via: 'read'` / `'grant'`); else the exact page (`pageKeyOf`). */
  readonly pageKey: string | null;
}

// ---- page_text ---------------------------------------------------------------------------------

export interface PageTextArgs extends PageExpectation {
  readonly maxChars: number;
  readonly maxTitleChars: number;
}

/**
 * `page_text` in the page: the body's rendered text (`innerText`; `textContent` where a DOM has no
 * layout), blank runs folded, cut at `maxChars` without splitting a surrogate pair. Answers
 * `{ status: 'ok', text, totalChars, truncated, title }` or `{ status: 'mismatch' }`.
 */
export function pageTextInPage(doc: PageDocument, loc: PageLocation, args: PageTextArgs): string {
  if (loc.origin !== args.origin || (args.pageKey !== null && loc.origin + loc.pathname + loc.search !== args.pageKey)) return '{"status":"mismatch"}';
  const cut = (text: string, max: number): string => {
    if (text.length <= max) return text;
    let end = max;
    const last = text.charCodeAt(end - 1);
    if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    return text.slice(0, end);
  };
  const body = doc.body;
  let raw = '';
  if (body !== null) {
    const inner = body.innerText;
    raw = typeof inner === 'string' ? inner : (body.textContent ?? '');
  }
  // Fold blank runs on a bounded prefix only (the regexes never see more than a few times maxChars).
  const scanned = cut(raw, args.maxChars * 4 + 64);
  const folded = scanned
    .replace(/[ \t\f\v ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t\f\v ]{2,}/g, ' ')
    .trim();
  const text = cut(folded, args.maxChars);
  const truncated = text.length < folded.length || scanned.length < raw.length;
  return JSON.stringify({ status: 'ok', text, totalChars: raw.length, truncated, title: cut(doc.title, args.maxTitleChars) });
}

// ---- click -------------------------------------------------------------------------------------

export interface ClickArgs extends PageExpectation {
  /** Exactly one of `selector` and `text` is a string. */
  readonly selector: string | null;
  readonly text: string | null;
  readonly clickable: string;
  readonly maxScanElements: number;
  readonly maxNameNodeVisits: number;
  readonly maxNameChars: number;
  readonly maxHrefChars: number;
}

/**
 * `click` in the page: finds the element by `selector` (`querySelector`, an invalid selector caught)
 * or by visible `text` among `clickable` elements (at most `maxScanElements`, in document order):
 * an exact match of its name (whitespace folded) first, else the first whose name contains the text,
 * case aside; hidden elements are skipped. Scrolls it into view, clicks it (no user gesture), and
 * answers what it clicked: `{ status: 'clicked', element: { tag, role, name, href, visible },
 * matchedBy }`, or `{ status: 'not-found' | 'bad-selector' | 'mismatch' }`.
 */
export function clickInPage(doc: PageDocument, loc: PageLocation, args: ClickArgs): string {
  if (loc.origin !== args.origin || (args.pageKey !== null && loc.origin + loc.pathname + loc.search !== args.pageKey)) return '{"status":"mismatch"}';
  const fold = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const clip = (text: string, max: number): string => {
    if (text.length <= max) return text;
    let end = max;
    const last = text.charCodeAt(end - 1);
    if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    return text.slice(0, end);
  };
  /** The element's text, read node by node within the visit and character budgets. */
  const textOf = (el: PageElement): string => {
    let out = '';
    let visits = 0;
    const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node !== null && visits < args.maxNameNodeVisits && out.length < args.maxNameChars * 2; node = walker.nextNode()) {
      visits += 1;
      out += ` ${clip(node.nodeValue ?? '', args.maxNameChars * 2)}`;
    }
    return fold(out);
  };
  /** A short accessible-ish name: `aria-label`, an input's value, its text, `title`, an image's `alt`. */
  const nameOf = (el: PageElement): string => {
    const aria = el.getAttribute('aria-label');
    if (aria !== null && fold(aria) !== '') return clip(fold(aria), args.maxNameChars);
    if (el.localName === 'input') {
      const value = typeof el.value === 'string' ? fold(el.value) : '';
      if (value !== '') return clip(value, args.maxNameChars);
    }
    const text = textOf(el);
    if (text !== '') return clip(text, args.maxNameChars);
    const title = el.getAttribute('title');
    if (title !== null && fold(title) !== '') return clip(fold(title), args.maxNameChars);
    const img = el.querySelector('img[alt]');
    const alt = img === null ? null : img.getAttribute('alt');
    return alt === null ? '' : clip(fold(alt), args.maxNameChars);
  };
  const visible = (el: PageElement): boolean => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.closest('[hidden]') === null);
  const implicitRole = (el: PageElement): string | null => {
    const tag = el.localName;
    if ((tag === 'a' || tag === 'area') && el.getAttribute('href') !== null) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      return 'textbox';
    }
    return null;
  };

  let target: PageElement | null = null;
  let matchedBy = 'selector';
  if (args.selector !== null) {
    try {
      target = doc.querySelector(args.selector);
    } catch {
      return '{"status":"bad-selector"}';
    }
  } else if (args.text !== null) {
    const want = fold(args.text);
    const lower = want.toLowerCase();
    const list = doc.querySelectorAll(args.clickable);
    const count = Math.min(list.length, args.maxScanElements);
    let contains: PageElement | null = null;
    for (let i = 0; i < count; i += 1) {
      const el = list.item(i);
      if (el === null || !visible(el)) continue;
      const name = nameOf(el);
      if (name === want) {
        target = el;
        matchedBy = 'text-exact';
        break;
      }
      if (contains === null && name.toLowerCase().includes(lower)) contains = el;
    }
    if (target === null && contains !== null) {
      target = contains;
      matchedBy = 'text-contains';
    }
  }
  if (target === null) return '{"status":"not-found"}';

  const role = target.getAttribute('role') ?? implicitRole(target);
  const href = typeof target.href === 'string' && target.href !== '' ? clip(target.href, args.maxHrefChars) : null;
  const element = { tag: target.localName, role, name: nameOf(target), href, visible: visible(target) };
  try {
    target.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  } catch {
    // Scrolling is a courtesy; the click still happens.
  }
  try {
    if (typeof target.click === 'function') target.click();
    else if (doc.defaultView !== null) target.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView }));
  } catch {
    return '{"status":"click-failed"}';
  }
  return JSON.stringify({ status: 'clicked', element, matchedBy });
}

// ---- execute_javascript ----------------------------------------------------------------------

export interface ExecuteArgs extends PageExpectation {
  readonly code: string;
  readonly maxResultBytes: number;
  readonly maxDepth: number;
  readonly maxErrorChars: number;
  readonly maxNodeChars: number;
  readonly markKey: string;
}

/**
 * `execute_javascript` in `AGENT_JS_WORLD_ID`: checks the page first, then compiles the approved
 * code from its string (after the check, so nothing in it runs on another page) and runs it:
 * - as an expression, if it is one (`document.title`, `fetchSomething().then(…)`, `await x`);
 * - else as a script, answering its completion value (the value of its last expression statement;
 *   a promise is awaited) if it parses as one (a marker call before the code tells a parse failure
 *   from an error thrown while running, so the code never runs twice);
 * - else (top-level `await` or `return`) as the body of an async function, answering what it returns.
 *
 * The value is written as JSON in-page, at most `maxResultBytes` of UTF-8 (cut there, `truncated`):
 * `undefined`, functions and symbols as `null` (dropped from objects), bigints as strings, DOM nodes
 * described (`<a id="…">`), cycles `"[Circular]"`, nesting past `maxDepth` `"[Too deep]"`, getters
 * that throw skipped. Answers `{ status: 'ok', type, json, truncated, bytes }`,
 * `{ status: 'error', error }` (`name: message`, at most `maxErrorChars`) or `{ status: 'mismatch' }`.
 */
export async function executeInPage(loc: PageLocation, args: ExecuteArgs): Promise<string> {
  if (loc.origin !== args.origin || (args.pageKey !== null && loc.origin + loc.pathname + loc.search !== args.pageKey)) return '{"status":"mismatch"}';
  // Captured before the code runs: what it changes in this world can't change how its answer is written.
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const keysOf = Object.keys;
  const isFiniteNumber = Number.isFinite;
  const toText = String;
  const global = globalThis as unknown as Record<string, unknown>;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...params: string[]) => () => Promise<unknown>;
  const SyncFunction = Function;
  const indirectEval = eval;

  const describeError = (error: unknown): string => {
    let text: string;
    try {
      if (error !== null && typeof error === 'object') {
        const name = typeof (error as { name?: unknown }).name === 'string' ? (error as { name: string }).name : 'Error';
        const message = typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '';
        text = message === '' ? name : `${name}: ${message}`;
      } else {
        text = `Thrown: ${toText(error)}`;
      }
    } catch {
      text = 'Error';
    }
    return text.length > args.maxErrorChars ? text.slice(0, args.maxErrorChars) : text;
  };

  const run = async (): Promise<unknown> => {
    let expression: (() => Promise<unknown>) | null = null;
    try {
      expression = new AsyncFunction(`return (\n${args.code}\n);`);
    } catch {
      expression = null;
    }
    if (expression !== null) return expression.call(undefined);
    let script = true;
    try {
      // Parse only: a sync function body takes what a script takes, plus `return`.
      SyncFunction(args.code);
    } catch {
      script = false;
    }
    if (script) {
      let started = false;
      global[args.markKey] = () => {
        started = true;
      };
      try {
        const value: unknown = indirectEval(`${args.markKey}();\n${args.code}`);
        delete global[args.markKey];
        return await value;
      } catch (error) {
        delete global[args.markKey];
        if (started) throw error;
        // It didn't parse as a script (a top-level `return`): nothing ran; run it as a function body.
      }
    }
    return new AsyncFunction(args.code).call(undefined);
  };

  let value: unknown;
  try {
    value = await run();
  } catch (error) {
    return stringify({ status: 'error', error: describeError(error) });
  }

  // ---- Bounded JSON ----
  const max = args.maxResultBytes;
  const parts: string[] = [];
  let bytes = 0;
  let truncated = false;
  const utf8 = (text: string): number => {
    let n = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    }
    return n;
  };
  const emit = (piece: string): boolean => {
    if (truncated) return false;
    const n = utf8(piece);
    if (bytes + n <= max) {
      parts.push(piece);
      bytes += n;
      return true;
    }
    // The part that fits, never half a surrogate pair.
    let end = 0;
    let used = 0;
    while (end < piece.length) {
      const c = piece.charCodeAt(end);
      const pair = c >= 0xd800 && c <= 0xdbff && end + 1 < piece.length;
      const size = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
      if (bytes + used + size > max) break;
      used += size;
      end += pair ? 2 : 1;
    }
    parts.push(piece.slice(0, end));
    bytes += used;
    truncated = true;
    return false;
  };
  const isNode = (candidate: object): boolean => {
    try {
      return typeof (candidate as { nodeType?: unknown }).nodeType === 'number' && typeof (candidate as { nodeName?: unknown }).nodeName === 'string';
    } catch {
      return false;
    }
  };
  const describeNode = (node: object): string => {
    let text: string;
    try {
      const el = node as { nodeType: number; nodeName: string; localName?: unknown; id?: unknown; getAttribute?: (name: string) => string | null; nodeValue?: unknown };
      if (el.nodeType === 1 && typeof el.localName === 'string') {
        const id = typeof el.id === 'string' && el.id !== '' ? ` id="${el.id}"` : '';
        const cls = typeof el.getAttribute === 'function' ? el.getAttribute('class') : null;
        text = `<${el.localName}${id}${cls ? ` class="${cls}"` : ''}>`;
      } else if (el.nodeType === 3) {
        text = `#text ${stringify(typeof el.nodeValue === 'string' ? el.nodeValue.slice(0, args.maxNodeChars) : '')}`;
      } else {
        text = el.nodeName;
      }
    } catch {
      text = '[node]';
    }
    return text.length > args.maxNodeChars ? text.slice(0, args.maxNodeChars) : text;
  };
  const ancestors: object[] = [];
  const write = (item: unknown, depth: number): boolean => {
    if (truncated) return false;
    if (item === null) return emit('null');
    switch (typeof item) {
      case 'string':
        return emit(stringify(item.length > max ? item.slice(0, max) : item));
      case 'number':
        return emit(isFiniteNumber(item) ? stringify(item) : 'null');
      case 'boolean':
        return emit(item ? 'true' : 'false');
      case 'bigint':
        return emit(stringify(toText(item)));
      case 'undefined':
      case 'function':
      case 'symbol':
        return emit('null');
      default:
        break;
    }
    const object = item as object;
    if (isNode(object)) return emit(stringify(describeNode(object)));
    if (ancestors.includes(object)) return emit('"[Circular]"');
    if (depth >= args.maxDepth) return emit('"[Too deep]"');
    let toJson: unknown;
    try {
      toJson = (object as { toJSON?: unknown }).toJSON;
    } catch {
      toJson = undefined;
    }
    if (typeof toJson === 'function') {
      let converted: unknown;
      try {
        converted = (toJson as () => unknown).call(object);
      } catch {
        converted = '[toJSON failed]';
      }
      ancestors.push(object);
      const ok = write(converted, depth + 1);
      ancestors.pop();
      return ok;
    }
    ancestors.push(object);
    if (isArray(object)) {
      if (!emit('[')) return false;
      const length = (object as unknown[]).length;
      for (let i = 0; i < length; i += 1) {
        if (i > 0 && !emit(',')) return false;
        let entry: unknown;
        try {
          entry = (object as unknown[])[i];
        } catch {
          entry = null;
        }
        if (!write(entry, depth + 1)) return false;
      }
      ancestors.pop();
      return emit(']');
    }
    if (!emit('{')) return false;
    let keys: string[];
    try {
      keys = keysOf(object);
    } catch {
      keys = [];
    }
    let first = true;
    for (const key of keys) {
      let entry: unknown;
      try {
        entry = (object as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      if (!first && !emit(',')) return false;
      first = false;
      if (!emit(`${stringify(key)}:`)) return false;
      if (!write(entry, depth + 1)) return false;
    }
    ancestors.pop();
    return emit('}');
  };

  let type: string;
  if (value === null) type = 'null';
  else if (isArray(value)) type = 'array';
  else if (typeof value === 'object' && isNode(value)) type = 'node';
  else type = typeof value;
  try {
    write(value, 0);
  } catch (error) {
    return stringify({ status: 'error', error: `Result could not be read: ${describeError(error)}` });
  }
  return stringify({ status: 'ok', type, json: parts.join(''), truncated, bytes });
}

// ---- Scripts -----------------------------------------------------------------------------------

/** The `page_text` script for `args`. */
export function pageTextScript(args: Omit<PageTextArgs, 'maxTitleChars'>): string {
  const full: PageTextArgs = { origin: args.origin, pageKey: args.pageKey, maxChars: args.maxChars, maxTitleChars: PAGE_TITLE_MAX_CHARS };
  return `(${pageTextInPage.toString()})(document, location, ${JSON.stringify(full)})`;
}

/** The `click` script for a selector or a visible text. */
export function clickScript(args: PageExpectation & { readonly selector: string | null; readonly text: string | null }): string {
  const full: ClickArgs = {
    origin: args.origin,
    pageKey: args.pageKey,
    selector: args.selector,
    text: args.text,
    clickable: CLICKABLE_SELECTOR,
    maxScanElements: CLICK_LIMITS.maxScanElements,
    maxNameNodeVisits: CLICK_LIMITS.maxNameNodeVisits,
    maxNameChars: CLICK_LIMITS.maxNameChars,
    maxHrefChars: CLICK_LIMITS.maxHrefChars,
  };
  return `(${clickInPage.toString()})(document, location, ${JSON.stringify(full)})`;
}

/** The `execute_javascript` wrapper for approved `code`: the code is a JSON string value in it, never source. */
export function executeScript(args: PageExpectation & { readonly code: string }): string {
  const full: ExecuteArgs = {
    origin: args.origin,
    pageKey: args.pageKey,
    code: args.code,
    maxResultBytes: EXECUTE_JS_LIMITS.maxResultBytes,
    maxDepth: EXECUTE_JS_LIMITS.maxDepth,
    maxErrorChars: EXECUTE_JS_LIMITS.maxErrorChars,
    maxNodeChars: EXECUTE_JS_LIMITS.maxNodeChars,
    markKey: EXECUTE_JS_MARK_KEY,
  };
  return `(${executeInPage.toString()})(location, ${JSON.stringify(full)})`;
}

/** Which world each script runs in. */
export const SCRIPT_WORLDS = { page_text: AGENT_PAGE_WORLD_ID, click: AGENT_PAGE_WORLD_ID, execute_javascript: AGENT_JS_WORLD_ID } as const;

/**
 * A script's answer as main takes it: a JSON string of at most `maxChars`, parsed to an object with
 * a string `status`; `null` for anything else (the page or a dead frame answered something odd).
 */
export function parsePageAnswer(answer: unknown, maxChars: number): { readonly status: string; readonly [key: string]: unknown } | null {
  if (typeof answer !== 'string' || answer.length > maxChars) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const status = (parsed as { status?: unknown }).status;
  return typeof status === 'string' ? (parsed as { status: string }) : null;
}
