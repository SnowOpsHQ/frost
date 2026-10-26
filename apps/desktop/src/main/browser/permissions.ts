import type { PermissionPrompt } from '@app/specs/browser.spec';
import {
  MAX_PENDING_PROMPTS_PER_TAB,
  MEDIA_TYPE_PERMISSION,
  MEDIA_TYPES,
  PERMISSION_PROMPT_TIMEOUT_MS,
  PROMPTABLE_ORIGIN_SCHEMES,
  PROMPTABLE_PERMISSIONS,
  SILENTLY_ALLOWED_PERMISSIONS,
  type MediaType,
  type PermissionDecision,
  type PromptablePermission,
  type RememberedDecision,
  type SitePermission,
} from '@app/specs/permissions.spec';

// Per-origin permission prompts for the browse session (spec `permissions.feature.md`). Pure
// decisions, the prompt broker (queues, remembered decisions, timeouts) and the session handlers
// `hardenBrowseSession` installs. No Electron imports: the handlers take Electron's arguments as
// plain values, so this runs under Vitest with fakes.

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

/** What a tab asks for, attributed to the requesting frame's origin. */
export interface PermissionAsk {
  /** Serialized `http(s)` origin of the frame that asked (`https://example.com`). */
  readonly origin: string;
  readonly permission: PromptablePermission;
  /** `media` only: the devices asked for, deduplicated, in `MEDIA_TYPES` order (camera first). */
  readonly mediaTypes?: readonly MediaType[];
}

export type PermissionVerdict = { kind: 'allow' } | { kind: 'deny' } | { kind: 'prompt'; ask: PermissionAsk };

/** `url`'s serialized origin if it is `http(s)` (`PROMPTABLE_ORIGIN_SCHEMES`), else `null`. */
function webOrigin(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const parsed = new URL(url);
    return includes(PROMPTABLE_ORIGIN_SCHEMES, parsed.protocol) && parsed.host !== '' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function field(details: unknown, key: string): unknown {
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>)[key] : undefined;
}

/**
 * The origin a permission request is attributed to: the requesting frame's last committed URL
 * (`details.requestingUrl`, a subframe's own), else `details.securityOrigin` (media requests).
 * `null` when neither is an `http(s)` URL (opaque `about:blank`, `data:`, `file:`, `app:` …).
 */
export function requestingOrigin(details: unknown): string | null {
  const url = field(details, 'requestingUrl');
  if (typeof url === 'string' && url !== '') return webOrigin(url);
  return webOrigin(field(details, 'securityOrigin'));
}

/** The media types of a `media` request, deduplicated, camera first; `[]` if none is known. */
function mediaTypesOf(details: unknown): MediaType[] {
  const types = field(details, 'mediaTypes');
  if (!Array.isArray(types)) return [];
  return MEDIA_TYPES.filter((type) => types.includes(type));
}

/**
 * How a browse-session permission request is answered (spec `permissions.spec.ts`):
 * `SILENTLY_ALLOWED_PERMISSIONS` → `allow`; `PROMPTABLE_PERMISSIONS` from an `http(s)` frame →
 * `prompt` (attributed to the requesting frame's origin; `media` needs a known media type);
 * everything else → `deny`.
 */
export function classifyPermissionRequest(permission: string, details: unknown): PermissionVerdict {
  if (includes(SILENTLY_ALLOWED_PERMISSIONS, permission)) return { kind: 'allow' };
  if (!includes(PROMPTABLE_PERMISSIONS, permission)) return { kind: 'deny' };
  const origin = requestingOrigin(details);
  if (origin === null) return { kind: 'deny' };
  const promptable = permission as PromptablePermission;
  if (promptable !== 'media') return { kind: 'prompt', ask: { origin, permission: promptable } };
  const mediaTypes = mediaTypesOf(details);
  return mediaTypes.length === 0 ? { kind: 'deny' } : { kind: 'prompt', ask: { origin, permission: 'media', mediaTypes } };
}

/** What `ask` is remembered against (`media` split per device). */
function sitePermissionsOf(ask: PermissionAsk): SitePermission[] {
  if (ask.permission !== 'media') return [ask.permission];
  return (ask.mediaTypes ?? []).map((type) => MEDIA_TYPE_PERMISSION[type]);
}

/**
 * Where Allow / Block decisions are remembered, per (origin, `SitePermission`). Synchronous: the
 * permission handlers answer from it inline. Task 5's persistent store keeps the same shape
 * (loaded into memory at startup, written through).
 */
export interface PermissionDecisionStore {
  get(origin: string, permission: SitePermission): RememberedDecision | undefined;
  set(origin: string, permission: SitePermission, decision: RememberedDecision): void;
}

/** The app session's in-memory decision store (nothing survives a restart until Task 5). */
export function createMemoryDecisionStore(): PermissionDecisionStore {
  const decisions = new Map<string, RememberedDecision>();
  const key = (origin: string, permission: SitePermission) => JSON.stringify([origin, permission]);
  return {
    get: (origin, permission) => decisions.get(key(origin, permission)),
    set: (origin, permission, decision) => {
      decisions.set(key(origin, permission), decision);
    },
  };
}

/** Pending prompts per tab and the remembered decisions behind them (spec `permissions.feature.md`, Broker). */
export interface PermissionBroker {
  /**
   * A tab's request: answered at once from remembered decisions, coalesced into an identical
   * pending prompt of that tab, denied beyond `MAX_PENDING_PROMPTS_PER_TAB`, or queued as a new
   * prompt (denied after `PERMISSION_PROMPT_TIMEOUT_MS`). `callback` is called exactly once.
   */
  request(tabId: number, ask: PermissionAsk, callback: (granted: boolean) => void): void;
  /** The prompt `tabId` shows: the head of its queue, or `null`. A fresh copy. */
  promptFor(tabId: number): PermissionPrompt | null;
  /**
   * Answers `promptId` if it is the prompt `tabId` shows (its head); `false` (a no-op) for any
   * other id: another tab's, a queued one, an answered or timed-out one, an unknown one.
   */
  answer(tabId: number, promptId: string, decision: PermissionDecision): boolean;
  /** Denies every pending request of `tabId` (nothing remembered). */
  denyTab(tabId: number): void;
  /** Whether (origin, permission) has a remembered Allow (the session's permission check). */
  check(origin: string, permission: SitePermission): boolean;
  /** Calls `listener` after every change of any tab's prompt; answers the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** How many prompts are pending, over all tabs. */
  pendingCount(): number;
}

export interface PermissionBrokerOptions {
  readonly store?: PermissionDecisionStore;
  /** Mints prompt ids; `crypto.randomUUID` (opaque, unguessable) unless a test injects one. */
  readonly randomId?: () => string;
}

interface Pending {
  readonly id: string;
  readonly tabId: number;
  readonly origin: string;
  readonly permission: PromptablePermission;
  /** What is still undecided (the prompt names these); narrowed as other answers settle some. */
  undecided: SitePermission[];
  readonly callbacks: ((granted: boolean) => void)[];
  readonly timer: ReturnType<typeof setTimeout>;
}

const SITE_TO_MEDIA_TYPE: Partial<Record<SitePermission, MediaType>> = { camera: 'video', microphone: 'audio' };

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export function createPermissionBroker(options: PermissionBrokerOptions = {}): PermissionBroker {
  const store = options.store ?? createMemoryDecisionStore();
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  /** Each tab's queue, head first. */
  const queues = new Map<number, Pending[]>();
  const listeners = new Set<() => void>();

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
  const evaluate = (origin: string, permissions: readonly SitePermission[]): boolean | SitePermission[] => {
    const decisions = permissions.map((permission) => store.get(origin, permission));
    if (decisions.includes('block')) return false;
    const undecided = permissions.filter((_, i) => decisions[i] === undefined);
    return undecided.length === 0 ? true : undecided;
  };

  /** Removes `entry` from its queue and answers every callback coalesced into it. */
  const settle = (entry: Pending, granted: boolean): void => {
    clearTimeout(entry.timer);
    const queue = queues.get(entry.tabId);
    if (queue) {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) queues.delete(entry.tabId);
    }
    for (const callback of entry.callbacks) call(callback, granted);
  };

  /** After a remembered decision: answer, or narrow, every pending prompt it now decides. */
  const resettle = (): void => {
    for (const entry of [...queues.values()].flat()) {
      const verdict = evaluate(entry.origin, entry.undecided);
      if (typeof verdict === 'boolean') settle(entry, verdict);
      else entry.undecided = verdict;
    }
  };

  const toPrompt = (entry: Pending): PermissionPrompt => {
    const prompt: PermissionPrompt = { id: entry.id, origin: entry.origin, permission: entry.permission };
    if (entry.permission === 'media') {
      prompt.mediaTypes = MEDIA_TYPES.filter((type) => entry.undecided.some((p) => SITE_TO_MEDIA_TYPE[p] === type));
    }
    return prompt;
  };

  return {
    request(tabId, ask, callback) {
      const permissions = sitePermissionsOf(ask);
      if (permissions.length === 0) return call(callback, false);
      const verdict = evaluate(ask.origin, permissions);
      if (typeof verdict === 'boolean') return call(callback, verdict);
      const queue = queues.get(tabId) ?? [];
      const same = queue.find((entry) => entry.origin === ask.origin && entry.permission === ask.permission && sameSet(entry.undecided, verdict));
      if (same) {
        same.callbacks.push(callback);
        return;
      }
      if (queue.length >= MAX_PENDING_PROMPTS_PER_TAB) return call(callback, false);
      const entry: Pending = {
        id: randomId(),
        tabId,
        origin: ask.origin,
        permission: ask.permission,
        undecided: verdict,
        callbacks: [callback],
        timer: setTimeout(() => {
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
        settle(head, false);
      } else {
        for (const permission of head.undecided) store.set(head.origin, permission, decision);
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

    check: (origin, permission) => store.get(origin, permission) === 'allow',

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
 * Wires the broker to the browse session (spec `permissions.feature.md`, Session wiring): requests
 * from a tab's WebContents (`tabIdOf`) are classified and, if promptable, queued for that tab;
 * from anything else denied. Checks answer `true` for silently allowed permissions and remembered
 * Allows of the checking frame's origin only.
 */
export function createBrowsePermissionHandlers(options: {
  readonly broker: PermissionBroker;
  readonly tabIdOf: (contents: unknown) => number | null;
}): BrowsePermissionHandlers {
  const { broker, tabIdOf } = options;
  return {
    request(contents, permission, callback, details) {
      const verdict = classifyPermissionRequest(permission, details);
      if (verdict.kind !== 'prompt') return callback(verdict.kind === 'allow');
      const tabId = tabIdOf(contents);
      if (tabId === null) return callback(false);
      broker.request(tabId, verdict.ask, callback);
    },

    check(_contents, permission, origin, details) {
      if (includes(SILENTLY_ALLOWED_PERMISSIONS, permission)) return true;
      if (!includes(PROMPTABLE_PERMISSIONS, permission)) return false;
      if (permission === 'media') {
        const mediaType = field(details, 'mediaType');
        const checked = webOrigin(field(details, 'securityOrigin')) ?? webOrigin(origin);
        if (checked === null || !includes(MEDIA_TYPES, mediaType)) return false;
        return broker.check(checked, MEDIA_TYPE_PERMISSION[mediaType as MediaType]);
      }
      const checked = webOrigin(origin);
      return checked !== null && broker.check(checked, permission as Exclude<PromptablePermission, 'media'>);
    },
  };
}
