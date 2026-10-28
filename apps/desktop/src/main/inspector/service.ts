import type { InspectorService } from '@app/ipc-contract';
import {
  InspectorAckSchema,
  InspectorChildrenAnswerSchema,
  InspectorNodeAnswerSchema,
  InspectorPickAnswerSchema,
  type InspectorAck,
  type InspectorChildrenAnswer,
  type InspectorNodeAnswer,
  type InspectorPickAnswer,
  type InspectorRefusal,
  type NodePath,
} from '@app/specs/inspector.schema';
import { isWebUrl } from '@app/specs/web-url.spec';
import type { WebContents } from 'electron';
import type { z } from 'zod';
import { INSPECTOR_SCRIPT_LIMITS, runInspector, type InspectorRequest, type InspectorScriptLimits, type InspectorScriptTarget } from './page-script';

// The DOM inspector (Phase 6 Task 8; spec `inspector.spec.ts`, `inspector.schema.ts`; acceptance
// `inspector.feature.md`, The service). It reads the active tab's page through the scripts of
// `page-script.ts`, in `INSPECTOR_WORLD_ID` only, and never writes to it. Every script call has a
// deadline (`scriptTimeoutMs`; a pick `pickTimeoutMs` more), and every answer is checked with
// `inspector.schema.ts` before it is used: the page can answer anything. One pick per tab at a
// time; a main-frame navigation, the tab closing or leaving the front, Esc (heard by main before the
// page) or `cancelPick` end it. The service never rejects: each failure is a refusal and one log
// line in frost's own words (never page text or a URL).

/** A tab's WebContents as the inspector uses it (its `did-start-navigation`, `destroyed` and `before-input-event` events while picking). */
export interface InspectorContents extends InspectorScriptTarget, Pick<NodeJS.EventEmitter, 'on' | 'removeListener'> {
  getURL(): string;
  isDestroyed(): boolean;
  /** Gives the page keyboard focus, so the user's Esc reaches it while picking. */
  focus?(): void;
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
}

const ACTIVE_POLL_MS = 250;
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

export function createInspectorService(deps: InspectorServiceDeps): InspectorService {
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
    const onKey = (event: { preventDefault(): void } | undefined, input?: { type?: unknown; key?: unknown }): void => {
      if (input?.type !== 'keyDown' || input.key !== 'Escape') return;
      event?.preventDefault();
      cancel();
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
    }
  }

  return {
    children: (tabId, path, docToken, offset) =>
      guarded<InspectorChildrenAnswer>(
        'children',
        async () => {
          const contents = targetOf(tabId);
          if (typeof contents === 'string') return refused(contents);
          const answer = checked(parse(await script(contents, { op: 'children', path, token: docToken, offset }, limits.scriptTimeoutMs), OK_CHILDREN, 'children'), path, docToken);
          if (typeof answer === 'string') return refused(answer);
          return answer.offset === offset ? answer : refused('failed');
        },
        refused('failed'),
      ),

    node: (tabId, path, docToken) =>
      guarded<InspectorNodeAnswer>(
        'node',
        async () => {
          const contents = targetOf(tabId);
          if (typeof contents === 'string') return refused(contents);
          const answer = checked(parse(await script(contents, { op: 'node', path, token: docToken }, limits.scriptTimeoutMs), OK_NODE, 'node'), path, docToken);
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

    highlight: (tabId, path, docToken) =>
      guarded<InspectorAck>(
        'highlight',
        async () => {
          const contents = targetOf(tabId);
          if (typeof contents === 'string') return refused(contents);
          const answer = parse(await script(contents, { op: 'highlight', path, token: docToken }, limits.scriptTimeoutMs), ACK, 'highlight');
          return typeof answer === 'string' ? refused(answer) : answer;
        },
        refused('failed'),
      ),

    // Any open tab (not only the one in front): the panel clears the tab it leaves.
    clear: (tabId) =>
      guarded<InspectorAck>(
        'clear',
        async () => {
          picks.get(tabId)?.cancel();
          const contents = targetOf(tabId, false);
          if (typeof contents === 'string') return refused(contents);
          const answer = parse(await script(contents, { op: 'clear' }, limits.scriptTimeoutMs), ACK, 'clear');
          return typeof answer === 'string' ? refused(answer) : answer;
        },
        refused('failed'),
      ),
  };
}

/** `InspectorTabs` over the browser controller's state and main's map of tab WebContents. */
export function inspectorTabs(browser: { getState(): { readonly activeTabId: number | null } }, contentsOf: (tabId: number) => InspectorContents | null): InspectorTabs {
  return { activeTabId: () => browser.getState().activeTabId, contentsOf };
}

/** Main's inspector over Electron: the tabs' live WebContents (`index.ts` creates it with one line). */
export function createMainInspector({ browser, tabContents, log }: { readonly browser: { getState(): { readonly activeTabId: number | null }; tabIdOf(contents: WebContents): number | null }; readonly tabContents: ReadonlyMap<number, WebContents>; readonly log: (message: string) => void }): InspectorService {
  const contentsOf = (tabId: number): WebContents | null => [...tabContents.values()].find((contents) => !contents.isDestroyed() && browser.tabIdOf(contents) === tabId) ?? null;
  return createInspectorService({ tabs: inspectorTabs(browser, contentsOf), log });
}
