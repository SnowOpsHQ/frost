// Spec: specs/render-profile.spec.ts (TAB_OVERRIDES_WORLD_ID, CSS_OFF_BADGE, CSS_OFF_HINT), specs/agent-page-tools.spec.ts
// (NON_AGENT_WORLD_IDS)
// Acceptance: specs/render-profile.feature.md (Page writes; Tab overrides: CSS off)
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';
import { NON_AGENT_WORLD_IDS } from '@app/specs/agent-page-tools.spec';
import { CSS_OFF_BADGE, CSS_OFF_HINT, TAB_OVERRIDES_WORLD_ID } from '@app/specs/render-profile.spec';
import { CSS_OFF_STATE_KEY, cssOffPage, cssOffScript, runCssOff, type CssOffDocument } from '../css-off';

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="data:text/css,p{color:red}">
<style id="s1">#a { color: rgb(255, 0, 0) }</style>
<style id="s2">#b { color: rgb(0, 128, 0) }</style>
<script>document.head.insertAdjacentHTML('beforeend', '<style id="from-script">#a { color: blue }</style>')</script>
</head><body><p id="a">a</p><p id="b" style="color: rgb(1, 2, 3)">b</p><iframe srcdoc="<style>p{color:red}</style><p>framed</p>"></iframe></body></html>`;

/** A page with its scripts off (as under JavaScript off: only frost's world script runs). */
function page(html = PAGE) {
  const dom = new JSDOM(html, { url: 'https://example.com/page', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { document } = dom.window;
  const sheets = () => [...document.styleSheets] as unknown as { disabled: boolean }[];
  const run = (off: boolean): unknown => vm.runInContext(cssOffScript(off), dom.getInternalVMContext());
  return { dom, document, sheets, run };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('css off', () => {
  test('world-1701-only', async () => {
    expect(TAB_OVERRIDES_WORLD_ID).toBe(1_701);
    expect(NON_AGENT_WORLD_IDS).toContain(TAB_OVERRIDES_WORLD_ID);
    const target = { executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: { code: string }[]): Promise<unknown> => 2) };
    expect(await runCssOff(target, true)).toBe(true);
    expect(await runCssOff(target, false)).toBe(true);
    expect(target.executeJavaScriptInIsolatedWorld.mock.calls).toEqual([
      [TAB_OVERRIDES_WORLD_ID, [{ code: cssOffScript(true) }]],
      [TAB_OVERRIDES_WORLD_ID, [{ code: cssOffScript(false) }]],
    ]);
    // The page can answer anything: only a count is accepted; a failure never rejects.
    for (const answer of ['2', -1, 1.5, Number.NaN, null, { count: 1 }, undefined]) {
      target.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(answer);
      expect(await runCssOff(target, true), String(answer)).toBe(false);
    }
    target.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('gone'));
    expect(await runCssOff(target, true)).toBe(false);
    target.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => {
      throw new Error('destroyed');
    });
    expect(await runCssOff(target, true)).toBe(false);
    // The script is self-contained: it compiles alone and names no module binding.
    for (const off of [true, false]) expect(() => new vm.Script(cssOffScript(off))).not.toThrow();
    expect(CSS_OFF_BADGE).toBe('CSS off (stylesheets)');
    // Shadow roots keep their own styles (not in `document.styleSheets`), and the hint says so.
    expect(CSS_OFF_HINT).toContain('Inline styles, shadow roots and frames keep theirs');
  });

  test('top-frame-only', async () => {
    // Run on the tab's WebContents (its top frame), never on a frame of it.
    const frame = { executeJavaScript: vi.fn(), executeJavaScriptInIsolatedWorld: vi.fn() };
    const target = { executeJavaScriptInIsolatedWorld: vi.fn(async () => 0), mainFrame: { frames: [frame], framesInSubtree: [frame] } };
    await runCssOff(target, true);
    expect(frame.executeJavaScript).not.toHaveBeenCalled();
    expect(frame.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    // In the page: the top document's sheets only; a frame's document keeps its own.
    const p = page();
    expect(p.run(true)).toBe(2);
    expect(p.sheets().every((sheet) => sheet.disabled)).toBe(true);
    const framed = p.document.querySelector('iframe')!.contentDocument;
    for (const sheet of [...(framed?.styleSheets ?? [])] as unknown as { disabled: boolean }[]) expect(sheet.disabled).toBe(false);
    // Inline `style` attributes are not stylesheets: they stay (and nothing else in the DOM changed).
    expect(p.document.getElementById('b')!.getAttribute('style')).toBe('color: rgb(1, 2, 3)');
    expect(p.document.querySelectorAll('[disabled]')).toHaveLength(0);
  });

  test('new-stylesheets-disabled', async () => {
    const p = page();
    p.run(true);
    // A `<style>` the page adds later is disabled too (the world's observer).
    p.document.head.insertAdjacentHTML('beforeend', '<style id="late">#a { color: blue }</style>');
    await tick();
    expect((p.document.getElementById('late') as HTMLStyleElement).sheet!.disabled).toBe(true);
    // A stylesheet that finishes loading later (its `load` event, seen while capturing).
    const link = p.document.createElement('link');
    const loaded = { disabled: false };
    Object.defineProperty(link, 'sheet', { get: () => loaded });
    p.document.body.append(link);
    link.dispatchEvent(new p.dom.window.Event('load'));
    expect(loaded.disabled).toBe(true);
    // Adopted sheets set later by the page are found by the periodic sweep.
    const adopted = { disabled: false };
    const q = page();
    const doc = q.document as unknown as CssOffDocument & { adoptedStyleSheets: unknown[] };
    const store: Record<string, unknown> = {};
    expect(cssOffPage(doc, store, CSS_OFF_STATE_KEY, true, 5)).toBe(2);
    doc.adoptedStyleSheets = [adopted];
    // (The sweep runs every 5 ms: wait for it, never a fixed sleep.)
    await vi.waitFor(() => expect(adopted.disabled).toBe(true));
    // Running again on the same document adds no second observer or timer.
    const state = store[CSS_OFF_STATE_KEY];
    expect(cssOffPage(doc, store, CSS_OFF_STATE_KEY, true, 5)).toBe(3);
    expect(store[CSS_OFF_STATE_KEY]).toBe(state);
    expect(cssOffPage(doc, store, CSS_OFF_STATE_KEY, false, 5)).toBe(3);
    expect(adopted.disabled).toBe(false);
    p.run(false);
  });

  test('off-reenables', async () => {
    const p = page();
    // A sheet the page itself turned off stays off: frost re-enables only the sheets it disabled.
    const own = p.sheets()[1]!;
    own.disabled = true;
    expect(p.run(true)).toBe(1);
    expect(p.sheets().every((sheet) => sheet.disabled)).toBe(true);
    p.document.head.insertAdjacentHTML('beforeend', '<style id="third">#b { color: blue }</style>');
    await tick();
    expect(p.run(false)).toBe(2);
    expect(p.sheets().map((sheet) => sheet.disabled)).toEqual([false, true, false]);
    // Off: nothing is watched any more.
    p.document.head.insertAdjacentHTML('beforeend', '<style id="after">#a { color: blue }</style>');
    await tick();
    expect((p.document.getElementById('after') as HTMLStyleElement).sheet!.disabled).toBe(false);
    expect((p.dom.window as unknown as Record<string, unknown>)[CSS_OFF_STATE_KEY]).toBeUndefined();
    // Off when it was never on: nothing to do.
    expect(page().run(false)).toBe(0);
  });

  test('works-with-javascript-off', async () => {
    // Scripts off (JSDOM runs none: the page's own script never added its `<style>`): frost's world
    // script needs nothing from the page and still disables every sheet, and keeps watching.
    const p = page();
    expect(p.document.getElementById('from-script')).toBeNull();
    expect(p.run(true)).toBe(2);
    expect(p.sheets().every((sheet) => sheet.disabled)).toBe(true);
    p.document.head.insertAdjacentHTML('beforeend', '<style id="late">#a { color: blue }</style>');
    await tick();
    expect((p.document.getElementById('late') as HTMLStyleElement).sheet!.disabled).toBe(true);
    p.run(false);
  });
});
