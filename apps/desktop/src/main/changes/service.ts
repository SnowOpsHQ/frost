import { canonicalJson, diffSnapshots } from '@app/change-intel';
import { uuidv7 as defaultUuidv7, type ChangeIntelRepository } from '@app/db';
import type { ChangesReadService, ChangesService } from '@app/ipc-contract';
import type { SeoAuditResponse } from '@app/seo-core';
import { MAX_DIFF_JSON_BYTES, MAX_SNAPSHOT_JSON_BYTES, UNFILED_PROJECT_ID, type CaptureSource } from '@app/specs/capture-db.spec';
import { CAPTURE_LIMITS, CAPTURE_SNAPSHOT_VERSION, PAGE_REGIONS, CaptureSnapshotSchema, DIFF_ENGINE_VERSION, SnapshotDiffSchema, type CaptureSnapshot, type SnapshotDiff } from '@app/specs/capture-snapshot.schema';
import { SearchParamsSchema, type SearchParams } from '@app/specs/capture-search-params.schema';
import { CAPTURE_BUSY, CAPTURE_STALE_RETRIES, DiffSummarySchema, type CaptureAnswer, type CaptureRefusal, type HistoryVersion } from '@app/specs/changes.schema';
import { RenderProfileSchema } from '@app/specs/render-profile.schema.spec';
import type { z } from 'zod';
import type { LoadTimes } from './loads';
import { recordedProfile } from './profile-in-effect';
import { parseRegionAnswer, type RegionTarget } from './regions';
import { buildCaptureSnapshot, identityHash, laneKeyFor, sha256Hex, storedPageUrl } from './snapshot';
import { readScreenshots } from '../screenshots/service';

// Capturing a page into its versioned history, and reading it back (Phase 6 Task 3; spec
// `changes.spec.ts`, `changes.schema.ts`; acceptance `changes-capture.feature.md`, The service).
// A capture joins the active tab's ready audit with a region extraction in `CAPTURE_WORLD_ID`, and
// appends the snapshot through `@app/db`: a new version with its diff when the page changed, else
// one more capture of the lane's latest version. Writes go one at a time through a queue; a capture
// never rejects (each failure is a refusal and one log line, never page text). Everything read back
// from the database is parsed with its Zod schema first: a tampered row is skipped.

/** What the service needs of the browser: the active tab, a tab's page, and its audit (`browser.seo.getAudit`). */
export interface ChangesTabs {
  activeTabId(): number | null;
  /** The tab's live page WebContents, `null` for an id that names no open tab. */
  contentsOf(tabId: number): RegionTarget | null;
  getAudit(tabId: number): SeoAuditResponse;
  /** When the tab last loaded (`LoadTimes`, `loads.ts`); `null`: not since it was watched. */
  loadedAt(tabId: number): number | null;
}

export interface ChangesServiceDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  readonly tabs: ChangesTabs;
  /** Runs the region extraction in the tab's capture world (`runRegions`); its answer is untrusted. */
  readonly extract: (contents: RegionTarget) => Promise<unknown>;
  readonly now?: () => number;
  readonly uuidv7?: (now?: number) => string;
  /** Where a refused capture or a failed read is reported (one line each; never page text). */
  readonly log?: (message: string) => void;
  /** The search parameters a manual capture of the tab records. */
  readonly searchParamsOf?: (tabId: number) => SearchParams | null;
  /** How long an extraction may take (default `CAPTURE_LIMITS.extractTimeoutMs`). */
  readonly extractTimeoutMs?: number;
}

/** A capture's options: the IPC passes only `projectId`; a project's capture run also its source and the query's search parameters. */
export interface CaptureOptions {
  readonly projectId?: string;
  readonly source?: CaptureSource;
  readonly searchParams?: SearchParams | null;
  /** A capture run's: the page (stored form) the tab must show, else the capture is refused `no-audit` (the user navigated it). */
  readonly pageUrl?: string;
}

/** Main's changes service: the procedures' (`ChangesService`) and Phase 5's reads (`ChangesReadService`). */
export interface MainChangesService extends ChangesService, ChangesReadService {
  capture(tabId: number, options?: CaptureOptions): Promise<CaptureAnswer>;
  /** Tells `listener` of each capture saved, with its project (retention enforces the project's policy; `retention.ts`). */
  onCaptured(listener: (projectId: string) => void): void;
}

// TODO(phase-3-merge): the tab's visible search parameters (serp-search-params.schema.ts)
const noSearchParams = (_tabId: number): SearchParams | null => null;

const refused = (reason: CaptureRefusal): CaptureAnswer => ({ status: 'refused', reason });
/** An error's code or name: never its message (a database error's message holds its parameters, URLs among them). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};
/** Whether `snapshot` was cut short (`changes-diff.feature.md`, Partial snapshots). */
const cutShort = (snapshot: CaptureSnapshot): boolean => snapshot.partial || PAGE_REGIONS.some((region) => snapshot.regions[region].truncated);

/** `promise`, or a rejection once `ms` pass. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `json` parsed with `schema`, else `undefined` (never throws). */
function parsedJson<T>(schema: z.ZodType<T>, json: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `diff`, or one keeping fewer changes (`truncated`; the summary still counts all) whose canonical
 * JSON fits `MAX_DIFF_JSON_BYTES`: each round keeps the first three quarters of the changes.
 */
function fitDiff(diff: SnapshotDiff): SnapshotDiff {
  let current = diff;
  while (current.changes.length > 0 && Buffer.byteLength(canonicalJson(current), 'utf8') > MAX_DIFF_JSON_BYTES) {
    current = { ...current, changes: current.changes.slice(0, Math.floor((current.changes.length * 3) / 4)), truncated: true };
  }
  return current;
}

export function createChangesService(deps: ChangesServiceDeps): MainChangesService {
  const { store, tabs } = deps;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuidv7 ?? defaultUuidv7;
  const log = (message: string): void => deps.log?.(`changes: ${message}`);
  const searchParamsOf = deps.searchParamsOf ?? noSearchParams;
  const extractTimeoutMs = deps.extractTimeoutMs ?? CAPTURE_LIMITS.extractTimeoutMs;
  /** Tabs with a capture running. */
  const busy = new Set<number>();
  let captured: (projectId: string) => void = () => undefined;
  /** The write queue: one capture's head read and append at a time. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  /** A refusal that is a failure: one log line saying why (frost's own words, never page data). */
  const failed = (reason: CaptureRefusal, why: string): CaptureAnswer => {
    log(`capture refused (${reason}): ${why}`);
    return refused(reason);
  };

  /** A version's snapshot as main can use it: its row, and the snapshot if it parses (another snapshot version does not). */
  const readVersion = async (id: string): Promise<{ laneKey: string; snapshot: CaptureSnapshot | null } | null> => {
    const stored = await store.version(id);
    if (!stored) return null;
    const snapshot = stored.schemaVersion === CAPTURE_SNAPSHOT_VERSION ? parsedJson(CaptureSnapshotSchema, stored.snapshotJson) : undefined;
    return { laneKey: stored.laneKey, snapshot: snapshot ?? null };
  };

  /**
   * The tab, if it is the active one, shows a page a snapshot can hold, and has a **settled** ready
   * audit of that page (fragment aside) taken after its latest load: not the last load's audit kept
   * on screen through a reload, and not a provisional one (robots.txt still `pending`).
   */
  const readyTab = (tabId: number): { contents: RegionTarget; response: Extract<SeoAuditResponse, { status: 'ready' }>; page: string } | CaptureRefusal => {
    const response = tabs.getAudit(tabId);
    const contents = tabs.contentsOf(tabId);
    if (!contents || (response.status === 'unavailable' && response.reason === 'no-tab')) return 'no-tab';
    if (tabs.activeTabId() !== tabId) return 'not-active';
    const page = storedPageUrl(contents.getURL());
    // A URL longer than a snapshot keeps can never be captured (its audit holds it cut): say so.
    if (page !== null && page.length > CAPTURE_LIMITS.maxUrlChars) return 'invalid-page';
    if (response.status !== 'ready' || page === null || storedPageUrl(response.audit.url) !== page) return 'no-audit';
    const loadedAt = tabs.loadedAt(tabId);
    if (response.audit.indexability.robots?.outcome === 'pending' || (loadedAt !== null && response.audit.takenAt <= loadedAt)) return 'no-audit';
    return { contents, response, page };
  };
  /** A `readyTab` refusal: `invalid-page` is a failure (logged), the others are states. */
  const notReady = (reason: CaptureRefusal): CaptureAnswer => (reason === 'invalid-page' ? failed(reason, 'its URL is longer than a snapshot keeps') : refused(reason));

  async function captureTab(tabId: number, options: CaptureOptions): Promise<CaptureAnswer> {
    let tab: ReturnType<typeof readyTab>;
    try {
      tab = readyTab(tabId);
    } catch {
      return failed('no-audit', 'the tab or its audit could not be read');
    }
    if (typeof tab === 'string') return notReady(tab);
    const { contents, response, page } = tab;
    if (options.pageUrl !== undefined && page !== options.pageUrl) return refused('no-audit');

    const projectId = options.projectId ?? UNFILED_PROJECT_ID;
    try {
      if ((await store.project(projectId)) === null) return refused('no-project');
    } catch (error) {
      return failed('store-failed', `the project could not be read (${codeOf(error)})`);
    }
    const given = options.searchParams !== undefined ? options.searchParams : searchParamsOf(tabId);
    const params = given === null ? null : SearchParamsSchema.safeParse(given);
    if (params !== null && !params.success) return failed('invalid-page', 'its search parameters do not fit their schema');
    const searchParams = params?.data ?? null;
    // The audit's profile in effect, by the rule screenshots follow too (`profile-in-effect.ts`).
    const profile = recordedProfile(response.renderProfile ?? null);
    if (profile === undefined) return failed('invalid-page', 'its render profile does not fit its schema');

    // The regions, read in the capture world (untrusted: validated, then checked against the tab again).
    let raw: unknown;
    try {
      raw = await within(
        Promise.resolve().then(() => deps.extract(contents)),
        extractTimeoutMs,
      );
    } catch (error) {
      return failed('extract-failed', error instanceof Error && error.message === 'timed out' ? 'the extraction timed out' : 'the extraction failed');
    }
    const regions = parseRegionAnswer(raw);
    if (regions === null) return failed('extract-failed', 'its answer does not fit RegionAnswerSchema');
    let again: ReturnType<typeof readyTab>;
    try {
      again = readyTab(tabId);
    } catch {
      return failed('no-audit', 'the tab or its audit could not be read');
    }
    if (typeof again === 'string') return notReady(again);
    if (again.page !== page || again.response.audit !== response.audit || storedPageUrl(regions.url) !== page) return refused('no-audit');

    // The snapshot, its lane and its identity.
    let snapshot: CaptureSnapshot;
    let snapshotJson: string;
    let hash: string;
    let laneKey: string | null;
    try {
      const parsed = CaptureSnapshotSchema.safeParse(buildCaptureSnapshot(response.audit, regions, sha256Hex));
      if (!parsed.success) return failed('invalid-page', 'its snapshot does not fit CaptureSnapshotSchema');
      snapshot = parsed.data;
      snapshotJson = canonicalJson(snapshot);
      hash = identityHash(snapshot);
      laneKey = laneKeyFor(page, profile?.profile ?? null, searchParams);
    } catch {
      return failed('invalid-page', 'its snapshot could not be built');
    }
    if (laneKey === null || Buffer.byteLength(snapshotJson, 'utf8') > MAX_SNAPSHOT_JSON_BYTES) return failed('invalid-page', 'its snapshot cannot be stored');
    const lane = laneKey;
    const capture = {
      projectId,
      laneKey: lane,
      pageUrl: page,
      renderProfileJson: profile?.json ?? null,
      renderProfilePartial: profile?.partial ?? false,
      searchParamsJson: searchParams === null ? null : canonicalJson(searchParams),
      source: options.source ?? 'manual',
      auditTakenAt: snapshot.takenAt,
      snapshotJson,
      snapshotHash: hash,
      schemaVersion: CAPTURE_SNAPSHOT_VERSION,
    };

    // Written one capture at a time: read the head, diff against it, append (again once if the lane moved).
    /** Whether the project went (tombstoned) while the capture ran; else the write failed for another reason. */
    const goneOr = async (why: string): Promise<CaptureAnswer> => ((await store.project(projectId)) === null ? refused('no-project') : failed('store-failed', why));
    return serial(async () => {
      try {
        for (let attempt = 0; attempt <= CAPTURE_STALE_RETRIES; attempt++) {
          const head = await store.latestVersion(lane);
          let diff: SnapshotDiff | null = null;
          // A capture cut short that the diff finds no change in is one more capture of the head.
          let reuse: string | null = null;
          if (head !== null && head.snapshotHash !== hash) {
            const before = (await readVersion(head.id))?.snapshot ?? null;
            const found = diffSnapshots(before, snapshot);
            if (before !== null && cutShort(snapshot) && found.changeCount === 0) reuse = head.snapshotHash;
            else diff = fitDiff(found);
          }
          const at = now();
          const ids = { captureId: uuid(at), versionId: uuid(at) };
          const diffInput =
            head !== null && diff !== null
              ? { id: uuid(at), fromVersionId: head.id, engineVersion: DIFF_ENGINE_VERSION, diffJson: canonicalJson(diff), summaryJson: canonicalJson(diff.summary), changeCount: diff.changeCount }
              : undefined;
          const result = await store.appendCapture({ ...capture, ...(reuse === null ? {} : { snapshotHash: reuse }), ...ids, createdAt: at, ...(diffInput ? { diff: diffInput } : {}) });
          if (result === null) return goneOr('the store refused the capture');
          if (result.status === 'appended') {
            captured(projectId);
            return { status: 'captured', captureId: result.captureId, versionId: result.versionId, newVersion: result.newVersion, changeCount: result.newVersion ? (diff?.changeCount ?? null) : 0 };
          }
        }
        return goneOr('its lane kept changing while it was written');
      } catch (error) {
        return failed('store-failed', `the store failed (${codeOf(error)})`);
      }
    });
  }

  /** `run`'s answer, or `fallback` (logged) when the database fails. */
  const guarded = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      log(`${what} failed (${codeOf(error)})`);
      return fallback;
    }
  };

  const service: MainChangesService = {
    onCaptured: (listener) => void (captured = listener),
    async capture(tabId, options = {}) {
      if (busy.has(tabId)) return refused(CAPTURE_BUSY);
      busy.add(tabId);
      try {
        return await captureTab(tabId, options);
      } catch (error) {
        // Nothing above throws past its own handling; this keeps "never rejects" true regardless.
        return failed('store-failed', `the capture failed (${error instanceof Error ? error.name : 'unknown error'})`);
      } finally {
        busy.delete(tabId);
      }
    },

    history: (input) =>
      guarded(
        'history read',
        async () => {
          const found = await store.history({ pageUrl: input.url, ...(input.projectId === undefined ? {} : { projectId: input.projectId }), cursor: input.cursor ?? null, ...(input.limit === undefined ? {} : { limit: input.limit }) });
          const versions = found.entries.flatMap((entry): HistoryVersion[] => {
            const renderProfile = entry.renderProfileJson === null ? null : parsedJson(RenderProfileSchema, entry.renderProfileJson);
            const searchParams = entry.searchParamsJson === null ? null : parsedJson(SearchParamsSchema, entry.searchParamsJson);
            // A row whose lane cannot be read back is skipped; a diff summary that does not parse is no summary.
            if (renderProfile === undefined || searchParams === undefined) return [];
            const summary = entry.diff ? (parsedJson(DiffSummarySchema, entry.diff.summaryJson) ?? null) : null;
            return [
              {
                versionId: entry.id,
                createdAt: entry.createdAt,
                captureCount: entry.captureCount,
                lastCapturedAt: entry.lastCapturedAt,
                laneKey: entry.laneKey,
                renderProfile,
                searchParams,
                parentVersionId: entry.parentVersionId,
                summary,
                changeCount: summary !== null && entry.diff ? entry.diff.changeCount : null,
              },
            ];
          });
          return { versions, next: found.next ? { createdAt: found.next.createdAt, id: found.next.id } : null };
        },
        { versions: [], next: null },
      ),

    version: (input) => guarded('version read', async () => (await readVersion(input.versionId))?.snapshot ?? null, null),

    diff: (input) =>
      guarded(
        'diff read',
        async () => {
          const [from, to] = [await readVersion(input.fromVersionId), await readVersion(input.toVersionId)];
          if (!from?.snapshot || !to?.snapshot || from.laneKey !== to.laneKey) return null;
          const stored = await store.diffFor(input.fromVersionId, input.toVersionId);
          if (stored && stored.engineVersion === DIFF_ENGINE_VERSION && stored.laneKey === from.laneKey) {
            const diff = parsedJson(SnapshotDiffSchema, stored.diffJson);
            if (diff) return diff;
          }
          return diffSnapshots(from.snapshot, to.snapshot);
        },
        null,
      ),

    pages: (input) =>
      guarded(
        'pages read',
        async () => {
          const rows = await store.pages({ ...(input.projectId === undefined ? {} : { projectId: input.projectId }), ...(input.limit === undefined ? {} : { limit: input.limit }) });
          return { pages: rows.map((row) => ({ url: row.pageUrl, captureCount: row.captureCount, lastCapturedAt: row.lastCapturedAt })) };
        },
        { pages: [] },
      ),

    // Phase 5's reads (`CHANGES_READ_API`): the same answers.
    listPages: (input) => service.pages(input),
    getVersion: (input) => service.version(input),
    // Screenshots' rows, as `screenshots.list` reads them (Task 5, `screenshot.feature.md`, Listing).
    listScreenshots: (input) => guarded('screenshots read', () => readScreenshots(store, input), { screenshots: [], next: null }),
  };
  return service;
}

/** `ChangesTabs` over the browser controller, main's map of tab WebContents (`contentsOf`) and the tabs' load times. */
export function changesTabs(
  browser: { getState(): { readonly activeTabId: number | null }; readonly seo: { getAudit(tabId: number): SeoAuditResponse } },
  contentsOf: (tabId: number) => RegionTarget | null,
  loads: LoadTimes,
): ChangesTabs {
  return {
    activeTabId: () => browser.getState().activeTabId,
    contentsOf,
    getAudit: (tabId) => browser.seo.getAudit(tabId),
    loadedAt: (tabId) => {
      const contents = contentsOf(tabId);
      return contents ? loads.loadedAt(contents) : null;
    },
  };
}
