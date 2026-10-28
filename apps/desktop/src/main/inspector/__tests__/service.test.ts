// Spec: specs/inspector.spec.ts (INSPECTOR_LIMITS, INSPECTOR_REFUSALS), specs/inspector.schema.ts (the answers)
// Acceptance: specs/inspector.feature.md (The service; Scenarios inspector-service-refusals, inspector-service-deadlines,
// inspector-service-validates-answers, inspector-one-pick-per-tab, inspector-pick-cancel-paths)
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { INSPECTOR_LIMITS } from '@app/specs/inspector.spec';
import { INSPECTOR_SCRIPT_LIMITS, type InspectorRequest, type InspectorScriptLimits } from '../page-script';
import { createInspectorService, inspectorTabs, type InspectorContents } from '../service';

const TOKEN = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const ROW = { index: 0, tag: 'html', id: '', classes: [], childElementCount: 2, textPreview: '', shadow: false };
const CHILDREN = { status: 'ok', docToken: TOKEN, path: [], node: ROW, offset: 0, children: [{ ...ROW, tag: 'head' }], more: false };
const NODE = {
  status: 'ok',
  docToken: TOKEN,
  path: [1, 0],
  node: {
    tag: 'h1',
    attributes: [{ name: 'id', value: 'title', truncated: false }],
    attributesMore: false,
    box: { x: 1, y: 2, width: 3, height: 4 },
    offset: { x: 1, y: 2 },
    styles: [{ name: 'display', value: 'block' }],
    region: 'main',
    seo: { headingLevel: 1, link: null, image: null, meta: null, linkRel: null, lang: 'en' },
    childElementCount: 0,
  },
};

type Answer = (request: InspectorRequest) => unknown;

class FakeContents extends EventEmitter {
  destroyed = false;
  url = 'https://example.com/page';
  focused = 0;
  readonly requests: InspectorRequest[] = [];
  constructor(public answer: Answer) {
    super();
  }
  executeJavaScriptInIsolatedWorld = async (): Promise<unknown> => undefined;
  getURL = () => this.url;
  isDestroyed = () => this.destroyed;
  focus = () => void (this.focused += 1);
}

function setup(answer: Answer = () => CHILDREN, limits: Partial<InspectorScriptLimits> = {}) {
  const contents = new FakeContents(answer);
  let active: number | null = 1;
  const logs: string[] = [];
  const service = createInspectorService({
    tabs: { activeTabId: () => active, contentsOf: (tabId) => (tabId === 1 || tabId === 2 ? (contents as unknown as InspectorContents) : null) },
    log: (line) => logs.push(line),
    limits: { ...INSPECTOR_SCRIPT_LIMITS, scriptTimeoutMs: 30, pickTimeoutMs: 60, ...limits },
    activePollMs: 5,
    run: async (_target, request) => {
      contents.requests.push(request);
      return contents.answer(request);
    },
  });
  return { contents, service, logs, setActive: (id: number | null) => void (active = id) };
}

const never = (): Promise<never> => new Promise(() => undefined);
/** A pick that waits until the test answers it. */
function pending() {
  let answer: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((resolve) => (answer = resolve));
  return { promise, answer: (value: unknown) => answer(value) };
}
const ops = (contents: FakeContents) => contents.requests.map((r) => r.op);

afterEach(() => {
  vi.useRealTimers();
});

describe('inspector service', () => {
  test('inspector-service-refusals', async () => {
    const { service, contents, setActive } = setup();
    expect(await service.children(9, [], null, 0)).toEqual({ status: 'refused', reason: 'no-tab' });
    expect(await service.children(2, [], null, 0)).toEqual({ status: 'refused', reason: 'not-active' });
    expect(await service.pick(2, null)).toEqual({ status: 'refused', reason: 'not-active' });
    expect(await service.highlight(2, [1], null)).toEqual({ status: 'refused', reason: 'not-active' });
    contents.url = 'about:blank';
    expect(await service.node(1, [1], null)).toEqual({ status: 'refused', reason: 'no-page' });
    contents.url = 'https://example.com/page';
    contents.destroyed = true;
    expect(await service.children(1, [], null, 0)).toEqual({ status: 'refused', reason: 'no-tab' });
    contents.destroyed = false;
    // Clear works on any open tab (the panel clears the one it leaves); nothing ran in the page above.
    expect(contents.requests).toEqual([]);
    contents.answer = () => ({ status: 'ok' });
    setActive(1);
    expect(await service.clear(2)).toEqual({ status: 'ok' });
    expect(ops(contents)).toEqual(['clear']);
    expect(await service.children(1, [], null, 0)).toEqual({ status: 'refused', reason: 'failed' }); // `{ status: 'ok' }` is no children answer
  });

  test('inspector-service-deadlines', async () => {
    const { service, contents, logs } = setup(() => never());
    const started = Date.now();
    expect(await service.children(1, [], null, 0)).toEqual({ status: 'refused', reason: 'failed' });
    expect(await service.node(1, [], null)).toEqual({ status: 'refused', reason: 'failed' });
    expect(await service.highlight(1, null, null)).toEqual({ status: 'refused', reason: 'failed' });
    expect(await service.clear(1)).toEqual({ status: 'refused', reason: 'failed' });
    // A pick that never answers fails after its own deadline (pick + script), and is ended in the page too.
    expect(await service.pick(1, null)).toEqual({ status: 'refused', reason: 'failed' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ops(contents)).toEqual(['children', 'node', 'highlight', 'clear', 'pick', 'cancelPick']);
    expect(logs.every((line) => line.startsWith('inspector: '))).toBe(true);
    expect(logs).toContain('inspector: the children script did not answer in time');
    // A script that rejects is a failure too.
    contents.answer = () => Promise.reject(new Error('page said SECRET'));
    expect(await service.node(1, [], null)).toEqual({ status: 'refused', reason: 'failed' });
    expect(logs.join('\n')).not.toContain('SECRET');
    // The spec's deadlines are the defaults.
    expect(INSPECTOR_SCRIPT_LIMITS).toMatchObject({ scriptTimeoutMs: INSPECTOR_LIMITS.scriptTimeoutMs, pickTimeoutMs: INSPECTOR_LIMITS.pickTimeoutMs });
  });

  test('inspector-service-validates-answers', async () => {
    const { service, contents, logs } = setup();
    expect(await service.children(1, [], null, 0)).toEqual(CHILDREN);
    expect(await service.children(1, [], TOKEN, 0)).toEqual(CHILDREN);
    contents.answer = () => NODE;
    expect(await service.node(1, [1, 0], TOKEN)).toEqual(NODE);
    const garbage: [unknown, string][] = [
      [{ status: 'stale' }, 'stale'],
      [{ status: 'not-found' }, 'not-found'],
      [{ ...CHILDREN, docToken: OTHER }, 'stale'], // another document than asked
      [{ ...CHILDREN, path: [1] }, 'failed'], // another node than asked
      [{ ...CHILDREN, offset: 5 }, 'failed'],
      [{ ...CHILDREN, extra: 'SECRET' }, 'failed'],
      [{ ...CHILDREN, children: new Array(INSPECTOR_LIMITS.maxChildren + 1).fill(ROW) }, 'failed'],
      [{ ...CHILDREN, node: { ...ROW, textPreview: 'SECRET'.repeat(100) } }, 'failed'],
      [{ ...CHILDREN, docToken: 'not a token' }, 'failed'],
      [{ status: 'refused', reason: 'busy' }, 'failed'], // the page may not answer a refusal of its own
      [{ status: 'stale', extra: 1 }, 'failed'],
      ['SECRET', 'failed'],
      [null, 'failed'],
      [
        Object.defineProperty({ ...CHILDREN }, 'more', {
          get() {
            throw new Error('SECRET');
          },
          enumerable: true,
        }),
        'failed',
      ],
    ];
    for (const [i, [raw, reason]] of garbage.entries()) {
      contents.answer = () => raw;
      expect(await service.children(1, [], TOKEN, 0), `garbage ${i}`).toEqual({ status: 'refused', reason });
    }
    contents.answer = () => ({ ...NODE, node: { ...NODE.node, region: 'sidebar' } });
    expect(await service.node(1, [1, 0], TOKEN)).toEqual({ status: 'refused', reason: 'failed' });
    contents.answer = () => ({ ...NODE, node: { ...NODE.node, styles: [{ name: 'cursor', value: 'x' }] } });
    expect(await service.node(1, [1, 0], TOKEN)).toEqual({ status: 'refused', reason: 'failed' });
    contents.answer = () => ({ status: 'refused', reason: 'busy' });
    expect(await service.highlight(1, [1], TOKEN)).toEqual({ status: 'refused', reason: 'failed' });
    // No page text in the log.
    expect(logs.join('\n')).not.toContain('SECRET');
  });

  test('inspector-one-pick-per-tab', async () => {
    const page = pending();
    const { service, contents } = setup((request) => (request.op === 'pick' ? page.promise : request.op === 'cancelPick' ? (page.answer(null), true) : { status: 'ok' }));
    const first = service.pick(1, TOKEN);
    expect(await service.pick(1, TOKEN)).toEqual({ status: 'refused', reason: 'busy' });
    expect(contents.focused).toBe(1); // the page has focus, so the user's Esc reaches it
    expect(await service.cancelPick(1)).toBe(true);
    expect(await first).toEqual({ status: 'refused', reason: 'cancelled' });
    expect(ops(contents)).toEqual(['pick', 'cancelPick']);
    expect(await service.cancelPick(1)).toBe(false);
    // A picked answer, checked.
    const next = pending();
    contents.answer = () => next.promise;
    const second = service.pick(1, TOKEN);
    next.answer({ status: 'picked', docToken: TOKEN, path: [1, 0] });
    expect(await second).toEqual({ status: 'picked', docToken: TOKEN, path: [1, 0] });
    for (const [raw, reason] of [
      [null, 'cancelled'],
      [{ status: 'stale' }, 'stale'],
      [{ status: 'picked', docToken: OTHER, path: [1] }, 'stale'],
      [{ status: 'picked', docToken: TOKEN, path: new Array(INSPECTOR_LIMITS.maxPathDepth + 1).fill(0) }, 'failed'],
      [{ status: 'picked', docToken: TOKEN, path: [-1] }, 'failed'],
    ] as const) {
      contents.answer = () => raw;
      expect(await service.pick(1, TOKEN)).toEqual({ status: 'refused', reason });
    }
    // Every listener is gone after each pick.
    for (const event of ['did-start-navigation', 'destroyed', 'before-input-event']) expect(contents.listenerCount(event)).toBe(0);
  });

  test('inspector-pick-cancel-paths', async () => {
    const cases: [string, (s: ReturnType<typeof setup>) => void][] = [
      ['navigation', (s) => s.contents.emit('did-start-navigation', { isMainFrame: true })],
      ['closing', (s) => s.contents.emit('destroyed')],
      ['tab switch', (s) => s.setActive(2)],
      ['clear', (s) => void s.service.clear(1)],
    ];
    for (const [name, end] of cases) {
      const s = setup((request) => (request.op === 'pick' ? never() : request.op === 'clear' ? { status: 'ok' } : true), { pickTimeoutMs: 5_000 });
      const picking = s.service.pick(1, null);
      await Promise.resolve();
      // A subframe's navigation does not end it.
      s.contents.emit('did-start-navigation', { isMainFrame: false });
      end(s);
      expect(await picking, name).toEqual({ status: 'refused', reason: 'cancelled' });
    }
    // Esc, heard by main before the page: the key never reaches the page.
    const s = setup((request) => (request.op === 'pick' ? never() : true), { pickTimeoutMs: 5_000 });
    const picking = s.service.pick(1, null);
    await Promise.resolve();
    const other = { preventDefault: vi.fn() };
    s.contents.emit('before-input-event', other, { type: 'keyDown', key: 'a' });
    expect(other.preventDefault).not.toHaveBeenCalled();
    const esc = { preventDefault: vi.fn() };
    s.contents.emit('before-input-event', esc, { type: 'keyDown', key: 'Escape' });
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(await picking).toEqual({ status: 'refused', reason: 'cancelled' });
    expect(ops(s.contents)).toEqual(['pick', 'cancelPick']);
  });

  test('inspector-tabs-follow-the-browser', () => {
    const contents = new FakeContents(() => null) as unknown as InspectorContents;
    const tabs = inspectorTabs({ getState: () => ({ activeTabId: 4 }) }, (id) => (id === 4 ? contents : null));
    expect(tabs.activeTabId()).toBe(4);
    expect(tabs.contentsOf(4)).toBe(contents);
    expect(tabs.contentsOf(5)).toBeNull();
  });
});
