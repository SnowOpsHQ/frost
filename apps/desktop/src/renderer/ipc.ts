import type { AppRouter } from '@app/ipc-contract';
import { createIpcClient } from '@app/ipc-contract/renderer';
import type { LinkFilter } from '@app/seo-core';
import type { SeoAuditRef } from '@app/ipc-contract';
import type { CopyValueKey, OpenInTemplateId } from '@app/specs/command-palette.spec';
import type { PageCommand } from '@app/specs/page-commands.spec';
import type { PermissionDecision } from '@app/specs/permissions.spec';
import type { RenderProfile, TabOverrides } from '@app/specs/render-profile.spec';
import type { HighlightMode, ImageFilter } from '@app/specs/seo-sidebar.spec';
import type { SeoExportKind } from '@app/specs/seo-exports.spec';
import type { HistoryCursorAnswer, HistoryPageAnswer, HistoryRetentionAnswer, JumpBackInAnswer } from '@app/ipc-contract';
import type { HistoryClearRange, HistoryRetentionResult, SearchEngineId } from '@app/specs/browser-polish.spec';
import type { CompareAnswer, CopyCsvAnswer, RankCsvKind, RankRange, RankSeriesAnswer, RankTableAnswer, ReadingDatesAnswer, SaveCsvAnswer } from '@app/specs/rankings.spec';
import type { AddCompetitorAnswer, BulkAddAnswer, BulkSearchesInput, ProjectChangeAnswer, SetSiteAnswer, SetTagsAnswer } from '@app/specs/projects.spec';
import type { CaptureCadence, EntryKind } from '@app/specs/workspace-db.spec';

// The chrome's one IPC client (the sender-guarded `browser.*` and `seo.*` procedures, `ping`) and
// the user intents it sends. All browser state, and every SEO audit, lives in main. The chrome never
// touches the system clipboard itself: "Copy" commands ask main to write it.

export const ipc = createIpcClient<AppRouter>();

function ignore(): void {}

export const actions = {
  /** Resolves whether a navigation started (`false` on a no-op or an IPC failure). */
  navigate: (input: string) => ipc.browser.navigate.mutate({ input }).catch(() => false),
  newTab: () => ipc.browser.newTab.mutate().catch(ignore),
  closeTab: (tabId: number) => ipc.browser.closeTab.mutate({ tabId }).catch(ignore),
  activateTab: (tabId: number) => ipc.browser.activateTab.mutate({ tabId }).catch(ignore),
  back: () => ipc.browser.back.mutate().catch(ignore),
  forward: () => ipc.browser.forward.mutate().catch(ignore),
  reload: () => ipc.browser.reload.mutate().catch(ignore),
  stop: () => ipc.browser.stop.mutate().catch(ignore),
  answerPermission: (promptId: string, decision: PermissionDecision) => ipc.browser.answerPermission.mutate({ promptId, decision }).catch(ignore),
  setPageBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipc.browser.setPageBounds.mutate(bounds).catch(ignore),
  /** Audits the tab again (`seo.rerun`). */
  rerunAudit: (tabId: number) => ipc.seo.rerun.mutate({ tabId }).catch(ignore),
  /** Opens an `http(s)` URL from a panel in a background tab (main checks the scheme); resolves the tab's id or `null`. */
  openBackgroundTab: (url: string, options: { readonly inherit?: boolean } = {}) => ipc.browser.openBackgroundTab.mutate({ url, ...(options.inherit === true ? { inherit: true } : {}) }).catch(() => null),
  /** Sets the tab's highlight overlay (`seo.setHighlight`; `phrase` only for `keyphrase`); resolves whether it was set. */
  setHighlight: (tabId: number, mode: HighlightMode, phrase?: string) => ipc.seo.setHighlight.mutate(phrase === undefined ? { tabId, mode } : { tabId, mode, phrase }).catch(() => false),
  /** Copies the filtered links of the audit on screen as CSV through main's clipboard; resolves how many rows (`null`: nothing copied). */
  copyLinksCsv: (tabId: number, audit: SeoAuditRef, filter: LinkFilter) => ipc.seo.copyLinksCsv.mutate({ tabId, audit, filter }).catch(() => null),
  /** Copies a URL the audit on screen lists through main's clipboard; resolves whether it was copied. */
  copyUrl: (tabId: number, audit: SeoAuditRef, url: string) => ipc.seo.copyUrl.mutate({ tabId, audit, url }).catch(() => false),
  /** Copies one JSON-LD block of the audit on screen through main's clipboard (main formats it); resolves whether it was copied. */
  copySchemaJson: (tabId: number, audit: SeoAuditRef, block: number) => ipc.seo.copySchemaJson.mutate({ tabId, audit, block }).catch(() => false),
  /**
   * Copies a table of the audit on screen as CSV through main's clipboard (`seoExport.copyCsv`, Phase 11
   * Task 1): images (with the panel's filter), headings, or the audit's speed report; resolves how many rows (`null`: main
   * wrote nothing, the audit changed; `'failed'`: the IPC call failed).
   */
  copySeoCsv: (tabId: number, audit: SeoAuditRef, kind: SeoExportKind, filter?: ImageFilter): Promise<number | null | 'failed'> =>
    ipc.seoExport.copyCsv.mutate({ tabId, audit, kind, ...(filter === undefined ? {} : { filter }) }).catch(() => 'failed' as const),
  /** Measures the active tab's page speed (`seo.measureSpeed`); resolves its answer, `null` on an IPC failure. */
  measureSpeed: (tabId: number) => ipc.seo.measureSpeed.mutate({ tabId }).catch(() => null),
  /** Starts the accessibility check on the tab's page (`seo.runAccessibility`); resolves whether one is running. */
  runAccessibility: (tabId: number) => ipc.seo.runAccessibility.mutate({ tabId }).catch(() => false),
  // The command palette's (`command-palette.feature.md`).
  /** Runs a page command (zoom …) on the active tab, as its menu item does. */
  pageCommand: (command: PageCommand) => ipc.browser.pageCommand.mutate({ command }).catch(ignore),
  /** Gives focus back to the active tab's page; resolves whether a page took it. */
  focusPage: () => ipc.browser.focusPage.mutate().catch(() => false),
  /** The menu's Clear Browsing Data… (main asks first). */
  clearBrowsingData: () => ipc.browser.clearBrowsingData.mutate().catch(ignore),
  /** Copies one allowlisted value of the audit on screen through main's clipboard; resolves whether it was copied. */
  copyValue: (tabId: number, audit: SeoAuditRef, key: CopyValueKey) => ipc.seo.copyValue.mutate({ tabId, audit, key }).catch(() => false),
  /** "Open in" a tool: main builds the URL and may refuse (`OpenToolResult`); `null` on an IPC failure. */
  openTool: (tool: OpenInTemplateId) => ipc.browser.openTool.mutate({ tool }).catch(() => null),
  /** Sets the tab's render profile (`pin`: as this site's pin); resolves whether it was set (`render-profile.feature.md`). */
  setRenderProfile: (tabId: number, profile: RenderProfile, pin?: boolean) => ipc.browser.setRenderProfile.mutate({ tabId, profile, ...(pin === undefined ? {} : { pin }) }).catch(() => false),
  /** Reset: the tab's render profile and this site's pin go; resolves whether it had one. */
  clearRenderProfile: (tabId: number) => ipc.browser.clearRenderProfile.mutate({ tabId }).catch(() => false),
  /** Sets the tab's overrides (CSS off, cookies off, location; all off: normal); resolves whether it was set (Phase 11 Task 6). */
  setTabOverrides: (tabId: number, overrides: TabOverrides) => ipc.tabOverrides.set.mutate({ tabId, overrides }).catch(() => false),
  // Browser polish (`browser-polish.feature.md`): find in page, history, reopen tab, search engine.
  /** Opens the active tab's find bar (as Mod+F). */
  openFind: () => ipc.find.open.mutate().catch(ignore),
  /** Runs `text` in the tab's find bar (main calls `findInPage`); resolves whether its bar was open. */
  findSearch: (tabId: number, text: string, matchCase: boolean) => ipc.find.search.mutate({ tabId, text, matchCase }).catch(() => false),
  findStep: (tabId: number, forward: boolean) => ipc.find.step.mutate({ tabId, forward }).catch(() => false),
  closeFind: (tabId: number) => ipc.find.close.mutate({ tabId }).catch(() => false),
  /** One page of history; an empty one on an IPC failure. */
  historyList: (query: string, after: HistoryCursorAnswer | null, projectId?: string): Promise<HistoryPageAnswer> =>
    ipc.history.list.query({ query, after, ...(projectId === undefined ? {} : { projectId }) }).catch(() => ({ visits: [], next: null })),
  jumpBackIn: (): Promise<JumpBackInAnswer> => ipc.history.jumpBackIn.query().catch(() => ({ mostVisited: [], recent: [] })),
  removeVisit: (url: string) => ipc.history.remove.mutate({ url }).catch(() => false),
  /** "Clear all history" (main asks first); resolves whether it cleared. */
  clearHistory: () => ipc.history.clearAll.mutate().catch(() => false),
  /** Clear by range (Phase 11 Task 10; main asks first); resolves whether it cleared. */
  clearHistoryRange: (range: HistoryClearRange) => ipc.history.clearRange.mutate({ range }).catch(() => false),
  /** The history retention settings; `null` on an IPC failure. */
  historyRetention: (): Promise<HistoryRetentionAnswer | null> => ipc.history.retention.query().catch(() => null),
  /** Stores the history retention settings (main asks first when visits would go, then applies them); `failed` on an IPC failure. */
  setHistoryRetention: (settings: HistoryRetentionAnswer): Promise<HistoryRetentionResult> => ipc.history.setRetention.mutate(settings).catch(() => 'failed' as const),
  /** The live projects, for the History view's filter; none on an IPC failure. */
  listProjects: () => ipc.projects.list.query().then((answer) => answer.projects).catch(() => []),
  reopenClosedTab: () => ipc.history.reopenClosedTab.mutate().catch(() => null),
  showHistory: () => ipc.history.show.mutate().catch(ignore),
  setSearchEngine: (engine: SearchEngineId) => ipc.settings.setSearchEngine.mutate({ engine }).catch(() => false),
};

/**
 * The Rankings and Compare views' procedures (`rankings.*`; acceptance `rankings.feature.md`, The
 * views). Each resolves `null` on an IPC failure (the views say it as `store-failed`); none names a
 * path: Save CSV… asks in main's own dialog.
 */
export const rankingsActions = {
  table: (input: { projectId: string; range: RankRange; tag?: string }): Promise<RankTableAnswer | null> => ipc.rankings.table.query(input).catch(() => null),
  series: (projectId: string, searchKey: string, range: RankRange): Promise<RankSeriesAnswer | null> => ipc.rankings.series.query({ projectId, searchKey, range }).catch(() => null),
  readingDates: (projectId: string, searchKey: string): Promise<ReadingDatesAnswer | null> => ipc.rankings.readingDates.query({ projectId, searchKey }).catch(() => null),
  compare: (projectId: string, a: string, b: string): Promise<CompareAnswer | null> => ipc.rankings.compare.query({ projectId, a, b }).catch(() => null),
  copyCsv: (projectId: string, kind: RankCsvKind, range: RankRange, tag: string | null): Promise<CopyCsvAnswer> => ipc.rankings.copyCsv.mutate({ projectId, kind, range, ...(tag === null ? {} : { tag }) }).catch(() => null),
  saveCsv: (projectId: string, kind: RankCsvKind, range: RankRange, tag: string | null): Promise<SaveCsvAnswer | null> => ipc.rankings.saveCsv.mutate({ projectId, kind, range, ...(tag === null ? {} : { tag }) }).catch(() => null),
};

/**
 * The project workspace's procedures (`projects.*`, Phase 10 Task 4; the sheet's star, Settings, tag
 * editor and Bulk add, acceptance `projects.feature.md`, The sheet). Each resolves `null` on an IPC
 * failure (the sheet says "Something went wrong"); main reads every domain and tag again.
 */
export const projectsActions = {
  setFavorite: (projectId: string, favorite: boolean): Promise<ProjectChangeAnswer | null> => ipc.projects.setFavorite.mutate({ projectId, favorite }).catch(() => null),
  setSite: (projectId: string, domain: string | null, subdomains: boolean): Promise<SetSiteAnswer | null> => ipc.projects.setSite.mutate({ projectId, domain, subdomains }).catch(() => null),
  addCompetitor: (projectId: string, domain: string): Promise<AddCompetitorAnswer | null> => ipc.projects.addCompetitor.mutate({ projectId, domain }).catch(() => null),
  removeCompetitor: (projectId: string, competitorId: string): Promise<ProjectChangeAnswer | null> => ipc.projects.removeCompetitor.mutate({ projectId, competitorId }).catch(() => null),
  setTags: (projectId: string, entryKind: EntryKind, entryId: string, tags: readonly string[]): Promise<SetTagsAnswer | null> => ipc.projects.setTags.mutate({ projectId, entryKind, entryId, tags: [...tags] }).catch(() => null),
  addSearches: (projectId: string, searches: BulkSearchesInput): Promise<BulkAddAnswer | null> =>
    ipc.projects.addSearches.mutate({ projectId, searches: { ...searches, locales: [...searches.locales], devices: [...searches.devices], tags: [...searches.tags] } }).catch(() => null),
  // Phase 10 Task 8: main may ask the rank run disclosure before a cadence is first set.
  setCadence: (projectId: string, cadence: CaptureCadence): Promise<ProjectChangeAnswer | null> => ipc.projects.setCadence.mutate({ projectId, cadence }).catch(() => null),
  setAutoCapture: (projectId: string, on: boolean): Promise<ProjectChangeAnswer | null> => ipc.projects.setAutoCapture.mutate({ projectId, on }).catch(() => null),
  /** Check rankings: a run of the saved searches only, without screenshots (main asks the disclosure first when it must). */
  checkRankings: (projectId: string) => ipc.projects.startRun.mutate({ projectId, screenshot: false, scope: 'searches' }).catch(() => null),
};
