import { randomUUID } from 'node:crypto';
import {
  AGENT_JS_WORLD_ID,
  AGENT_PAGE_WORLD_ID,
  CLICK_LIMITS,
  CLICKABLE_SELECTOR,
  EXECUTE_JS_LIMITS,
  EXECUTE_JS_VAULT_KEY,
  executeMarkKey,
  PAGE_TITLE_MAX_CHARS,
} from '@app/specs/agent-page-tools.spec';

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
// - The DOM is the page's: an element or a form named like a DOM member (`<img name="body">`,
//   `<form name="querySelectorAll">`) shadows that member on `document` or the form ("clobbering").
//   So the `AGENT_PAGE_WORLD_ID` scripts call DOM members only through the getters and methods they
//   take from the interface prototypes (`Document.prototype`, `Element.prototype`, …) at their start
//   (`domKit`): only frost's scripts run in that world, so those prototypes are the originals.
// - `AGENT_JS_WORLD_ID` runs approved code, which may change that world's built-ins, and what it
//   changes stays for the document's lifetime. So `executeInPage` keeps the world's original
//   built-ins from its first run in a document in a non-writable, non-configurable global
//   (`EXECUTE_JS_VAULT_KEY`), uses only those (called uncurried, through the kept `Reflect.apply`),
//   reaches the global object through the script's own top-level `this` (never a name code can
//   rebind), writes its answer from primitives only, and checks the answer's `length` (a string
//   primitive's, which nothing can hook) as its last step.
//
// The functions are typed loosely (`any`): main has no DOM lib, and they run in the page's realm.

/* eslint-disable @typescript-eslint/no-explicit-any */

interface PageLocation {
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
}

/** What every script is told about the page it must find. */
export interface PageExpectation {
  /** `location.origin` must equal it. */
  readonly origin: string;
  /** `null`: the origin is enough (`via: 'read'` / `'grant'`); else the exact page (`pageKeyOf`). */
  readonly pageKey: string | null;
}

// ---- The DOM, unclobbered (AGENT_PAGE_WORLD_ID) --------------------------------------------------

/**
 * The DOM members the page scripts use, taken from the interface prototypes of `g` (the world's
 * global) and called on `doc` and its nodes with `Reflect.apply`, so a named element or form
 * control can't stand in for one. A member the DOM lacks (a test DOM without layout) is `null`.
 */
export function domKit(g: any, doc: any) {
  const apply = g.Reflect.apply;
  const own = g.Object.getOwnPropertyDescriptor;
  const proto = (name: string) => (g[name] ? g[name].prototype : null);
  const getter = (p: any, name: string) => {
    const d = p ? own(p, name) : undefined;
    return d && typeof d.get === 'function' ? d.get : null;
  };
  const method = (p: any, name: string) => {
    const d = p ? own(p, name) : undefined;
    return d && typeof d.value === 'function' ? d.value : null;
  };
  const D = proto('Document');
  const E = proto('Element');
  const N = proto('Node');
  const H = proto('HTMLElement');
  const m = {
    body: getter(D, 'body'),
    title: getter(D, 'title'),
    defaultView: getter(D, 'defaultView'),
    docQuery: method(D, 'querySelector'),
    docQueryAll: method(D, 'querySelectorAll'),
    createTreeWalker: method(D, 'createTreeWalker'),
    localName: getter(E, 'localName'),
    getAttribute: method(E, 'getAttribute'),
    closest: method(E, 'closest'),
    query: method(E, 'querySelector'),
    scrollIntoView: method(E, 'scrollIntoView'),
    checkVisibility: method(E, 'checkVisibility'),
    textContent: getter(N, 'textContent'),
    nodeValue: getter(N, 'nodeValue'),
    innerText: getter(H, 'innerText'),
    click: method(H, 'click'),
    dispatchEvent: method(proto('EventTarget'), 'dispatchEvent'),
    nextNode: method(proto('TreeWalker'), 'nextNode'),
    item: method(proto('NodeList'), 'item'),
    length: getter(proto('NodeList'), 'length'),
    inputValue: getter(proto('HTMLInputElement'), 'value'),
    anchorHref: getter(proto('HTMLAnchorElement'), 'href'),
    areaHref: getter(proto('HTMLAreaElement'), 'href'),
  };
  const call = (fn: any, self: any, args: any[]) => (fn === null ? undefined : apply(fn, self, args));
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    body: () => call(m.body, doc, []) ?? null,
    title: () => text(call(m.title, doc, [])) ?? '',
    view: () => call(m.defaultView, doc, []) ?? null,
    query: (selector: string) => call(m.docQuery, doc, [selector]) ?? null,
    queryAll: (selector: string) => call(m.docQueryAll, doc, [selector]),
    count: (list: any) => call(m.length, list, []) as number,
    at: (list: any, index: number) => call(m.item, list, [index]) ?? null,
    walker: (root: any) => call(m.createTreeWalker, doc, [root, 4 /* NodeFilter.SHOW_TEXT */]),
    next: (walker: any) => call(m.nextNode, walker, []) ?? null,
    nodeValue: (node: any) => text(call(m.nodeValue, node, [])) ?? '',
    tag: (el: any) => text(call(m.localName, el, [])) ?? '',
    attr: (el: any, name: string) => text(call(m.getAttribute, el, [name])),
    closest: (el: any, selector: string) => call(m.closest, el, [selector]) ?? null,
    queryIn: (el: any, selector: string) => call(m.query, el, [selector]) ?? null,
    textContent: (el: any) => text(call(m.textContent, el, [])) ?? '',
    /** The rendered text (`innerText`); `null` where the DOM has no layout. */
    innerText: (el: any) => (m.innerText === null ? null : text(call(m.innerText, el, []))),
    visible: (el: any) => (m.checkVisibility !== null ? call(m.checkVisibility, el, []) === true : call(m.closest, el, ['[hidden]']) === null),
    href: (el: any) => {
      const tag = text(call(m.localName, el, []));
      const fn = tag === 'a' ? m.anchorHref : tag === 'area' ? m.areaHref : null;
      try {
        return text(call(fn, el, []));
      } catch {
        return null; // An SVG `<a>`: no HTML href.
      }
    },
    value: (el: any) => {
      try {
        return text(call(m.inputValue, el, []));
      } catch {
        return null;
      }
    },
    scroll: (el: any) => call(m.scrollIntoView, el, [{ block: 'center', inline: 'nearest' }]),
    /** `HTMLElement.prototype.click`, or a dispatched click for an element that isn't one (SVG). */
    click: (el: any) => {
      try {
        call(m.click, el, []);
        return;
      } catch {
        // Not an HTMLElement.
      }
      const view = call(m.defaultView, doc, []);
      if (view) call(m.dispatchEvent, el, [new view.MouseEvent('click', { bubbles: true, cancelable: true, view })]);
    },
  };
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
export function pageTextInPage(g: any, doc: any, loc: PageLocation, args: PageTextArgs, kit: typeof domKit): string {
  if (loc.origin !== args.origin || (args.pageKey !== null && loc.origin + loc.pathname + loc.search !== args.pageKey)) return '{"status":"mismatch"}';
  const dom = kit(g, doc);
  const cut = (text: string, max: number): string => {
    if (text.length <= max) return text;
    let end = max;
    const last = text.charCodeAt(end - 1);
    if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    return text.slice(0, end);
  };
  const body = dom.body();
  let raw = '';
  if (body !== null) raw = dom.innerText(body) ?? dom.textContent(body);
  // Fold blank runs on a bounded prefix only (the regexes never see more than a few times maxChars).
  const scanned = cut(raw, args.maxChars * 4 + 64);
  const folded = scanned
    .replace(/[ \t\f\v ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t\f\v ]{2,}/g, ' ')
    .trim();
  const text = cut(folded, args.maxChars);
  const truncated = text.length < folded.length || scanned.length < raw.length;
  return JSON.stringify({ status: 'ok', text, totalChars: raw.length, truncated, title: cut(dom.title(), args.maxTitleChars) });
}

// ---- click -------------------------------------------------------------------------------------

export interface ClickArgs extends PageExpectation {
  /** Exactly one of `selector` and `text` is a string. */
  readonly selector: string | null;
  readonly text: string | null;
  /** Only an exact match of the text (a standing grant: no guessing on the user's behalf). */
  readonly exactOnly: boolean;
  readonly clickable: string;
  readonly maxScanElements: number;
  readonly maxNameNodeVisits: number;
  readonly maxNameChars: number;
  readonly maxHrefChars: number;
}

/**
 * `click` in the page: finds the element by `selector` (`querySelector`, an invalid selector caught)
 * or by visible `text` among `clickable` elements (at most `maxScanElements`, in document order):
 * an exact match of its name (whitespace folded) first, else (unless `exactOnly`) the first whose
 * name contains the text, case aside; hidden elements are skipped. Scrolls it into view, clicks it
 * (no user gesture), and answers what it clicked: `{ status: 'clicked', element: { tag, role, name,
 * href, visible }, matchedBy }`, or `{ status: 'not-found' | 'bad-selector' | 'mismatch' }`.
 */
export function clickInPage(g: any, doc: any, loc: PageLocation, args: ClickArgs, kit: typeof domKit): string {
  if (loc.origin !== args.origin || (args.pageKey !== null && loc.origin + loc.pathname + loc.search !== args.pageKey)) return '{"status":"mismatch"}';
  const dom = kit(g, doc);
  const fold = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const clip = (text: string, max: number): string => {
    if (text.length <= max) return text;
    let end = max;
    const last = text.charCodeAt(end - 1);
    if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    return text.slice(0, end);
  };
  /** The element's text, read node by node within the visit and character budgets. */
  const textOf = (el: any): string => {
    let out = '';
    let visits = 0;
    const walker = dom.walker(el);
    for (let node = dom.next(walker); node !== null && visits < args.maxNameNodeVisits && out.length < args.maxNameChars * 2; node = dom.next(walker)) {
      visits += 1;
      out += ` ${clip(dom.nodeValue(node), args.maxNameChars * 2)}`;
    }
    return fold(out);
  };
  /** A short accessible-ish name: `aria-label`, an input's value, its text, `title`, an image's `alt`. */
  const nameOf = (el: any): string => {
    const aria = dom.attr(el, 'aria-label');
    if (aria !== null && fold(aria) !== '') return clip(fold(aria), args.maxNameChars);
    if (dom.tag(el) === 'input') {
      const value = fold(dom.value(el) ?? '');
      if (value !== '') return clip(value, args.maxNameChars);
    }
    const text = textOf(el);
    if (text !== '') return clip(text, args.maxNameChars);
    const title = dom.attr(el, 'title');
    if (title !== null && fold(title) !== '') return clip(fold(title), args.maxNameChars);
    const img = dom.queryIn(el, 'img[alt]');
    const alt = img === null ? null : dom.attr(img, 'alt');
    return alt === null ? '' : clip(fold(alt), args.maxNameChars);
  };
  const implicitRole = (el: any): string | null => {
    const tag = dom.tag(el);
    if ((tag === 'a' || tag === 'area') && dom.attr(el, 'href') !== null) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'input') {
      const type = (dom.attr(el, 'type') ?? 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      return 'textbox';
    }
    return null;
  };

  let target: any = null;
  let matchedBy = 'selector';
  if (args.selector !== null) {
    try {
      target = dom.query(args.selector);
    } catch {
      return '{"status":"bad-selector"}';
    }
  } else if (args.text !== null) {
    const want = fold(args.text);
    const lower = want.toLowerCase();
    const list = dom.queryAll(args.clickable);
    const count = Math.min(dom.count(list), args.maxScanElements);
    let contains: any = null;
    for (let i = 0; i < count; i += 1) {
      const el = dom.at(list, i);
      if (el === null || !dom.visible(el)) continue;
      const name = nameOf(el);
      if (name === want) {
        target = el;
        matchedBy = 'text-exact';
        break;
      }
      if (!args.exactOnly && contains === null && name.toLowerCase().includes(lower)) contains = el;
    }
    if (target === null && contains !== null) {
      target = contains;
      matchedBy = 'text-contains';
    }
  }
  if (target === null) return '{"status":"not-found"}';

  const role = dom.attr(target, 'role') ?? implicitRole(target);
  const rawHref = dom.href(target);
  const href = rawHref !== null && rawHref !== '' ? clip(rawHref, args.maxHrefChars) : null;
  const element = { tag: dom.tag(target), role, name: nameOf(target), href, visible: dom.visible(target) };
  try {
    dom.scroll(target);
  } catch {
    // Scrolling is a courtesy; the click still happens.
  }
  try {
    dom.click(target);
  } catch {
    return '{"status":"click-failed"}';
  }
  return JSON.stringify({ status: 'clicked', element, matchedBy });
}

// ---- execute_javascript ----------------------------------------------------------------------

export interface ExecuteArgs extends PageExpectation {
  readonly code: string;
  readonly maxResultBytes: number;
  readonly maxAnswerChars: number;
  readonly maxDepth: number;
  readonly maxErrorChars: number;
  readonly maxNodeChars: number;
  /** `EXECUTE_JS_VAULT_KEY`. */
  readonly vaultKey: string;
  /** This call's random marker name (`executeMarkKey`). */
  readonly markKey: string;
}

/**
 * `execute_javascript` in `AGENT_JS_WORLD_ID` (`g`: the world's global, the script's top-level
 * `this`). Checks the page first; then takes the world's original built-ins (`EXECUTE_JS_VAULT_KEY`,
 * kept from its first run in the document); then compiles the approved code from its string (after
 * the check, so nothing in it runs on another page) and runs it once:
 * - code without `await`: as an expression if it is one (`document.title`); else as a script,
 *   answering its completion value (a marker call, named at random per call, before the code tells
 *   a parse failure from an error thrown while running); else (a top-level `return`) as a function
 *   body;
 * - code with `await`: as an async expression if it is one, else as an async function body.
 *
 * A promise result is followed with the kept `Promise.prototype.then`. The value is written as JSON
 * in-page, at most `maxResultBytes` of UTF-8 (cut there, `truncated`): `undefined`, functions and
 * symbols as `null` (dropped from objects), bigints as strings, DOM nodes described (`<a id="…">`),
 * cycles `"[Circular]"`, nesting past `maxDepth` `"[Too deep]"`, getters that throw skipped.
 * Answers `{ status: 'ok', type, json, truncated, bytes }`, `{ status: 'error', error }` (`name:
 * message`, at most `maxErrorChars`) or `{ status: 'mismatch' }`, as a string of at most
 * `maxAnswerChars` (else a fixed error).
 */
export function executeInPage(g: any, loc: PageLocation, args: ExecuteArgs): string | Promise<string> {
  if (loc.origin !== args.origin || (args.pageKey !== null && loc.origin + loc.pathname + loc.search !== args.pageKey)) return '{"status":"mismatch"}';
  const FAILED = '{"status":"error","error":"The result could not be written."}';

  // ---- The world's original built-ins: kept on the first run in this document, read after. ----
  // An own, non-configurable, non-writable data property: reading it runs nothing of anyone's.
  let v: any = g[args.vaultKey];
  if (v === undefined) {
    try {
      const O = g.Object;
      const R = g.Reflect;
      v = O.freeze({
        __proto__: null,
        apply: R.apply,
        deleteProperty: R.deleteProperty,
        defineProperty: O.defineProperty,
        keys: O.keys,
        hasOwn: O.hasOwn,
        ownDescriptor: O.getOwnPropertyDescriptor,
        objectProto: O.prototype,
        arrayProto: g.Array.prototype,
        isArray: g.Array.isArray,
        isFinite: g.Number.isFinite,
        toText: g.String,
        stringify: g.JSON.stringify,
        slice: g.String.prototype.slice,
        charCodeAt: g.String.prototype.charCodeAt,
        indexOf: g.String.prototype.indexOf,
        SyncFunction: g.Function,
        AsyncFunction: O.getPrototypeOf(async function () {}).constructor,
        evaluate: g.eval,
        Promise: g.Promise,
        then: g.Promise.prototype.then,
      });
      O.defineProperty(g, args.vaultKey, { __proto__: null, value: v, writable: false, enumerable: false, configurable: false });
    } catch {
      return FAILED;
    }
  }
  if (v === null || typeof v !== 'object') return FAILED;
  const apply = v.apply;
  const stringify = v.stringify;
  const toText = v.toText;
  const charAt = (text: string, i: number): number => apply(v.charCodeAt, text, [i]);
  const sliceOf = (text: string, end: number): string => apply(v.slice, text, [0, end]);
  const cut = (text: string, max: number): string => {
    if (text.length <= max) return text;
    let end = max;
    const last = charAt(text, end - 1);
    if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    return sliceOf(text, end);
  };
  /** The last step: an answer that is a string primitive within the cap (`length` can't be hooked). */
  const finish = (answer: unknown): string => (typeof answer === 'string' && answer.length <= args.maxAnswerChars ? answer : FAILED);

  const describeError = (error: unknown): string => {
    let text = 'Error';
    try {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        const name: unknown = (error as { name?: unknown }).name;
        const message: unknown = (error as { message?: unknown }).message;
        const label = typeof name === 'string' ? name : 'Error';
        text = typeof message === 'string' && message !== '' ? label + ': ' + message : label;
      } else {
        text = 'Thrown: ' + toText(error);
      }
    } catch {
      text = 'Error';
    }
    return cut(text, args.maxErrorChars);
  };
  const errorAnswer = (error: unknown): string => finish('{"status":"error","error":' + stringify(describeError(error)) + '}');

  // ---- Bounded JSON, written from primitives only ----
  const write = (value: unknown): string => {
    const max = args.maxResultBytes;
    let out = '';
    let bytes = 0;
    let truncated = false;
    const sizeOf = (c: number, pair: boolean): number => (c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3);
    const isPair = (text: string, i: number): boolean => {
      const c = charAt(text, i);
      if (c < 0xd800 || c > 0xdbff || i + 1 >= text.length) return false;
      const d = charAt(text, i + 1);
      return d >= 0xdc00 && d <= 0xdfff;
    };
    const emit = (piece: string): boolean => {
      if (truncated) return false;
      let used = 0;
      let end = 0;
      while (end < piece.length) {
        const pair = isPair(piece, end);
        const size = sizeOf(charAt(piece, end), pair);
        if (bytes + used + size > max) {
          truncated = true;
          break;
        }
        used += size;
        end += pair ? 2 : 1;
      }
      out += end === piece.length ? piece : sliceOf(piece, end);
      bytes += used;
      return !truncated;
    };
    const isNode = (candidate: object): boolean => {
      try {
        return typeof (candidate as { nodeType?: unknown }).nodeType === 'number' && typeof (candidate as { nodeName?: unknown }).nodeName === 'string';
      } catch {
        return false;
      }
    };
    const describeNode = (node: any): string => {
      let text = '[node]';
      try {
        const nodeType: unknown = node.nodeType;
        const localName: unknown = node.localName;
        if (nodeType === 1 && typeof localName === 'string') {
          const id: unknown = node.id;
          const cls: unknown = typeof node.getAttribute === 'function' ? node.getAttribute('class') : null;
          text = '<' + localName + (typeof id === 'string' && id !== '' ? ' id="' + id + '"' : '') + (typeof cls === 'string' && cls !== '' ? ' class="' + cls + '"' : '') + '>';
        } else if (nodeType === 3) {
          const value: unknown = node.nodeValue;
          text = '#text ' + stringify(typeof value === 'string' ? cut(value, args.maxNodeChars) : '');
        } else {
          const name: unknown = node.nodeName;
          text = typeof name === 'string' ? name : '[node]';
        }
      } catch {
        text = '[node]';
      }
      return cut(text, args.maxNodeChars);
    };
    /** Whether `proto` (an original built-in prototype) holds a `toJSON` now, `fn` or an accessor. */
    const fromBuiltin = (proto: object, fn: unknown): boolean => {
      if (!v.hasOwn(proto, 'toJSON')) return false;
      const d = v.ownDescriptor(proto, 'toJSON');
      return !v.hasOwn(d, 'value') || d.value === fn;
    };
    /** Objects being written, innermost first (a list of null-prototype links: no array methods). */
    type Link = { readonly item: object; readonly up: Link | null };
    let open: Link | null = null;
    const isOpen = (item: object): boolean => {
      for (let link = open; link !== null; link = link.up) if (link.item === item) return true;
      return false;
    };
    const walk = (item: unknown, depth: number): boolean => {
      if (truncated) return false;
      if (item === null) return emit('null');
      switch (typeof item) {
        case 'string':
          return emit(stringify(item.length > max ? sliceOf(item, max) : item));
        case 'number':
          return emit(v.isFinite(item) ? stringify(item) : 'null');
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
      if (isOpen(object)) return emit('"[Circular]"');
      if (depth >= args.maxDepth) return emit('"[Too deep]"');
      let toJson: unknown;
      try {
        toJson = (object as { toJSON?: unknown }).toJSON;
        // A `toJSON` the value only inherits from the world's `Object.prototype` or `Array.prototype`
        // is ignored: earlier code can put one there (none is there originally).
        if (typeof toJson === 'function' && !v.hasOwn(object, 'toJSON') && (fromBuiltin(v.objectProto, toJson) || fromBuiltin(v.arrayProto, toJson))) toJson = undefined;
      } catch {
        toJson = undefined;
      }
      const parent: Link | null = open;
      open = { __proto__: null, item: object, up: parent } as unknown as Link;
      let ok: boolean;
      if (typeof toJson === 'function') {
        let converted: unknown;
        try {
          converted = apply(toJson, object, []);
        } catch {
          converted = '[toJSON failed]';
        }
        ok = walk(converted, depth + 1);
      } else {
        let array = false;
        try {
          array = v.isArray(object);
        } catch {
          array = false;
        }
        ok = array ? writeArray(object, depth) : writeObject(object, depth);
      }
      open = parent;
      return ok;
    };
    const writeArray = (array: any, depth: number): boolean => {
      if (!emit('[')) return false;
      let length = 0;
      try {
        const raw: unknown = array.length;
        length = typeof raw === 'number' ? raw : 0;
      } catch {
        length = 0;
      }
      for (let i = 0; i < length; i += 1) {
        if (i > 0 && !emit(',')) return false;
        let entry: unknown;
        try {
          entry = array[i];
        } catch {
          entry = null;
        }
        if (!walk(entry, depth + 1)) return false;
      }
      return emit(']');
    };
    const writeObject = (object: any, depth: number): boolean => {
      if (!emit('{')) return false;
      let keys: any;
      try {
        keys = v.keys(object);
      } catch {
        keys = [];
      }
      let first = true;
      for (let i = 0; i < keys.length; i += 1) {
        const key: unknown = keys[i];
        if (typeof key !== 'string') continue;
        let entry: unknown;
        try {
          entry = object[key];
        } catch {
          continue;
        }
        if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
        if (!first && !emit(',')) return false;
        first = false;
        if (!emit(stringify(key) + ':')) return false;
        if (!walk(entry, depth + 1)) return false;
      }
      return emit('}');
    };

    let type = 'object';
    try {
      type = value === null ? 'null' : typeof value === 'object' && v.isArray(value) ? 'array' : typeof value === 'object' && isNode(value) ? 'node' : typeof value;
    } catch {
      type = typeof value;
    }
    try {
      walk(value, 0);
    } catch (error) {
      return finish('{"status":"error","error":' + stringify('Result could not be read: ' + describeError(error)) + '}');
    }
    return finish('{"status":"ok","type":' + stringify(type) + ',"json":' + stringify(out) + ',"truncated":' + (truncated ? 'true' : 'false') + ',"bytes":' + stringify(bytes) + '}');
  };

  /** A result that may be a promise: followed with the kept `then` (never the world's). */
  const deliver = (value: unknown): string | Promise<string> => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return write(value);
    let settle: ((answer: string) => void) | null = null;
    const outer: Promise<string> = new v.Promise((resolve: (answer: string) => void) => {
      settle = resolve;
    });
    try {
      // Throws for anything but a native promise: such a value is written as it is.
      apply(v.then, value, [(result: unknown) => settle!(write(result)), (error: unknown) => settle!(errorAnswer(error))]);
    } catch {
      return write(value);
    }
    return outer;
  };

  // ---- Compile (nothing runs) and run once ----
  const code = args.code;
  const compile = (Constructor: any, source: string): any => {
    try {
      return new Constructor(source);
    } catch {
      return null;
    }
  };
  try {
    if (apply(v.indexOf, code, ['await']) === -1) {
      const expression = compile(v.SyncFunction, 'return (\n' + code + '\n);');
      if (expression !== null) return deliver(expression());
      if (compile(v.SyncFunction, code) !== null) {
        let started = false;
        v.defineProperty(g, args.markKey, {
          __proto__: null,
          value: () => {
            started = true;
          },
          writable: true,
          enumerable: false,
          configurable: true,
        });
        let value: unknown;
        let thrown = false;
        let error: unknown;
        try {
          value = v.evaluate(args.markKey + '();\n' + code);
        } catch (caught) {
          thrown = true;
          error = caught;
        }
        v.deleteProperty(g, args.markKey);
        if (started) return thrown ? errorAnswer(error) : deliver(value);
        // It didn't run (a top-level `return` made it no script): run it as a function body.
      }
      return deliver(new v.SyncFunction(code)());
    }
    const expression = compile(v.AsyncFunction, 'return (\n' + code + '\n);');
    return deliver(expression !== null ? expression() : new v.AsyncFunction(code)());
  } catch (error) {
    return errorAnswer(error);
  }
}

// ---- Scripts -----------------------------------------------------------------------------------

/** The `page_text` script for `args`. */
export function pageTextScript(args: Omit<PageTextArgs, 'maxTitleChars'>): string {
  const full: PageTextArgs = { origin: args.origin, pageKey: args.pageKey, maxChars: args.maxChars, maxTitleChars: PAGE_TITLE_MAX_CHARS };
  return `(${pageTextInPage.toString()})(this, document, location, ${JSON.stringify(full)}, ${domKit.toString()})`;
}

/** The `click` script for a selector or a visible text (`exactOnly`: no contains-match). */
export function clickScript(args: PageExpectation & { readonly selector: string | null; readonly text: string | null; readonly exactOnly?: boolean }): string {
  const full: ClickArgs = {
    origin: args.origin,
    pageKey: args.pageKey,
    selector: args.selector,
    text: args.text,
    exactOnly: args.exactOnly === true,
    clickable: CLICKABLE_SELECTOR,
    maxScanElements: CLICK_LIMITS.maxScanElements,
    maxNameNodeVisits: CLICK_LIMITS.maxNameNodeVisits,
    maxNameChars: CLICK_LIMITS.maxNameChars,
    maxHrefChars: CLICK_LIMITS.maxHrefChars,
  };
  return `(${clickInPage.toString()})(this, document, location, ${JSON.stringify(full)}, ${domKit.toString()})`;
}

/**
 * The `execute_javascript` wrapper for approved `code`: the code is a JSON string value in it, never
 * source, and each call gets its own random marker name (`markId`, default `randomUUID()`).
 */
export function executeScript(args: PageExpectation & { readonly code: string; readonly markId?: string }): string {
  const full: ExecuteArgs = {
    origin: args.origin,
    pageKey: args.pageKey,
    code: args.code,
    maxResultBytes: EXECUTE_JS_LIMITS.maxResultBytes,
    maxAnswerChars: EXECUTE_JS_LIMITS.maxAnswerChars,
    maxDepth: EXECUTE_JS_LIMITS.maxDepth,
    maxErrorChars: EXECUTE_JS_LIMITS.maxErrorChars,
    maxNodeChars: EXECUTE_JS_LIMITS.maxNodeChars,
    vaultKey: EXECUTE_JS_VAULT_KEY,
    markKey: executeMarkKey(args.markId ?? randomUUID()),
  };
  return `(${executeInPage.toString()})(this, location, ${JSON.stringify(full)})`;
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
