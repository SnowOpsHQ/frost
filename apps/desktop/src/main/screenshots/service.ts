import { createHash } from 'node:crypto';
import { canonicalJson } from '@app/change-intel';
import { isUuidv7, uuidv7 as defaultUuidv7, type ChangeIntelRepository, type StoredScreenshot } from '@app/db';
import type { ScreenshotsService } from '@app/ipc-contract';
import { UNFILED_PROJECT_ID, type ScreenshotKind } from '@app/specs/capture-db.spec';
import { SearchParamsSchema, type SearchParams } from '@app/specs/capture-search-params.schema';
import { RenderProfileSchema } from '@app/specs/render-profile.schema.spec';
import type { RenderProfile, TabRenderProfile } from '@app/specs/render-profile.spec';
import {
  SCREENSHOT_LIMITS,
  ScreenshotEntrySchema,
  ScreenshotRectSchema,
  type ScreenshotEntry,
  type ScreenshotLimits,
  type ScreenshotRefusal,
  type ScreenshotsAnswer,
  type ScreenshotsInput,
  type TakeScreenshotAnswer,
} from '@app/specs/screenshot.schema';
import type { z } from 'zod';
import { storedPageUrl } from '../changes/snapshot';
import { captureArea, captureFullPage, captureViewport, ScreenshotFailure, type CaptureOptions, type Captured, type ScreenshotTarget } from './capture';
import type { ScreenshotImaging } from './imaging';
import type { ScreenshotFiles } from './store';

// Screenshots of the active tab, and reading them back (Phase 6 Task 5; spec `screenshot.spec.ts`,
// `screenshot.schema.ts`; acceptance `screenshot.feature.md`). One screenshot per tab at a time; a
// running one is cancelled by a main-frame navigation, the tab closing, another tab coming to the
// front, or (for an area) `cancelArea`. The PNG is written to the file store first, then its row
// through `@app/db`. The service never rejects: each failure is a refusal and one log line in
// frost's own words (never page text, a URL or a path).

/** A tab's WebContents as the service watches it while a screenshot runs (its `did-start-navigation` and `destroyed` events). */
export interface ScreenshotContents extends ScreenshotTarget, Pick<NodeJS.EventEmitter, 'on' | 'removeListener'> {
  getURL(): string;
  isDestroyed(): boolean;
}

/** What the service needs of the browser. */
export interface ScreenshotTabs {
  activeTabId(): number | null;
  /** The tab's live page WebContents, `null` for an id that names no open tab. */
  contentsOf(tabId: number): ScreenshotContents | null;
  /** The render profile in effect on the tab (`null`: none, or one that failed to apply). */
  renderProfileOf(tabId: number): RenderProfile | null;
}

export type ScreenshotCapturers = Readonly<Record<ScreenshotKind, (target: ScreenshotTarget, options: CaptureOptions) => Promise<Captured>>>;

export interface ScreenshotsServiceDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: ChangeIntelRepository;
  readonly files: ScreenshotFiles;
  readonly tabs: ScreenshotTabs;
  readonly imaging: ScreenshotImaging;
  /** Shows the file in the system's file manager (`shell.showItemInFolder`). */
  readonly reveal: (file: string) => void;
  readonly now?: () => number;
  readonly uuidv7?: (now?: number) => string;
  /** One line per refusal or failed read (never page text, a URL or a path). */
  readonly log?: (message: string) => void;
  /** The search parameters a screenshot of the tab records. */
  readonly searchParamsOf?: (tabId: number) => SearchParams | null;
  readonly limits?: ScreenshotLimits;
  /** How often a running screenshot checks that its tab is still in front (ms). */
  readonly activePollMs?: number;
  /** The kinds' capture (tests replace them). */
  readonly capturers?: Partial<ScreenshotCapturers>;
}

/** A screenshot's options: the IPC passes `kind` and `projectId`; a project's capture run also its capture and the query's search parameters. */
export interface TakeOptions {
  readonly kind: ScreenshotKind;
  readonly projectId?: string;
  readonly captureId?: string;
  readonly searchParams?: SearchParams | null;
}

/** Main's screenshots service: the procedures' (`ScreenshotsService`), with main-internal options on `take`. */
export interface MainScreenshotsService extends ScreenshotsService {
  take(tabId: number, options: TakeOptions): Promise<TakeScreenshotAnswer>;
  /** Tells `listener` of each screenshot saved, with its project (retention enforces the project's policy; `retention.ts`). */
  onSaved(listener: (projectId: string) => void): void;
}

const ACTIVE_POLL_MS = 250;

// TODO(phase-3-merge): the tab's visible search parameters (serp-search-params.schema.ts)
const noSearchParams = (_tabId: number): SearchParams | null => null;

const refused = (reason: ScreenshotRefusal): TakeScreenshotAnswer => ({ status: 'refused', reason });
/** An error's code or name: never its message (a file error's message holds its path, a database error's its parameters). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

/** `json` parsed with `schema`; `undefined` if it does not parse (never throws). */
function parsedJson<T>(schema: z.ZodType<T>, json: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A stored row as the chrome and the read API see it, or `null` when any of its JSON does not read back. */
function entryOf(row: StoredScreenshot): ScreenshotEntry | null {
  const rect = row.rectJson === null ? null : parsedJson(ScreenshotRectSchema, row.rectJson);
  const renderProfile = row.renderProfileJson === null ? null : parsedJson(RenderProfileSchema, row.renderProfileJson);
  const searchParams = row.searchParamsJson === null ? null : parsedJson(SearchParamsSchema, row.searchParamsJson);
  if (rect === undefined || renderProfile === undefined || searchParams === undefined) return null;
  const entry = ScreenshotEntrySchema.safeParse({
    id: row.id,
    projectId: row.projectId,
    pageUrl: row.pageUrl,
    captureId: row.captureId,
    kind: row.kind,
    rect,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    segments: row.segments,
    renderProfile,
    searchParams,
    createdAt: row.createdAt,
  });
  return entry.success ? entry.data : null;
}

/**
 * Screenshots of a page and/or a project, newest first (`screenshots.list`, and the read API's
 * `listScreenshots`): each row parsed with `ScreenshotEntrySchema`, a tampered one skipped. Rejects
 * only when the database does.
 */
export async function readScreenshots(store: ChangeIntelRepository, input: ScreenshotsInput): Promise<ScreenshotsAnswer> {
  const pageUrl = input.url === undefined ? undefined : storedPageUrl(input.url);
  if (pageUrl === null) return { screenshots: [], next: null };
  const found = await store.screenshots({
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    cursor: input.cursor ?? null,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return { screenshots: found.screenshots.map(entryOf).filter((entry): entry is ScreenshotEntry => entry !== null), next: found.next ? { createdAt: found.next.createdAt, id: found.next.id } : null };
}

export function createScreenshotsService(deps: ScreenshotsServiceDeps): MainScreenshotsService {
  const { store, files, tabs, imaging } = deps;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuidv7 ?? defaultUuidv7;
  const log = (message: string): void => deps.log?.(`screenshots: ${message}`);
  const searchParamsOf = deps.searchParamsOf ?? noSearchParams;
  const limits = deps.limits ?? SCREENSHOT_LIMITS;
  const capturers: ScreenshotCapturers = { viewport: captureViewport, full: captureFullPage, area: captureArea, ...deps.capturers };
  let saved: (projectId: string) => void = () => undefined;
  /** The screenshot each tab is taking (one at a time); its `controller` while the page is being captured (it can be cancelled then). */
  const runs = new Map<number, { readonly kind: ScreenshotKind; controller: AbortController | null }>();
  const failed = (reason: ScreenshotRefusal, why: string): TakeScreenshotAnswer => {
    log(`screenshot refused (${reason}): ${why}`);
    return refused(reason);
  };

  /** The JSON the row records of the tab: its render profile in effect and its search parameters (canonical), or why not. */
  const lane = (tabId: number, options: TakeOptions): { renderProfileJson: string | null; searchParamsJson: string | null } | string => {
    const given = options.searchParams !== undefined ? options.searchParams : searchParamsOf(tabId);
    const params = given === null ? null : SearchParamsSchema.safeParse(given);
    if (params !== null && !params.success) return 'its search parameters do not fit their schema';
    const profile = tabs.renderProfileOf(tabId);
    const parsedProfile = profile === null ? null : RenderProfileSchema.safeParse(profile);
    // A profile that does not read back is recorded as none (said in the log); the screenshot is still taken.
    if (parsedProfile !== null && !parsedProfile.success) log('the tab\'s render profile does not fit its schema: recorded as none');
    return { renderProfileJson: parsedProfile?.success ? canonicalJson(parsedProfile.data) : null, searchParamsJson: params === null ? null : canonicalJson(params.data) };
  };

  async function takeTab(tabId: number, options: TakeOptions, run: { controller: AbortController | null }): Promise<TakeScreenshotAnswer> {
    const contents = tabs.contentsOf(tabId);
    if (!contents || contents.isDestroyed()) return refused('no-tab');
    if (tabs.activeTabId() !== tabId) return refused('not-active');
    const page = storedPageUrl(contents.getURL());
    if (page === null) return refused('no-page');
    const projectId = options.projectId ?? UNFILED_PROJECT_ID;
    try {
      if ((await store.project(projectId)) === null) return refused('no-project');
    } catch (error) {
      return failed('store-failed', `the project could not be read (${codeOf(error)})`);
    }
    if (options.captureId !== undefined && !isUuidv7(options.captureId)) return failed('store-failed', 'its capture id is not one');
    const recorded = lane(tabId, options);
    if (typeof recorded === 'string') return failed('store-failed', recorded);

    // Taken while the tab stays on this page (any main-frame navigation, an in-page one too, would
    // record it under a URL it no longer shows) and in front; anything else cancels it.
    const controller = new AbortController();
    const cancel = (): void => controller.abort('cancelled');
    const onNavigate = (details?: { isMainFrame?: unknown }): void => {
      if (details?.isMainFrame === true) cancel();
    };
    const onDestroyed = (): void => cancel();
    // While an area is selected, Esc is heard by main before the page gets it, so a page cannot keep
    // its own Esc from cancelling.
    const onKey = (event: { preventDefault(): void } | undefined, input?: { type?: unknown; key?: unknown }): void => {
      if (options.kind !== 'area' || input?.type !== 'keyDown' || input.key !== 'Escape') return;
      event?.preventDefault();
      cancel();
    };
    contents.on('did-start-navigation', onNavigate);
    contents.on('destroyed', onDestroyed);
    contents.on('before-input-event', onKey);
    const poll = setInterval(() => {
      if (contents.isDestroyed() || tabs.activeTabId() !== tabId) cancel();
    }, deps.activePollMs ?? ACTIVE_POLL_MS);
    run.controller = controller;
    let captured: Captured;
    try {
      captured = await capturers[options.kind](contents, { signal: controller.signal, limits });
    } catch (error) {
      if (error instanceof ScreenshotFailure) return error.reason === 'cancelled' ? refused('cancelled') : failed(error.reason, error.message);
      return failed('capture-failed', `the capture failed (${codeOf(error)})`);
    } finally {
      clearInterval(poll);
      contents.removeListener('did-start-navigation', onNavigate);
      contents.removeListener('destroyed', onDestroyed);
      contents.removeListener('before-input-event', onKey);
      run.controller = null;
    }

    let png: Buffer;
    try {
      png = imaging.encodePng(captured.bitmap);
    } catch (error) {
      return failed('capture-failed', `the image could not be encoded (${codeOf(error)})`);
    }
    if (png.length > limits.maxPngBytes) return failed('too-large', `its PNG is ${png.length} bytes`);
    // The hash's lock, held until its row is written: the write may reuse a file no row names yet, and
    // a purge or the orphan sweep must not unlink it in between (`store.ts`, `lock`).
    const release = await files.lock(createHash('sha256').update(png).digest('hex'));
    let file: { sha256: string; bytes: number };
    try {
      file = await files.write(png);
    } catch (error) {
      release();
      return failed('store-failed', `the file could not be written (${codeOf(error)})`);
    }
    // Its thumbnail, made now from the bitmap in hand (no decode later) and kept in memory.
    try {
      remember(file.sha256, dataUrl('image/png', imaging.thumbnail(captured.bitmap)));
    } catch (error) {
      log(`the thumbnail could not be made (${codeOf(error)})`);
    }
    const at = now();
    const id = uuid(at);
    const { width, height } = captured.bitmap;
    let stored = false;
    try {
      stored = await store.appendScreenshot({
        id,
        projectId,
        pageUrl: page,
        captureId: options.captureId ?? null,
        kind: options.kind,
        rectJson: captured.rect === null ? null : canonicalJson(captured.rect),
        width,
        height,
        bytes: file.bytes,
        sha256: file.sha256,
        segments: captured.segments,
        ...recorded,
        createdAt: at,
      });
    } catch (error) {
      log(`the row could not be written (${codeOf(error)})`);
    } finally {
      release();
    }
    // The file stays when its row is not written: the orphan sweep (Task 7) removes files no row names
    // (another row may already name this one, so it is never unlinked here).
    if (!stored) {
      const gone = await store.project(projectId).then(
        (project) => project === null,
        () => false,
      );
      return gone ? refused('no-project') : failed('store-failed', 'the store refused the row');
    }
    saved(projectId);
    return { status: 'saved', id, kind: options.kind, width, height, bytes: file.bytes, truncated: captured.truncated };
  }

  /** `run`'s answer, or `fallback` (logged) when it throws. */
  const guarded = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      log(`${what} failed (${codeOf(error)})`);
      return fallback;
    }
  };
  /** A stored screenshot's PNG and hash, if its row reads back and its file matches its hash. */
  const pngOf = async (id: string): Promise<{ png: Buffer; sha256: string } | null> => {
    const row = await store.screenshot(id);
    const png = row ? await files.read(row.sha256) : null;
    return row && png ? { png, sha256: row.sha256 } : null;
  };
  /** The largest image `data:` URLs carry (`maxImageDataUrlChars`, less the prefix, as base64). */
  const maxImageBytes = Math.floor(((limits.maxImageDataUrlChars - 32) * 3) / 4);
  const dataUrl = (type: string, data: Buffer): string => `data:${type};base64,${data.toString('base64')}`;
  /** Thumbnails by file hash, most recently used last (at most `thumbnailCacheEntries`). */
  const thumbnails = new Map<string, string>();
  const remember = (sha256: string, url: string): void => {
    if (url.length > limits.maxImageDataUrlChars) return;
    thumbnails.delete(sha256);
    thumbnails.set(sha256, url);
    while (thumbnails.size > limits.thumbnailCacheEntries) thumbnails.delete(thumbnails.keys().next().value!);
  };

  return {
    onSaved: (listener) => void (saved = listener),
    async take(tabId, options) {
      if (runs.has(tabId)) return refused('busy');
      // Held from here until its row is written, so a second take of the tab meanwhile is busy.
      const run: { readonly kind: ScreenshotKind; controller: AbortController | null } = { kind: options.kind, controller: null };
      runs.set(tabId, run);
      try {
        return await takeTab(tabId, options, run);
      } catch (error) {
        // Nothing above throws past its own handling; this keeps "never rejects" true regardless.
        return failed('capture-failed', `the screenshot failed (${codeOf(error)})`);
      } finally {
        runs.delete(tabId);
      }
    },

    list: (input) => guarded('list', () => readScreenshots(store, input), { screenshots: [], next: null }),

    image: (id, size) =>
      guarded(
        'image',
        async () => {
          // The file is checked against its hash every time; only a thumbnail's decoding is saved.
          const stored = await pngOf(id);
          if (stored === null) return null;
          const known = size === 'thumb' ? thumbnails.get(stored.sha256) : undefined;
          if (known !== undefined) {
            remember(stored.sha256, known);
            return known;
          }
          const rendered = imaging.render(stored.png, size, maxImageBytes);
          if (rendered === null) return null;
          const url = dataUrl(rendered.type, rendered.data);
          if (url.length > limits.maxImageDataUrlChars) return null;
          if (size === 'thumb') remember(stored.sha256, url);
          return url;
        },
        null,
      ),

    reveal: (id) =>
      guarded(
        'reveal',
        async () => {
          const row = await store.screenshot(id);
          if (!row || !(await files.has(row.sha256))) return false;
          deps.reveal(files.fileFor(row.sha256));
          return true;
        },
        false,
      ),

    copy: (id) =>
      guarded(
        'copy',
        async () => {
          const stored = await pngOf(id);
          return stored !== null && (await imaging.copy(stored.png));
        },
        false,
      ),

    async cancelArea(tabId) {
      const controller = runs.get(tabId)?.kind === 'area' ? runs.get(tabId)!.controller : null;
      if (!controller || controller.signal.aborted) return false;
      controller.abort('cancelled');
      return true;
    },
  };
}

/** `ScreenshotTabs` over the browser controller's state and main's map of tab WebContents (`contentsOf`). */
export function screenshotTabs(
  browser: { getState(): { readonly activeTabId: number | null; readonly tabs: readonly { readonly id: number; readonly renderProfile: TabRenderProfile | null }[] } },
  contentsOf: (tabId: number) => ScreenshotContents | null,
): ScreenshotTabs {
  return {
    activeTabId: () => browser.getState().activeTabId,
    contentsOf,
    renderProfileOf: (tabId) => {
      const profile = browser.getState().tabs.find((tab) => tab.id === tabId)?.renderProfile ?? null;
      return profile && profile.status !== 'failed' ? profile.profile : null;
    },
  };
}
