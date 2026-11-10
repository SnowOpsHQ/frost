// Spec: specs/inspector.spec.ts (INSPECTOR_WORLD_ID, INSPECTOR_LIMITS, DOC_TOKEN_PATTERN), specs/inspector.schema.ts,
// specs/capture.spec.ts (PAGE_REGIONS), specs/changes.spec.ts (REGION_EXTRACT_LIMITS, CAPTURE_BLOCK_ELEMENTS)
// Acceptance: specs/inspector.feature.md (Page scripts; Scenarios inspector-paths-resolve, inspector-answers-are-capped,
// inspector-stale-token, inspector-node-details, inspector-region-agrees-with-regions, inspector-pick-needs-trusted-click,
// inspector-pick-ends-without-picking, inspector-outline-lifecycle, inspector-leaves-dom-unchanged, inspector-scripts-are-self-contained;
// Phase 11 Task 5: search-text-finds-paths, search-selector-invalid-refused, search-capped, serialize-capped-and-truncated-flag,
// scripts-never-write-dom; INSPECTOR_SEARCH_LIMITS, INSPECTOR_SOURCE_MAX_CHARS)
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';
import { CAPTURE_LIMITS } from '@app/specs/capture.spec';
import { CAPTURE_BLOCK_ELEMENTS, REGION_EXTRACT_LIMITS } from '@app/specs/changes.spec';
import {
  DOC_TOKEN_PATTERN,
  INSPECTOR_LIMITS,
  INSPECTOR_SEARCH_LIMITS,
  INSPECTOR_SOURCE_MAX_CHARS,
  INSPECTOR_WORLD_ID,
  InspectorChildrenAnswerSchema,
  InspectorNodeAnswerSchema,
  InspectorSearchAnswerSchema,
  InspectorSourceAnswerSchema,
  type NodePath,
} from '@app/specs/inspector.schema';
import { extractRegions, type RegionDocument } from '../../changes/regions';
import { INSPECTOR_SCRIPT_LIMITS, INSPECTOR_STATE_KEY, inspectorScript, inspectPage, runInspector, type InspectorDocument, type InspectorRequest, type InspectorScriptLimits, type InspectorState } from '../page-script';

// jsdom marks every `dispatchEvent` untrusted, as browsers do. A trusted event (the user's own input)
// is delivered through jsdom's internal dispatch, here in the test only.
const require = createRequire(import.meta.url);
const { implForWrapper } = require('jsdom/lib/generated/idl/utils.js') as { implForWrapper(wrapper: unknown): { isTrusted: boolean; _dispatch(event: unknown): boolean } };

const BODY = `<header id="top" class="site  bar"><nav><a href="/home" rel="nofollow" target="_blank">Home</a></nav></header>
<main><h1 id="title" class="hero big">  Big
  title <b>bold</b> tail </h1><p>Text <img src="/i.png" alt="Logo"></p><div id="host"></div></main>
<footer lang="fr"><p>Pied</p></footer>`;

function page(body = BODY, { head = '<title>t</title><meta name="description" content="About tea"><link rel="canonical" href="/canonical">', limits = {} as Partial<InspectorScriptLimits> } = {}) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`, { url: 'https://example.com/guides/page', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  const store: Record<string, unknown> = {};
  const L: InspectorScriptLimits = { ...INSPECTOR_SCRIPT_LIMITS, ...limits };
  const call = (request: InspectorRequest) => inspectPage(document as unknown as InspectorDocument, store, INSPECTOR_STATE_KEY, request, L);
  const token = () => (call({ op: 'token' }) as { docToken: string }).docToken;
  /** The tag at `path` (the test's own reckoning; `'none'` where no element is). */
  const tagAt = (path: NodePath): string => {
    let el: Element | undefined = document.documentElement;
    for (const i of path) el = el?.children[i];
    return el ? el.localName : 'none';
  };
  const children = (path: NodePath, offset = 0, t: string | null = token(), tag: string | null = tagAt(path)) => call({ op: 'children', path, tag, token: t, offset }) as Record<string, unknown>;
  const node = (path: NodePath, t: string = token(), tag: string = tagAt(path)) => call({ op: 'node', path, tag, token: t }) as Record<string, unknown>;
  const highlight = (path: NodePath | null, t: string = token(), tag: string = path ? tagAt(path) : '') => call({ op: 'highlight', node: path === null ? null : { path, tag }, token: t });
  const pick = (t: string | null = token()) => call({ op: 'pick', token: t }) as Promise<unknown>;
  const state = () => store[INSPECTOR_STATE_KEY] as InspectorState;
  const host = () => state()?.overlay?.host as unknown as HTMLElement | undefined;
  const trusted = <E extends Event>(target: EventTarget, event: E): E => {
    implForWrapper(event).isTrusted = true;
    implForWrapper(target)._dispatch(implForWrapper(event));
    return event;
  };
  const mouse = (type: string) => new window.MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0 });
  const pointer = (type: string) => new window.PointerEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0, pointerId: 1 });
  const esc = () => trusted(document.body, new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  return { dom, window, document, store, call, token, tagAt, children, node, highlight, pick, state, host, trusted, mouse, pointer, esc, html: () => document.documentElement.outerHTML };
}

/** The element-index path of `el` from `<html>` (the test's own reckoning). */
function pathTo(el: Element): NodePath {
  const path: NodePath = [];
  for (let at: Element = el; at.parentElement !== null; at = at.parentElement) path.unshift([...at.parentElement.children].indexOf(at));
  return path;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('tree and token', () => {
  test('inspector-paths-resolve', () => {
    const p = page();
    const t = p.token();
    expect(t).toMatch(DOC_TOKEN_PATTERN);
    expect(p.token()).toBe(t); // kept on the world's global
    expect(page().token()).not.toBe(t); // another document, another token

    const root = InspectorChildrenAnswerSchema.parse(p.children([]));
    expect(root).toMatchObject({ status: 'ok', docToken: t, path: [], offset: 0, more: false, node: { index: 0, tag: 'html', childElementCount: 2 } });
    if (root.status !== 'ok') throw new Error('not ok');
    expect(root.children.map((c) => [c.index, c.tag])).toEqual([
      [0, 'head'],
      [1, 'body'],
    ]);
    const body = InspectorChildrenAnswerSchema.parse(p.children([1]));
    if (body.status !== 'ok') throw new Error('not ok');
    expect(body.children.map((c) => c.tag)).toEqual(['header', 'main', 'footer']);
    expect(body.children[0]).toEqual({ index: 0, tag: 'header', id: 'top', classes: ['site', 'bar'], childElementCount: 1, textPreview: '', shadow: false });
    // The open shadow root is shown, not entered.
    (p.document.getElementById('host') as HTMLElement).attachShadow({ mode: 'open' }).innerHTML = '<p>inside</p>';
    const main = InspectorChildrenAnswerSchema.parse(p.children([1, 1]));
    if (main.status !== 'ok') throw new Error('not ok');
    // Direct text only (not `<b>`'s), whitespace collapsed.
    expect(main.children[0]).toMatchObject({ tag: 'h1', id: 'title', classes: ['hero', 'big'], textPreview: 'Big title tail', childElementCount: 1 });
    expect(main.children[2]).toMatchObject({ tag: 'div', id: 'host', shadow: true, childElementCount: 0 });
    expect(main.node).toMatchObject({ index: 1, tag: 'main' });
    // No element at the path, or another element than the caller expects there: not found.
    expect(p.children([1, 1], 0, t, 'section')).toEqual({ status: 'not-found' });
    expect(p.node([1, 1, 0], t, 'p')).toEqual({ status: 'not-found' });
    expect(p.children([1, 7])).toEqual({ status: 'not-found' });
    expect(p.node([0, 0, 9])).toEqual({ status: 'not-found' });
  });

  test('inspector-answers-are-capped', () => {
    const L = INSPECTOR_LIMITS;
    const many = `<ul>${'<li>x</li>'.repeat(L.maxChildren * 2 + 50)}</ul>`;
    const classes = Array.from({ length: L.maxClassNames + 5 }, (_, i) => `c${i}`).join(' ');
    const attrs = Array.from({ length: L.maxAttributes + 5 }, (_, i) => `data-a${i}="v"`).join(' ');
    const p = page(`${many}<div class="${classes} ${'k'.repeat(500)}" ${attrs} title="${'t'.repeat(L.maxAttributeValueChars + 10)}" data-${'n'.repeat(300)}="1">${'word '.repeat(200)}</div>`);
    const first = InspectorChildrenAnswerSchema.parse(p.children([1, 0]));
    const second = InspectorChildrenAnswerSchema.parse(p.children([1, 0], L.maxChildren));
    const last = InspectorChildrenAnswerSchema.parse(p.children([1, 0], L.maxChildren * 2));
    if (first.status !== 'ok' || second.status !== 'ok' || last.status !== 'ok') throw new Error('not ok');
    expect([first.children.length, first.more, first.children[0]!.index]).toEqual([L.maxChildren, true, 0]);
    expect([second.children.length, second.more, second.children[0]!.index]).toEqual([L.maxChildren, true, L.maxChildren]);
    expect([last.children.length, last.more, last.children.at(-1)!.index]).toEqual([50, false, L.maxChildren * 2 + 49]);

    const row = InspectorChildrenAnswerSchema.parse(p.children([1]));
    if (row.status !== 'ok') throw new Error('not ok');
    const div = row.children[1]!;
    expect(div.classes).toHaveLength(L.maxClassNames);
    expect(div.textPreview.length).toBeLessThanOrEqual(L.maxTextPreviewChars);
    const details = InspectorNodeAnswerSchema.parse(p.node([1, 1]));
    if (details.status !== 'ok') throw new Error('not ok');
    expect(details.node.attributes).toHaveLength(L.maxAttributes);
    expect(details.node.attributesMore).toBe(true);
    expect(details.node.attributes[0]!.name).toBe('class');
    expect(details.node.attributes[0]!.value.length).toBeLessThanOrEqual(L.maxAttributeValueChars);

    const longValue = page(`<p title="${'t'.repeat(L.maxAttributeValueChars + 10)}" data-${'n'.repeat(300)}="1">x</p>`);
    const p2 = InspectorNodeAnswerSchema.parse(longValue.node([1, 0]));
    if (p2.status !== 'ok') throw new Error('not ok');
    expect(p2.node.attributes[0]).toMatchObject({ name: 'title', truncated: true });
    expect(p2.node.attributes[0]!.value).toHaveLength(L.maxAttributeValueChars);
    expect(p2.node.attributes[1]!.name).toHaveLength(L.maxAttributeNameChars);

    // A path past `maxPathDepth` names nothing; a deeper picked element is answered as its ancestor at that depth.
    const deep = page(`${'<div>'.repeat(L.maxPathDepth + 10)}<span id="deep">x</span>${'</div>'.repeat(L.maxPathDepth + 10)}`);
    expect(deep.children(new Array(L.maxPathDepth + 1).fill(0))).toEqual({ status: 'not-found' });
    expect(InspectorChildrenAnswerSchema.parse(deep.children([1, ...new Array(L.maxPathDepth - 1).fill(0)])).status).toBe('ok');
  });

  test('inspector-stale-token', () => {
    const p = page();
    const other = 'f'.repeat(32);
    expect(p.children([], 0, other)).toEqual({ status: 'stale' });
    expect(p.node([1], other)).toEqual({ status: 'stale' });
    expect(p.highlight([1], other)).toEqual({ status: 'stale' });
    return expect(p.pick(other)).resolves.toEqual({ status: 'stale' });
  });
});

describe('node details', () => {
  test('inspector-node-details', () => {
    const p = page();
    const details = (el: Element) => {
      const answer = InspectorNodeAnswerSchema.parse(p.node(pathTo(el)));
      if (answer.status !== 'ok') throw new Error('not ok');
      return answer.node;
    };
    const h1 = details(p.document.querySelector('h1')!);
    expect(h1).toMatchObject({ tag: 'h1', region: 'main', childElementCount: 1, attributesMore: false, seo: { headingLevel: 1, link: null, image: null, meta: null, linkRel: null, lang: 'en' } });
    expect(h1.attributes).toEqual([
      { name: 'id', value: 'title', truncated: false },
      { name: 'class', value: 'hero big', truncated: false },
    ]);
    expect(h1.styles.map((s) => s.name)).toEqual(INSPECTOR_LIMITS.computedStyleProps);
    expect(h1.styles.find((s) => s.name === 'display')!.value).toBe('block');
    expect(h1.box).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(details(p.document.querySelector('a')!)).toMatchObject({ region: 'nav', seo: { link: { href: 'https://example.com/home', rel: 'nofollow', target: '_blank' }, headingLevel: null } });
    expect(details(p.document.querySelector('img')!).seo.image).toEqual({ src: 'https://example.com/i.png', alt: 'Logo', naturalWidth: 0, naturalHeight: 0 });
    expect(details(p.document.querySelector('meta[name]')!)).toMatchObject({ region: 'head', seo: { meta: { name: 'description', content: 'About tea' } } });
    expect(details(p.document.head).region).toBe('head');
    expect(details(p.document.querySelector('link')!).seo.linkRel).toEqual({ rel: 'canonical', href: 'https://example.com/canonical' });
    expect(details(p.document.querySelector('footer p')!)).toMatchObject({ region: 'footer', seo: { lang: 'fr' } });
    expect(details(p.document.querySelector('header')!).region).toBe('header');
    expect(details(p.document.body).region).toBe('other');
    // A missing URL is reported missing, never as the page's own.
    const bare = page('<img alt=""><a name="x">anchor</a>', { head: '<link rel="preload">' });
    const bareDetails = (el: Element) => (InspectorNodeAnswerSchema.parse(bare.node(pathTo(el))) as { node: { seo: Record<string, unknown> } }).node.seo;
    expect(bareDetails(bare.document.querySelector('img')!).image).toEqual({ src: null, alt: '', naturalWidth: 0, naturalHeight: 0 });
    expect(bareDetails(bare.document.querySelector('a')!).link).toBeNull();
    expect(bareDetails(bare.document.querySelector('link')!).linkRel).toEqual({ rel: 'preload', href: '' });
  });

  test('inspector-region-agrees-with-regions', () => {
    // The landmark fixtures of `changes/__tests__/regions.test.ts`: every heading and link the region
    // extraction tags is given the same region by the inspector.
    const fixtures = [
      `<header>Site name<nav><a href="/a">Home</a></nav></header>
       <main><h1>Title</h1><p>Body text</p>
         <article><header><h2>Post</h2></header><p>Post body</p><aside><h3>Side</h3><a href="/s">Side link</a></aside></article>
         <div role="navigation"><a href="https://other.org/b">Away</a></div>
         <nav role="none"><h4>Not a nav</h4></nav>
         <section><footer><a href="/sf">Section foot</a></footer></section></main>
       <div>Loose text<h2>Loose heading</h2><a href="/loose">Loose</a></div>
       <footer><a href="/c">Copyright</a></footer>`,
      '<main><p>m</p></main><footer><div role="banner"><h2>Inner banner</h2><a href="/ib">x</a></div></footer>',
      '<div><h1>Plain</h1><a href="/w">Words</a></div><section><footer><h2>Section foot</h2></footer></section><footer role="contentinfo"><a href="/f">Foot</a></footer>',
      '<main role="none"><h1>x</h1></main><a href="/y">y</a>',
      '<div role="main"><header><h1>In main</h1></header></div><div role="article"><footer><h2>Article foot</h2></footer></div><a href="/l">Loose</a>',
      `${'<div role="note"></div>'.repeat(REGION_EXTRACT_LIMITS.maxMainScan + 50)}<main><p>m</p></main><h2>loose</h2>`,
      '<aside role="complementary navigation"><h2>Side</h2></aside><nav><header><h2>Nav head</h2></header></nav>',
    ];
    let compared = 0;
    for (const body of fixtures) {
      const p = page(body, { head: '' });
      const answer = extractRegions(p.document as unknown as RegionDocument, CAPTURE_LIMITS, REGION_EXTRACT_LIMITS, CAPTURE_BLOCK_ELEMENTS) as { headings: { region: string }[]; links: { list: { region: string }[] } };
      const headings = [...p.document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
      const links = [...p.document.links];
      expect(answer.headings).toHaveLength(headings.length);
      expect(answer.links.list).toHaveLength(links.length);
      const pairs: [Element, string][] = [...headings.map((el, i) => [el, answer.headings[i]!.region] as [Element, string]), ...links.map((el, i) => [el, answer.links.list[i]!.region] as [Element, string])];
      for (const [el, region] of pairs) {
        const details = InspectorNodeAnswerSchema.parse(p.node(pathTo(el)));
        if (details.status !== 'ok') throw new Error('not ok');
        expect(details.node.region, `${body.slice(0, 40)} ${el.outerHTML}`).toBe(region);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });
});

describe('pick', () => {
  test('inspector-pick-needs-trusted-click', async () => {
    const p = page();
    const before = p.html();
    const h1 = p.document.querySelector('h1')!;
    const heard: string[] = [];
    // The page's listeners: on the target, and a capture one on window added after the picker started.
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) h1.addEventListener(type, (event) => heard.push(`${type}:${event.isTrusted}`));
    const picking = p.pick();
    p.window.addEventListener('click', (event) => heard.push(`late-capture:${event.isTrusted}`), true);
    expect(p.host()?.isConnected).toBe(true);
    // The page's own synthetic events pick nothing, and the picker leaves them alone.
    h1.dispatchEvent(p.mouse('click'));
    h1.dispatchEvent(p.pointer('pointermove'));
    p.document.body.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(p.state().pick).not.toBeNull();
    expect(p.state().hover).toBeNull();
    expect(heard).toEqual(['late-capture:false', 'click:false']);
    heard.length = 0;
    // The user's pointer moves the hover outline; the user's click picks, and nothing after the picker hears it.
    p.trusted(h1, p.pointer('pointermove'));
    expect(p.state().hover).toBe(h1);
    p.trusted(h1, p.pointer('pointerdown'));
    p.trusted(h1, p.mouse('mousedown'));
    p.trusted(h1, p.mouse('mouseup'));
    const click = p.trusted(h1, p.mouse('click'));
    await expect(picking).resolves.toEqual({ status: 'picked', docToken: p.token(), path: pathTo(h1) });
    expect(click.defaultPrevented).toBe(true);
    expect(heard).toEqual([]);
    // The selection outline stays until cleared; the page's own nodes are as they were.
    expect(p.state().selected).toBe(h1);
    expect(p.host()?.isConnected).toBe(true);
    expect(InspectorChildrenAnswerSchema.parse(p.children([])).status).toBe('ok');
    expect((p.children([]) as { node: { childElementCount: number } }).node.childElementCount).toBe(2); // the host is never a child
    expect(p.call({ op: 'clear' })).toEqual({ status: 'ok' });
    expect(p.host()).toBeUndefined();
    expect(p.html()).toBe(before);
    // After the pick, clicks reach the page again.
    p.trusted(h1, p.mouse('click'));
    expect(heard).toEqual(['late-capture:true', 'click:true']);
  });

  test('inspector-pick-hit-tests-under-the-cover', async () => {
    const p = page(`${BODY}<iframe id="frame"></iframe>`);
    const before = p.html();
    const frame = p.document.getElementById('frame')!;
    const heard: string[] = [];
    for (const type of ['pointermove', 'contextmenu', 'touchstart', 'click']) p.document.addEventListener(type, () => heard.push(type), true);
    frame.addEventListener('click', () => heard.push('frame-click'));
    const picking = p.pick();
    const host = p.host()!;
    // Chromium's hit-testing at the pointer: the cover (retargeted to the host) first, then what is under it.
    const asked: [number, number][] = [];
    (p.document as unknown as { elementsFromPoint(x: number, y: number): Element[] }).elementsFromPoint = (x, y) => {
      asked.push([x, y]);
      return [host, frame, p.document.body, p.document.documentElement];
    };
    const at = { clientX: 30, clientY: 40, bubbles: true, composed: true, cancelable: true };
    p.trusted(host, new p.window.PointerEvent('pointermove', at));
    expect(p.state().hover).toBe(frame);
    // A right-click opens no menu (the page's or frost's: Chromium shows none for a cancelled `contextmenu`); a touch does nothing.
    expect(p.trusted(host, new p.window.MouseEvent('contextmenu', { ...at, button: 2 })).defaultPrevented).toBe(true);
    expect(p.trusted(host, new p.window.Event('touchstart', { bubbles: true, cancelable: true })).defaultPrevented).toBe(true);
    expect(p.state().pick).not.toBeNull();
    // The click picks the element under the cover (the frame itself: nothing inside it is reached).
    const click = p.trusted(host, new p.window.MouseEvent('click', { ...at, button: 0 }));
    await expect(picking).resolves.toEqual({ status: 'picked', docToken: p.token(), path: pathTo(frame) });
    expect(click.defaultPrevented).toBe(true);
    expect(heard).toEqual([]);
    expect(asked).toEqual([
      [30, 40],
      [30, 40],
    ]);
    // The cover is up only while picking.
    expect((p.state().overlay!.catcher as unknown as HTMLElement).style.getPropertyValue('display')).toBe('none');
    p.call({ op: 'clear' });
    expect(p.html()).toBe(before);
  });

  test('inspector-pick-ends-without-picking', async () => {
    // Esc.
    const esc = page();
    const before = esc.html();
    const byEsc = esc.pick();
    esc.esc();
    await expect(byEsc).resolves.toBeNull();
    expect(esc.host()).toBeUndefined();
    expect(esc.html()).toBe(before);
    // The cancel request (main's Esc, Cancel, a navigation, the tab leaving the front).
    const byCancel = esc.pick();
    expect(esc.call({ op: 'cancelPick' })).toBe(true);
    await expect(byCancel).resolves.toBeNull();
    expect(esc.call({ op: 'cancelPick' })).toBe(false);
    // The timeout.
    const slow = page(BODY, { limits: { pickTimeoutMs: 20 } });
    await expect(slow.pick()).resolves.toBeNull();
    expect(slow.host()).toBeUndefined();
    // The page leaving.
    const left = page();
    const byLeave = left.pick();
    // The page's own `pagehide` does not end it; the real one does.
    left.window.dispatchEvent(new left.window.Event('pagehide'));
    await settle();
    expect(left.state().pick).not.toBeNull();
    left.trusted(left.window, new left.window.Event('pagehide'));
    await expect(byLeave).resolves.toBeNull();
    // A second pick ends the first.
    const twice = page();
    const first = twice.pick();
    const second = twice.pick();
    await expect(first).resolves.toBeNull();
    twice.esc();
    await expect(second).resolves.toBeNull();
    // The page removing the host ends it; a host the page appends again is inert.
    const removed = page();
    const html = removed.html();
    const byRemoval = removed.pick();
    const host = removed.host()!;
    host.remove();
    await expect(byRemoval).resolves.toBeNull();
    expect(removed.html()).toBe(html);
    removed.document.documentElement.append(host);
    expect(removed.state().overlay).toBeNull();
    expect(host.style.getPropertyValue('display')).toBe('none');
    removed.trusted(removed.document.querySelector('h1')!, removed.mouse('click'));
    expect(removed.state().selected).toBeNull();
    // A click right after the host was taken out (before any observer ran) picks nothing either.
    const quick = page();
    const byQuick = quick.pick();
    quick.host()!.remove();
    quick.trusted(quick.document.querySelector('h1')!, quick.mouse('click'));
    await expect(byQuick).resolves.toBeNull();
    expect(quick.state().selected).toBeNull();
    expect(quick.state().overlay).toBeNull();
  });
});

describe('outlines', () => {
  test('inspector-outline-lifecycle', () => {
    const p = page();
    const before = p.html();
    expect(p.highlight([1, 1, 0])).toEqual({ status: 'ok' });
    expect(p.state().hover).toBe(p.document.querySelector('h1'));
    const host = p.host()!;
    expect(host.parentElement).toBe(p.document.documentElement);
    // While it is up, paths and child counts ignore it.
    expect(InspectorChildrenAnswerSchema.parse(p.children([]))).toMatchObject({ node: { childElementCount: 2 }, children: [{ tag: 'head' }, { tag: 'body' }], more: false });
    expect(p.highlight([1, 9])).toEqual({ status: 'not-found' });
    expect(p.highlight([1, 1, 0], p.token(), 'h2')).toEqual({ status: 'not-found' });
    // Nothing outlined any more: the host goes.
    expect(p.highlight(null)).toEqual({ status: 'ok' });
    expect(host.isConnected).toBe(false);
    expect(p.html()).toBe(before);
  });

  test('inspector-leaves-dom-unchanged', async () => {
    const p = page();
    const before = p.html();
    const t = p.token();
    p.children([]);
    p.children([1, 1]);
    p.node([1, 1, 0]);
    p.highlight([1, 0], t);
    const picking = p.pick();
    p.trusted(p.document.querySelector('p')!, p.pointer('pointermove'));
    p.trusted(p.document.querySelector('p')!, p.mouse('click'));
    await picking;
    p.call({ op: 'clear' });
    expect(p.html()).toBe(before);
    // Nothing was written to any page element: no attribute, style or text changed.
    for (const el of p.document.querySelectorAll('*')) expect(el.getAttribute('style')).toBeNull();
  });
});

describe('scripts', () => {
  test('inspector-scripts-are-self-contained', async () => {
    const t = 'a'.repeat(32);
    const requests: InspectorRequest[] = [{ op: 'token' }, { op: 'children', path: [], tag: null, token: null, offset: 0 }, { op: 'node', path: [1, 1, 0], tag: 'h1', token: t }, { op: 'highlight', node: null, token: t }, { op: 'clear' }, { op: 'cancelPick' }, { op: 'pick', token: null }];
    for (const request of requests) expect(() => new vm.Script(inspectorScript(request))).not.toThrow();
    // Run in a fresh context with the page's document: nothing from this module is needed.
    const p = page();
    const context = p.dom.getInternalVMContext();
    const token = (vm.runInContext(inspectorScript({ op: 'token' }), context) as { docToken: string }).docToken;
    expect(token).toMatch(DOC_TOKEN_PATTERN);
    expect(InspectorChildrenAnswerSchema.parse(vm.runInContext(inspectorScript({ op: 'children', path: [1], tag: 'body', token, offset: 0 }), context))).toMatchObject({ status: 'ok', docToken: token });
    expect(InspectorNodeAnswerSchema.parse(vm.runInContext(inspectorScript({ op: 'node', path: [1, 1, 0], tag: 'h1', token }), context))).toMatchObject({ status: 'ok', node: { tag: 'h1', region: 'main' } });
    const picking = vm.runInContext(inspectorScript({ op: 'pick', token }), context) as Promise<unknown>;
    expect(vm.runInContext(inspectorScript({ op: 'cancelPick' }), context)).toBe(true);
    await expect(picking).resolves.toBeNull();
    // Run through the target, in the inspector's world only.
    const calls: [number, string][] = [];
    const target = { executeJavaScriptInIsolatedWorld: async (world: number, scripts: { code: string }[]) => (calls.push([world, scripts[0]!.code]), null) };
    await runInspector(target, { op: 'token' });
    expect(calls).toEqual([[INSPECTOR_WORLD_ID, inspectorScript({ op: 'token' })]]);
  });
});

describe('search and source', () => {
  type Search = { status: string; docToken?: string; matches?: { path: NodePath; node: { tag: string; index: number; id: string; textPreview: string } }[]; more?: boolean };
  const search = (p: ReturnType<typeof page>, mode: 'text' | 'selector', query: string, t: string = p.token()) => p.call({ op: 'search', token: t, mode, query }) as Search;
  const source = (p: ReturnType<typeof page>, t: string = p.token()) => p.call({ op: 'source', token: t }) as { status: string; docToken?: string; text?: string; truncated?: boolean };
  /** The element a path names (the test's own reckoning). */
  const at = (p: ReturnType<typeof page>, path: NodePath): Element | undefined => {
    let el: Element | undefined = p.document.documentElement;
    for (const i of path) el = el?.children[i];
    return el;
  };

  test('search-text-finds-paths', () => {
    const p = page(`${BODY}<section><p>Find THE needle here</p><div>needle<span>not mine</span></div><p>other</p></section>`);
    const t = p.token();
    // Something outlined: the overlay's host is in the page, and is never a match nor counted in a path.
    p.highlight([1, 1, 0]);
    expect(p.host()?.isConnected).toBe(true);
    const answer = InspectorSearchAnswerSchema.parse(search(p, 'text', 'Needle'));
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer.docToken).toBe(t);
    expect(answer.more).toBe(false);
    // Own text only, case-insensitive, in document order.
    expect(answer.matches.map((m) => m.node.tag)).toEqual(['p', 'div']);
    for (const match of answer.matches) {
      const el = at(p, match.path)!;
      expect(el.localName).toBe(match.node.tag);
      expect(match.node.index).toBe(match.path.at(-1));
    }
    expect(answer.matches[0]!.node.textPreview).toBe('Find THE needle here');
    // Text inside the head counts too; text split across child elements does not.
    expect(search(p, 'text', 'T').matches!.map((m) => [m.node.tag, m.path])).toContainEqual(['title', [0, 0]]);
    // Attribute values are not text.
    expect(search(p, 'text', 'about tea').matches).toEqual([]);
    expect(search(p, 'text', 'title bold').matches).toEqual([]);
    expect(search(p, 'text', 'Big title').matches!.map((m) => m.node.id)).toEqual(['title']);
    // The host's own label is never searched.
    expect(search(p, 'text', 'h1#title').matches).toEqual([]);
  });

  test('search-selector-invalid-refused', () => {
    const p = page();
    p.highlight([1, 1, 0]);
    const answer = InspectorSearchAnswerSchema.parse(search(p, 'selector', 'main a, h1.hero, div'));
    if (answer.status !== 'ok') throw new Error('not ok');
    // Document order; the overlay host (a `div` of the inspector's own) is never a match.
    expect(answer.matches.map((m) => [m.node.tag, m.path])).toEqual([
      ['h1', [1, 1, 0]],
      ['div', [1, 1, 2]],
    ]);
    expect(search(p, 'selector', 'nav > a').matches!.map((m) => m.path)).toEqual([[1, 0, 0, 0]]);
    expect(search(p, 'selector', 'blink').matches).toEqual([]);
    for (const bad of ['h1[', '!!', 'a:nope(1)', '}']) expect(search(p, 'selector', bad)).toEqual({ status: 'invalid-selector' });
  });

  test('search-capped', () => {
    const many = '<p>hit</p>'.repeat(INSPECTOR_SEARCH_LIMITS.maxResults + 10);
    const p = page(many);
    for (const mode of ['text', 'selector'] as const) {
      const answer = InspectorSearchAnswerSchema.parse(search(p, mode, mode === 'text' ? 'hit' : 'p'));
      if (answer.status !== 'ok') throw new Error('not ok');
      expect(answer.matches).toHaveLength(INSPECTOR_SEARCH_LIMITS.maxResults);
      expect(answer.more).toBe(true);
    }
    // Exactly the cap: nothing more.
    const exact = page('<p>hit</p>'.repeat(INSPECTOR_SEARCH_LIMITS.maxResults));
    expect(search(exact, 'text', 'hit')).toMatchObject({ status: 'ok', more: false });
    // The visit budget stops a search before the end of a large document.
    const tight = page(`${'<div><i>x</i></div>'.repeat(40)}<p>late</p>`, { limits: { maxNodesVisited: 30 } as Partial<InspectorScriptLimits> });
    expect(search(tight, 'text', 'late')).toMatchObject({ status: 'ok', matches: [], more: true });
    expect(search(tight, 'selector', 'i')).toMatchObject({ status: 'ok', more: true });
    expect((search(tight, 'selector', 'i').matches ?? []).length).toBeLessThanOrEqual(30);
    // Every node looked at counts, comments and elements without text included.
    const comments = page(`${'<!--c-->'.repeat(40)}<p>late</p>`, { limits: { maxNodesVisited: 30 } as Partial<InspectorScriptLimits> });
    expect(search(comments, 'text', 'late')).toMatchObject({ status: 'ok', matches: [], more: true });
    const empties = page(`${'<b></b>'.repeat(40)}<p>late</p>`, { limits: { maxNodesVisited: 30 } as Partial<InspectorScriptLimits> });
    expect(search(empties, 'text', 'late')).toMatchObject({ status: 'ok', matches: [], more: true });
    expect(search(page(`${'<!--c-->'.repeat(10)}<p>late</p>`, { limits: { maxNodesVisited: 30 } as Partial<InspectorScriptLimits> }), 'text', 'late')).toMatchObject({ status: 'ok', more: false, matches: [{ node: { tag: 'p' } }] });
    // A selector match deeper than a path may be is left out (its ancestor chain is checked first).
    const deep = page(`${'<div>'.repeat(8)}<i class="deep">x</i>${'</div>'.repeat(8)}<i class="deep">y</i>`, { limits: { maxPathDepth: 5 } as Partial<InspectorScriptLimits> });
    expect(search(deep, 'selector', '.deep').matches!.map((m) => m.path)).toEqual([[1, 1]]);
    expect(search(deep, 'text', 'x').matches).toEqual([]);
    // Another document's token.
    expect(search(p, 'text', 'hit', 'f'.repeat(32))).toEqual({ status: 'stale' });
    expect(source(p, 'f'.repeat(32))).toEqual({ status: 'stale' });
  });

  test('serialize-capped-and-truncated-flag', () => {
    const p = page(`${BODY}<script>if (1 < 2) document.title = "</b>";</script>`);
    const html = p.html();
    const answer = InspectorSourceAnswerSchema.parse({ kind: 'rendered', ref: 0, ...source(p) });
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer.text).toBe(`<!DOCTYPE html>\n${html}`);
    expect(answer.truncated).toBe(false);
    // With an outline showing, the overlay host is left out: the same text.
    const t = p.token();
    p.highlight([1, 1, 0], t);
    expect(p.html()).not.toBe(html);
    expect(source(p)).toMatchObject({ status: 'ok', docToken: t, text: `<!DOCTYPE html>\n${html}`, truncated: false });
    // `<html>`'s start tag is written from its attributes (escaped as the browser does), never by cloning it.
    const tricky = page('<p>x</p>');
    const root = tricky.document.documentElement;
    root.setAttribute('data-q', 'say "hi" & a\u00a0b <ok>');
    root.setAttribute('is', 'x-root');
    const plain = tricky.html();
    const clone = vi.spyOn(tricky.window.Node.prototype, 'cloneNode');
    tricky.highlight([1, 0]);
    expect(source(tricky).text).toBe(`<!DOCTYPE html>\n${plain}`);
    expect(source(tricky).text).toContain('data-q="say &quot;hi&quot; &amp; a&nbsp;b <ok>"');
    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();
    // A legacy doctype keeps its ids; no doctype, no line for it.
    const legacy = new JSDOM('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><html><body>x</body></html>');
    const legacyAnswer = inspectPage(legacy.window.document as unknown as InspectorDocument, {}, INSPECTOR_STATE_KEY, { op: 'source', token: null }, INSPECTOR_SCRIPT_LIMITS) as { text: string };
    expect(legacyAnswer.text.split('\n')[0]).toBe('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">');
    const none = new JSDOM('<html><body>x</body></html>');
    expect((inspectPage(none.window.document as unknown as InspectorDocument, {}, INSPECTOR_STATE_KEY, { op: 'source', token: null }, INSPECTOR_SCRIPT_LIMITS) as { text: string }).text).toBe('<html><head></head><body>x</body></html>');
    // Past the cap: cut, flagged, never splitting a surrogate pair.
    const small = page(`<p>${'a'.repeat(50)}😀😀</p>`, { limits: { maxSourceChars: 140 } as Partial<InspectorScriptLimits> });
    const full = `<!DOCTYPE html>\n${small.html()}`;
    const cut = source(small);
    expect(cut.truncated).toBe(true);
    expect(cut.text!.length).toBeLessThanOrEqual(140);
    expect(full.startsWith(cut.text!)).toBe(true);
    const at = full.indexOf('😀');
    const capped = page(`<p>${'a'.repeat(50)}😀😀</p>`, { limits: { maxSourceChars: at + 1 } as Partial<InspectorScriptLimits> });
    expect(source(capped).text).toBe(full.slice(0, at));
    // The real cap holds for a large document, and the answer validates.
    const big = page(`<p>${'x'.repeat(INSPECTOR_SOURCE_MAX_CHARS)}</p>`);
    const bigAnswer = InspectorSourceAnswerSchema.parse({ kind: 'rendered', ref: 0, ...source(big) });
    expect(bigAnswer).toMatchObject({ status: 'ok', truncated: true });
    if (bigAnswer.status === 'ok') expect(bigAnswer.text).toHaveLength(INSPECTOR_SOURCE_MAX_CHARS);
  });

  test('scripts-never-write-dom', () => {
    const p = page(`${BODY}<!-- a comment --><template><p>t</p></template>`);
    const before = p.html();
    const t = p.token();
    const reads = () => {
      search(p, 'text', 'title', t);
      search(p, 'selector', '*', t);
      search(p, 'selector', 'h1[', t);
      search(p, 'selector', 'p:has(img)', t);
      source(p, t);
    };
    reads();
    expect(p.html()).toBe(before);
    expect(p.host()).toBeUndefined();
    // With an outline showing: only the inspector's own host is added, and it goes with the outline.
    p.highlight([1, 1, 0], t);
    reads();
    p.highlight(null, t);
    expect(p.html()).toBe(before);
    for (const el of p.document.querySelectorAll('*')) expect(el.getAttribute('style')).toBeNull();
    // The scripts run in the inspector's world, self-contained.
    for (const request of [{ op: 'search', token: t, mode: 'selector', query: 'a' }, { op: 'source', token: t }] as InspectorRequest[]) {
      expect(() => new vm.Script(inspectorScript(request))).not.toThrow();
      expect(vm.runInContext(inspectorScript(request), p.dom.getInternalVMContext())).toMatchObject({ status: 'stale' });
    }
  });
});
