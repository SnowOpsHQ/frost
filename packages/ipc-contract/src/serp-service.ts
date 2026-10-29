import type { IntentAnswer, IntentEnableOutcome, IntentState } from '@app/specs/intent-classifier.spec';
import type { PackUpdateOutcome } from '@app/specs/serp-selector-pack.spec';
import type { PackStatus, SerpState, SerpTabState } from '@app/specs/serp-service.schema';
import type { ProbesState } from '@app/specs/visibility-probes.schema';

// The SERP overlay as the `serp.*` procedures and other phases see it (Phase 3 Task 4; spec
// `serp-service.spec.ts`, `serp-service.schema.ts`; acceptance `serp-overlay.feature.md`, Router and
// Service), and the visibility probes (Task 5; `visibility-probes.spec.ts`,
// `visibility-probes.schema.ts`; acceptance `visibility-probes.feature.md`). Main implements it
// (`apps/desktop/src/main/serp/service.ts`, `probes.ts`, joined in `setup.ts`); this package only
// knows the interfaces.

/** The visibility probes' part of `SerpService` (Task 5). */
export interface SerpProbesService {
  /**
   * The user's "Run visibility probes" on the tab: fetches its current URL once per agent
   * (`PROBE_AGENTS`) through the SERP lane (`SERP_FETCHER_LIMITS`), robots.txt from main's cache once per origin judged. Only for the
   * active tab showing an `http(s)` page; `true` if a run is under way (started now, or already:
   * one run per tab). **Fetches.** Never throws.
   */
  runProbes(tabId: number): boolean;
  /** Stops the tab's run, keeping what it found; `true` if one was running. */
  stopProbes(tabId: number): boolean;
  /** The tab's run for the page it shows now (`ProbesStateSchema`; `idle` without one). Never fetches; never throws. */
  probes(tabId: number): ProbesState;
  /**
   * Resolves with the tab's probes state once its `version` exceeds `sinceVersion` (at once if it
   * already does), or when `signal` aborts. At most `MAX_PENDING_PROBE_WATCHES` wait.
   */
  watchProbes(tabId: number, sinceVersion: number, signal?: AbortSignal): Promise<ProbesState>;
}

/** What the `serp.*` procedures call (each one after `enforceSender`). */
export interface SerpService extends SerpProbesService {
  /**
   * The tab's SERP state (`SerpTabStateSchema`): its reading of the page it shows now, whether its
   * outlines are drawn, its query's intent and the pack's status. A result page with no reading yet
   * that has finished loading is read now (`pending`). A tab id that names no open tab is
   * `not-serp` with no URL. Never throws.
   */
  state(tabId: number): SerpTabState;
  /**
   * Resolves with the tab's state once the service's version exceeds `sinceVersion` (at once if it
   * already does), or when `signal` aborts. At most `MAX_PENDING_SERP_WATCHES` wait; one more
   * answers the oldest early.
   */
  watch(tabId: number, sinceVersion: number, signal?: AbortSignal): Promise<SerpTabState>;
  /**
   * Draws (`on`) or removes the tab's outlines; `true` if they are drawn now. Drawn only for the
   * active tab with a `ready` reading; anything else is `false` (a no-op for `on`).
   */
  setOutlines(tabId: number, on: boolean): boolean;
  /** The selector pack in use and the last update check's outcome (`PackStatusSchema`). */
  packStatus(): PackStatus;
  /**
   * The user's "Check for selector updates": fetches, verifies and, if newer, installs the remote
   * pack (`PACK_UPDATE_OUTCOMES`). The only thing that requests a pack. Concurrent calls share one
   * run; never rejects.
   */
  checkPackUpdate(): Promise<PackUpdateOutcome>;
  /** Where on-device intent stands (`INTENT_STATES`). */
  intentState(): IntentState;
  /**
   * The user's "Enable on-device intent": downloads, checks and stores the model if it is missing
   * (`INTENT_ENABLE_OUTCOMES`). The only thing that downloads it. Never rejects.
   */
  enableIntent(): Promise<IntentEnableOutcome>;
  /** Classifies any query on this computer (`IntentAnswer`); never downloads, never fetches, never rejects. */
  classify(query: string): Promise<IntentAnswer>;
}

/**
 * The read API for Phase 5's agent tools (stable after merge; answers Zod-typed by
 * `serp-service.schema.ts` and `visibility-probes.schema.ts`). None of these calls fetch anything or
 * download a model, **except `runProbes`**, which fetches on the user's behalf: an agent tool calls
 * it only through Phase 5's approval model, never on its own.
 */
export interface SerpReadApi {
  /**
   * The tab's SERP reading (`SerpStateSchema`): `not-serp`, `pending`, `ready` with its
   * `SerpSnapshot`, `unreadable` with its reason, or `disabled`. Reads the page the user loaded if it
   * has no reading yet (in the tab's isolated world; no request). Never throws.
   */
  snapshot(tabId: number): SerpState;
  /**
   * Classifies a query with the on-device classifier (`IntentAnswerSchema`): `ready` with the result,
   * or its state (`model-missing` …) when it cannot. Never downloads the model (only the user
   * enables it); never rejects.
   */
  classifyIntent(query: string): Promise<IntentAnswer>;
  /**
   * The tab's last probe run for the page it shows now (`ProbesStateSchema`: rows per agent, diffs
   * against the browser baseline; `idle` without one). Read-only: never fetches; never throws.
   */
  probes(tabId: number): ProbesState;
  /**
   * **Fetches on the user's behalf**: starts the visibility probes on the tab, as the user's "Run
   * visibility probes" does (one GET per agent through the bounded fetcher's SERP lane, robots.txt
   * once from main's cache; only the active tab showing an `http(s)` page; one run per tab). Phase 5
   * must gate it behind its approval model; `true` if a run is under way. Never throws.
   */
  runProbes(tabId: number): boolean;
}
