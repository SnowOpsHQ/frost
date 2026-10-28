import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { webContents as electronWebContents, type WebContents } from 'electron';
import type { SerpReadApi, SerpService } from '@app/ipc-contract';
import type { BrowserState } from '@app/specs/browser.spec';
import type { BoundedFetcher } from '@app/specs/fetcher.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { SERP_E2E_PACK_KEY_SWITCH, SERP_E2E_PACK_URL_SWITCH, SERP_PACK_DIR, SERP_PACK_PUBLIC_KEYS, SERP_PACK_REMOTE_URL } from '@app/specs/serp-selector-pack.spec';
import { SERP_DEVICE_OF_PRESET } from '@app/specs/serp.spec';
import type { IntentClassifier } from '../intent/classifier';
import { createIntent } from '../intent/setup';
import type { AnalysisWorker } from '../seo/analysis';
import { BUNDLED_PACK } from './bundled';
import { runOutline, watchOutline } from './outline';
import { boundedPackFetch, createPackStore, fileStorage, type PackFiles } from './pack-store';
import { createProbeParser } from './probe-parser';
import { createProbes } from './probes';
import { runSerpRead } from './read-script';
import { createSerpAnalyzer } from './serp-analyzer';
import { createSerpService, type Serp, type SerpTabs } from './service';

// Wires the SERP overlay for main (spec `serp-service.spec.ts`; acceptance `serp-overlay.feature.md`,
// Setup), called once from `main/index.ts` when the browse session and the fetcher lanes exist:
// - the selector pack store: the bundled pack (verified now), a stored remote pack in
//   `userData/SERP_PACK_DIR` (verified again by `load()`, at once), and updates through the bounded
//   fetcher's `checks` lane, only on the user's "Check for selector updates". In unpackaged builds
//   only, `--frost-e2e-serp-pack-url` replaces the remote URL (`http:` allowed, for the store and its
//   fetch) and `--frost-e2e-serp-pack-key` adds a trusted key (packaged builds refuse both switches
//   at startup and never read them here);
// - the SERP analysis worker (`serp-analysis.cjs`, `worker_threads`, a capped heap, as the SEO
//   workers);
// - on-device intent (`createIntent`, the `checks` lane for the user's download; its e2e fake switch
//   is honoured there);
// - the reader and the outlines, in each tab's isolated SERP world;
// - the visibility probes (Task 5, `visibility-probes.spec.ts`): the `checks` lane, main's robots.txt
//   fetcher (`robots`, the `audit` lane's cache) and a SERP worker of their own for the parse
//   (`probe-parser.ts`), joined into the service and the read API; a run is cancelled by its tab's
//   new document, in-page move or close, and by Clear Browsing Data;
// - each browse-session tab's page events (`did-finish-load`, `did-navigate`, `did-navigate-in-page`,
//   `destroyed`), subscribed from `web-contents-created` here (and for any tab already open), so
//   `main/index.ts` holds only the registration lines;
// - disposal on `will-quit`.

/** The parts of Electron's `app` the setup uses. */
export interface SerpSetupApp {
  readonly isPackaged: boolean;
  on(event: 'web-contents-created', listener: (event: unknown, contents: WebContents) => void): unknown;
  once(event: 'will-quit', listener: () => void): unknown;
}

/** The parts of main's browser controller the setup reads (never changes). */
export interface SerpSetupBrowser {
  tabIdOf(contents: unknown): number | null;
  getState(): BrowserState;
}

export interface SerpSetupOptions {
  readonly app: SerpSetupApp;
  readonly browser: SerpSetupBrowser;
  /** Whether a WebContents is a tab's (the browse session's); fails closed. */
  readonly isBrowseContents: (contents: WebContents) => boolean;
  /** The bounded fetcher's lanes (`createFetcherLanes`): pack updates, the model download and the probes use `checks`. */
  readonly fetchers: { readonly checks: BoundedFetcher };
  /** Main's robots.txt fetcher (`RobotsFetcher.get`, cached per origin): the probes ask it once per run. */
  readonly robots: (pageUrl: string) => Promise<RobotsFetch | null>;
  readonly userData: string;
  /** `app.commandLine`. */
  readonly switches: { hasSwitch(name: string): boolean; getSwitchValue(name: string): string };
  readonly log: (message: string) => void;
  /** Test seams: the analysis and probe workers, the classifier, the bundled pack and the WebContents already open. */
  readonly spawnAnalysis?: () => AnalysisWorker;
  readonly spawnProbes?: () => AnalysisWorker;
  readonly classifier?: IntentClassifier;
  readonly bundled?: PackFiles;
  readonly openContents?: () => readonly WebContents[];
}

export interface SerpSetup {
  /** For the IPC services (`serp`). */
  readonly service: SerpService;
  /** For Phase 5's agent tools. */
  readonly readApi: SerpReadApi;
  /** Clear Browsing Data: every reading, outline and intent answer goes, and every probe run is cancelled. */
  onClearBrowsingData(): void;
  /** Watches a browse-session tab's page (anything else is ignored; done for every new WebContents already). */
  watchContents(contents: WebContents): void;
  /** Stops the service, the probes, the analysis and probe workers and the intent process (run on `will-quit`). */
  dispose(): void;
}

/** The e2e seams, read only by unpackaged builds: the pack URL (and whether `http:` is allowed) and the trusted keys. */
export function serpPackSeams(options: Pick<SerpSetupOptions, 'app' | 'switches'>): { url: string; allowHttp: boolean; publicKeys: readonly string[] } {
  if (options.app.isPackaged) return { url: SERP_PACK_REMOTE_URL, allowHttp: false, publicKeys: SERP_PACK_PUBLIC_KEYS };
  const url = options.switches.hasSwitch(SERP_E2E_PACK_URL_SWITCH) ? options.switches.getSwitchValue(SERP_E2E_PACK_URL_SWITCH).trim() : '';
  const key = options.switches.hasSwitch(SERP_E2E_PACK_KEY_SWITCH) ? options.switches.getSwitchValue(SERP_E2E_PACK_KEY_SWITCH).trim() : '';
  return { url: url === '' ? SERP_PACK_REMOTE_URL : url, allowHttp: url !== '', publicKeys: key === '' ? SERP_PACK_PUBLIC_KEYS : [...SERP_PACK_PUBLIC_KEYS, key] };
}

export function setupSerp(options: SerpSetupOptions): SerpSetup {
  const { app, browser, log } = options;
  const seams = serpPackSeams(options);
  const packs = createPackStore({
    bundled: options.bundled ?? BUNDLED_PACK,
    publicKeys: seams.publicKeys,
    storage: fileStorage(path.join(options.userData, SERP_PACK_DIR)),
    fetchPack: boundedPackFetch(options.fetchers.checks, { allowHttp: seams.allowHttp }),
    url: seams.url,
    allowHttp: seams.allowHttp,
    log,
  });
  // The page-derived answer is validated and analysed off this thread, in a worker of the SERP's own.
  const analyzer = createSerpAnalyzer({
    spawn: options.spawnAnalysis ?? (() => new Worker(path.join(__dirname, 'serp-analysis.cjs'), { resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } })),
  });
  // The probes' bodies (up to 5 MB each) are parsed in another instance of the same worker, with a
  // heap fit for two bounded parses, so a slow page never holds a SERP reading back.
  const probeParser = createProbeParser({
    spawn: options.spawnProbes ?? (() => new Worker(path.join(__dirname, 'serp-analysis.cjs'), { resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } })),
  });
  const classifier = options.classifier ?? createIntent({ userData: options.userData, fetcher: options.fetchers.checks, isPackaged: app.isPackaged, switches: { has: (name) => options.switches.hasSwitch(name) }, log });

  // The tabs' pages, by WebContents id (browse-session tabs only).
  const pages = new Map<number, WebContents>();
  const tabs: SerpTabs = {
    tab(tabId) {
      const state = browser.getState();
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return null;
      const contents = [...pages.values()].find((candidate) => !candidate.isDestroyed() && browser.tabIdOf(candidate) === tabId);
      if (!contents) return null;
      const profile = tab.renderProfile;
      const preset = profile && profile.status !== 'failed' ? profile.profile.device : 'none';
      return { contentsId: contents.id, url: contents.getURL(), documentSeq: tab.documentSeq, loading: tab.loading, device: SERP_DEVICE_OF_PRESET[preset], page: contents };
    },
    tabOf(contentsId) {
      const contents = pages.get(contentsId);
      return contents && !contents.isDestroyed() ? browser.tabIdOf(contents) : null;
    },
    activeTabId: () => browser.getState().activeTabId,
  };
  /** A page that is gone is never scripted (its promise rejects instead). */
  const alive = (page: unknown): WebContents => {
    const contents = page as WebContents;
    if (contents.isDestroyed()) throw new Error('the page is gone');
    return contents;
  };
  const serp: Serp = createSerpService({
    packs,
    analyzer,
    read: async (page, layout) => runSerpRead(alive(page), layout),
    outline: { paint: async (page, layout, expectedUrl) => runOutline(alive(page), layout, expectedUrl), ended: async (page) => watchOutline(alive(page)) },
    classifier,
    tabs,
    log,
  });
  // The visibility probes: only on the user's "Run visibility probes", for the active tab.
  const probes = createProbes({
    fetcher: options.fetchers.checks,
    robots: options.robots,
    parse: (job) => probeParser.run(job),
    tab: (tabId) => {
      const tab = tabs.tab(tabId);
      return tab ? { contentsId: tab.contentsId, url: tab.url, active: tabs.activeTabId() === tabId } : null;
    },
    log,
  });
  const service: SerpService = { ...serp, runProbes: probes.run, stopProbes: probes.stop, probes: probes.state, watchProbes: probes.watch };
  const readApi: SerpReadApi = { ...serp.readApi, probes: probes.state, runProbes: probes.run };
  // The stored remote pack, verified again at every start (never fetched here).
  void packs.load().catch((error: unknown) => log(`serp: the stored selector pack could not be loaded: ${error instanceof Error ? error.message : String(error)}`));

  const watchContents = (contents: WebContents): void => {
    if (pages.has(contents.id) || !options.isBrowseContents(contents)) return;
    const id = contents.id;
    pages.set(id, contents);
    contents.on('did-finish-load', () => serp.loaded(id));
    contents.on('did-navigate', () => {
      serp.navigated(id);
      probes.dropped(id);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      serp.navigatedInPage(id, url);
      probes.navigatedInPage(id, url);
    });
    contents.once('destroyed', () => {
      pages.delete(id);
      serp.closed(id);
      probes.dropped(id);
    });
  };
  app.on('web-contents-created', (_event, contents) => watchContents(contents));
  for (const contents of (options.openContents ?? (() => electronWebContents.getAllWebContents()))()) {
    if (!contents.isDestroyed()) watchContents(contents);
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    serp.dispose();
    probes.dispose();
    analyzer.dispose();
    probeParser.dispose();
    classifier.dispose();
  };
  app.once('will-quit', dispose);

  const onClearBrowsingData = (): void => {
    serp.forget();
    // Nothing a run fetches afterwards is kept (as the checks, seo-checks.feature.md).
    probes.cancelAll();
  };
  return { service, readApi, onClearBrowsingData, watchContents, dispose };
}
