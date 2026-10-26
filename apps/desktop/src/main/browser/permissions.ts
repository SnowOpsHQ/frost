import type { StoredDecision } from '@app/db';
import type { PermissionPrompt } from '@app/specs/browser.spec';
import {
  MAX_COALESCED_REQUESTS,
  MAX_PENDING_PROMPTS_PER_TAB,
  MAX_PROMPT_IGNORES,
  MEDIA_TYPE_PERMISSION,
  MEDIA_TYPES,
  PERMISSION_PROMPT_TIMEOUT_MS,
  PROMPTABLE_PERMISSIONS,
  SILENTLY_ALLOWED_PERMISSIONS,
  type MediaType,
  type PermissionDecision,
  type PromptablePermission,
  type RememberedDecision,
  type SitePermission,
} from '@app/specs/permissions.spec';
import { webOrigin } from '@app/specs/web-url.spec';

// Per-origin permission prompts for the browse session (spec `permissions.feature.md`). Pure
// decisions, the requesting-frame check, the prompt broker (queues, remembered decisions,
// timeouts, back-off) and the session handlers `hardenBrowseSession` installs. No Electron
// imports: the handlers take Electron's arguments as plain values, so this runs under Vitest.

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

/**
 * What a decision is remembered against: the requesting frame's origin and the tab's top-level
 * origin (equal for a top-level request). Both are serialized `http(s)` origins.
 */
export interface PermissionScope {
  readonly origin: string;
  readonly topLevelOrigin: string;
}

/** What a tab asks for, in its scope. */
export interface PermissionAsk extends PermissionScope {
  readonly permission: PromptablePermission;
  /** `media` only: the devices asked for, deduplicated, in `MEDIA_TYPES` order (camera first). */
  readonly mediaTypes?: readonly MediaType[];
}

export type PermissionVerdict =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'prompt'; permission: PromptablePermission; mediaTypes?: MediaType[] };

/** `origin` if it already is a serialized `http(s)` origin (a frame's `origin`), else `null`. */
function exactWebOrigin(origin: unknown): string | null {
  return typeof origin === 'string' && webOrigin(origin) === origin ? origin : null;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** The media types of a `media` request, deduplicated, camera first; `[]` if none is known. */
function mediaTypesOf(details: unknown): MediaType[] {
  const types = field(details, 'mediaTypes');
  if (!Array.isArray(types)) return [];
  return MEDIA_TYPES.filter((type) => types.includes(type));
}

/**
 * How a browse-session permission request is answered by kind (spec `permissions.spec.ts`):
 * `SILENTLY_ALLOWED_PERMISSIONS` → `allow`; `PROMPTABLE_PERMISSIONS` → `prompt` (`media` needs a
 * known media type); everything else → `deny`. Who asked is `requestScope`'s question.
 */
export function classifyPermissionRequest(permission: string, details: unknown): PermissionVerdict {
  if (includes(SILENTLY_ALLOWED_PERMISSIONS, permission)) return { kind: 'allow' };
  if (!includes(PROMPTABLE_PERMISSIONS, permission)) return { kind: 'deny' };
  const promptable = permission as PromptablePermission;
  if (promptable !== 'media') return { kind: 'prompt', permission: promptable };
  const mediaTypes = mediaTypesOf(details);
  return mediaTypes.length === 0 ? { kind: 'deny' } : { kind: 'prompt', permission: 'media', mediaTypes };
}

interface FrameLike {
  readonly url: unknown;
  readonly origin: unknown;
}

/**
 * The scope of a request, judged from the **requesting frame's own origin** (spec
 * `permissions.feature.md`, Requesting frame), or `null` (deny): the tab's main frame for a
 * main-frame request (its origin must be `requestingUrl`'s), else every frame of the tab at
 * `requestingUrl` (at least one, all on that URL's origin). Opaque origins (CSP / iframe
 * `sandbox`), non-`http(s)` ones, frames that are gone or navigated, and an opaque top-level page
 * are all `null`. `contents` is the tab's WebContents (its `mainFrame` may throw once destroyed).
 */
export function requestScope(contents: unknown, details: unknown): PermissionScope | null {
  const origin = webOrigin(field(details, 'requestingUrl'));
  if (origin === null) return null;
  const url = field(details, 'requestingUrl');
  try {
    const mainFrame = field(contents, 'mainFrame') as (FrameLike & { readonly framesInSubtree?: unknown }) | undefined;
    if (!mainFrame) return null;
    const topLevelOrigin = exactWebOrigin(mainFrame.origin);
    if (topLevelOrigin === null) return null;
    if (field(details, 'isMainFrame') === true) return mainFrame.origin === origin ? { origin, topLevelOrigin } : null;
    const frames = Array.isArray(mainFrame.framesInSubtree) ? (mainFrame.framesInSubtree as FrameLike[]) : [];
    const requesting = frames.filter((frame) => frame !== mainFrame && frame.url === url);
    if (requesting.length === 0 || !requesting.every((frame) => frame.origin === origin)) return null;
    return { origin, topLevelOrigin };
  } catch {
    return null;
  }
}

function sameScope(a: PermissionScope | null, b: PermissionScope): boolean {
  return a !== null && a.origin === b.origin && a.topLevelOrigin === b.topLevelOrigin;
}

/** What `ask` is remembered against (`media` split per device). */
function sitePermissionsOf(ask: PermissionAsk): SitePermission[] {
  if (ask.permission !== 'media') return [ask.permission];
  return (ask.mediaTypes ?? []).map((type) => MEDIA_TYPE_PERMISSION[type]);
}

/**
 * Where Allow / Block decisions are remembered, per (scope, `SitePermission`). Synchronous: the
 * permission handlers answer from it inline. The persistent store (`createPersistentDecisionStore`)
 * keeps the same shape (loaded into memory at startup, written through).
 */
export interface PermissionDecisionStore {
  get(scope: PermissionScope, permission: SitePermission): RememberedDecision | undefined;
  set(scope: PermissionScope, permission: SitePermission, decision: RememberedDecision): void;
  /** Forgets every decision (Clear Browsing Data). */
  clear(): void;
}

const scopeKey = (scope: PermissionScope, permission: SitePermission): string => JSON.stringify([scope.origin, scope.topLevelOrigin, permission]);

/** An in-memory decision store: nothing survives a restart. */
export function createMemoryDecisionStore(): PermissionDecisionStore {
  const decisions = new Map<string, RememberedDecision>();
  return {
    get: (scope, permission) => decisions.get(scopeKey(scope, permission)),
    set: (scope, permission, decision) => {
      decisions.set(scopeKey(scope, permission), decision);
    },
    clear: () => decisions.clear(),
  };
}

/** The app's decision store: in memory, Blocks loaded at startup and written through (Task 5). */
export interface PersistentDecisionStore extends PermissionDecisionStore {
  /** Adds the Blocks saved at the last launch (startup, before any request). Not written back. */
  load(decisions: Iterable<StoredDecision>): void;
}

/**
 * Remembered decisions, of which only Blocks persist (spec `browser-session-db.feature.md`,
 * Permission decisions; `PERSISTED_DECISIONS`): answered from memory (the handlers are
 * synchronous); a Block `set` is also handed to `persist` with its full key, an Allow stays in
 * memory for the app session. `load` takes Blocks only. Dismissals and the back-off never reach a
 * store: they stay in the broker, for the app session. `clear` forgets the memory only (the
 * database is cleared on its own).
 */
export function createPersistentDecisionStore(persist: (decision: StoredDecision) => void): PersistentDecisionStore {
  const memory = createMemoryDecisionStore();
  return {
    get: memory.get,
    set(scope, permission, decision) {
      memory.set(scope, permission, decision);
      if (decision === 'block') persist({ origin: scope.origin, topLevelOrigin: scope.topLevelOrigin, permission, decision });
    },
    clear: memory.clear,
    load(decisions) {
      for (const { origin, topLevelOrigin, permission, decision } of decisions) {
        if (decision === 'block') memory.set({ origin, topLevelOrigin }, permission, decision);
      }
    },
  };
}

/** Pending prompts per tab and the remembered decisions behind them (spec `permissions.feature.md`, Broker). */
export interface PermissionBroker {
  /**
   * A tab's request: answered at once from remembered decisions (or the back-off), coalesced into
   * an identical pending prompt of that tab (up to `MAX_COALESCED_REQUESTS`), denied beyond
   * `MAX_PENDING_PROMPTS_PER_TAB`, or queued as a new prompt (denied after
   * `PERMISSION_PROMPT_TIMEOUT_MS`). `callback` is called exactly once. `options.isCurrent` (the
   * requesting-frame check, run again) must still hold when the prompt is allowed, else that
   * request is denied. With `options.mayPrompt: false` (a fullscreen tab) a request that would
   * prompt is denied instead.
   */
  request(tabId: number, ask: PermissionAsk, callback: (granted: boolean) => void, options?: RequestOptions): void;
  /** The prompt `tabId` shows: the head of its queue, or `null`. A fresh copy. */
  promptFor(tabId: number): PermissionPrompt | null;
  /**
   * Answers `promptId` if it is the prompt `tabId` shows (its head); `false` (a no-op) for any
   * other id: another tab's, a queued one, an answered or timed-out one, an unknown one.
   */
  answer(tabId: number, promptId: string, decision: PermissionDecision): boolean;
  /** Denies every pending request of `tabId` (nothing remembered, no back-off). */
  denyTab(tabId: number): void;
  /** Whether (scope, permission) has a remembered Allow (the session's permission check). */
  check(scope: PermissionScope, permission: SitePermission): boolean;
  /**
   * Forgets every remembered Allow and Block (the store's) and the back-off (Clear Browsing
   * Data): the next request asks again. Pending prompts stay (they are undecided).
   */
  forgetDecisions(): void;
  /** Calls `listener` after every change of any tab's prompt; answers the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** How many prompts are pending, over all tabs. */
  pendingCount(): number;
}

export interface RequestOptions {
  readonly isCurrent?: () => boolean;
  readonly mayPrompt?: boolean;
}

export interface PermissionBrokerOptions {
  readonly store?: PermissionDecisionStore;
  /** Mints prompt ids; `crypto.randomUUID` (opaque, unguessable) unless a test injects one. */
  readonly randomId?: () => string;
}

interface Waiter {
  readonly callback: (granted: boolean) => void;
  readonly isCurrent: () => boolean;
}

interface Pending {
  readonly id: string;
  readonly tabId: number;
  readonly scope: PermissionScope;
  readonly permission: PromptablePermission;
  /** What is still undecided (the prompt names these); narrowed as other answers settle some. */
  undecided: SitePermission[];
  readonly waiters: Waiter[];
  readonly timer: ReturnType<typeof setTimeout>;
}

const SITE_TO_MEDIA_TYPE: Partial<Record<SitePermission, MediaType>> = { camera: 'video', microphone: 'audio' };

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

const always = (): boolean => true;

export function createPermissionBroker(options: PermissionBrokerOptions = {}): PermissionBroker {
  const store = options.store ?? createMemoryDecisionStore();
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  /** Each tab's queue, head first. */
  const queues = new Map<number, Pending[]>();
  const listeners = new Set<() => void>();
  /** Dismissals and timeouts per (scope, permission), for the back-off. */
  const ignores = new Map<string, number>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const call = (callback: (granted: boolean) => void, granted: boolean): void => {
    try {
      callback(granted);
    } catch {
      // The requesting frame is gone; nothing to answer.
    }
  };

  /** What remembered decisions say about `permissions`: `true`/`false`, or the undecided ones. */
  const evaluate = (scope: PermissionScope, permissions: readonly SitePermission[]): boolean | SitePermission[] => {
    const decisions = permissions.map((permission) => store.get(scope, permission));
    if (decisions.includes('block')) return false;
    const undecided = permissions.filter((_, i) => decisions[i] === undefined);
    return undecided.length === 0 ? true : undecided;
  };

  const silenced = (scope: PermissionScope, permissions: readonly SitePermission[]): boolean =>
    permissions.some((permission) => (ignores.get(scopeKey(scope, permission)) ?? 0) >= MAX_PROMPT_IGNORES);

  const countIgnored = (entry: Pending): void => {
    for (const permission of entry.undecided) {
      const key = scopeKey(entry.scope, permission);
      ignores.set(key, (ignores.get(key) ?? 0) + 1);
    }
  };

  /** Removes `entry` from its queue and answers every request coalesced into it. */
  const settle = (entry: Pending, granted: boolean): void => {
    clearTimeout(entry.timer);
    const queue = queues.get(entry.tabId);
    if (queue) {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) queues.delete(entry.tabId);
    }
    for (const waiter of entry.waiters) {
      // A grant reaches only requests whose frame is still the one that asked.
      let current = false;
      if (granted) {
        try {
          current = waiter.isCurrent();
        } catch {
          current = false;
        }
      }
      call(waiter.callback, granted && current);
    }
  };

  /** After a remembered decision: answer, or narrow, every pending prompt it now decides. */
  const resettle = (): void => {
    for (const entry of [...queues.values()].flat()) {
      const verdict = evaluate(entry.scope, entry.undecided);
      if (typeof verdict === 'boolean') settle(entry, verdict);
      else entry.undecided = verdict;
    }
  };

  const toPrompt = (entry: Pending): PermissionPrompt => {
    const { origin, topLevelOrigin } = entry.scope;
    const prompt: PermissionPrompt = { id: entry.id, origin, topLevelOrigin: topLevelOrigin === origin ? null : topLevelOrigin, permission: entry.permission };
    if (entry.permission === 'media') {
      prompt.mediaTypes = MEDIA_TYPES.filter((type) => entry.undecided.some((p) => SITE_TO_MEDIA_TYPE[p] === type));
    }
    return prompt;
  };

  return {
    request(tabId, ask, callback, { isCurrent = always, mayPrompt = true } = {}) {
      const scope: PermissionScope = { origin: ask.origin, topLevelOrigin: ask.topLevelOrigin };
      const permissions = sitePermissionsOf(ask);
      if (permissions.length === 0) return call(callback, false);
      const verdict = evaluate(scope, permissions);
      if (typeof verdict === 'boolean') return call(callback, verdict);
      if (!mayPrompt || silenced(scope, verdict)) return call(callback, false);
      const queue = queues.get(tabId) ?? [];
      const same = queue.find((entry) => sameScope(entry.scope, scope) && entry.permission === ask.permission && sameSet(entry.undecided, verdict));
      if (same) {
        if (same.waiters.length >= MAX_COALESCED_REQUESTS) return call(callback, false);
        same.waiters.push({ callback, isCurrent });
        return;
      }
      if (queue.length >= MAX_PENDING_PROMPTS_PER_TAB) return call(callback, false);
      const entry: Pending = {
        id: randomId(),
        tabId,
        scope,
        permission: ask.permission,
        undecided: verdict,
        waiters: [{ callback, isCurrent }],
        timer: setTimeout(() => {
          countIgnored(entry);
          settle(entry, false);
          notify();
        }, PERMISSION_PROMPT_TIMEOUT_MS),
      };
      queue.push(entry);
      queues.set(tabId, queue);
      notify();
    },

    promptFor(tabId) {
      const head = queues.get(tabId)?.[0];
      return head ? toPrompt(head) : null;
    },

    answer(tabId, promptId, decision) {
      const head = queues.get(tabId)?.[0];
      if (!head || head.id !== promptId) return false;
      if (decision === 'dismiss') {
        countIgnored(head);
        settle(head, false);
      } else {
        for (const permission of head.undecided) store.set(head.scope, permission, decision);
        settle(head, decision === 'allow');
        resettle();
      }
      notify();
      return true;
    },

    denyTab(tabId) {
      const queue = queues.get(tabId);
      if (!queue) return;
      for (const entry of [...queue]) settle(entry, false);
      notify();
    },

    check: (scope, permission) => store.get(scope, permission) === 'allow',

    forgetDecisions() {
      store.clear();
      ignores.clear();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    pendingCount: () => [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
  };
}

/** The browse session's permission handlers (Electron's arguments, as plain values). */
export interface BrowsePermissionHandlers {
  /** `setPermissionRequestHandler`. */
  request(contents: unknown, permission: string, callback: (granted: boolean) => void, details: unknown): void;
  /** `setPermissionCheckHandler`. */
  check(contents: unknown, permission: string, requestingOrigin: string, details: unknown): boolean;
}

/**
 * The top-level origin of a permission check: `details.embeddingOrigin` (Electron 45 sets the
 * top-level origin there), else the checking origin itself for a main-frame check, else the tab's
 * `mainFrame.origin` (media checks carry no `embeddingOrigin`).
 */
function checkTopLevelOrigin(contents: unknown, origin: string, details: unknown): string | null {
  const embedding = field(details, 'embeddingOrigin');
  if (typeof embedding === 'string' && embedding !== '') return webOrigin(embedding);
  if (field(details, 'isMainFrame') === true) return origin;
  try {
    return exactWebOrigin(field(field(contents, 'mainFrame'), 'origin'));
  } catch {
    return null;
  }
}

/**
 * Wires the broker to the browse session (spec `permissions.feature.md`, Session wiring): a
 * promptable request from a tab's WebContents (`tabIdOf`) whose requesting frame checks out
 * (`requestScope`) is queued for that tab, unless the tab is fullscreen (denied: the prompt would
 * be hidden); anything else is denied. Checks answer `true` for silently allowed permissions and
 * remembered Allows of the checking frame's scope only.
 */
export function createBrowsePermissionHandlers(options: {
  readonly broker: PermissionBroker;
  readonly tabIdOf: (contents: unknown) => number | null;
  /** Whether the tab is in HTML fullscreen (its new requests are denied). */
  readonly isFullscreen?: (tabId: number) => boolean;
}): BrowsePermissionHandlers {
  const { broker, tabIdOf } = options;
  return {
    request(contents, permission, callback, details) {
      const verdict = classifyPermissionRequest(permission, details);
      if (verdict.kind !== 'prompt') return callback(verdict.kind === 'allow');
      const tabId = tabIdOf(contents);
      const scope = tabId === null ? null : requestScope(contents, details);
      if (tabId === null || scope === null) return callback(false);
      const ask: PermissionAsk = { ...scope, permission: verdict.permission, ...(verdict.mediaTypes ? { mediaTypes: verdict.mediaTypes } : {}) };
      broker.request(tabId, ask, callback, {
        isCurrent: () => sameScope(requestScope(contents, details), scope),
        // No prompt can show over a fullscreen page: only what is already remembered answers.
        mayPrompt: options.isFullscreen?.(tabId) !== true,
      });
    },

    check(contents, permission, requestingOrigin, details) {
      if (includes(SILENTLY_ALLOWED_PERMISSIONS, permission)) return true;
      if (!includes(PROMPTABLE_PERMISSIONS, permission)) return false;
      if (permission === 'media') {
        const mediaType = field(details, 'mediaType');
        const origin = webOrigin(field(details, 'securityOrigin')) ?? webOrigin(requestingOrigin);
        if (origin === null || !includes(MEDIA_TYPES, mediaType)) return false;
        const topLevelOrigin = checkTopLevelOrigin(contents, origin, details);
        return topLevelOrigin !== null && broker.check({ origin, topLevelOrigin }, MEDIA_TYPE_PERMISSION[mediaType as MediaType]);
      }
      const origin = webOrigin(requestingOrigin);
      const topLevelOrigin = origin === null ? null : checkTopLevelOrigin(contents, origin, details);
      return origin !== null && topLevelOrigin !== null && broker.check({ origin, topLevelOrigin }, permission as Exclude<PromptablePermission, 'media'>);
    },
  };
}
