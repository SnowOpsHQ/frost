import { TRPCError } from '@trpc/server';
import {
  AnswerPermissionInputSchema,
  BrowserStateSchema,
  NavigateInputSchema,
  OpenBackgroundTabInputSchema,
  PageBoundsSchema,
  TabIdInputSchema,
  WATCH_TIMEOUT_MS,
  WatchInputSchema,
  type BrowserState,
} from '@app/specs/browser.spec';
import { OpenToolInputSchema, PageCommandInputSchema, SeoCopyValueInputSchema } from '@app/specs/command-palette.schema';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { ClearRenderProfileInputSchema, SetRenderProfileInputSchema } from '@app/specs/render-profile.schema.spec';
import { SeoCopySchemaInputSchema, SeoCopyUrlInputSchema, SeoHighlightInputSchema, SeoLinksCsvInputSchema, SeoTabInputSchema } from '@app/specs/seo-snapshot.spec';
import { checksRouter } from './checks-router';
import { contentRouter } from './content-router';
import { javascriptRouter } from './javascript-router';
import { devtoolsRouter } from './devtools-router';
import { findRouter, historyRouter, settingsRouter } from './polish-router';
import { serpRouter } from './serp-router';
import type { BrowserService } from './services';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Every procedure starts `publicProcedure.use(enforceSender)` (spec `ipc-sender.feature.md`,
// `every-procedure-enforces-sender`; Semgrep `ipc-sender-guard` in Task 5).

/**
 * Hands the procedure main's `BrowserService` (from the IPC context). Chained after
 * `enforceSender`, so a rejected sender never reaches it; a context without the service fails
 * with a masked internal error.
 */
const requireBrowser = middleware(({ ctx, next }) => {
  const browser = ctx.services?.browser;
  if (!browser) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'browser service unavailable' });
  return next({ ctx: { ...ctx, browser } });
});

/** Hands the procedure main's `SeoService`, like `requireBrowser` (after `enforceSender`; fails closed). */
const requireSeo = middleware(({ ctx, next }) => {
  const seo = ctx.services?.seo;
  if (!seo) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'seo service unavailable' });
  return next({ ctx: { ...ctx, seo } });
});

/**
 * The long-poll behind `browser.watch` (spec `WATCH_TIMEOUT_MS`): the current state at once if it
 * is newer than `sinceVersion`, else the state from the service's next change, or the current
 * state after `WATCH_TIMEOUT_MS`. Either way the timer is cleared and the service's waiter released.
 */
async function watchState(browser: BrowserService, sinceVersion: number): Promise<BrowserState> {
  const current = browser.getState();
  if (current.version > sinceVersion) return current;
  // A version from the future (a stale or forged poll) waits for the next change, not forever.
  const since = Math.min(sinceVersion, current.version);
  const release = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      browser.watch(since, release.signal),
      new Promise<BrowserState>((resolve) => {
        timer = setTimeout(() => resolve(browser.getState()), WATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release.abort();
  }
}

/**
 * Browser chrome ↔ main (spec `browser-chrome.feature.md`, `tabs.feature.md` and
 * `permissions.feature.md`, Router). `navigate` answers whether a navigation started; `newTab` the
 * new tab's id (`null` at `MAX_TABS`); `closeTab` / `activateTab` whether the id named an open
 * tab; `openBackgroundTab` the new background tab's id (`null` when nothing opened);
 * `answerPermission` whether the id was the active tab's prompt; the other mutations answer
 * `null`.
 * `navigate`, `back`, `forward`, `reload` and `stop` act on the active tab.
 */
const browserRouter = router({
  navigate: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(NavigateInputSchema)
    .mutation(({ ctx, input }) => ctx.browser.navigate(input.input) === true),
  newTab: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => ctx.browser.newTab()),
  closeTab: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(TabIdInputSchema)
    .mutation(({ ctx, input }) => ctx.browser.closeTab(input.tabId) === true),
  activateTab: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(TabIdInputSchema)
    .mutation(({ ctx, input }) => ctx.browser.activateTab(input.tabId) === true),
  openBackgroundTab: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(OpenBackgroundTabInputSchema)
    .mutation(({ ctx, input }) => {
      // Render profiles (`render-profile.feature.md`, Popups): only a page of the audited site inherits.
      const id = ctx.browser.openBackgroundTab(input.url, input.inherit === true);
      return typeof id === 'number' ? id : null;
    }),
  back: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => {
      ctx.browser.back();
      return null;
    }),
  forward: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => {
      ctx.browser.forward();
      return null;
    }),
  reload: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => {
      ctx.browser.reload();
      return null;
    }),
  stop: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => {
      ctx.browser.stop();
      return null;
    }),
  setPageBounds: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(PageBoundsSchema)
    .mutation(({ ctx, input }) => {
      ctx.browser.setPageBounds(input);
      return null;
    }),
  answerPermission: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(AnswerPermissionInputSchema)
    .mutation(({ ctx, input }) => ctx.browser.answerPermission(input.promptId, input.decision) === true),
  // The command palette (`command-palette.feature.md`, Router): a page command (zoom …) as the menu
  // runs it, focus back to the page, and the menu's confirming Clear Browsing Data…; each answers `null`
  // but `focusPage` (whether a page took focus).
  pageCommand: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(PageCommandInputSchema)
    .mutation(({ ctx, input }) => {
      ctx.browser.runPageCommand(input.command);
      return null;
    }),
  focusPage: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => ctx.browser.focusPage() === true),
  clearBrowsingData: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .mutation(({ ctx }) => {
      ctx.browser.clearBrowsingData();
      return null;
    }),
  // "Open in" a tool (`command-palette.feature.md`): only a table id; main builds the URL and checks
  // where the page came from (`OpenToolResult`).
  openTool: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(OpenToolInputSchema)
    .mutation(({ ctx, input }) => {
      if (!ctx.browser.openTool) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'openTool unavailable' });
      return ctx.browser.openTool(input.tool);
    }),
  // Render profiles (Phase 2.5 Task 1, `render-profile.feature.md`): whether the tab's profile was set /
  // whether it had one to clear.
  setRenderProfile: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(SetRenderProfileInputSchema)
    .mutation(({ ctx, input }) => ctx.browser.setRenderProfile(input.tabId, input.profile, input.pin) === true),
  clearRenderProfile: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(ClearRenderProfileInputSchema)
    .mutation(({ ctx, input }) => ctx.browser.clearRenderProfile(input.tabId) === true),
  watch: publicProcedure
    .use(enforceSender)
    .use(requireBrowser)
    .input(WatchInputSchema)
    .output(BrowserStateSchema)
    .query(({ ctx, input }) => watchState(ctx.browser, input.sinceVersion)),
});

/**
 * SEO sidebar ↔ main (spec `seo-sidebar.feature.md`, Router). `getAudit` answers the tab's audit
 * state (`SeoAuditResponse`: `pending` / `ready` / `unavailable`); `rerun` whether a fresh audit
 * started; `setHighlight` whether the overlay was set (`seo-panels.feature.md`); `copyLinksCsv`
 * how many rows it wrote to main's clipboard (`null`: none, no ready audit); `copyUrl` whether it
 * wrote the URL (only one the audit lists); `copySchemaJson` whether it wrote the JSON-LD block
 * (`seo-schema.feature.md`); `measureSpeed` the active tab's speed measurement (`seo-speed.feature.md`,
 * polled while the Speed panel is open); `runAccessibility` whether an accessibility check is running
 * (`seo-compliance.feature.md`). The chrome asks again whenever `browser.watch` reports a new `auditVersion`.
 */
const seoRouter = router({
  getAudit: publicProcedure
    .use(enforceSender)
    .use(requireSeo)
    .input(SeoTabInputSchema)
    .query(({ ctx, input }) => ctx.seo.getAudit(input.tabId)),
  rerun: publicProcedure
    .use(enforceSender)
    .use(requireSeo)
    .input(SeoTabInputSchema)
    .mutation(({ ctx, input }) => ctx.seo.rerun(input.tabId) === true),
  setHighlight: publicProcedure
    .use(enforceSender)
    .use(requireSeo)
    .input(SeoHighlightInputSchema)
    .mutation(({ ctx, input }) => ctx.seo.setHighlight(input.tabId, input.mode) === true),
  copyLinksCsv: publicProcedure
    .use(enforceSender)
    .use(requireSeo)
    .input(SeoLinksCsvInputSchema)
    .mutation(({ ctx, input }) => {
      const rows = ctx.seo.copyLinksCsv(input.tabId, input.audit, input.filter);
      return typeof rows === 'number' ? rows : null;
    }),
  copyUrl: publicProcedure
    .use(enforceSender)
    .use(requireSeo)
    .input(SeoCopyUrlInputSchema)
    .mutation(({ ctx, input }) => ctx.seo.copyUrl(input.tabId, input.audit, input.url) === true),
  copySchemaJson: publicProcedure
    .use(enforceSender)
    .use(requireSeo)
    .input(SeoCopySchemaInputSchema)
    .mutation(({ ctx, input }) => ctx.seo.copySchemaJson(input.tabId, input.audit, input.block) === true),
  // Page speed (Task 5, `seo-speed.feature.md`): the active tab's live measurement (`SpeedResponse`).
  measureSpeed: publicProcedure
    .use(enforceSender)
    .use(requireSeo)
    .input(SeoTabInputSchema)
    .mutation(({ ctx, input }) => ctx.seo.measureSpeed(input.tabId)),
  // Compliance (Task 6, `seo-compliance.feature.md`): starts the accessibility check on the active tab.
  runAccessibility: publicProcedure
    .use(enforceSender)
    .use(requireSeo)
    .input(SeoTabInputSchema)
    .mutation(({ ctx, input }) => ctx.seo.runAccessibility(input.tabId) === true),
  // Command palette (Phase 2.5 Task 4, `command-palette.feature.md`): one allowlisted value of the shown audit.
  copyValue: publicProcedure
    .use(enforceSender)
    .use(requireSeo)
    .input(SeoCopyValueInputSchema)
    .mutation(({ ctx, input }) => ctx.seo.copyValue(input.tabId, input.audit, input.key) === true),
});

export const appRouter = router({
  ping: publicProcedure.use(enforceSender).query(() => 'pong' as const),
  browser: browserRouter,
  seo: seoRouter,
  // Phase 2.5 Task 3 (`seo-content.feature.md`): the Content panel's notes and Copy as HTML.
  content: contentRouter,
  // Phase 2.5 Task 2 (`seo-javascript.feature.md`): the JavaScript panel's "Fetch again".
  javascript: javascriptRouter,
  // Phase 2.5 Task 5 (`devtools.feature.md`): the SEO devtools drawer (read-only; masked data).
  devtools: devtoolsRouter,
  // Phase 2.5 Task 6 (`browser-polish.feature.md`): find in page, history and reopen tab, settings.
  find: findRouter,
  history: historyRouter,
  settings: settingsRouter,
  // Phase 2.5 Task 7 (`seo-checks.feature.md`): link status, sitemap and hreflang reciprocity checks.
  checks: checksRouter,
  // Phase 3 Task 4 (`serp-overlay.feature.md`): the SERP overlay's reading, outlines, pack updates and intent.
  serp: serpRouter,
});

export type AppRouter = typeof appRouter;
