// Spec: specs/inspector.schema.ts (the inspector.* inputs and answers), specs/inspector.spec.ts (INSPECTOR_LIMITS), specs/ipc-sender.spec.ts
// Acceptance: specs/inspector.feature.md (Router; Scenarios every-inspector-procedure-enforces-sender,
// inspector-inputs-are-validated, inspector-procedures-call-service)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { INSPECTOR_LIMITS, type InspectorAck, type InspectorChildrenAnswer, type InspectorNodeAnswer, type InspectorPickAnswer, type NodePath } from '@app/specs/inspector.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type InspectorService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const TOKEN = '0123456789abcdef0123456789abcdef';
const ROW = { index: 0, tag: 'html', id: '', classes: [], childElementCount: 2, textPreview: '', shadow: false };
const CHILDREN: InspectorChildrenAnswer = { status: 'ok', docToken: TOKEN, path: [], node: ROW, offset: 0, children: [{ ...ROW, tag: 'body', index: 1 }], more: false };
const NODE: InspectorNodeAnswer = {
  status: 'ok',
  docToken: TOKEN,
  path: [1, 0],
  node: {
    tag: 'h1',
    attributes: [],
    attributesMore: false,
    box: { x: 0, y: 0, width: 10, height: 10 },
    offset: { x: 0, y: 0 },
    styles: [{ name: 'display', value: 'block' }],
    region: 'main',
    seo: { headingLevel: 1, link: null, image: null, meta: null, linkRel: null, lang: null },
    childElementCount: 0,
  },
};
const PICKED: InspectorPickAnswer = { status: 'picked', docToken: TOKEN, path: [1, 0] };
const OK: InspectorAck = { status: 'ok' };

function fakeInspector() {
  return {
    children: vi.fn(async (_tabId: number, _path: NodePath, _tag: string | null, _token: string | null, _offset: number): Promise<InspectorChildrenAnswer> => CHILDREN),
    node: vi.fn(async (_tabId: number, _path: NodePath, _tag: string, _token: string): Promise<InspectorNodeAnswer> => NODE),
    pick: vi.fn(async (_tabId: number, _token: string | null): Promise<InspectorPickAnswer> => PICKED),
    cancelPick: vi.fn(async (_tabId: number) => true),
    highlight: vi.fn(async (_tabId: number, _node: { path: NodePath; tag: string } | null, _token: string): Promise<InspectorAck> => OK),
    clear: vi.fn(async (_tabId: number): Promise<InspectorAck> => OK),
  } satisfies InspectorService;
}

function ctxFor(inspector: InspectorService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: inspector === undefined ? {} : { inspector },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { inspector: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.inspector[name];
  if (!fn) throw new Error(`no inspector.${name}`);
  return fn;
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

const VALID_INPUT: Record<string, unknown> = {
  children: { tabId: 1, path: [1, 0], tag: 'main', docToken: TOKEN, offset: 200 },
  node: { tabId: 1, path: [1, 0], tag: 'h1', docToken: TOKEN },
  pick: { tabId: 1, docToken: TOKEN },
  cancelPick: { tabId: 1 },
  highlight: { tabId: 1, node: null, docToken: TOKEN },
  clear: { tabId: 1 },
};
const PROCEDURES = Object.keys(VALID_INPUT);
const untouched = (inspector: ReturnType<typeof fakeInspector>) => {
  for (const fn of Object.values(inspector)) expect(fn).not.toHaveBeenCalled();
};

describe('inspector router', () => {
  test('every-inspector-procedure-enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('inspector.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `inspector.${n}`).sort());
    // `db-only-in-main`: no procedure name reads as being about a database.
    for (const p of paths) expect(p).not.toMatch(/sql|sqlite|database|db\b|exec|query|session/i);
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'file://']) {
        const inspector = fakeInspector();
        for (const input of [VALID_INPUT[name], { bogus: true }, { selector: 'h1' }, undefined]) {
          const error = await errorOf(procedure(ctxFor(inspector, origin), name)(input));
          expect(error.code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(inspector);
      }
    }
    // Without the service: a masked internal error, never a call.
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('inspector-inputs-are-validated', async () => {
    const badTabs = [{ tabId: 0 }, { tabId: -1 }, { tabId: 1.5 }, { tabId: '1' }, {}];
    const badPaths = [new Array(INSPECTOR_LIMITS.maxPathDepth + 1).fill(0), [-1], [1.5], ['0'], [null], '1/0', null, undefined];
    const badTokens = ['', 'x'.repeat(32), TOKEN.toUpperCase(), `${TOKEN}0`, 5, undefined];
    // Never a selector, a script or page text, under any key.
    const smuggled = [{ selector: 'h1' }, { code: 'alert(1)' }, { script: 'x' }, { html: '<b>' }, { world: 0 }];
    const badTags = ['', 'x'.repeat(INSPECTOR_LIMITS.maxNameChars + 1), 5, undefined];
    const first = { tabId: 1, path: [], tag: null, docToken: null, offset: 0 };
    const tree = { tabId: 1, path: [1], tag: 'body', docToken: TOKEN };
    const bad: Record<string, unknown[]> = {
      children: [
        ...badTabs.map((tab) => ({ ...first, ...tab, ...('tabId' in tab ? {} : { tabId: undefined }) })),
        ...badPaths.map((path) => ({ ...tree, path, offset: 0 })),
        ...badTokens.map((docToken) => ({ ...tree, docToken, offset: 0 })),
        ...badTags.map((tag) => ({ ...tree, tag, offset: 0 })),
        // A null token or tag only for the first read: `<html>`'s children from offset 0.
        { ...tree, docToken: null, offset: 0 },
        { ...tree, tag: null, offset: 0 },
        { ...first, offset: 200 },
        { ...first, path: [1] },
        { ...first, docToken: TOKEN, offset: 200 },
        { ...tree },
        { ...tree, offset: -1 },
        { ...tree, offset: 1.5 },
        { ...tree, offset: '0' },
        ...smuggled.map((extra) => ({ ...tree, offset: 0, ...extra })),
      ],
      node: [...badPaths.map((path) => ({ ...tree, path })), ...badTokens.map((docToken) => ({ ...tree, docToken })), ...badTags.map((tag) => ({ ...tree, tag })), { ...tree, docToken: null }, { ...tree, tag: null }, ...smuggled.map((extra) => ({ ...tree, ...extra }))],
      pick: [...badTokens.map((docToken) => ({ tabId: 1, docToken })), { tabId: 0, docToken: null }, ...smuggled.map((extra) => ({ tabId: 1, docToken: null, ...extra }))],
      cancelPick: [...badTabs, undefined, { tabId: 1, extra: 1 }],
      highlight: [
        ...badPaths.filter((path) => path !== null).map((path) => ({ tabId: 1, node: { path, tag: 'p' }, docToken: TOKEN })),
        ...badTags.map((tag) => ({ tabId: 1, node: { path: [1], tag }, docToken: TOKEN })),
        ...badTokens.map((docToken) => ({ tabId: 1, node: null, docToken })),
        { tabId: 1, node: null, docToken: null },
        { tabId: 1, path: [1], docToken: TOKEN },
        { tabId: 1, node: { path: [1], tag: 'p', extra: 1 }, docToken: TOKEN },
        ...smuggled.map((extra) => ({ tabId: 1, node: null, docToken: TOKEN, ...extra })),
      ],
      clear: [...badTabs, undefined, ...smuggled.map((extra) => ({ tabId: 1, ...extra }))],
    };
    for (const name of PROCEDURES) {
      for (const input of bad[name]!) {
        const inspector = fakeInspector();
        const outcome = await procedure(ctxFor(inspector), name)(input).then(
          () => 'accepted',
          (e: unknown) => (e instanceof TRPCError ? e.code : 'other'),
        );
        expect(outcome, `${name} ${String(JSON.stringify(input))?.slice(0, 80)}`).toBe('BAD_REQUEST');
        untouched(inspector);
      }
    }
  });

  test('inspector-procedures-call-service', async () => {
    const inspector = fakeInspector();
    const call = (name: string, input?: unknown) => procedure(ctxFor(inspector), name)(input);
    await expect(call('children', VALID_INPUT.children)).resolves.toEqual(CHILDREN);
    expect(inspector.children).toHaveBeenLastCalledWith(1, [1, 0], 'main', TOKEN, 200);
    await expect(call('children', { tabId: 1, path: [], tag: null, docToken: null, offset: 0 })).resolves.toEqual(CHILDREN);
    expect(inspector.children).toHaveBeenLastCalledWith(1, [], null, null, 0);
    await expect(call('node', VALID_INPUT.node)).resolves.toEqual(NODE);
    expect(inspector.node).toHaveBeenLastCalledWith(1, [1, 0], 'h1', TOKEN);
    await expect(call('pick', VALID_INPUT.pick)).resolves.toEqual(PICKED);
    expect(inspector.pick).toHaveBeenLastCalledWith(1, TOKEN);
    await expect(call('cancelPick', { tabId: 3 })).resolves.toBe(true);
    expect(inspector.cancelPick).toHaveBeenLastCalledWith(3);
    await expect(call('highlight', { tabId: 1, node: { path: [1], tag: 'body' }, docToken: TOKEN })).resolves.toEqual(OK);
    expect(inspector.highlight).toHaveBeenLastCalledWith(1, { path: [1], tag: 'body' }, TOKEN);
    await expect(call('clear', { tabId: 2 })).resolves.toEqual(OK);
    expect(inspector.clear).toHaveBeenLastCalledWith(2);
    inspector.pick.mockResolvedValueOnce({ status: 'refused', reason: 'busy' });
    await expect(call('pick', VALID_INPUT.pick)).resolves.toEqual({ status: 'refused', reason: 'busy' });
    // Answers are checked on the way out: a malformed or over-long answer never reaches the chrome.
    inspector.children.mockResolvedValueOnce({ ...CHILDREN, children: new Array(INSPECTOR_LIMITS.maxChildren + 1).fill(ROW) } as InspectorChildrenAnswer);
    expect((await errorOf(call('children', VALID_INPUT.children))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    inspector.node.mockResolvedValueOnce({ ...NODE, extra: 1 } as unknown as InspectorNodeAnswer);
    expect((await errorOf(call('node', VALID_INPUT.node))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    inspector.pick.mockResolvedValueOnce({ status: 'refused', reason: 'nope' } as unknown as InspectorPickAnswer);
    expect((await errorOf(call('pick', VALID_INPUT.pick))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    inspector.cancelPick.mockResolvedValueOnce('yes' as unknown as boolean);
    expect((await errorOf(call('cancelPick', { tabId: 1 }))).code).toBe(IPC_INTERNAL_ERROR_CODE);
  });
});
