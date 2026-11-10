import type { InspectorService } from '@app/ipc-contract';
import {
  DocTokenSchema,
  InspectorAckSchema,
  InspectorChildrenAnswerSchema,
  InspectorNodeAnswerSchema,
  InspectorPickAnswerSchema,
  InspectorSearchAnswerSchema,
  InspectorSourceAnswerSchema,
  type InspectorAck,
  type InspectorChildrenAnswer,
  type InspectorCopySourceAnswer,
  type InspectorNodeAnswer,
  type InspectorPickAnswer,
  type InspectorRefusal,
  type InspectorSearchAnswer,
  type InspectorSourceAnswer,
  type InspectorSourceKind,
  type NodePath,
} from '@app/specs/inspector.schema';
import { isWebUrl } from '@app/specs/web-url.spec';
import type { WebContents } from 'electron';
import { z } from 'zod';
import type { ServedSourceState } from '../seo/served';
import { INSPECTOR_SCRIPT_LIMITS, runInspector, type InspectorRequest, type InspectorScriptLimits, type InspectorScriptTarget } from './page-script';

// The DOM inspector (Phase 6 Task 8; spec `inspector.spec.ts`, `inspector.schema.ts`; acceptance
// `inspector.feature.md`, The service). It reads the active tab's page through the scripts of
// `page-script.ts`, in `INSPECTOR_WORLD_ID` only, and never writes to it. Every script call has a
// deadline (`scriptTimeoutMs`; a pick `pickTimeoutMs` more), and every answer is checked with
// `inspector.schema.ts` before it is used: the page can answer anything. One pick per tab at a
// time; a main-frame navigation, the tab closing or leaving the front, Esc (heard by main before the
// page) or `cancelPick` end it. The service never rejects: each failure is a refusal and one log
// line in frost's own words (never page text or a URL).
//
// Search and sources (Phase 11 Task 5): `search` and the rendered source run in the same world with
// the same deadline and checks. The served source is never fetched or decoded here: it is the text the
// analysis worker decoded for the audit's served fetch, kept by `seo/served.ts` (`served`), and
// answered only if the page confirms it still shows the panel's document **and** the tab's document
// generation and URL did not change while it was asked. Each source answer carries a `ref`: "Copy
// source" names it and main writes, with the clipboard it holds, only the text it answered under that
// `ref` (rendered: the text it kept from that read; served: the served entry that `ref` names, still
// the tab's for its current document and URL), else `stale`. The chrome never sends the text.
// The kept rendered text is dropped on `clear` of its tab, when its tab's WebContents is destroyed,
// and on Clear Browsing Data (`forget`).

/** A tab's WebContents as the inspector uses it (its `did-start-navigation`, `destroyed` and `before-input-event` events while picking). */
export interface InspectorContents extends InspectorScriptTarget, Pick<NodeJS.EventEmitter, 'on' | 'removeListener'> {
  getURL(): string;
  isDestroyed(): boolean;
  /** Gives the page keyboard focus, so the user's Esc reaches it while picking. */
  focus?(): void;
}

/** The served HTML of a tab's page, as the Inspector reads it (`seo/served.ts`); never fetches. */
export interface InspectorServed {
  /** The tab's document as the served cache knows it: its navigation generation (`ServedHtml.generation`) and its current URL. */
  document(contents: InspectorContents): { readonly generation: number; readonly url: string };
  /** The served source of the tab's current page (`ServedHtml.source`); `null`/`undefined`: nothing fetched. */
  source(contents: InspectorContents): ServedSourceState | null | undefined;
}

/** What the service needs of the browser. */
export interface InspectorTabs {
  activeTabId(): number | null;
  /** The tab's live page WebContents, `null` for an id that names no open tab. */
  contentsOf(tabId: number): InspectorContents | null;
}

export interface InspectorServiceDeps {
  readonly tabs: InspectorTabs;
  /** One line per refusal that is a failure (never page text or a URL). */
  readonly log?: (message: string) => void;
  readonly limits?: InspectorScriptLimits;
  /** How often a pick checks that its tab is still in front (ms). */
  readonly activePollMs?: number;
  /** Runs a request in the tab's inspector world (tests replace it). */
  readonly run?: (target: InspectorScriptTarget, request: InspectorRequest, limits: InspectorScriptLimits) => Promise<unknown>;
  /** The served source of the tab's current page (`seo/served.ts`, `ServedHtml.source`): never fetches. `null`/`undefined`: nothing fetched. */
  readonly served?: InspectorServed;
  /** Electron's `clipboard` in main ("Copy source"); without it nothing is written. */
  readonly clipboard?: { writeText(text: string): void };
}

const ACTIVE_POLL_MS = 250;
/** Longest main waits for the key-up of an Esc it took (ms). */
const ESCAPE_UP_MS = 5_000;
const refused = (reason: InspectorRefusal) => ({ status: 'refused', reason }) as const;
/** An error's name: never its message (it may quote the page). */
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown error');
const TIMED_OUT = Symbol('timed out');
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const samePath = (a: NodePath, b: NodePath): boolean => a.length === b.length && a.every((step, i) => step === b[i]);

/** The answers' `ok` / `picked` variants: the page may not answer a refusal of its own. */
const OK_CHILDREN = InspectorChildrenAnswerSchema.options[0];
const OK_NODE = InspectorNodeAnswerSchema.options[0];
const PICKED = InspectorPickAnswerSchema.options[0];
const ACK = InspectorAckSchema.options[0];
const OK_SEARCH = InspectorSearchAnswerSchema.options[0];
/** The rendered source as the page answers it (the service adds `kind`). */
const PAGE_SOURCE = InspectorSourceAnswerSchema.options[0].omit({ kind: true, ref: true });
const OK_SOURCE = InspectorSourceAnswerSchema.options[0];
const TOKEN_ANSWER = z.strictObject({ docToken: DocTokenSchema });

/** The inspector as main holds it: the IPC service, plus `forget` for Clear Browsing Data. */
export interface MainInspectorService extends InspectorService {
  /** Drops the kept rendered source (Clear Browsing Data). */
  forget(): void;
}

export function createInspectorService(deps: InspectorServiceDeps): MainInspectorService {
  const { tabs } = deps;
  const limits = deps.limits ?? INSPECTOR_SCRIPT_LIMITS;
  const run = deps.run ?? runInspector;
  const log = (message: string): void => deps.log?.(`inspector: ${message}`);
  /** The pick each tab is running (one at a time): ends it with nothing picked. */
  const picks = new Map<number, { cancel(): void }>();

  /** The tab's contents if it may be inspected (`active`: only the tab in front), else why not. */
  const targetOf = (tabId: number, active = true): InspectorContents | InspectorRefusal => {
    const contents = tabs.contentsOf(tabId);
    if (!contents || contents.isDestroyed()) return 'no-tab';
    if (active && tabs.activeTabId() !== tabId) return 'not-active';
    return isWebUrl(contents.getURL()) ? contents : 'no-page';
  };

  /** `request`'s raw answer, `TIMED_OUT` past `ms`, or `TIMED_OUT` too when the script rejects (logged). */
  async function script(contents: InspectorScriptTarget, request: InspectorRequest, ms: number, signal?: AbortSignal): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => run(contents, request, limits))
          .catch((error: unknown) => {
            log(`the ${request.op} script failed (${nameOf(error)})`);
            return TIMED_OUT;
          }),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), ms);
          if (signal) {
            onAbort = () => resolve(TIMED_OUT);
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** A raw answer's refusal (`stale`, `not-found`, `failed`), or the answer parsed with `schema`. */
  function parse<T>(raw: unknown, schema: z.ZodType<T>, what: string): T | InspectorRefusal {
    if (raw === TIMED_OUT) {
      log(`the ${what} script did not answer in time`);
      return 'failed';
    }
    if (isPlainObject(raw) && Object.keys(raw).length === 1 && (raw['status'] === 'stale' || raw['status'] === 'not-found')) return raw['status'];
    try {
      const parsed = schema.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch {
      // A getter that throws, or anything else Zod could not walk.
    }
    log(`the ${what} answer is not one`);
    return 'failed';
  }

  /** `run`'s answer, or `failed` (logged) if it throws: the service never rejects. */
  const guarded = async <T>(what: string, body: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await body();
    } catch (error) {
      log(`${what} failed (${nameOf(error)})`);
      return fallback;
    }
  };

  /** The answer, refused if the page answered for another path or document than asked. */
  const checked = <A extends { docToken: string; path: NodePath }>(answer: A | InspectorRefusal, path: NodePath, token: string | null): A | InspectorRefusal => {
    if (typeof answer === 'string') return answer;
    if (!samePath(answer.path, path)) {
      log('the page answered for another node');
      return 'failed';
    }
    return token !== null && answer.docToken !== token ? 'stale' : answer;
  };

  async function pickTab(tabId: number, docToken: string | null, signal: AbortSignal): Promise<InspectorPickAnswer> {
    const contents = targetOf(tabId);
    if (typeof contents === 'string') return refused(contents);
    const cancel = (): void => controller.abort();
    const controller = new AbortController();
    signal.addEventListener('abort', cancel, { once: true });
    const onNavigate = (details?: { isMainFrame?: unknown }): void => {
      if (details?.isMainFrame === true) cancel();
    };
    const onDestroyed = (): void => cancel();
    // Esc is heard by main before the page gets it, so a page cannot keep its own Esc from cancelling.
    // Its key-up is kept from the page too (as `browser/tab-events.ts` does for fullscreen), even once the pick has ended.
    let escapeTaken = false;
    const onKey = (event: { preventDefault(): void } | undefined, input?: { type?: unknown; key?: unknown }): void => {
      if (input?.key !== 'Escape' || (input.type !== 'keyDown' && input.type !== 'keyUp')) return;
      event?.preventDefault();
      if (input.type === 'keyDown') {
        escapeTaken = true;
        cancel();
      }
    };
    contents.on('did-start-navigation', onNavigate);
    contents.on('destroyed', onDestroyed);
    contents.on('before-input-event', onKey);
    const poll = setInterval(() => {
      if (contents.isDestroyed() || tabs.activeTabId() !== tabId) cancel();
    }, deps.activePollMs ?? ACTIVE_POLL_MS);
    try {
      try {
        contents.focus?.();
      } catch {
        // Focus is a convenience: Cancel in the chrome still ends the pick.
      }
      const raw = await script(contents, { op: 'pick', token: docToken }, limits.pickTimeoutMs + limits.scriptTimeoutMs, controller.signal);
      if (controller.signal.aborted || raw === TIMED_OUT) {
        if (!controller.signal.aborted) log('the pick did not answer in time');
        // End it in the page too (its overlay goes); a page that does not answer is left to its own timeout.
        if (!contents.isDestroyed()) await script(contents, { op: 'cancelPick' }, limits.scriptTimeoutMs);
        return refused(controller.signal.aborted ? 'cancelled' : 'failed');
      }
      if (raw === null) return refused('cancelled');
      const answer = parse(raw, PICKED, 'pick');
      if (typeof answer === 'string') return refused(answer);
      return docToken !== null && answer.docToken !== docToken ? refused('stale') : answer;
    } finally {
      clearInterval(poll);
      signal.removeEventListener('abort', cancel);
      contents.removeListener('did-start-navigation', onNavigate);
      contents.removeListener('destroyed', onDestroyed);
      contents.removeListener('before-input-event', onKey);
      if (escapeTaken && !contents.isDestroyed()) swallowEscapeUp(contents);
    }
  }

  /** Keeps the key-up of an Esc main took from the page (the next one only, for at most a few seconds). */
  function swallowEscapeUp(contents: InspectorContents): void {
    const stop = (): void => {
      clearTimeout(timer);
      contents.removeListener('before-input-event', onUp);
    };
    const onUp = (event: { preventDefault(): void } | undefined, input?: { type?: unknown; key?: unknown }): void => {
      if (input?.key !== 'Escape' || input.type !== 'keyUp') return;
      event?.preventDefault();
      stop();
    };
    const timer = setTimeout(stop, ESCAPE_UP_MS);
    contents.on('before-input-event', onUp);
  }

  /** The last rendered source answered (one, over all tabs): what Copy source writes for its `ref`. */
  let held: { readonly tabId: number; readonly docToken: string; readonly ref: number; readonly text: string; readonly truncated: boolean } | null = null;
  /** Stops watching the held source's WebContents for `destroyed`. */
  let unwatchHeld: (() => void) | null = null;
  let refs = 0;

  /** Drops the kept rendered source (all of it, or only `tabId`'s). */
  const dropHeld = (tabId?: number): void => {
    if (held === null || (tabId !== undefined && held.tabId !== tabId)) return;
    unwatchHeld?.();
    unwatchHeld = null;
    held = null;
  };

  /** Keeps `next` (replacing what was kept) until it is replaced or dropped; its tab's WebContents going away drops it. */
  const hold = (contents: InspectorContents, next: NonNullable<typeof held>): void => {
    dropHeld();
    held = next;
    const onDestroyed = (): void => {
      if (held?.ref === next.ref) dropHeld();
    };
    contents.on('destroyed', onDestroyed);
    unwatchHeld = () => contents.removeListener('destroyed', onDestroyed);
  };

  /** Whether the page still shows the document `docToken` (`stale` if not; `failed` on no answer). */
  async function sameDocument(contents: InspectorContents, docToken: string): Promise<true | InspectorRefusal> {
    const token = parse(await script(contents, { op: 'token' }, limits.scriptTimeoutMs), TOKEN_ANSWER, 'token');
    if (typeof token === 'string') return token;
    return token.docToken === docToken ? true : 'stale';
  }

  /**
   * The tab's served source for the document `docToken`: the tab's document generation and URL are
   * read before the page confirms its token and again after, and either changing meanwhile is `stale`.
   */
  async function servedFor(contents: InspectorContents, docToken: string): Promise<ServedSourceState | InspectorRefusal> {
    const served = deps.served;
    const before = served?.document(contents);
    const same = await sameDocument(contents, docToken);
    if (same !== true) return same;
    if (!served || !before) return { status: 'unavailable', reason: 'not-fetched', httpStatus: null };
    const after = served.document(contents);
    if (after.generation !== before.generation || after.url !== before.url) return 'stale';
    return served.source(contents) ?? { status: 'unavailable', reason: 'not-fetched', httpStatus: null };
  }

  /** The tab's `kind` source for the document `docToken` (rendered: read from the page and kept for Copy source; served: from the served cache). */
  async function readSource(tabId: number, docToken: string, kind: InspectorSourceKind): Promise<InspectorSourceAnswer> {
    const contents = targetOf(tabId);
    if (typeof contents === 'string') return refused(contents);
    if (kind === 'rendered') {
      const answer = parse(await script(contents, { op: 'source', token: docToken }, limits.scriptTimeoutMs), PAGE_SOURCE, 'source');
      if (typeof answer === 'string') return refused(answer);
      if (answer.docToken !== docToken) return refused('stale');
      const ref = ++refs;
      hold(contents, { tabId, docToken, ref, text: answer.text, truncated: answer.truncated });
      return { ...answer, kind, ref };
    }
    const served = await servedFor(contents, docToken);
    if (typeof served === 'string') return refused(served);
    if (served.status === 'pending') return { status: 'pending', kind };
    if (served.status === 'unavailable') return { status: 'unavailable', kind, reason: served.reason, httpStatus: served.httpStatus };
    const answer = OK_SOURCE.safeParse({ status: 'ok', kind, docToken, ref: served.ref, text: served.text, truncated: served.truncated });
    if (answer.success) return answer.data;
    log('the served source is not one');
    return refused('failed');
  }

  /** The text answered under `ref` for the document `docToken`, if it is still what the tab shows; else why not. */
  async function copyable(tabId: number, docToken: string, kind: InspectorSourceKind, ref: number): Promise<{ readonly text: string; readonly truncated: boolean } | InspectorRefusal> {
    const contents = targetOf(tabId);
    if (typeof contents === 'string') return contents;
    if (kind === 'rendered') {
      const kept = held;
      if (kept === null || kept.tabId !== tabId || kept.docToken !== docToken || kept.ref !== ref) return 'stale';
      const same = await sameDocument(contents, docToken);
      return same === true ? kept : same;
    }
    const served = await servedFor(contents, docToken);
    if (typeof served === 'string') return served;
    return served.status === 'ready' && served.ref === ref ? served : 'stale';
  }

  return {
    children: (tabId, path, tag, docToken, offset) =>
      guarded<InspectorChildrenAnswer>(
        'children',
        async () => {
          const contents = targetOf(tabId);
          if (typeof contents === 'string') return refused(contents);
          const answer = checked(parse(await script(contents, { op: 'children', path, tag, token: docToken, offset }, limits.scriptTimeoutMs), OK_CHILDREN, 'children'), path, docToken);
          if (typeof answer === 'string') return refused(answer);
          return answer.offset === offset ? answer : refused('failed');
        },
        refused('failed'),
      ),

    node: (tabId, path, tag, docToken) =>
      guarded<InspectorNodeAnswer>(
        'node',
        async () => {
          const contents = targetOf(tabId);
          if (typeof contents === 'string') return refused(contents);
          const answer = checked(parse(await script(contents, { op: 'node', path, tag, token: docToken }, limits.scriptTimeoutMs), OK_NODE, 'node'), path, docToken);
          return typeof answer === 'string' ? refused(answer) : answer;
        },
        refused('failed'),
      ),

    async pick(tabId, docToken) {
      if (picks.has(tabId)) return refused('busy');
      const controller = new AbortController();
      picks.set(tabId, { cancel: () => controller.abort() });
      try {
        return await pickTab(tabId, docToken, controller.signal);
      } catch (error) {
        log(`the pick failed (${nameOf(error)})`);
        return refused('failed');
      } finally {
        picks.delete(tabId);
      }
    },

    async cancelPick(tabId) {
      const pick = picks.get(tabId);
      if (!pick) return false;
      pick.cancel();
      return true;
    },

    highlight: (tabId, node, docToken) =>
      guarded<InspectorAck>(
        'highlight',
        async () => {
          const contents = targetOf(tabId);
          if (typeof contents === 'string') return refused(contents);
          const answer = parse(await script(contents, { op: 'highlight', node, token: docToken }, limits.scriptTimeoutMs), ACK, 'highlight');
          return typeof answer === 'string' ? refused(answer) : answer;
        },
        refused('failed'),
      ),

    search: (tabId, docToken, mode, query) =>
      guarded<InspectorSearchAnswer>(
        'search',
        async () => {
          const contents = targetOf(tabId);
          if (typeof contents === 'string') return refused(contents);
          const raw = await script(contents, { op: 'search', token: docToken, mode, query }, limits.scriptTimeoutMs);
          // Only a selector can be one the page's browser does not understand.
          if (mode === 'selector' && isPlainObject(raw) && Object.keys(raw).length === 1 && raw['status'] === 'invalid-selector') return refused('invalid-selector');
          const answer = parse(raw, OK_SEARCH, 'search');
          if (typeof answer === 'string') return refused(answer);
          return answer.docToken !== docToken ? refused('stale') : answer;
        },
        refused('failed'),
      ),

    source: (tabId, docToken, kind) => guarded<InspectorSourceAnswer>('source', () => readSource(tabId, docToken, kind), refused('failed')),

    copySource: (tabId, docToken, kind, ref) =>
      guarded<InspectorCopySourceAnswer>(
        'copy source',
        async () => {
          const source = await copyable(tabId, docToken, kind, ref);
          if (typeof source === 'string') return refused(source);
          if (!deps.clipboard) return refused('failed');
          deps.clipboard.writeText(source.text);
          return { status: 'copied', kind, truncated: source.truncated };
        },
        refused('failed'),
      ),

    // Any open tab (not only the one in front): the panel clears the tab it leaves.
    clear: (tabId) =>
      guarded<InspectorAck>(
        'clear',
        async () => {
          picks.get(tabId)?.cancel();
          dropHeld(tabId);
          const contents = targetOf(tabId, false);
          if (typeof contents === 'string') return refused(contents);
          const answer = parse(await script(contents, { op: 'clear' }, limits.scriptTimeoutMs), ACK, 'clear');
          return typeof answer === 'string' ? refused(answer) : answer;
        },
        refused('failed'),
      ),

    forget: () => dropHeld(),
  };
}

/** `InspectorTabs` over the browser controller's state and main's map of tab WebContents. */
export function inspectorTabs(browser: { getState(): { readonly activeTabId: number | null } }, contentsOf: (tabId: number) => InspectorContents | null): InspectorTabs {
  return { activeTabId: () => browser.getState().activeTabId, contentsOf };
}

/** Main's inspector over Electron: the tabs' live WebContents (`index.ts` creates it with one line). */
export function createMainInspector({
  browser,
  tabContents,
  log,
  served,
  clipboard,
}: {
  readonly browser: { getState(): { readonly activeTabId: number | null }; tabIdOf(contents: WebContents): number | null };
  readonly tabContents: ReadonlyMap<number, WebContents>;
  readonly log: (message: string) => void;
  /** The tab's served HTML (`ServedHtml.generation`, and `.source` for its URL, user agent and scripting); read lazily, so the served cache may be set up later. */
  readonly served?: { document(contents: WebContents): { readonly generation: number; readonly url: string }; source(contents: WebContents): ServedSourceState | null | undefined };
  readonly clipboard?: { writeText(text: string): void };
}): MainInspectorService {
  const contentsOf = (tabId: number): WebContents | null => [...tabContents.values()].find((contents) => !contents.isDestroyed() && browser.tabIdOf(contents) === tabId) ?? null;
  return createInspectorService({
    tabs: inspectorTabs(browser, contentsOf),
    log,
    ...(served ? { served: { document: (contents: InspectorContents) => served.document(contents as WebContents), source: (contents: InspectorContents) => served.source(contents as WebContents) } } : {}),
    ...(clipboard ? { clipboard } : {}),
  });
}
