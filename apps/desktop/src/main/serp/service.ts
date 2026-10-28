import type { SerpReadApi, SerpService } from '@app/ipc-contract';
import type { IntentAnswer } from '@app/specs/intent-classifier.spec';
import type { PackUpdateOutcome } from '@app/specs/serp-selector-pack.spec';
import type { EngineLayout, SelectorEngine } from '@app/specs/serp-selector-pack.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { PackStatus, SerpState, SerpTabState } from '@app/specs/serp-service.schema';
import { MAX_PENDING_SERP_WATCHES, SERP_INPAGE_DEBOUNCE_MS, SERP_INTENT_CACHE_SIZE, SERP_OUTLINE_ACTIVE_POLL_MS } from '@app/specs/serp-service.spec';
import type { SerpSnapshot } from '@app/specs/serp-snapshot.schema';
import { SERP_PARAM_LIMITS, SERP_READ_TIMEOUT_MS, type SerpDevice, type SerpUnreadableReason } from '@app/specs/serp.spec';
import type { IntentClassifier } from '../intent/classifier';
import { matchSerp, redirectRules, type SerpMatch } from './engines';
import type { ActivePack, PackStore } from './pack-store';
import type { SerpReadTarget } from './read-script';
import type { SerpAnalyzer } from './serp-analyzer';

// The SERP service (spec `serp-service.spec.ts`, The service and Outlines; answers
// `serp-service.schema.ts`; acceptance `serp-overlay.feature.md`, Service and Outlines): each tab's
// reading of the result page it shows, for the `serp.*` procedures (`SerpService`) and Phase 5
// (`SerpReadApi`). Everything is injected (`setup.ts` wires the real ones), so it is tested with
// fakes.
//
// - A tab's reading (an `Entry`) belongs to its WebContents, its document (`documentSeq`), its URL,
//   its device and the pack's version; one that no longer matches the tab is not answered. A page
//   is a result page by `matchSerp` alone; nothing else is ever read.
// - Reads start on `loaded` (`did-finish-load`), on an in-page move to another search once it has
//   been quiet for `SERP_INPAGE_DEBOUNCE_MS`, and when the state of a loaded result page with no
//   current reading is asked for (a pack swap, a render profile change). The reader is abandoned
//   after `SERP_READ_TIMEOUT_MS`; its answer is analysed in the SERP worker; a reading superseded
//   meanwhile is dropped.
// - Every change bumps `version` and wakes the watchers (at most `MAX_PENDING_SERP_WATCHES`).
// - Intent: a `ready` reading's query is classified only while the classifier is `ready` (never a
//   download); answers are kept per query (`SERP_INTENT_CACHE_SIZE`).
// - Outlines: drawn for the active tab's `ready` reading only; removed on a navigation, a tab switch
//   (polled every `SERP_OUTLINE_ACTIVE_POLL_MS` while one is drawn), a pack swap, Clear Browsing Data
//   or the toggle; off when the page ends them.

/** A tab as the service sees it, now. */
export interface SerpTab {
  /** Its live page's WebContents id. */
  readonly contentsId: number;
  /** The page's URL now (`webContents.getURL()`). */
  readonly url: string;
  /** Its document (`TabState.documentSeq`). */
  readonly documentSeq: number;
  readonly loading: boolean;
  /** Its render profile's device (`SERP_DEVICE_OF_PRESET`). */
  readonly device: SerpDevice;
  /** Where the reader and the outlines run (its WebContents). */
  readonly page: SerpReadTarget;
}

export interface SerpTabs {
  /** The tab, or `null` when `tabId` names no open tab with a live page. */
  tab(tabId: number): SerpTab | null;
  /** The tab a page belongs to, or `null` for a page that is not a tab's. */
  tabOf(contentsId: number): number | null;
  activeTabId(): number | null;
}

/** Draws the outlines in a page (`runOutline`; `null`: off) and waits for them to end (`watchOutline`). Answers are page data. */
export interface SerpOutliner {
  paint(page: SerpReadTarget, layout: EngineLayout | null): Promise<unknown>;
  ended(page: SerpReadTarget): Promise<unknown>;
}

export interface SerpServiceOptions {
  readonly packs: Pick<PackStore, 'current' | 'checkForUpdate' | 'onChanged'>;
  readonly analyzer: Pick<SerpAnalyzer, 'analyse'>;
  /** Runs the reader in a page's SERP world (`runSerpRead`); its answer is unvalidated. */
  readonly read: (page: SerpReadTarget, layout: EngineLayout) => Promise<unknown>;
  readonly outline: SerpOutliner;
  readonly classifier: Pick<IntentClassifier, 'state' | 'ensureModel' | 'classify' | 'onChanged'>;
  readonly tabs: SerpTabs;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly debounceMs?: number;
  readonly readTimeoutMs?: number;
  readonly activePollMs?: number;
}

export interface Serp extends SerpService {
  /** The read API for Phase 5 (`SerpReadApi`). */
  readonly readApi: SerpReadApi;
  /** A page finished loading (`did-finish-load`): read it if it is a result page. */
  loaded(contentsId: number): void;
  /** A page's document went (`did-navigate`): its reading and outlines go. */
  navigated(contentsId: number): void;
  /** A page moved in place to `url` (`did-navigate-in-page`, main frame). */
  navigatedInPage(contentsId: number, url: string): void;
  /** A page closed (`destroyed`). */
  closed(contentsId: number): void;
  /** Clear Browsing Data: every reading, outline and intent answer goes. */
  forget(): void;
  /** The app is quitting: timers stop, watchers answer, nothing runs again. */
  dispose(): void;
  /** How many `watch` calls wait. */
  pendingWatches(): number;
}

/** Where a reading stands: under way, or analysed (`SerpSnapshot`) at `readAt`. */
type Reading = { readonly kind: 'pending' } | { readonly kind: 'done'; readonly snapshot: SerpSnapshot; readonly readAt: number };

interface Entry {
  readonly tabId: number;
  readonly contentsId: number;
  readonly documentSeq: number;
  /** The page's URL (another URL of the same search, a fragment or tracking token, keeps the reading). */
  url: string;
  readonly device: SerpDevice;
  readonly packVersion: number;
  readonly engine: SelectorEngine;
  readonly params: SearchParams;
  readonly page: SerpReadTarget;
  reading: Reading;
  intent: IntentAnswer | null;
  classifying: boolean;
  /** The drawn outline (its token), or `null`. */
  outline: { readonly token: number } | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const TIMED_OUT = Symbol('timed out');
const FAILED = Symbol('failed');

/** `run()`'s promise, also when it throws at once (a destroyed page). */
const attempt = <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error);
  }
};

/** Whether a paint answer says the outlines are drawn (`{ on: true, boxes }`). */
const drawnAnswer = (answer: unknown): boolean => typeof answer === 'object' && answer !== null && (answer as { on?: unknown }).on === true;

export function createSerpService(options: SerpServiceOptions): Serp {
  const { packs, analyzer, read, outline, classifier, tabs } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const debounceMs = options.debounceMs ?? SERP_INPAGE_DEBOUNCE_MS;
  const readTimeoutMs = options.readTimeoutMs ?? SERP_READ_TIMEOUT_MS;
  const activePollMs = options.activePollMs ?? SERP_OUTLINE_ACTIVE_POLL_MS;
  const entries = new Map<number, Entry>();
  const intents = new Map<string, IntentAnswer>();
  const waiters: { wake: () => void }[] = [];
  let version = 0;
  let outlineSeq = 0;
  let poll: ReturnType<typeof setInterval> | undefined;
  let lastUpdate: PackStatus['lastUpdate'] = null;
  let checking: Promise<PackUpdateOutcome> | null = null;
  let disposed = false;

  const bump = (): void => {
    version += 1;
    for (const waiter of waiters.splice(0)) waiter.wake();
  };
  const live = (entry: Entry): boolean => !disposed && entries.get(entry.tabId) === entry;
  const readyPack = (): Extract<ActivePack, { status: 'ready' }> | null => {
    const active = packs.current();
    return active.status === 'ready' ? active : null;
  };

  // ---- Outlines ---------------------------------------------------------------------------------

  const stopPollIfIdle = (): void => {
    if (poll !== undefined && ![...entries.values()].some((entry) => entry.outline)) {
      clearInterval(poll);
      poll = undefined;
    }
  };
  /** Turns `entry`'s outlines off; `paint`: remove them from the page (its document is still there). */
  const outlinesOff = (entry: Entry, paint: boolean): void => {
    if (!entry.outline) return;
    entry.outline = null;
    if (paint) void attempt(() => outline.paint(entry.page, null)).catch(() => undefined);
    stopPollIfIdle();
  };
  /** A tab switch removes the outlines (`SERP_OUTLINE_ACTIVE_POLL_MS` while one is drawn). */
  const ensurePoll = (): void => {
    poll ??= setInterval(() => {
      const active = tabs.activeTabId();
      let changed = false;
      for (const entry of entries.values()) {
        if (entry.outline && entry.tabId !== active) {
          outlinesOff(entry, true);
          changed = true;
        }
      }
      stopPollIfIdle();
      if (changed) bump();
    }, activePollMs);
    (poll as { unref?: () => void }).unref?.();
  };

  /** Drops `entry` (its timer, its outlines; `paint`: removed from a page still showing it). */
  const retire = (entry: Entry, paint: boolean): void => {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    outlinesOff(entry, paint);
    if (entries.get(entry.tabId) === entry) entries.delete(entry.tabId);
  };

  // ---- Reading ----------------------------------------------------------------------------------

  const unreadable = (entry: Entry, reason: SerpUnreadableReason): SerpSnapshot => ({ status: 'unreadable', reason, params: entry.params, packVersion: entry.packVersion });

  /** Reads and analyses `entry`'s page; dropped if the entry was superseded meanwhile. */
  async function run(entry: Entry): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw: unknown;
    try {
      raw = await Promise.race([
        attempt(() => read(entry.page, entry.engine.layout)),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), readTimeoutMs);
        }),
      ]);
    } catch {
      raw = FAILED;
    } finally {
      clearTimeout(timer);
    }
    if (!live(entry)) return;
    const snapshot =
      raw === TIMED_OUT
        ? unreadable(entry, 'timeout')
        : raw === FAILED
          ? unreadable(entry, 'invalid-answer')
          : await attempt(() => analyzer.analyse(raw, { params: entry.params, packVersion: entry.packVersion, redirects: redirectRules(entry.engine) })).catch(() => unreadable(entry, 'invalid-answer'));
    if (!live(entry)) return;
    entry.reading = { kind: 'done', snapshot, readAt: now() };
    classifyEntry(entry);
    bump();
  }

  /** A fresh reading of `tab` (replacing the tab's last); read now, or after `delayMs`. */
  const begin = (tabId: number, tab: SerpTab, match: SerpMatch, pack: Extract<ActivePack, { status: 'ready' }>, delayMs: number | null): Entry => {
    const previous = entries.get(tabId);
    if (previous) retire(previous, previous.contentsId === tab.contentsId && previous.documentSeq === tab.documentSeq);
    const entry: Entry = {
      tabId,
      contentsId: tab.contentsId,
      documentSeq: tab.documentSeq,
      url: tab.url,
      device: tab.device,
      packVersion: pack.version,
      engine: match.engine,
      params: match.params,
      page: tab.page,
      reading: { kind: 'pending' },
      intent: null,
      classifying: false,
      outline: null,
      timer: undefined,
    };
    entries.set(tabId, entry);
    if (delayMs === null) void run(entry);
    else
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (live(entry)) void run(entry);
      }, delayMs);
    bump();
    return entry;
  };

  /** Whether `entry` is the reading of what `tab` shows now, with the pack in use. */
  const isCurrent = (entry: Entry, tab: SerpTab, pack: Extract<ActivePack, { status: 'ready' }>): boolean =>
    entry.contentsId === tab.contentsId && entry.documentSeq === tab.documentSeq && entry.url === tab.url && entry.device === tab.device && entry.packVersion === pack.version;

  /** The tab's SERP state (a loaded result page with no current reading is read now) and its current entry. */
  const serpState = (tabId: number): { serp: SerpState; entry: Entry | null } => {
    const pack = readyPack();
    if (!pack) return { serp: { status: 'disabled', tabId, reason: 'pack-invalid' }, entry: null };
    const tab = tabs.tab(tabId);
    if (!tab) return { serp: { status: 'not-serp', tabId, url: '' }, entry: null };
    let entry = entries.get(tabId) ?? null;
    if (!entry || !isCurrent(entry, tab, pack)) {
      // A reading of something the tab no longer shows goes (removed from the page if it is still that document).
      if (entry) retire(entry, entry.contentsId === tab.contentsId && entry.documentSeq === tab.documentSeq);
      const match = disposed ? null : matchSerp(tab.url, pack.pack, tab.device);
      if (!match) return { serp: { status: 'not-serp', tabId, url: tab.url.length <= SERP_PARAM_LIMITS.maxUrlChars ? tab.url : '' }, entry: null };
      if (tab.loading) return { serp: { status: 'pending', tabId, documentSeq: tab.documentSeq, url: tab.url, params: match.params }, entry: null };
      entry = begin(tabId, tab, match, pack, null);
    }
    return { serp: stateOf(entry), entry };
  };

  const stateOf = (entry: Entry): SerpState => {
    const base = { tabId: entry.tabId, documentSeq: entry.documentSeq, url: entry.url };
    if (entry.reading.kind === 'pending') return { status: 'pending', ...base, params: entry.params };
    const { snapshot, readAt } = entry.reading;
    if (snapshot.status === 'ready') return { status: 'ready', ...base, readAt, snapshot };
    return { status: 'unreadable', ...base, readAt, reason: snapshot.reason, params: snapshot.params, packVersion: snapshot.packVersion };
  };

  // ---- Intent -----------------------------------------------------------------------------------

  const remember = (query: string, answer: IntentAnswer): void => {
    intents.delete(query);
    intents.set(query, answer);
    while (intents.size > SERP_INTENT_CACHE_SIZE) intents.delete(intents.keys().next().value!);
  };

  /** Classifies a `ready` reading's query, locally, if the classifier is `ready` (a kept answer first). */
  function classifyEntry(entry: Entry): void {
    if (entry.intent || entry.classifying || entry.reading.kind !== 'done' || entry.reading.snapshot.status !== 'ready') return;
    if (classifier.state() !== 'ready') return;
    const query = entry.params.query;
    const kept = intents.get(query);
    if (kept) {
      entry.intent = kept;
      return;
    }
    entry.classifying = true;
    void attempt(() => classifier.classify(query))
      .catch((): IntentAnswer => ({ state: 'unavailable' }))
      .then((answer) => {
        entry.classifying = false;
        if (answer.state === 'ready' || answer.state === 'no-query') {
          remember(query, answer);
          if (live(entry)) entry.intent = answer;
        }
        if (live(entry)) bump();
      });
  }

  const intentOf = (entry: Entry | null, serp: SerpState): IntentAnswer | null => {
    if (!entry || serp.status !== 'ready') return null;
    classifyEntry(entry);
    if (entry.intent) return entry.intent;
    const state = classifier.state();
    return state === 'ready' ? null : { state };
  };

  // ---- Pack -------------------------------------------------------------------------------------

  const packStatus = (): PackStatus => {
    const active = packs.current();
    const base = { lastUpdate, checking: checking !== null };
    if (active.status !== 'ready') return { state: 'disabled', version: null, source: null, published: null, ...base };
    return { state: 'ready', version: active.version, source: active.source, published: active.pack.published, ...base };
  };

  /** Every reading was made with another pack: all go (outlines too); the active tab is read again now, the others when asked for. */
  const unsubscribePacks = packs.onChanged(() => {
    if (disposed) return;
    for (const entry of [...entries.values()]) retire(entry, true);
    bump();
    const active = tabs.activeTabId();
    if (active !== null) serpState(active);
  });
  const unsubscribeIntent = classifier.onChanged(() => {
    if (!disposed) bump();
  });

  /** The page of `contentsId`'s entry. */
  const entryOf = (contentsId: number): Entry | undefined => [...entries.values()].find((entry) => entry.contentsId === contentsId);

  const tabState = (tabId: number): SerpTabState => {
    const { serp, entry } = serpState(tabId);
    const intent = intentOf(entry, serp);
    return { version, tabId, serp, outlines: entry?.outline != null, intent, pack: packStatus() };
  };

  const serp: Serp = {
    state: tabState,

    watch(tabId, sinceVersion, signal) {
      if (version > sinceVersion || disposed) return Promise.resolve(tabState(tabId));
      return new Promise<SerpTabState>((resolve) => {
        const waiter = {
          wake: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve(tabState(tabId));
          },
        };
        const onAbort = (): void => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(tabState(tabId));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
        while (waiters.length > MAX_PENDING_SERP_WATCHES) waiters.shift()!.wake();
      });
    },

    setOutlines(tabId, on) {
      if (disposed) return false;
      const { serp: state, entry } = serpState(tabId);
      if (!on) {
        if (entry?.outline) {
          outlinesOff(entry, true);
          bump();
        }
        return false;
      }
      if (!entry || state.status !== 'ready' || tabs.activeTabId() !== tabId) return false;
      if (entry.outline) return true;
      const token = ++outlineSeq;
      entry.outline = { token };
      const mine = (): boolean => live(entry) && entry.outline?.token === token;
      const off = (): void => {
        if (!mine()) return;
        outlinesOff(entry, false);
        bump();
      };
      void attempt(() => outline.paint(entry.page, entry.engine.layout)).then(
        (answer) => {
          if (!mine()) return;
          if (!drawnAnswer(answer)) {
            off();
            return;
          }
          // Whatever ends it (the page removed it, or was left), the tab's outlines are off.
          void attempt(() => outline.ended(entry.page)).then(off, off);
        },
        (error: unknown) => {
          log(`serp: the outlines could not be drawn: ${error instanceof Error ? error.message : String(error)}`);
          off();
        },
      );
      ensurePoll();
      bump();
      return true;
    },

    packStatus,

    checkPackUpdate() {
      if (checking) return checking;
      checking = attempt(() => packs.checkForUpdate())
        .catch((): PackUpdateOutcome => 'unreachable')
        .then((outcome) => {
          lastUpdate = { outcome, at: now() };
          checking = null;
          bump();
          return outcome;
        });
      // Watchers see `checking` while it runs.
      bump();
      return checking;
    },

    intentState: () => classifier.state(),
    enableIntent: () => classifier.ensureModel().catch(() => 'storage' as const),
    classify: (query) => classifier.classify(query).catch((): IntentAnswer => ({ state: 'unavailable' })),

    readApi: {
      snapshot: (tabId) => serpState(tabId).serp,
      classifyIntent: (query) => classifier.classify(query).catch((): IntentAnswer => ({ state: 'unavailable' })),
    },

    loaded(contentsId) {
      if (disposed) return;
      const tabId = tabs.tabOf(contentsId);
      const tab = tabId === null ? null : tabs.tab(tabId);
      const pack = readyPack();
      if (tabId === null || !tab || tab.contentsId !== contentsId || !pack) return;
      const match = matchSerp(tab.url, pack.pack, tab.device);
      if (match) {
        begin(tabId, tab, match, pack, null);
        return;
      }
      const previous = entries.get(tabId);
      if (previous) {
        retire(previous, previous.documentSeq === tab.documentSeq);
        bump();
      }
    },

    navigated(contentsId) {
      const entry = entryOf(contentsId);
      if (!entry) return;
      retire(entry, false);
      bump();
    },

    navigatedInPage(contentsId, url) {
      if (disposed) return;
      const tabId = tabs.tabOf(contentsId);
      const tab = tabId === null ? null : tabs.tab(tabId);
      const pack = readyPack();
      if (tabId === null || !tab || tab.contentsId !== contentsId || !pack) return;
      const entry = entries.get(tabId);
      const match = matchSerp(url, pack.pack, tab.device);
      // The same search at another URL (a fragment, a tracking token): the reading stays.
      if (entry && match && entry.contentsId === contentsId && entry.documentSeq === tab.documentSeq && entry.packVersion === pack.version && entry.device === tab.device && entry.params.url === match.params.url) {
        entry.url = url;
        return;
      }
      if (entry) retire(entry, true);
      if (match) begin(tabId, { ...tab, url }, match, pack, debounceMs);
      else bump();
    },

    closed(contentsId) {
      const entry = entryOf(contentsId);
      if (!entry) return;
      retire(entry, false);
      bump();
    },

    forget() {
      for (const entry of [...entries.values()]) retire(entry, true);
      intents.clear();
      bump();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribePacks();
      unsubscribeIntent();
      for (const entry of [...entries.values()]) retire(entry, false);
      if (poll !== undefined) clearInterval(poll);
      poll = undefined;
      bump();
    },

    pendingWatches: () => waiters.length,
  };
  return serp;
}
