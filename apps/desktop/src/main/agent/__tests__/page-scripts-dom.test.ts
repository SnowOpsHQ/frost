// Spec: specs/agent-page-tools.spec.ts (CLICK_LIMITS, CLICKABLE_SELECTOR, EXECUTE_JS_LIMITS, EXECUTE_JS_MARK_KEY, pageKeyOf)
// · specs/agent-tools.spec.ts (EXECUTE_JS_MAX_RESULT_BYTES)
// Acceptance: specs/agent-page-tools.feature.md (Scenarios: in the page)
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, test } from 'vitest';
import { EXECUTE_JS_MARK_KEY, pageKeyOf } from '@app/specs/agent-page-tools.spec';
import { EXECUTE_JS_MAX_RESULT_BYTES } from '@app/specs/agent-tools.spec';
import { clickScript, executeScript, pageTextScript } from '../tools/page-scripts';

const PAGE = 'https://example.com/guides/page?x=1#top';
const ORIGIN = 'https://example.com';
const KEY = pageKeyOf(PAGE)!;

/** A jsdom page at `url` whose window runs the scripts as the isolated world would (`window.eval`). */
function page(body: string, url = PAGE) {
  return new JSDOM(`<!doctype html><html lang="en"><head><title>Guide</title></head><body>${body}</body></html>`, { url, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
}

const evaluate = (dom: JSDOM, script: string): unknown => dom.window.eval(script);
const answerOf = (dom: JSDOM, script: string) => JSON.parse(evaluate(dom, script) as string) as Record<string, any>;
const executeAnswer = async (dom: JSDOM, code: string, pageKey: string | null = KEY) => JSON.parse((await (evaluate(dom, executeScript({ origin: ORIGIN, pageKey, code })) as Promise<string>)) as string) as Record<string, any>;

describe('click in the page', () => {
  test('dom-click-finder', () => {
    const dom = page(`
      <a href="/a" id="first">  Read   the guide </a>
      <button id="buy" onclick="this.dataset.clicked = (Number(this.dataset.clicked || 0) + 1)">Buy now</button>
      <button id="hidden" hidden>Exact</button>
      <span role="button" id="span">Exact</span>
      <input type="submit" value="Send form" id="send">
      <div id="plain">Not clickable</div>`);
    const doc = dom.window.document;
    let clicks = 0;
    doc.getElementById('buy')!.addEventListener('click', () => (clicks += 1));

    // By selector: tag, implicit role, name and href; clicked once.
    const bySelector = answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: '#buy', text: null }));
    expect(bySelector).toEqual({ status: 'clicked', matchedBy: 'selector', element: { tag: 'button', role: 'button', name: 'Buy now', href: null, visible: true } });
    expect(clicks).toBe(1);

    // By exact text (whitespace folded); a link reports its resolved href.
    const link = answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: null, text: 'Read the guide' }));
    expect(link.matchedBy).toBe('text-exact');
    expect(link.element).toMatchObject({ tag: 'a', role: 'link', name: 'Read the guide', href: 'https://example.com/a' });

    // An exact match wins over an earlier partial one; hidden elements are skipped.
    const exact = answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: null, text: 'Exact' }));
    expect(exact.element).toMatchObject({ tag: 'span', role: 'button', name: 'Exact' });

    // Case-insensitive contains, an input's value as its name.
    const contains = answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: null, text: 'send' }));
    expect(contains).toMatchObject({ matchedBy: 'text-contains', element: { tag: 'input', role: 'button', name: 'Send form' } });
    // Not clickable elements are not searched; misses and bad selectors are answers, not throws.
    expect(answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: null, text: 'Not clickable' }))).toEqual({ status: 'not-found' });
    expect(answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: '#nothing', text: null }))).toEqual({ status: 'not-found' });
    expect(answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: 'a[', text: null }))).toEqual({ status: 'bad-selector' });
  });

  test('dom-click-finder bounds the scan and the name', () => {
    const many = Array.from({ length: 2_100 }, (_, i) => `<button>Item ${i}</button>`).join('');
    const dom = page(`${many}<button id="long">${'word '.repeat(400)}</button>`);
    // Past `maxScanElements` (2000) nothing is read.
    expect(answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: null, text: 'Item 2050' }))).toEqual({ status: 'not-found' });
    expect(answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: null, text: 'Item 1999' })).element.name).toBe('Item 1999');
    const long = answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: '#long', text: null }));
    expect(long.element.name.length).toBeLessThanOrEqual(160);
  });

  test('dom-click-input-is-data', () => {
    const tricky = `x"y\\z</script><script>window.pwned=1</script>'`;
    const dom = page('');
    const doc = dom.window.document;
    const button = doc.createElement('button');
    button.setAttribute('data-k', tricky);
    button.textContent = tricky;
    doc.body.append(button);
    let clicked = 0;
    button.addEventListener('click', () => (clicked += 1));
    // The selector is a CSS string: escaped for CSS, and passed to the page as JSON data.
    const selector = `button[data-k="${tricky.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    const script = clickScript({ origin: ORIGIN, pageKey: null, selector, text: null });
    expect(script).toContain(JSON.stringify(selector));
    expect(answerOf(dom, script).status).toBe('clicked');
    expect(answerOf(dom, clickScript({ origin: ORIGIN, pageKey: null, selector: null, text: tricky })).matchedBy).toBe('text-exact');
    expect(clicked).toBe(2);
    expect((dom.window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe('page_text in the page', () => {
  test('dom-page-text-caps', () => {
    const dom = page(`<h1>Title</h1>\n\n\n\n<p>First    para</p><p>${'x'.repeat(50)}\u{1F600}tail</p>`);
    const all = answerOf(dom, pageTextScript({ origin: ORIGIN, pageKey: null, maxChars: 10_000 }));
    expect(all.status).toBe('ok');
    expect(all.title).toBe('Guide');
    expect(all.text).not.toMatch(/\n{3,}/);
    expect(all.text).toContain('First para');
    expect(all.truncated).toBe(false);
    // Cut at maxChars, never half a surrogate pair.
    const text = all.text as string;
    const at = text.indexOf('\u{1F600}');
    const cut = answerOf(dom, pageTextScript({ origin: ORIGIN, pageKey: null, maxChars: at + 1 }));
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBe(at);
    expect(cut.totalChars).toBeGreaterThan(cut.text.length);
  });
});

describe('the page check', () => {
  test('dom-page-check', async () => {
    const dom = page('<button id="b">Go</button>');
    let clicks = 0;
    dom.window.document.getElementById('b')!.addEventListener('click', () => (clicks += 1));
    // Another origin.
    expect(answerOf(dom, clickScript({ origin: 'https://other.example', pageKey: null, selector: '#b', text: null }))).toEqual({ status: 'mismatch' });
    expect(answerOf(dom, pageTextScript({ origin: 'https://other.example', pageKey: null, maxChars: 100 }))).toEqual({ status: 'mismatch' });
    // Approved: another page of the same origin (path or query), but the fragment doesn't count.
    expect(answerOf(dom, clickScript({ origin: ORIGIN, pageKey: pageKeyOf('https://example.com/guides/page?x=2'), selector: '#b', text: null }))).toEqual({ status: 'mismatch' });
    expect(answerOf(dom, clickScript({ origin: ORIGIN, pageKey: pageKeyOf('https://example.com/guides/other?x=1'), selector: '#b', text: null }))).toEqual({ status: 'mismatch' });
    expect(clicks).toBe(0);
    expect(answerOf(dom, clickScript({ origin: ORIGIN, pageKey: pageKeyOf('https://example.com/guides/page?x=1#elsewhere'), selector: '#b', text: null })).status).toBe('clicked');
    expect(clicks).toBe(1);
    // execute_javascript: the code never runs on another page.
    (dom.window as unknown as { ran?: number }).ran = 0;
    expect(await executeAnswer(dom, 'window.ran = 1', pageKeyOf('https://example.com/other'))).toEqual({ status: 'mismatch' });
    expect((dom.window as unknown as { ran?: number }).ran).toBe(0);
    // Code that tries to break out of the wrapper is still only a string until after the check.
    expect(await executeAnswer(dom, '1 })(); window.ran = 2; (async () => {', pageKeyOf('https://example.com/other'))).toEqual({ status: 'mismatch' });
    expect((dom.window as unknown as { ran?: number }).ran).toBe(0);
  });
});

describe('execute_javascript in the page', () => {
  test('dom-execute-runs-code', async () => {
    const dom = page('<p id="p">Hello</p>');
    const win = dom.window as unknown as Record<string, unknown>;
    // An expression, awaited.
    expect(await executeAnswer(dom, 'document.title')).toEqual({ status: 'ok', type: 'string', json: '"Guide"', truncated: false, bytes: 7 });
    expect(await executeAnswer(dom, 'Promise.resolve({ a: [1, 2] })')).toMatchObject({ type: 'object', json: '{"a":[1,2]}' });
    expect(await executeAnswer(dom, '{ a: 1 }')).toMatchObject({ json: '{"a":1}' });
    // A script: its completion value.
    expect(await executeAnswer(dom, 'const n = document.querySelectorAll("p").length;\nn + 1;')).toMatchObject({ type: 'number', json: '2' });
    // Top-level await / return: an async function body.
    expect(await executeAnswer(dom, 'const v = await Promise.resolve(41);\nreturn v + 1;')).toMatchObject({ json: '42' });
    expect(await executeAnswer(dom, 'return document.getElementById("p").textContent')).toMatchObject({ json: '"Hello"' });
    // Runs once, even when it throws while running; the marker is gone afterwards.
    win.count = 0;
    expect(await executeAnswer(dom, 'window.count += 1; throw new TypeError("boom")')).toEqual({ status: 'error', error: 'TypeError: boom' });
    expect(win.count).toBe(1);
    expect(EXECUTE_JS_MARK_KEY in win).toBe(false);
    expect(await executeAnswer(dom, 'Promise.reject(new RangeError("nope"))')).toEqual({ status: 'error', error: 'RangeError: nope' });
    expect(await executeAnswer(dom, 'throw "plain"')).toEqual({ status: 'error', error: 'Thrown: plain' });
    expect(await executeAnswer(dom, 'function (')).toMatchObject({ status: 'error', error: expect.stringMatching(/^SyntaxError/) });
    expect((await executeAnswer(dom, `throw new Error(${JSON.stringify('m'.repeat(2_000))})`)).error.length).toBe(500);
    // Changing JSON in the world doesn't change how this answer is written.
    expect(await executeAnswer(dom, 'JSON.stringify = () => "x"; [1]')).toMatchObject({ status: 'ok', json: '[1]' });
  });

  test('dom-execute-bounded-json', async () => {
    const dom = page('<a id="l" class="c">x</a>');
    expect(await executeAnswer(dom, 'undefined')).toMatchObject({ type: 'undefined', json: 'null' });
    expect(await executeAnswer(dom, '() => 1')).toMatchObject({ type: 'function', json: 'null' });
    expect(await executeAnswer(dom, '10n')).toMatchObject({ type: 'bigint', json: '"10"' });
    expect(await executeAnswer(dom, 'NaN')).toMatchObject({ json: 'null' });
    expect(await executeAnswer(dom, 'document.getElementById("l")')).toMatchObject({ type: 'node', json: '"<a id=\\"l\\" class=\\"c\\">"' });
    expect(await executeAnswer(dom, '({ f() {}, u: undefined, s: Symbol("x"), d: new Date(0), list: [undefined, () => 1] })')).toMatchObject({
      json: '{"d":"1970-01-01T00:00:00.000Z","list":[null,null]}',
    });
    expect(await executeAnswer(dom, 'const a = { n: 1 }; a.self = a; a')).toMatchObject({ json: '{"n":1,"self":"[Circular]"}' });
    expect(await executeAnswer(dom, '({ ok: 1, get bad() { throw new Error("x") } })')).toMatchObject({ json: '{"ok":1}' });
    const deep = JSON.parse((await executeAnswer(dom, 'let d = {}; const top = d; for (let i = 0; i < 40; i++) { d.n = {}; d = d.n } top')).json);
    let depth = 0;
    for (let at: any = deep; typeof at === 'object'; at = at.n) depth += 1;
    expect(depth).toBe(24);

    // The UTF-8 byte cap: cut there, flagged, never half a character.
    const big = await executeAnswer(dom, `"é".repeat(${EXECUTE_JS_MAX_RESULT_BYTES})`);
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.json, 'utf8')).toBeLessThanOrEqual(EXECUTE_JS_MAX_RESULT_BYTES);
    expect(big.bytes).toBe(Buffer.byteLength(big.json, 'utf8'));
    expect(big.json.startsWith('"éé')).toBe(true);
    const array = await executeAnswer(dom, `Array.from({ length: 1e6 }, (_, i) => i)`);
    expect(array.truncated).toBe(true);
    expect(array.bytes).toBeLessThanOrEqual(EXECUTE_JS_MAX_RESULT_BYTES);
    const fits = await executeAnswer(dom, `"a".repeat(${EXECUTE_JS_MAX_RESULT_BYTES - 2})`);
    expect(fits).toMatchObject({ truncated: false, bytes: EXECUTE_JS_MAX_RESULT_BYTES });
  });
});
