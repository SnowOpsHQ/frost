import { randomUUID } from 'node:crypto';
import { modelPageUrl } from '@app/specs/agent-page-tools.spec';
import { AI_CHECK_LIMITS, AI_CHECK_SYSTEM_PROMPT, aiCheckFailureReason, DEFAULT_AI_CHECK_MODE, isAiCheckMode, type AiCheckMode, type AiCheckUnavailableReason } from '@app/specs/ai-checks.spec';
import type { AiCheckResult, AiCheckView, AiChecksState } from '@app/specs/ai-checks.schema';
import type { AiChecksService } from '@app/ipc-contract';
import type { AiChecksRepository, SettingsRepository } from '@app/db';
import type { AgentCheckPort } from '../agent/check-port';
import type { ServedHtml } from '../seo/served';
import { readAiCheckInput, type AiCheckPage } from './input';
import { parseAiCheckOutput } from './output';

// The AI checks service (Phase 9 Task 10, Decisions 15–17; acceptance `specs/ai-checks.feature.md`,
// Service). Pure: main's Electron wiring is `main.ts`.
//
// - The mode is `off` until the stored one is read, and stays `off` by default. Leaving `off` asks
//   in main's own consent dialog (`confirmEnable`); the renderer only asks.
// - A check is wanted by "Check this page" (`checkNow`, any on mode; exempt from the hourly cap and
//   the backoff) or, in `automatic`, for the active tab once its audit is ready (`refresh`).
// - Its input is only the served HTML the audit fetched, read with `served.peek` (`input.ts`); the
//   service never fetches. Then the guard, then the cache (the URL and the input's hash), then the
//   model main's agent settings name (`no-model` when not set up), then the chat (a running turn
//   goes first: `busy-chat`), then, for an automatic check, the hourly cap and the backoff (`rate`).
// - One check runs at a time, each with a fresh id, on the route and model `agent.model()` named.
//   Its end (`check.finish` / `check.error`) is parsed and capped (`output.ts`): an answer is stored
//   and shown; an error code is mapped to a reason (`aiCheckFailureReason`) and only ever read as
//   "this check failed"; an automatic one that failed backs further automatic checks off.
// - Turning `off`, Clear Browsing Data and quitting stop the running check (`check.stop`).

/** The tabs as a check sees them. */
export interface AiChecksTabs {
  activeTabId(): number | null;
  /**
   * The tab's page: its live document, URL, the audit's served key (the tab's user agent and
   * scripting) and whether its audit is ready; `null` without such a tab.
   */
  page(tabId: number): (AiCheckPage & { readonly auditReady: boolean }) | null;
}

export interface AiChecksDeps {
  readonly tabs: AiChecksTabs;
  /** The audit's served-HTML cache (`null` until it exists); only `peek` is ever called. */
  readonly served: () => Pick<ServedHtml, 'peek'> | null;
  readonly agent: AgentCheckPort;
  /** `SessionStore.aiChecks`. */
  readonly store: Pick<AiChecksRepository, 'get' | 'put' | 'clear'>;
  /** `SessionStore.settings`. */
  readonly settings: Pick<SettingsRepository, 'aiChecksMode' | 'setAiChecksMode'>;
  /** Main's consent dialog (`AI_CHECKS_ENABLE_PROMPT`): `true` only when the user confirmed. */
  readonly confirmEnable: () => Promise<boolean>;
  readonly now?: () => number;
  /** A fresh check id (default: a random UUID); never one used before. */
  readonly newCheckId?: () => string;
  /** Fixed lines only: never a URL, page text or model text. */
  readonly log?: (line: string) => void;
}

export interface AiChecksMainService extends AiChecksService {
  /** Reads the stored mode (until then: `off`). */
  load(): Promise<void>;
  /** The mode in effect. */
  mode(): AiCheckMode;
  /** The tabs, an audit or the served HTML changed: look again (the active tab, and the pages asked for). */
  refresh(): void;
  /** Clear Browsing Data: the running check stops; every answer, stored and in memory, goes. */
  clear(): Promise<void>;
  /** App quit: the running check stops, watchers are answered. */
  dispose(): void;
}

const IDLE: AiCheckView = { status: 'idle' };
const QUEUED: AiCheckView = { status: 'queued' };
const CHECKING: AiCheckView = { status: 'checking' };
const HOUR_MS = 60 * 60_000;
const unavailable = (reason: AiCheckUnavailableReason): AiCheckView => ({ status: 'unavailable', reason });

/** A page's key: its URL without fragment or userinfo (`''` for no web page). */
const keyOf = (url: string): string => modelPageUrl(url) ?? '';

/** A small map that forgets its oldest entries past `max`. */
function boundedMap<V>(max: number) {
  const map = new Map<string, V>();
  return {
    get: (key: string) => map.get(key),
    set(key: string, value: V) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value!);
    },
    delete: (key: string) => map.delete(key),
    clear: () => map.clear(),
  };
}

interface Running {
  readonly checkId: string;
  readonly tabId: number;
  readonly url: string;
  readonly inputHash: string;
  readonly modelId: string;
  readonly automatic: boolean;
}

interface Note {
  readonly url: string;
  readonly view: AiCheckView;
}

export function createAiChecksService(deps: AiChecksDeps): AiChecksMainService {
  const now = deps.now ?? Date.now;
  const newCheckId = deps.newCheckId ?? (() => randomUUID());
  const log = deps.log ?? (() => undefined);

  let mode: AiCheckMode = DEFAULT_AI_CHECK_MODE;
  let loading: Promise<void> | null = null;
  let disposed = false;
  let version = 0;
  const waiters: { wake: () => void }[] = [];
  /** Each tab's last outcome for the page it showed. */
  const notes = new Map<number, Note>();
  /** "Check this page" asked for, per tab, until it ran or was refused (`again`: past a cached answer). */
  const wanted = new Map<number, { readonly url: string; readonly again: boolean }>();
  let running: Running | null = null;
  /** Automatic checks started in the last hour (their start times). */
  let automaticStarts: number[] = [];
  /** No automatic check starts before this (after a failed one). */
  let backoffUntil = 0;
  /** The answers of this run, by page (ahead of the store, so a write in flight is never asked again). */
  const answers = boundedMap<AiCheckResult>(AI_CHECK_LIMITS.maxStoredUrls);
  /** The last failure per page and input: an automatic check never asks the same input again. */
  const failures = boundedMap<{ readonly inputHash: string; readonly reason: AiCheckUnavailableReason }>(AI_CHECK_LIMITS.maxStoredUrls);
  let consenting = false;
  let modeChain: Promise<unknown> = Promise.resolve();

  const bump = (): void => {
    version += 1;
    for (const waiter of waiters.splice(0)) waiter.wake();
  };
  const setNote = (tabId: number, url: string, view: AiCheckView): void => {
    const before = notes.get(tabId);
    if (before && before.url === url && JSON.stringify(before.view) === JSON.stringify(view)) return;
    notes.set(tabId, { url, view });
    bump();
  };
  /** Shows `view` on every tab whose note is for `url`. */
  const noteAll = (url: string, view: AiCheckView): void => {
    for (const [tabId, note] of notes) if (note.url === url) setNote(tabId, url, view);
  };

  const pageOf = (tabId: number) => {
    try {
      return deps.tabs.page(tabId);
    } catch {
      return null;
    }
  };
  const servedNow = () => {
    try {
      return deps.served();
    } catch {
      return null;
    }
  };

  /** Stops the running check (its late answer is ignored: `running` is cleared first). */
  const stopRunning = (): void => {
    const stopping = running;
    if (stopping === null) return;
    running = null;
    try {
      deps.agent.stopCheck(stopping.checkId);
    } catch {
      log('ai checks: stopping a check failed');
    }
    bump();
  };

  const withinCap = (at: number): boolean => {
    automaticStarts = automaticStarts.filter((start) => at - start < HOUR_MS);
    return automaticStarts.length < AI_CHECK_LIMITS.maxAutomaticPerHour;
  };

  const storedAnswer = async (url: string): Promise<AiCheckResult | null> => {
    const kept = answers.get(url);
    if (kept) return kept;
    try {
      const stored = await deps.store.get(url);
      if (stored) answers.set(url, stored);
      return stored;
    } catch {
      log('ai checks: reading a stored answer failed');
      return null;
    }
  };

  /** Whether checks are off now (read afresh after every wait). */
  const checksOff = (): boolean => mode === 'off';
  /** Whether `tabId` still shows the page keyed `url`. */
  const stillOn = (tabId: number, url: string): boolean => {
    const page = pageOf(tabId);
    return page !== null && keyOf(page.url) === url;
  };

  /** Looks at `tabId`'s page: shows what is known, and starts its check when one is wanted and may run. */
  const consider = async (tabId: number): Promise<void> => {
    const page = pageOf(tabId);
    if (page === null) {
      wanted.delete(tabId);
      notes.delete(tabId);
      return;
    }
    const url = keyOf(page.url);
    const want = wanted.get(tabId);
    if (want && want.url !== url) wanted.delete(tabId);
    const manual = wanted.get(tabId) ?? null;
    if (mode === 'off') {
      wanted.delete(tabId);
      setNote(tabId, url, unavailable('off'));
      return;
    }
    if (url === '') {
      wanted.delete(tabId);
      setNote(tabId, url, IDLE);
      return;
    }
    if (running && running.tabId === tabId && running.url === url) return setNote(tabId, url, CHECKING);
    const automatic = manual === null && mode === 'automatic' && deps.tabs.activeTabId() === tabId && page.auditReady;
    const read = readAiCheckInput(servedNow(), page);
    if (read.status === 'skip') {
      // A page not fetched yet, with nothing asked for it, simply has nothing to show.
      if (read.reason === 'served-pending' && manual === null && !automatic) return setNote(tabId, url, IDLE);
      if (read.reason !== 'served-pending') wanted.delete(tabId);
      return setNote(tabId, url, unavailable(read.reason));
    }
    if (manual?.again !== true) {
      const stored = await storedAnswer(read.url);
      if (!stillOn(tabId, url) || checksOff()) return void schedule();
      if (stored && stored.inputHash === read.inputHash) {
        wanted.delete(tabId);
        const before = notes.get(tabId);
        // An answer this tab just got stays "fresh"; one read from before is `cached`.
        const fresh = before?.url === url && before.view.status === 'ready' && before.view.result.inputHash === stored.inputHash && before.view.result.checkedAt === stored.checkedAt && !before.view.cached;
        return setNote(tabId, url, { status: 'ready', result: stored, cached: !fresh });
      }
    }
    const failed = failures.get(read.url);
    const failedHere = failed !== undefined && failed.inputHash === read.inputHash ? unavailable(failed.reason) : null;
    if (manual === null && !automatic) return setNote(tabId, url, failedHere ?? IDLE);
    // An automatic check never asks the same input again after it failed ("Check again" does).
    if (manual === null && failedHere !== null) return setNote(tabId, url, failedHere);
    const model = await deps.agent.model().catch(() => null);
    if (!stillOn(tabId, url) || checksOff()) return void schedule();
    if (model === null) {
      wanted.delete(tabId);
      return setNote(tabId, url, unavailable('no-model'));
    }
    if (deps.agent.chatRunning()) return setNote(tabId, url, unavailable('busy-chat'));
    if (running !== null) return setNote(tabId, url, manual !== null ? QUEUED : IDLE);
    if (manual === null && (now() < backoffUntil || !withinCap(now()))) return setNote(tabId, url, unavailable('rate'));
    const started = await deps.agent.start();
    // Everything is checked again after the wait: the mode, the page, the queue, the chat, the model;
    // an automatic check also needs the mode still `automatic` and its tab still the active one.
    const current = deps.agent.current();
    if (disposed || checksOff() || !stillOn(tabId, url) || running !== null || current.route !== model.route || current.modelId !== model.modelId) return void schedule();
    if (manual === null && (mode !== 'automatic' || deps.tabs.activeTabId() !== tabId)) return void schedule();
    if (deps.agent.chatRunning()) return setNote(tabId, url, unavailable('busy-chat'));
    wanted.delete(tabId);
    if (!started) return setNote(tabId, url, unavailable('network'));
    const checkId = newCheckId();
    const posted = deps.agent.startCheck({ checkId, systemPrompt: AI_CHECK_SYSTEM_PROMPT, input: read.message, modelId: model.modelId, route: model.route });
    if (!posted) {
      log('ai checks: the agent did not take a check');
      return setNote(tabId, url, unavailable('network'));
    }
    running = { checkId, tabId, url: read.url, inputHash: read.inputHash, modelId: model.modelId, automatic: manual === null };
    if (manual === null) automaticStarts.push(now());
    setNote(tabId, url, CHECKING);
  };

  // One look at a time; another change while one runs asks for one more.
  let pumping: Promise<void> | null = null;
  let dirty = false;
  const schedule = (): Promise<void> => {
    dirty = true;
    pumping ??= (async () => {
      try {
        while (dirty && !disposed) {
          dirty = false;
          // Pages asked for first (oldest first), then the active tab.
          const active = deps.tabs.activeTabId();
          const tabs = [...wanted.keys()];
          if (active !== null && !tabs.includes(active)) tabs.push(active);
          for (const tabId of tabs) {
            try {
              await consider(tabId);
            } catch {
              log('ai checks: looking at a page failed');
            }
          }
          // Notes of tabs that are gone.
          for (const tabId of [...notes.keys()]) if (pageOf(tabId) === null) notes.delete(tabId);
        }
      } finally {
        pumping = null;
      }
    })();
    return pumping;
  };

  const unsubscribeCheck = deps.agent.onCheck((event) => {
    const done = running;
    if (done === null || event.checkId !== done.checkId) return;
    running = null;
    if (event.type === 'check.finish') {
      const output = parseAiCheckOutput(event.text);
      if (output === null) {
        failures.set(done.url, { inputHash: done.inputHash, reason: 'invalid-output' });
        noteAll(done.url, unavailable('invalid-output'));
      } else {
        const result: AiCheckResult = { url: done.url, inputHash: done.inputHash, modelId: done.modelId, checkedAt: now(), output };
        answers.set(done.url, result);
        failures.delete(done.url);
        void deps.store.put(result).then(
          (stored) => {
            if (!stored) log('ai checks: an answer was not stored');
          },
          () => log('ai checks: storing an answer failed'),
        );
        noteAll(done.url, { status: 'ready', result, cached: false });
      }
    } else {
      // The runtime's code only says "this check failed"; main's own stop never reaches here.
      const reason = aiCheckFailureReason(event.code);
      failures.set(done.url, { inputHash: done.inputHash, reason });
      if (done.automatic) backoffUntil = now() + AI_CHECK_LIMITS.automaticBackoffMs;
      noteAll(done.url, unavailable(reason));
    }
    bump();
    void schedule();
  });
  const unsubscribeChats = deps.agent.onChatsIdle(() => void schedule());

  const load = (): Promise<void> => {
    loading ??= (async () => {
      try {
        const stored = await deps.settings.aiChecksMode();
        // A mode set while it was read wins.
        if (mode === DEFAULT_AI_CHECK_MODE && isAiCheckMode(stored)) mode = stored;
      } catch {
        log('ai checks: reading the mode failed; off');
      }
      bump();
      void schedule();
    })();
    return loading;
  };

  const applyMode = async (target: AiCheckMode): Promise<AiCheckMode> => {
    await load();
    if (disposed || !isAiCheckMode(target) || target === mode) return mode;
    if (mode === 'off') {
      // Leaving `off` needs main's consent dialog; one at a time.
      if (consenting) return mode;
      consenting = true;
      let confirmed = false;
      try {
        confirmed = (await deps.confirmEnable()) === true;
      } catch {
        confirmed = false;
      } finally {
        consenting = false;
      }
      if (!confirmed || disposed) return mode;
    }
    let written = false;
    try {
      written = (await deps.settings.setAiChecksMode(target, now())) === true;
    } catch {
      written = false;
    }
    if (!written) {
      log('ai checks: the mode could not be stored');
      return mode;
    }
    mode = target;
    if (mode === 'off') {
      wanted.clear();
      stopRunning();
    }
    bump();
    void schedule();
    return mode;
  };

  const state = (tabId: number): AiChecksState => {
    const page = pageOf(tabId);
    const url = page === null ? '' : keyOf(page.url);
    let model: AiChecksState['model'] = null;
    try {
      model = deps.agent.current();
    } catch {
      model = null;
    }
    const note = notes.get(tabId);
    let check: AiCheckView;
    if (mode === 'off') check = unavailable('off');
    else if (url !== '' && running !== null && running.tabId === tabId && running.url === url) check = CHECKING;
    else if (note && note.url === url) check = note.view;
    else check = IDLE;
    return { version, tabId, mode, model, url: url.slice(0, AI_CHECK_LIMITS.maxUrlChars), check };
  };

  return {
    load,
    mode: () => mode,
    state,

    watch(tabId, sinceVersion, signal) {
      if (version > sinceVersion || disposed) return Promise.resolve(state(tabId));
      return new Promise<AiChecksState>((resolve) => {
        const waiter = {
          wake: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve(state(tabId));
          },
        };
        const onAbort = (): void => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(state(tabId));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
        while (waiters.length > 8) waiters.shift()!.wake();
      });
    },

    setMode(target) {
      const next = modeChain.then(() => applyMode(target));
      modeChain = next.catch(() => undefined);
      return next;
    },

    async checkNow(tabId, again) {
      await load();
      if (disposed) return false;
      const page = pageOf(tabId);
      const url = page === null ? '' : keyOf(page.url);
      if (mode === 'off' || url === '') {
        await schedule();
        return false;
      }
      if (running !== null && running.tabId === tabId && running.url === url) return true;
      wanted.set(tabId, { url, again: again === true });
      await schedule();
      const view = state(tabId).check;
      return view.status !== 'unavailable' || view.reason === 'served-pending' || view.reason === 'busy-chat';
    },

    refresh() {
      if (!disposed) void schedule();
    },

    async clear() {
      wanted.clear();
      stopRunning();
      answers.clear();
      failures.clear();
      notes.clear();
      try {
        await deps.store.clear();
      } catch {
        log('ai checks: clearing the stored answers failed');
      }
      bump();
    },

    dispose() {
      if (disposed) return;
      wanted.clear();
      stopRunning();
      disposed = true;
      unsubscribeCheck();
      unsubscribeChats();
      for (const waiter of waiters.splice(0)) waiter.wake();
    },
  };
}
