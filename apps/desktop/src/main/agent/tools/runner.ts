import { getToolDefinition } from '@app/ai-skills';
import type { SeoAuditResponse } from '@app/seo-core';
import { pageUrlOf } from '@app/specs/agent-approvals.spec';
import { EXECUTE_JS_LIMITS, modelPageUrl, PAGE_SCRIPT_TIMEOUT_MS, PAGE_TEXT_DEFAULT_CHARS, pageKeyOf, pageSource } from '@app/specs/agent-page-tools.spec';
import type { JsonValue } from '@app/specs/agent-protocol.schema';
import { EXECUTE_JS_TIMEOUT_MS, TOOL_RESULT_MAX_CHARS, type ToolErrorCode } from '@app/specs/agent-tools.spec';
import { parseWebUrl, webOrigin } from '@app/specs/web-url.spec';
import type { ToolRunContext, ToolRunner, ToolRunOutcome } from '../approvals';
import { auditNotReady, clip, summariseAudit, summarisePageData } from './audit-summary';
import type { TabNavigation, NavigateOptions } from './navigator';
import { clickScript, executeScript, pageTextScript, parsePageAnswer, SCRIPT_WORLDS, type PageExpectation } from './page-scripts';
import { createSearchTools, type SearchToolInput, type SearchToolPorts } from './search-tools';
import { createProbeTools } from './probe-tools';

// The agent's core page tools (Phase 5 Task 5; spec `specs/agent-page-tools.spec.ts`, acceptance
// `specs/agent-page-tools.feature.md`): the broker's `ToolRunner` for `page_audit`, `page_data`,
// `page_text`, `navigate`, `click` and `execute_javascript`. The broker hands it only calls it
// decided to run, with input main re-parsed, and wraps and caps what it answers; the runner still
// re-parses the input (defence in depth), checks the page it must find (`ToolRunContext`), and
// answers `{ ok: true, data, source }` or `{ ok: false, code }`.
//
// - Every tool needs an expectation: a `null` `expectedOrigin` (or, approved, `expectedUrl`) acts
//   on nothing and answers `expired`, as does a page that is no longer the expected one.
// - `page_audit` / `page_data` read main's audit, not the page: the audit's URL and the tab's live
//   URL must be on the expected origin (approved: exactly the expected page).
// - `page_text`, `click` and `execute_javascript` check the page inside their isolated-world script,
//   before reading or acting (`page-scripts.ts`); main checks the tab's URL first only to skip a
//   script that would refuse anyway.
// - `execute_javascript` runs only `via: 'approval'`, in `AGENT_JS_WORLD_ID`, bounded by
//   `EXECUTE_JS_TIMEOUT_MS` from main. A script that is still running then answers `timeout`: an
//   isolated-world script can't be stopped, so the page may keep running it (a busy loop freezes the
//   tab until the user reloads or closes it); frost does not reload the page on its own.
// - Every tool honours `signal` (an abort answers `failed`), and no tool reads cookies, storage or
//   the page's main world.
// - `serp_results`, `search_intent`, `run_ai_search` and `gsc_performance` run over `deps.ports`
//   (Task 8, `search-tools.ts`): a missing port answers `unavailable`;
// - `visibility_probes` and `run_visibility_probes` run over `deps.ports.probes` (`probe-tools.ts`),
//   page tools like the others: the tab must still show the expected page (approved: exactly it).

/** The part of a tab's WebContents the page scripts need (Electron's `WebContents`; tests use fakes). */
export interface PageContents {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[], userGesture?: boolean): Promise<unknown>;
  getURL(): string;
  isDestroyed(): boolean;
}

export interface PageToolDeps {
  /** The chat tab's live page WebContents, or `null` (no tab, no page yet). */
  readonly contentsOf: (tabId: number) => PageContents | null;
  /** The tab's audit (`browser.seo.getAudit`). */
  readonly audit: (tabId: number) => SeoAuditResponse;
  /** Loads `href` in the tab through the controller (`createTabNavigator`). */
  readonly navigate: (tabId: number, href: string, options: NavigateOptions) => Promise<TabNavigation>;
  /** Milliseconds clock for `elapsedMs` (default `Date.now`). */
  readonly now?: () => number;
  /** The search tools' data ports (Task 8); a missing one makes its tools answer `unavailable`. */
  readonly ports?: SearchToolPorts;
}

/** Script answers main will parse (characters): far above what any capped script writes (`execute_javascript`'s own cap is `EXECUTE_JS_LIMITS.maxAnswerChars`). */
const MAX_SCRIPT_ANSWER_CHARS = 512 * 1024;

const fail = (code: ToolErrorCode): ToolRunOutcome => ({ ok: false, code });
const ok = (data: unknown, origin: string): ToolRunOutcome => ({ ok: true, data, source: pageSource(origin) });

/** What a script must find, from the context: `null` (act on nothing: `expired`) if the context names none. */
function expectationOf(context: ToolRunContext): PageExpectation | null {
  if (context.expectedOrigin === null) return null;
  if (context.via !== 'approval') return { origin: context.expectedOrigin, pageKey: null };
  const pageKey = pageKeyOf(context.expectedUrl);
  return pageKey === null || webOrigin(context.expectedUrl) !== context.expectedOrigin ? null : { origin: context.expectedOrigin, pageKey };
}

/** Whether `url` is the page `expected` names (its origin; approved, its page key). */
function isExpectedPage(url: unknown, expected: PageExpectation): boolean {
  if (webOrigin(url) !== expected.origin) return false;
  return expected.pageKey === null || pageKeyOf(url) === expected.pageKey;
}

type ScriptRun = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: 'timeout' | 'failed' };

/** Runs `code` in `worldId`, racing `timeoutMs` and `signal` (abort: `failed`). A rejection is `failed`. */
function runScript(contents: PageContents, worldId: number, code: string, timeoutMs: number, signal: AbortSignal): Promise<ScriptRun> {
  return new Promise<ScriptRun>((resolve) => {
    if (signal.aborted) {
      resolve({ ok: false, code: 'failed' });
      return;
    }
    let done = false;
    const finish = (run: ScriptRun) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(run);
    };
    const onAbort = () => finish({ ok: false, code: 'failed' });
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<unknown>;
    try {
      // Never as a user gesture: a script's click opens no popup and starts nothing a gesture would allow.
      pending = contents.executeJavaScriptInIsolatedWorld(worldId, [{ code }], false);
    } catch {
      finish({ ok: false, code: 'failed' });
      return;
    }
    Promise.resolve(pending).then(
      (value) => finish({ ok: true, value }),
      () => finish({ ok: false, code: 'failed' }),
    );
  });
}

/**
 * `data` with its string field `key` cut until `data`'s JSON text fits `TOOL_RESULT_MAX_CHARS`
 * (escapes counted), and `truncated` set when it was cut.
 */
function fitString<T extends Record<string, unknown>>(data: T, key: keyof T & string): T {
  let current = data;
  for (let guard = 0; guard < 64; guard += 1) {
    const length = JSON.stringify(current).length;
    if (length <= TOOL_RESULT_MAX_CHARS) return current;
    const text = current[key];
    if (typeof text !== 'string' || text.length === 0) return current;
    current = { ...current, [key]: clip(text, Math.max(0, text.length - (length - TOOL_RESULT_MAX_CHARS) - 16)), truncated: true };
  }
  return current;
}

export function createPageToolRunner(deps: PageToolDeps): ToolRunner {
  const now = deps.now ?? Date.now;
  // `gsc_performance`'s page is in its input: the broker fills in the tab's as the call arrives.
  const search = createSearchTools(deps.ports ? { ports: deps.ports } : {});
  const probeTools = createProbeTools({
    port: deps.ports?.probes ?? null,
    // The page check every page tool makes: the tab's live page must be the expected one.
    page: (context) => {
      const expected = expectationOf(context);
      if (expected === null) return 'expired';
      const contents = livePage(context, expected);
      return typeof contents === 'string' ? contents : { expected, matches: (url: unknown) => isExpectedPage(url, expected) };
    },
  });

  /** The tab's live page, if it is (still) the expected one; else why not. */
  const livePage = (context: ToolRunContext, expected: PageExpectation): PageContents | ToolErrorCode => {
    const contents = deps.contentsOf(context.tabId);
    if (contents === null || contents.isDestroyed()) return 'unavailable';
    return isExpectedPage(contents.getURL(), expected) ? contents : 'expired';
  };

  const readAudit = (toolName: 'page_audit' | 'page_data', context: ToolRunContext): ToolRunOutcome => {
    const expected = expectationOf(context);
    if (expected === null) return fail('expired');
    const contents = deps.contentsOf(context.tabId);
    if (contents !== null && !contents.isDestroyed() && !isExpectedPage(contents.getURL(), expected)) return fail('expired');
    const response = deps.audit(context.tabId);
    if (response.status !== 'ready') {
      if (response.status === 'unavailable' && response.reason === 'no-tab') return fail('unavailable');
      return ok(auditNotReady(response), expected.origin);
    }
    // The audit is of the page it names: it must be the expected one.
    if (!isExpectedPage(response.audit.url, expected)) return fail('expired');
    const data = toolName === 'page_audit' ? summariseAudit(response.audit, response.renderProfile) : summarisePageData(response.audit, response.renderProfile);
    return ok(data, expected.origin);
  };

  const pageText = async (input: { maxChars?: number | undefined }, context: ToolRunContext): Promise<ToolRunOutcome> => {
    const expected = expectationOf(context);
    if (expected === null) return fail('expired');
    const contents = livePage(context, expected);
    if (typeof contents === 'string') return fail(contents);
    const maxChars = input.maxChars ?? PAGE_TEXT_DEFAULT_CHARS;
    const run = await runScript(contents, SCRIPT_WORLDS.page_text, pageTextScript({ ...expected, maxChars }), PAGE_SCRIPT_TIMEOUT_MS, context.signal);
    if (!run.ok) return fail(run.code);
    const answer = parsePageAnswer(run.value, MAX_SCRIPT_ANSWER_CHARS);
    if (answer === null) return fail('failed');
    if (answer.status === 'mismatch') return fail('expired');
    if (answer.status !== 'ok' || typeof answer.text !== 'string' || typeof answer.totalChars !== 'number' || typeof answer.truncated !== 'boolean') return fail('failed');
    const text = clip(answer.text, maxChars);
    const data = fitString(
      {
        title: typeof answer.title === 'string' ? clip(answer.title, 300) : '',
        text,
        chars: text.length,
        totalChars: answer.totalChars,
        truncated: answer.truncated || text.length < answer.text.length,
      },
      'text',
    );
    return ok({ ...data, chars: data.text.length }, expected.origin);
  };

  const click = async (input: { selector?: string | undefined; text?: string | undefined }, context: ToolRunContext): Promise<ToolRunOutcome> => {
    if (context.via === 'read') return fail('not-allowed');
    const expected = expectationOf(context);
    if (expected === null) return fail('expired');
    const contents = livePage(context, expected);
    if (typeof contents === 'string') return fail(contents);
    // Under a standing grant only an exact text match is clicked: no guessing without the user.
    const script = clickScript({ ...expected, selector: input.selector ?? null, text: input.selector === undefined ? (input.text ?? null) : null, exactOnly: context.via === 'grant' });
    const run = await runScript(contents, SCRIPT_WORLDS.click, script, PAGE_SCRIPT_TIMEOUT_MS, context.signal);
    if (!run.ok) return fail(run.code);
    const answer = parsePageAnswer(run.value, MAX_SCRIPT_ANSWER_CHARS);
    if (answer === null) return fail('failed');
    switch (answer.status) {
      case 'mismatch':
        return fail('expired');
      case 'not-found':
        return ok(
          {
            clicked: false,
            reason:
              input.selector !== undefined
                ? 'No element matches the selector.'
                : context.via === 'grant'
                  ? 'No visible clickable element has exactly that text (under a standing grant only an exact match is clicked).'
                  : 'No visible clickable element has that text.',
          },
          expected.origin,
        );
      case 'bad-selector':
        return ok({ clicked: false, reason: 'The selector is not valid CSS.' }, expected.origin);
      case 'clicked': {
        const element = answer.element as Record<string, unknown> | null;
        if (element === null || typeof element !== 'object') return fail('failed');
        const text = (value: unknown, max: number) => (typeof value === 'string' ? clip(value, max) : null);
        return ok(
          {
            clicked: true,
            matchedBy: text(answer.matchedBy, 32),
            element: { tag: text(element.tag, 64), role: text(element.role, 64), name: text(element.name, 200), href: text(element.href, 600), visible: element.visible === true },
          },
          expected.origin,
        );
      }
      default:
        return fail('failed');
    }
  };

  const executeJavascript = async (input: { code: string }, context: ToolRunContext): Promise<ToolRunOutcome> => {
    // Only the user's approval of this exact call runs code (never a grant or the read setting).
    if (context.via !== 'approval') return fail('not-allowed');
    const expected = expectationOf(context);
    if (expected === null || expected.pageKey === null) return fail('expired');
    const contents = livePage(context, expected);
    if (typeof contents === 'string') return fail(contents);
    const started = now();
    const run = await runScript(contents, SCRIPT_WORLDS.execute_javascript, executeScript({ ...expected, code: input.code }), EXECUTE_JS_TIMEOUT_MS, context.signal);
    if (!run.ok) return fail(run.code);
    const answer = parsePageAnswer(run.value, EXECUTE_JS_LIMITS.maxAnswerChars);
    if (answer === null) return fail('failed');
    const elapsedMs = Math.max(0, now() - started);
    if (answer.status === 'mismatch') return fail('expired');
    if (answer.status === 'error') return ok({ error: typeof answer.error === 'string' ? clip(answer.error, EXECUTE_JS_LIMITS.maxErrorChars) : 'Error', elapsedMs }, expected.origin);
    if (answer.status !== 'ok' || typeof answer.json !== 'string' || typeof answer.type !== 'string' || typeof answer.truncated !== 'boolean') return fail('failed');
    const type = clip(answer.type, 16);
    if (!answer.truncated) {
      let result: unknown;
      try {
        result = answer.json === '' ? null : JSON.parse(answer.json);
      } catch {
        return fail('failed');
      }
      const whole = { result, truncated: false, type, elapsedMs };
      // Fits as data; else handed on as its JSON text, cut (the model still reads its start).
      if (JSON.stringify(whole).length <= TOOL_RESULT_MAX_CHARS) return ok(whole, expected.origin);
    }
    return ok(fitString({ result: answer.json, truncated: true, resultIsJsonText: true, type, elapsedMs }, 'result'), expected.origin);
  };

  const navigate = async (input: { url: string }, context: ToolRunContext): Promise<ToolRunOutcome> => {
    if (context.via === 'read') return fail('not-allowed');
    const href = parseWebUrl(input.url)?.href ?? null;
    if (href === null) return fail('invalid-input');
    // The URL loaded is the one the broker decided on (`parseWebUrl(url).href`), never the raw input.
    if (context.expectedUrl === null || context.expectedOrigin === null || href !== context.expectedUrl || webOrigin(href) !== context.expectedOrigin) return fail('expired');
    let result: TabNavigation;
    try {
      result = await deps.navigate(context.tabId, href, { signal: context.signal, ...(context.via === 'grant' ? { allowedOrigin: context.expectedOrigin } : {}) });
    } catch {
      return fail('failed');
    }
    if (context.signal.aborted) return fail('failed');
    switch (result.status) {
      case 'aborted':
      case 'refused':
        return fail('failed');
      case 'no-tab':
        return fail('unavailable');
      case 'not-shown':
        return ok({ navigated: false, reason: "The chat's tab is not the tab on screen, so nothing was opened. Ask the user to switch back to it." }, context.expectedOrigin);
      case 'done': {
        const landed = webOrigin(result.url) ?? context.expectedOrigin;
        const data = {
          requested: modelPageUrl(href) ?? href,
          url: modelPageUrl(result.url) ?? result.url,
          title: result.title,
          status: result.httpStatus,
          settled: result.settled,
          ...(result.blockedRedirectTo !== null ? { blocked: 'redirect', to: result.blockedRedirectTo, note: 'A redirect to another site was cancelled: the standing grant covers this site only.' } : {}),
          ...(pageUrlOf(result.url) !== pageUrlOf(href) && result.blockedRedirectTo === null ? { redirected: true } : {}),
        };
        return ok(data, landed);
      }
    }
  };

  return {
    async run(toolName: string, input: JsonValue, context: ToolRunContext): Promise<ToolRunOutcome> {
      if (context.signal.aborted) return fail('failed');
      const definition = getToolDefinition(toolName);
      if (definition === undefined) return fail('unavailable');
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) return fail('invalid-input');
      const value = parsed.data as Record<string, unknown>;
      switch (definition.name) {
        case 'page_audit':
        case 'page_data':
          return readAudit(definition.name, context);
        case 'page_text':
          return pageText(value as { maxChars?: number }, context);
        case 'click':
          return click(value as { selector?: string; text?: string }, context);
        case 'execute_javascript':
          return executeJavascript(value as { code: string }, context);
        case 'navigate':
          return navigate(value as { url: string }, context);
        case 'serp_results':
        case 'search_intent':
        case 'run_ai_search':
        case 'gsc_performance':
          return search.run({ toolName: definition.name, input: value } as SearchToolInput, context);
        case 'visibility_probes':
        case 'run_visibility_probes':
          return probeTools.run(definition.name, context);
      }
    },
  };
}
