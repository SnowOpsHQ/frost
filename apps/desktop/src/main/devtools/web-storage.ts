import { DEVTOOLS_STORAGE_WORLD_ID, WEB_STORAGE_LIMITS, type WebStorageArea, type WebStorageAreaView, type WebStorageItem, type WebStorageUnavailableReason, type WebStorageView } from '@app/specs/devtools.spec';
import { WebStorageKeysAnswerSchema, WebStorageValueAnswerSchema, type WebStorageKeysAnswer } from '@app/specs/devtools.schema';
import { parseWebUrl } from '@app/specs/web-url.spec';

// The devtools drawer's web storage reader (Phase 11 Task 4, Decision 6; spec `devtools.spec.ts`,
// `WEB_STORAGE_LIMITS`; acceptance `devtools.feature.md`, Web storage). The drawer's one page script:
// `readPageStorage` is self-contained and read-only; it is serialised with its request and limits
// into a script and run in the tab's isolated world `DEVTOOLS_STORAGE_WORLD_ID`
// (`executeJavaScriptInIsolatedWorld`, the top frame), so the page's own globals, getters or a `Proxy`
// it put on `localStorage` in its main world never reach it. It never writes storage and leaves
// nothing in the page.
// - `keys`: per area the keys (capped) and their value sizes, never a value; the browser's usage
//   estimate. Run only when the chrome asks (`read`: the Storage tab opened, or Refresh).
// - `value`: one key's (capped) value, only for the one key the user revealed, read again for each
//   answer and never kept here.
// Every answer is page data: it is validated (`WebStorageKeysAnswerSchema`,
// `WebStorageValueAnswerSchema`), bounded by `scriptTimeoutMs`, and dropped when its origin is not the
// tab's or a commit or a clear overtook it. Main keeps, per tab, the last listing (keys and sizes) and
// the reveal, both stamped with the tab's committed document (`committed` forgets them). One script at
// a time per tab: a keys read or a revealed-value read in flight is shared by the answers asking
// meanwhile, and the next script waits for the previous one.

/** The parts of a tab's WebContents the reader uses. */
export interface WebStorageTarget {
  readonly id: number;
  getURL(): string;
  isDestroyed(): boolean;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

export type WebStorageRequest = { readonly op: 'keys' } | { readonly op: 'value'; readonly area: WebStorageArea; readonly key: string };

/** What `answer` gives the Storage tab. */
export interface WebStorageResult {
  readonly webStorage: WebStorageView | null;
  readonly usage: number | null;
  readonly quota: number | null;
}

export interface WebStorageReader {
  /**
   * The tab's web storage for its current document: with `read`, the reader runs now (the keys, then
   * the revealed key alone); without, the last listing (no script), the revealed key read again.
   * `webStorage: null` until a read for this document. Never rejects.
   */
  answer(target: WebStorageTarget, read: boolean): Promise<WebStorageResult>;
  /** Reveals one listed key (not cut) for the tab's current document; `false` otherwise. */
  reveal(target: WebStorageTarget, area: WebStorageArea, key: string): boolean;
  /** The tab committed another document: its listing and reveal are forgotten. */
  committed(contentsId: number): void;
  forget(contentsId: number): void;
  /** Forgets every listing and reveal (Clear Browsing Data, Clear this site's data). */
  clear(): void;
}

export interface WebStorageReaderOptions {
  /** A tab's Storage view changed (a reveal). */
  readonly changed?: (contentsId: number) => void;
  readonly log?: (message: string) => void;
}

// ---- The page script (runs in DEVTOOLS_STORAGE_WORLD_ID; self-contained) ------------------------

/** The parts of a page `Storage` the script reads (structural: main needs no DOM lib). */
interface PageStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}
interface PageGlobal {
  readonly origin?: unknown;
  readonly location?: { readonly origin?: unknown };
  readonly localStorage: PageStorage;
  readonly sessionStorage: PageStorage;
  readonly navigator?: { readonly storage?: { estimate?: () => Promise<{ readonly usage?: unknown; readonly quota?: unknown }> } };
}
interface ScriptLimits {
  readonly maxKeys: number;
  readonly maxKeyChars: number;
  readonly maxValueChars: number;
  /** The script's own budget for listing keys and waiting for the estimate (below main's timeout). */
  readonly budgetMs: number;
  readonly estimateMs: number;
}

const SCRIPT_LIMITS: ScriptLimits = {
  maxKeys: WEB_STORAGE_LIMITS.maxKeys,
  maxKeyChars: WEB_STORAGE_LIMITS.maxKeyChars,
  maxValueChars: WEB_STORAGE_LIMITS.maxValueChars,
  budgetMs: Math.floor(WEB_STORAGE_LIMITS.scriptTimeoutMs / 2),
  estimateMs: Math.floor(WEB_STORAGE_LIMITS.scriptTimeoutMs / 4),
};

/**
 * The reader. Self-contained: serialised with `toString()`, so it uses nothing from this module.
 * Read-only: only `length`, `key` and `getItem` of the storages, and `navigator.storage.estimate()`.
 */
function readPageStorage(g: PageGlobal, request: WebStorageRequest, L: ScriptLimits): unknown {
  const cut = (value: string, max: number): string => {
    if (value.length <= max) return value;
    const code = value.charCodeAt(max - 1);
    return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
  };
  let origin = 'null';
  let opaque = true;
  try {
    const own = String(g.origin);
    const of = g.location ? String(g.location.origin) : 'null';
    origin = own;
    opaque = own === 'null' || of === 'null';
  } catch {
    opaque = true;
  }
  if (opaque) origin = 'null';
  const storageOf = (area: string): PageStorage | null => {
    try {
      return area === 'local' ? g.localStorage : area === 'session' ? g.sessionStorage : null;
    } catch {
      return null;
    }
  };
  if (request.op === 'value') {
    if (opaque) return { op: 'value', status: 'unavailable', origin, reason: 'opaque-origin' };
    const storage = storageOf(request.area);
    if (!storage) return { op: 'value', status: 'unavailable', origin, reason: 'denied' };
    try {
      const value = storage.getItem(request.key);
      const shown = typeof value === 'string' ? cut(value, L.maxValueChars) : null;
      return { op: 'value', status: 'ready', origin, area: request.area, key: request.key, value: shown, truncated: shown !== null && typeof value === 'string' && shown.length < value.length };
    } catch {
      return { op: 'value', status: 'unavailable', origin, reason: 'denied' };
    }
  }
  const started = Date.now();
  const list = (area: string): unknown => {
    if (opaque) return { status: 'unavailable', reason: 'opaque-origin' };
    const storage = storageOf(area);
    if (!storage) return { status: 'unavailable', reason: 'denied' };
    try {
      const total = Number(storage.length) || 0;
      const items: { key: string; keyTruncated: boolean; size: number }[] = [];
      for (let i = 0; i < total && items.length < L.maxKeys; i++) {
        if (Date.now() - started > L.budgetMs) break;
        const key = storage.key(i);
        if (typeof key !== 'string') continue;
        const value = storage.getItem(key);
        const shown = cut(key, L.maxKeyChars);
        items.push({ key: shown, keyTruncated: shown.length < key.length, size: typeof value === 'string' ? value.length : 0 });
      }
      return { status: 'ready', items, total: Math.max(total, items.length) };
    } catch {
      return { status: 'unavailable', reason: 'denied' };
    }
  };
  const local = list('local');
  const session = list('session');
  const done = (estimate: { readonly usage?: unknown; readonly quota?: unknown } | null) => {
    const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
    return { op: 'keys', origin, local, session, usage: estimate ? num(estimate.usage) : null, quota: estimate ? num(estimate.quota) : null };
  };
  if (opaque) return done(null);
  let pending: Promise<{ readonly usage?: unknown; readonly quota?: unknown }> | null = null;
  try {
    const storageManager = g.navigator ? g.navigator.storage : undefined;
    pending = storageManager && typeof storageManager.estimate === 'function' ? storageManager.estimate() : null;
  } catch {
    pending = null;
  }
  if (!pending) return done(null);
  return Promise.race([pending.then((e) => e, () => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), L.estimateMs))]).then(done, () => done(null));
}

/** The script for `request`, run in `DEVTOOLS_STORAGE_WORLD_ID` (`globalThis` is that world's own). */
export function webStorageScript(request: WebStorageRequest): string {
  return `(${readPageStorage.toString()})(globalThis, ${JSON.stringify(request)}, ${JSON.stringify(SCRIPT_LIMITS)})`;
}

// ---- Main's side ----------------------------------------------------------------------------------

const TIMED_OUT = Symbol('timed out');
const FAILED = Symbol('failed');

interface Listing {
  readonly document: number;
  readonly origin: string;
  readonly view: WebStorageView;
  readonly usage: number | null;
  readonly quota: number | null;
}

const both = (reason: WebStorageUnavailableReason): WebStorageView => ({ local: { status: 'unavailable', reason }, session: { status: 'unavailable', reason } });

/** A validated keys answer's area as the Storage tab shows it (every value masked). */
function areaView(area: WebStorageKeysAnswer['local']): WebStorageAreaView {
  if (area.status !== 'ready') return { status: 'unavailable', reason: area.reason };
  return { status: 'ready', total: area.total, items: area.items.map((i): WebStorageItem => ({ key: i.key, keyTruncated: i.keyTruncated, size: i.size, value: null, valueTruncated: false })) };
}

export function createWebStorageReader(options: WebStorageReaderOptions = {}): WebStorageReader {
  const listings = new Map<number, Listing>();
  const reveals = new Map<number, { readonly area: WebStorageArea; readonly key: string; readonly document: number }>();
  const documents = new Map<number, number>();
  const documentOf = (id: number): number => documents.get(id) ?? 0;
  /** Bumped by `clear` and `forget`: a read in flight across one never saves or shows what it read. */
  let generation = 0;
  /** Per tab, the keys read in flight: a second request while it runs shares it (one script at a time per tab). */
  const reading = new Map<number, Promise<void>>();
  const log = (message: string): void => options.log?.(`devtools: ${message}`);

  /** Per tab, the last script started: the next one waits for it (one script at a time per tab). */
  const lanes = new Map<number, Promise<unknown>>();
  /** Per tab, the revealed value read in flight, shared by the answers asking meanwhile (never kept after). */
  const valueReads = new Map<number, { readonly key: string; readonly read: Promise<unknown> }>();

  /** Runs `request` after the tab's previous script settled. */
  const run = (target: WebStorageTarget, request: WebStorageRequest): Promise<unknown> => {
    const id = target.id;
    const next = (lanes.get(id) ?? Promise.resolve()).then(() => runNow(target, request));
    lanes.set(id, next);
    void next.then(() => {
      if (lanes.get(id) === next) lanes.delete(id);
    });
    return next;
  };

  /** Runs `request` in the storage world, at most `scriptTimeoutMs`: the raw (untrusted) answer, or why there is none. Never rejects. */
  const runNow = async (target: WebStorageTarget, request: WebStorageRequest): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => target.executeJavaScriptInIsolatedWorld(DEVTOOLS_STORAGE_WORLD_ID, [{ code: webStorageScript(request) }]))
          .catch((error: unknown) => {
            log(`the storage reader failed (${error instanceof Error ? error.message : String(error)})`);
            return FAILED;
          }),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), WEB_STORAGE_LIMITS.scriptTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Reads the keys now; the listing kept for the tab's current document, or none (the page moved on). */
  const readKeys = async (target: WebStorageTarget, pageOrigin: string): Promise<void> => {
    const id = target.id;
    const stamp = documentOf(id);
    const started = generation;
    const raw = await run(target, { op: 'keys' });
    if (generation !== started) return;
    if (documentOf(id) !== stamp || target.isDestroyed() || parseWebUrl(target.getURL())?.origin !== pageOrigin) {
      listings.delete(id);
      return;
    }
    const keep = (view: WebStorageView, usage: number | null = null, quota: number | null = null) => listings.set(id, { document: stamp, origin: pageOrigin, view, usage, quota });
    if (raw === TIMED_OUT) return void keep(both('timeout'));
    if (raw === FAILED) return void keep(both('failed'));
    const parsed = WebStorageKeysAnswerSchema.safeParse(raw);
    if (!parsed.success) return void keep(both('invalid'));
    const answer = parsed.data;
    // An opaque document reads nothing; one of another origin is not this tab's page any more.
    if (answer.origin === 'null') return void keep(both('opaque-origin'));
    if (answer.origin !== pageOrigin) {
      listings.delete(id);
      return;
    }
    keep({ local: areaView(answer.local), session: areaView(answer.session) }, answer.usage, answer.quota);
  };

  /** The revealed key's value, read alone now, for `listing` (`null`: none shown). Never kept. */
  const readRevealed = async (target: WebStorageTarget, listing: Listing): Promise<{ area: WebStorageArea; key: string; value: string; truncated: boolean } | null> => {
    const id = target.id;
    const shown = reveals.get(id);
    if (!shown || shown.document !== listing.document) return null;
    const area = listing.view[shown.area];
    if (area.status !== 'ready' || !area.items.some((i) => i.key === shown.key && !i.keyTruncated)) return null;
    const started = generation;
    const shareKey = JSON.stringify([started, listing.document, shown.area, shown.key]);
    let shared = valueReads.get(id);
    if (shared?.key !== shareKey) {
      const read = run(target, { op: 'value', area: shown.area, key: shown.key });
      shared = { key: shareKey, read };
      valueReads.set(id, shared);
      void read.then(() => {
        if (valueReads.get(id)?.read === read) valueReads.delete(id);
      });
    }
    const raw = await shared.read;
    // Overtaken by a commit, a clear (or the tab went): the value belongs to no document the chrome shows.
    if (generation !== started || documentOf(id) !== listing.document || target.isDestroyed() || parseWebUrl(target.getURL())?.origin !== listing.origin) return null;
    const parsed = WebStorageValueAnswerSchema.safeParse(raw);
    if (!parsed.success || parsed.data.status !== 'ready') return null;
    const answer = parsed.data;
    if (answer.origin !== listing.origin || answer.area !== shown.area || answer.key !== shown.key || answer.value === null) return null;
    return { area: answer.area, key: answer.key, value: answer.value, truncated: answer.truncated };
  };

  return {
    async answer(target, read) {
      const none: WebStorageResult = { webStorage: null, usage: null, quota: null };
      const page = parseWebUrl(target.getURL());
      if (!page) return none;
      const id = target.id;
      let pending = reading.get(id);
      if (read && !pending) {
        const run = readKeys(target, page.origin).finally(() => {
          if (reading.get(id) === run) reading.delete(id);
        });
        reading.set(id, run);
        pending = run;
      }
      // A read in flight (this one's or an earlier request's) is shared: no second script runs for it.
      if (pending) await pending;
      const listing = listings.get(id);
      if (!listing || listing.document !== documentOf(id) || listing.origin !== page.origin) return none;
      const revealed = await readRevealed(target, listing);
      // The listing may have gone while the value was read (a commit): show nothing of either.
      if (listings.get(id) !== listing || listing.document !== documentOf(id)) return none;
      const view: WebStorageView = revealed
        ? {
            ...listing.view,
            [revealed.area]: (() => {
              const area = listing.view[revealed.area];
              if (area.status !== 'ready') return area;
              return { ...area, items: area.items.map((i) => (i.key === revealed.key && !i.keyTruncated ? { ...i, value: revealed.value, valueTruncated: revealed.truncated } : i)) };
            })(),
          }
        : listing.view;
      return { webStorage: view, usage: listing.usage, quota: listing.quota };
    },

    reveal(target, area, key) {
      const id = target.id;
      const listing = listings.get(id);
      const page = parseWebUrl(target.getURL());
      if (!listing || !page || listing.document !== documentOf(id) || listing.origin !== page.origin) return false;
      const view = listing.view[area];
      if (view.status !== 'ready' || !view.items.some((i) => i.key === key && !i.keyTruncated)) return false;
      // One revealed key per tab, stamped with its committed document.
      reveals.set(id, { area, key, document: listing.document });
      options.changed?.(id);
      return true;
    },

    committed(contentsId) {
      documents.set(contentsId, documentOf(contentsId) + 1);
      listings.delete(contentsId);
      reveals.delete(contentsId);
    },

    forget(contentsId) {
      generation += 1;
      listings.delete(contentsId);
      reveals.delete(contentsId);
      documents.delete(contentsId);
    },

    clear() {
      generation += 1;
      listings.clear();
      reveals.clear();
    },
  };
}
