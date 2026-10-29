// Spec: specs/agent-page-tools.spec.ts (AGENT_PAGE_WORLD_ID, AGENT_JS_WORLD_ID, NON_AGENT_WORLD_IDS, PAGE_SCRIPT_TIMEOUT_MS,
// PAGE_TEXT_DEFAULT_CHARS, PAGE_AUDIT_LIMITS, pageSource) · specs/agent-tools.spec.ts (EXECUTE_JS_TIMEOUT_MS,
// EXECUTE_JS_MAX_RESULT_BYTES, TOOL_RESULT_MAX_CHARS) · specs/agent-approvals.spec.ts (runTargetFor, ToolRunVia)
// Acceptance: specs/agent-page-tools.feature.md (Scenarios: reads, click, execute_javascript, the page check, navigate, every tool)
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runAudit, type Finding, type SeoAudit, type SeoAuditResponse } from '@app/seo-core';
import { runTargetFor, type ToolRunVia } from '@app/specs/agent-approvals.spec';
import { AGENT_JS_WORLD_ID, AGENT_PAGE_WORLD_ID, NON_AGENT_WORLD_IDS, PAGE_AUDIT_LIMITS, PAGE_SCRIPT_TIMEOUT_MS, PAGE_TEXT_DEFAULT_CHARS, pageSource } from '@app/specs/agent-page-tools.spec';
import type { JsonValue } from '@app/specs/agent-protocol.schema';
import { EXECUTE_JS_TIMEOUT_MS, TOOL_RESULT_MAX_CHARS } from '@app/specs/agent-tools.spec';
import { DEFAULT_RENDER_PROFILE } from '@app/specs/render-profile.spec';
import { NO_PAGE_CONTEXT, PageSnapshotSchema } from '@app/specs/seo-snapshot.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import type { ToolRunContext, ToolRunOutcome } from '../approvals';
import { createBrowserPageToolRunner, createPageToolRunner, type PageContents, type PageToolDeps, type TabNavigation } from '../tools';

const PAGE = 'https://example.com/guides/page?x=1#top';
const ORIGIN = 'https://example.com';
const TAB = 7;

afterEach(() => {
  vi.useRealTimers();
});

/** A script call a fake WebContents saw. */
interface Call {
  readonly worldId: number;
  readonly code: string;
  /** `executeJavaScriptInIsolatedWorld`'s third argument, as passed (never a gesture). */
  readonly userGesture: unknown;
}

/** A WebContents whose isolated-world scripts run in a jsdom page at `url` (as Chromium would run them). */
function domContents(body: string, { url = PAGE, shownUrl = url }: { url?: string; shownUrl?: string } = {}) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head><title>Guide</title></head><body>${body}</body></html>`, { url, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const calls: Call[] = [];
  const contents: PageContents = {
    executeJavaScriptInIsolatedWorld: async (worldId, scripts, ...rest) => {
      calls.push({ worldId, code: scripts[0]!.code, userGesture: rest.length > 0 ? rest[0] : 'omitted' });
      return dom.window.eval(scripts[0]!.code) as unknown;
    },
    getURL: () => shownUrl,
    isDestroyed: () => false,
  };
  return { dom, calls, contents };
}

/** A WebContents whose scripts answer `answer` (a value, a rejection, or never). */
function scriptedContents(answer: () => Promise<unknown>, url = PAGE) {
  const calls: Call[] = [];
  const contents: PageContents = {
    executeJavaScriptInIsolatedWorld: (worldId, scripts, ...rest) => {
      calls.push({ worldId, code: scripts[0]!.code, userGesture: rest.length > 0 ? rest[0] : 'omitted' });
      return answer();
    },
    getURL: () => url,
    isDestroyed: () => false,
  };
  return { calls, contents };
}

function readyAudit(url = 'https://example.com/guides/page?x=1', changes: Parameters<typeof rawSnapshot>[1] = {}): SeoAudit {
  return runAudit({ ...PageSnapshotSchema.parse(rawSnapshot(url, changes)), ...NO_PAGE_CONTEXT });
}

function runner(overrides: Partial<PageToolDeps> = {}) {
  const navigate = vi.fn(async (..._args: Parameters<PageToolDeps['navigate']>): Promise<TabNavigation> => ({ status: 'done', url: 'https://example.com/next', title: 'Next', httpStatus: 200, settled: true, blockedRedirectTo: null }));
  const deps: PageToolDeps = {
    contentsOf: () => null,
    audit: (): SeoAuditResponse => ({ status: 'ready', url: PAGE, audit: readyAudit(), renderProfile: null }),
    navigate,
    now: () => 1_000,
    ...overrides,
  };
  return { tools: createPageToolRunner(deps), navigate: (overrides.navigate as typeof navigate | undefined) ?? navigate };
}

/** The context the broker would hand the runner for `toolName` on a tab at `tabUrl`. */
function context(toolName: string, input: unknown, via: ToolRunVia, { tabUrl = PAGE, signal = new AbortController().signal }: { tabUrl?: string | null; signal?: AbortSignal } = {}): ToolRunContext {
  return { tabId: TAB, signal, via, ...runTargetFor(toolName, input, tabUrl) };
}

async function run(tools: ReturnType<typeof runner>['tools'], toolName: string, input: Record<string, unknown>, via: ToolRunVia, options?: Parameters<typeof context>[3]): Promise<ToolRunOutcome> {
  return tools.run(toolName, input as JsonValue, context(toolName, input, via, options));
}

const dataOf = (outcome: ToolRunOutcome) => {
  expect(outcome.ok).toBe(true);
  return (outcome as { data: Record<string, any> }).data;
};

describe('page reads', () => {
  test('page-audit-summarises-ready-audit', async () => {
    const audit = readyAudit('https://example.com/guides/page?x=1', { titles: [], titleTotal: 0, metaDescriptions: [], metaDescriptionTotal: 0 });
    expect(audit.findings.length).toBeGreaterThan(1);
    const { tools } = runner({ audit: () => ({ status: 'ready', url: PAGE, audit, renderProfile: { profile: { ...DEFAULT_RENDER_PROFILE, javascriptDisabled: true }, partial: false } }) });
    const outcome = await run(tools, 'page_audit', {}, 'read');
    expect(outcome).toMatchObject({ ok: true, source: pageSource(ORIGIN) });
    const data = dataOf(outcome);
    expect(data).toMatchObject({ status: 'ready', score: audit.score, band: audit.band, indexable: audit.indexable, indexability: audit.indexability.verdict, counts: audit.counts, renderProfile: 'JavaScript off' });
    expect(data.findings.map((f: { ruleId: string }) => f.ruleId)).toEqual(audit.findings.map((f) => f.ruleId));
    // Most severe first (the audit's order), each with its explanation.
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const ranks = data.findings.map((f: { severity: keyof typeof rank }) => rank[f.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(data.findings[0]).toMatchObject({ ruleId: audit.findings[0]!.ruleId, severity: audit.findings[0]!.severity, title: audit.findings[0]!.title, fix: audit.findings[0]!.fix });
    expect(data.keyFacts).toMatchObject({ title: null, description: null, h1: ['Main heading'], wordCount: 640 });
    expect(data.findingsOmitted).toBe(0);
  });

  test('page-audit-trims-to-budget', async () => {
    const audit = readyAudit();
    const long = 'w'.repeat(2_000);
    const finding = (i: number): Finding => ({
      ruleId: audit.findings[0]?.ruleId ?? ('title-missing' as Finding['ruleId']),
      category: 'content' as Finding['category'],
      severity: i < 10 ? 'error' : i < 40 ? 'warning' : 'info',
      title: `${i} ${long}`,
      why: long,
      fix: long,
      details: { facts: Array.from({ length: 10 }, () => ({ label: long, value: long })), samples: Array.from({ length: 10 }, () => long), count: i },
    });
    const huge: SeoAudit = { ...audit, findings: Array.from({ length: 200 }, (_, i) => finding(i)) };
    const { tools } = runner({ audit: () => ({ status: 'ready', url: PAGE, audit: huge }) });
    const data = dataOf(await run(tools, 'page_audit', {}, 'read'));
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(PAGE_AUDIT_LIMITS.budgetChars);
    expect(data.findingsTotal).toBe(200);
    expect(data.findings.length).toBeGreaterThan(0);
    expect(data.findings.length + data.findingsOmitted).toBe(200);
    // The kept ones are the first (most severe), each cut.
    expect(data.findings[0].title.startsWith('0 ')).toBe(true);
    expect(data.findings[0].title.length).toBe(PAGE_AUDIT_LIMITS.maxFindingTextChars);
    expect(data.findings[0].facts).toHaveLength(PAGE_AUDIT_LIMITS.maxFindingFacts);
    expect(data.findings[0].samples).toHaveLength(PAGE_AUDIT_LIMITS.maxFindingSamples);
  });

  test('page-audit-pending-and-unavailable', async () => {
    let response: SeoAuditResponse = { status: 'pending', url: PAGE };
    const { tools } = runner({ audit: () => response });
    expect(dataOf(await run(tools, 'page_audit', {}, 'read'))).toMatchObject({ status: 'pending' });
    response = { status: 'unavailable', url: PAGE, reason: 'timeout' };
    expect(dataOf(await run(tools, 'page_data', {}, 'read'))).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    response = { status: 'unavailable', url: '', reason: 'no-tab' };
    expect(await run(tools, 'page_audit', {}, 'read')).toEqual({ ok: false, code: 'unavailable' });
  });

  test('page-data-facts', async () => {
    const audit = readyAudit('https://example.com/guides/page?x=1', {
      headings: Array.from({ length: 80 }, (_, i) => ({ level: (i % 3) + 1, text: `Heading ${i}` })),
      headingTotal: 90,
    });
    const { tools } = runner({ audit: () => ({ status: 'ready', url: PAGE, audit, renderProfile: null }) });
    const outcome = await run(tools, 'page_data', {}, 'read');
    expect(outcome).toMatchObject({ ok: true, source: pageSource(ORIGIN) });
    const data = dataOf(outcome);
    expect(data).toMatchObject({
      url: audit.page.url,
      title: { text: 'A well titled page about something useful' },
      metaDescription: { text: expect.stringContaining('A description') },
      canonical: audit.page.canonical,
      robots: audit.page.robots,
      lang: 'en',
      links: audit.page.links,
      images: { missingAlt: audit.page.images.missingAlt },
      indexability: { verdict: audit.indexability.verdict, indexable: audit.indexable },
      renderProfile: null,
    });
    expect(data.headings.total).toBe(90);
    expect(data.headings.outline).toHaveLength(PAGE_AUDIT_LIMITS.maxHeadings);
    expect(data.headings.outline[0]).toEqual({ level: 1, text: 'Heading 0' });
    expect(Array.isArray(data.structuredData.types)).toBe(true);
    expect(data.hreflang).toMatchObject({ total: audit.indexability.hreflang.total });
  });

  test('page-data-internal-links', async () => {
    const link = (href: string, text: string, kind: 'internal' | 'external' = 'internal') => ({ href, scheme: 'https:', rel: '', text, kind, target: null });
    const audit = readyAudit('https://example.com/guides/page?x=1', {
      links: [
        link('https://example.com/tea#brew', '  Green\n tea  '),
        link('https://example.com/tea', 'Tea again'),
        link('https://other.example/', 'Elsewhere', 'external'),
        ...Array.from({ length: 60 }, (_, i) => link(`https://example.com/p/${i}/${'x'.repeat(900)}`, 't'.repeat(200))),
      ],
      linkTotal: 63,
    });
    const { tools } = runner({ audit: () => ({ status: 'ready', url: PAGE, audit, renderProfile: null }) });
    const links = dataOf(await run(tools, 'page_data', {}, 'read')).internalLinks;
    // Distinct addresses without their fragment, in page order, the first anchor text for each, collapsed.
    expect(links.list[0]).toEqual({ text: 'Green tea', href: 'https://example.com/tea' });
    expect(links.list.every((item: { href: string }) => !item.href.startsWith('https://other.example'))).toBe(true);
    expect(links.distinct).toBe(61);
    expect(links.list.length + links.omitted).toBe(61);
    expect(links.list.length).toBeLessThanOrEqual(PAGE_AUDIT_LIMITS.maxInternalLinks);
    expect(links.list[1].text).toHaveLength(PAGE_AUDIT_LIMITS.maxLinkTextChars);
    expect(links.list[1].href).toHaveLength(PAGE_AUDIT_LIMITS.maxUrlChars);
    expect(JSON.stringify(links).length).toBeLessThanOrEqual(PAGE_AUDIT_LIMITS.internalLinksBudgetChars);
  });

  test('audit-tools-refuse-other-page', async () => {
    // The audit is of another origin.
    const other = runner({ audit: () => ({ status: 'ready', url: 'https://other.example/', audit: readyAudit('https://other.example/') }) });
    expect(await run(other.tools, 'page_audit', {}, 'read')).toEqual({ ok: false, code: 'expired' });
    expect(await run(other.tools, 'page_data', {}, 'read')).toEqual({ ok: false, code: 'expired' });
    // The tab has moved to another origin since the broker decided.
    const moved = runner({ contentsOf: () => scriptedContents(async () => null, 'https://other.example/').contents });
    expect(await run(moved.tools, 'page_audit', {}, 'read')).toEqual({ ok: false, code: 'expired' });
    // Approved (read tools off): another page of the same origin is refused; the fragment doesn't count.
    const sibling = runner({ audit: () => ({ status: 'ready', url: PAGE, audit: readyAudit('https://example.com/guides/other') }) });
    expect(await run(sibling.tools, 'page_data', {}, 'read')).toMatchObject({ ok: true });
    expect(await run(sibling.tools, 'page_data', {}, 'approval')).toEqual({ ok: false, code: 'expired' });
    const same = runner({ audit: () => ({ status: 'ready', url: PAGE, audit: readyAudit('https://example.com/guides/page?x=1#elsewhere') }) });
    expect(await run(same.tools, 'page_data', {}, 'approval')).toMatchObject({ ok: true });
    // No expectation at all.
    const { tools } = runner();
    expect(await run(tools, 'page_audit', {}, 'read', { tabUrl: null })).toEqual({ ok: false, code: 'expired' });
  });

  test('page-text-capped', async () => {
    const paragraph = 'Plain words here. '.repeat(2_000);
    const page = domContents(`<p>${paragraph}</p>`);
    const { tools } = runner({ contentsOf: (tabId) => (tabId === TAB ? page.contents : null) });
    const outcome = await run(tools, 'page_text', {}, 'read');
    expect(outcome).toMatchObject({ ok: true, source: pageSource(ORIGIN) });
    const data = dataOf(outcome);
    expect(page.calls.map((call) => call.worldId)).toEqual([AGENT_PAGE_WORLD_ID]);
    expect(data.text.length).toBe(PAGE_TEXT_DEFAULT_CHARS);
    expect(data).toMatchObject({ title: 'Guide', chars: PAGE_TEXT_DEFAULT_CHARS, truncated: true });
    expect(data.totalChars).toBeGreaterThan(PAGE_TEXT_DEFAULT_CHARS);
    expect(dataOf(await run(tools, 'page_text', { maxChars: 50 }, 'read')).text).toHaveLength(50);
    // Escape-heavy text at the largest maxChars still fits the tool cap once its escapes count.
    const quotes = domContents(`<p>${'"\\'.repeat(20_000)}</p>`);
    const fitted = runner({ contentsOf: () => quotes.contents });
    const big = dataOf(await run(fitted.tools, 'page_text', { maxChars: TOOL_RESULT_MAX_CHARS }, 'read'));
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(big.truncated).toBe(true);
    expect(big.chars).toBe(big.text.length);
  });
});

describe('click', () => {
  test('click-reports-element', async () => {
    const page = domContents('<a href="/pricing" id="p">See pricing</a>');
    let clicks = 0;
    page.dom.window.document.getElementById('p')!.addEventListener('click', (event) => {
      event.preventDefault();
      clicks += 1;
    });
    const { tools } = runner({ contentsOf: () => page.contents });
    const outcome = await run(tools, 'click', { text: 'see pricing' }, 'approval');
    expect(outcome).toMatchObject({ ok: true, source: pageSource(ORIGIN) });
    expect(dataOf(outcome)).toEqual({ clicked: true, matchedBy: 'text-contains', element: { tag: 'a', role: 'link', name: 'See pricing', href: 'https://example.com/pricing', visible: true } });
    expect(clicks).toBe(1);
    // Under a standing grant only an exact text match is clicked.
    expect(dataOf(await run(tools, 'click', { text: 'see pricing' }, 'grant'))).toMatchObject({ clicked: false, reason: expect.stringContaining('exact') });
    expect(clicks).toBe(1);
    expect(dataOf(await run(tools, 'click', { text: 'See pricing' }, 'grant'))).toMatchObject({ clicked: true, matchedBy: 'text-exact' });
    expect(clicks).toBe(2);
    expect(page.calls.every((call) => call.worldId === AGENT_PAGE_WORLD_ID)).toBe(true);
    expect(page.calls.every((call) => call.userGesture === false)).toBe(true);
    expect(dataOf(await run(tools, 'click', { selector: '#none' }, 'approval'))).toEqual({ clicked: false, reason: 'No element matches the selector.' });
    expect(dataOf(await run(tools, 'click', { selector: '[' }, 'approval'))).toEqual({ clicked: false, reason: 'The selector is not valid CSS.' });
    expect(clicks).toBe(2);
  });

  test('click-selector-is-data', async () => {
    const { calls, contents } = scriptedContents(async () => '{"status":"not-found"}');
    const { tools } = runner({ contentsOf: () => contents });
    const selector = `a[title="</script><script>alert(1)</script>\\"'"]`;
    await run(tools, 'click', { selector }, 'grant');
    const code = calls[0]!.code;
    // The selector appears only as a JSON string value, inside one object literal after the fixed function.
    expect(code).toContain(JSON.stringify(selector));
    expect(code.split(JSON.stringify(selector))).toHaveLength(2);
    expect(code).not.toContain(selector);
    expect(code.endsWith('})')).toBe(true);
    const text = 'Say "hi" \\ </script>';
    await run(tools, 'click', { text }, 'grant');
    expect(calls[1]!.code).toContain(JSON.stringify(text));
  });

  test('click-needs-grant-or-approval', async () => {
    const { calls, contents } = scriptedContents(async () => '{"status":"not-found"}');
    const { tools } = runner({ contentsOf: () => contents });
    expect(await run(tools, 'click', { selector: 'a' }, 'read')).toEqual({ ok: false, code: 'not-allowed' });
    expect(calls).toHaveLength(0);
    // Invalid input (both or neither) is refused before anything runs.
    expect(await run(tools, 'click', { selector: 'a', text: 'b' }, 'grant')).toEqual({ ok: false, code: 'invalid-input' });
    expect(calls).toHaveLength(0);
  });
});

describe('execute_javascript', () => {
  test('execute-js-never-main-world', async () => {
    const page = domContents('<p>Hi</p>');
    const { tools } = runner({ contentsOf: () => page.contents });
    const code = 'document.querySelector("p").textContent';
    const outcome = await run(tools, 'execute_javascript', { code }, 'approval');
    expect(dataOf(outcome)).toEqual({ result: 'Hi', truncated: false, type: 'string', elapsedMs: 0 });
    expect(page.calls).toHaveLength(1);
    const call = page.calls[0]!;
    expect(call.worldId).toBe(AGENT_JS_WORLD_ID);
    expect(call.userGesture).toBe(false);
    expect(call.worldId).not.toBe(0);
    expect(call.worldId).not.toBe(AGENT_PAGE_WORLD_ID);
    expect(NON_AGENT_WORLD_IDS).not.toContain(call.worldId);
    // The code is a JSON string value in the fixed wrapper, never source of its own.
    expect(call.code).toContain(JSON.stringify(code));
    expect(call.code.replace(JSON.stringify(code), '')).not.toContain('document.querySelector("p")');
  });

  test('execute-js-approval-only', async () => {
    const { calls, contents } = scriptedContents(async () => '{"status":"ok","type":"number","json":"1","truncated":false,"bytes":1}');
    const { tools } = runner({ contentsOf: () => contents });
    expect(await run(tools, 'execute_javascript', { code: '1' }, 'read')).toEqual({ ok: false, code: 'not-allowed' });
    expect(await run(tools, 'execute_javascript', { code: '1' }, 'grant')).toEqual({ ok: false, code: 'not-allowed' });
    expect(calls).toHaveLength(0);
    // Approved, but with no page named: nothing runs.
    const bare = await tools.run('execute_javascript', { code: '1' }, { tabId: TAB, signal: new AbortController().signal, via: 'approval', expectedOrigin: ORIGIN, expectedUrl: null });
    expect(bare).toEqual({ ok: false, code: 'expired' });
    expect(calls).toHaveLength(0);
    expect(dataOf(await run(tools, 'execute_javascript', { code: '1' }, 'approval'))).toMatchObject({ result: 1 });
  });

  test('execute-js-timeout', async () => {
    vi.useFakeTimers();
    const { contents } = scriptedContents(() => new Promise(() => undefined));
    const { tools } = runner({ contentsOf: () => contents });
    let settled: ToolRunOutcome | null = null;
    void run(tools, 'execute_javascript', { code: 'while (true) {}' }, 'approval').then((outcome) => (settled = outcome));
    await vi.advanceTimersByTimeAsync(EXECUTE_JS_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ ok: false, code: 'timeout' });
    // The page scripts have their own, shorter limit.
    let text: ToolRunOutcome | null = null;
    void run(tools, 'page_text', {}, 'read').then((outcome) => (text = outcome));
    await vi.advanceTimersByTimeAsync(PAGE_SCRIPT_TIMEOUT_MS);
    expect(text).toEqual({ ok: false, code: 'timeout' });
  });

  test('execute-js-result-truncated', async () => {
    const page = domContents('');
    const { tools } = runner({ contentsOf: () => page.contents });
    // Over the byte cap: cut in the page, handed on as its JSON text.
    const huge = dataOf(await run(tools, 'execute_javascript', { code: '"a".repeat(1e6)' }, 'approval'));
    expect(huge).toMatchObject({ truncated: true, resultIsJsonText: true, type: 'string' });
    expect(huge.result.startsWith('"aaa')).toBe(true);
    expect(JSON.stringify(huge).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    // Under the byte cap but over the tool cap: cut to the tool cap, flagged.
    const medium = dataOf(await run(tools, 'execute_javascript', { code: 'Array.from({ length: 5000 }, (_, i) => "item" + i)' }, 'approval'));
    expect(medium).toMatchObject({ truncated: true, resultIsJsonText: true, type: 'array' });
    expect(JSON.stringify(medium).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(medium.result.startsWith('["item0","item1"')).toBe(true);
  });

  test('execute-js-errors', async () => {
    const page = domContents('');
    const { tools } = runner({ contentsOf: () => page.contents });
    expect(dataOf(await run(tools, 'execute_javascript', { code: 'throw new Error("nope")' }, 'approval'))).toEqual({ error: 'Error: nope', elapsedMs: 0 });
    // The world rejected (a dead frame) or answered something odd: failed.
    const rejected = runner({ contentsOf: () => scriptedContents(() => Promise.reject(new Error('Script failed to execute'))).contents });
    expect(await run(rejected.tools, 'execute_javascript', { code: '1' }, 'approval')).toEqual({ ok: false, code: 'failed' });
    const odd = runner({ contentsOf: () => scriptedContents(async () => ({ status: 'ok' })).contents });
    expect(await run(odd.tools, 'execute_javascript', { code: '1' }, 'approval')).toEqual({ ok: false, code: 'failed' });
    const unparsable = runner({ contentsOf: () => scriptedContents(async () => '{"status":"ok","type":"string","json":"{","truncated":false,"bytes":1}').contents });
    expect(await run(unparsable.tools, 'execute_javascript', { code: '1' }, 'approval')).toEqual({ ok: false, code: 'failed' });
  });
});

describe('the page check', () => {
  test('page-mismatch-expired', async () => {
    // The tab's URL still reads as expected, but the page in it answers that it is another one.
    const page = domContents('<button id="b">Go</button>', { url: 'https://example.com/elsewhere', shownUrl: PAGE });
    const { tools } = runner({ contentsOf: () => page.contents });
    for (const [tool, input, via] of [
      ['click', { selector: '#b' }, 'approval'],
      ['page_text', {}, 'approval'],
      ['execute_javascript', { code: '1' }, 'approval'],
    ] as const) {
      expect(await run(tools, tool, input, via)).toEqual({ ok: false, code: 'expired' });
    }
    expect(page.calls).toHaveLength(3);
    // A tab already on another origin: no script runs at all.
    const away = scriptedContents(async () => '{"status":"ok"}', 'https://other.example/');
    const gone = runner({ contentsOf: () => away.contents });
    expect(await run(gone.tools, 'click', { selector: '#b' }, 'grant')).toEqual({ ok: false, code: 'expired' });
    expect(await run(gone.tools, 'page_text', {}, 'read')).toEqual({ ok: false, code: 'expired' });
    expect(away.calls).toHaveLength(0);
    // No page in the tab: unavailable.
    const empty = runner({ contentsOf: () => null });
    expect(await run(empty.tools, 'page_text', {}, 'read')).toEqual({ ok: false, code: 'unavailable' });
  });
});

describe('navigate', () => {
  test('navigate-loads-parsed-href', async () => {
    const { tools, navigate } = runner();
    const input = { url: 'HTTPS://Example.COM:443/a b?q=1' };
    const outcome = await run(tools, 'navigate', input, 'approval');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]).toEqual([TAB, 'https://example.com/a%20b?q=1', { signal: expect.any(AbortSignal) }]);
    expect(outcome).toEqual({
      ok: true,
      source: pageSource(ORIGIN),
      data: { requested: 'https://example.com/a%20b?q=1', url: 'https://example.com/next', title: 'Next', status: 200, settled: true, redirected: true },
    });
  });

  test('navigate-refuses-other-target', async () => {
    const { tools, navigate } = runner();
    const decided = context('navigate', { url: 'https://example.com/a' }, 'approval');
    expect(await tools.run('navigate', { url: 'https://example.com/b' }, decided)).toEqual({ ok: false, code: 'expired' });
    expect(await tools.run('navigate', { url: 'https://example.com/a' }, { ...decided, expectedOrigin: null })).toEqual({ ok: false, code: 'expired' });
    expect(await run(tools, 'navigate', { url: 'https://example.com/a' }, 'read')).toEqual({ ok: false, code: 'not-allowed' });
    expect(await run(tools, 'navigate', { url: 'javascript:alert(1)' }, 'approval')).toEqual({ ok: false, code: 'invalid-input' });
    expect(navigate).not.toHaveBeenCalled();
  });

  test('navigate-grant-blocks-redirect', async () => {
    const blocked = vi.fn(async (..._args: Parameters<PageToolDeps['navigate']>): Promise<TabNavigation> => ({ status: 'done', url: 'https://example.com/start', title: 'Start', httpStatus: null, settled: true, blockedRedirectTo: 'https://evil.example' }));
    const { tools } = runner({ navigate: blocked });
    const granted = dataOf(await run(tools, 'navigate', { url: 'https://example.com/go' }, 'grant'));
    expect(blocked.mock.calls[0]![2]).toEqual({ signal: expect.any(AbortSignal), allowedOrigin: ORIGIN });
    expect(granted).toMatchObject({ blocked: 'redirect', to: 'https://evil.example', url: 'https://example.com/start' });
    // Approved: no origin limit; it reports where it ended, and its source is that page.
    const followed = vi.fn(async (..._args: Parameters<PageToolDeps['navigate']>): Promise<TabNavigation> => ({ status: 'done', url: 'https://landing.example/', title: 'Landed', httpStatus: 200, settled: true, blockedRedirectTo: null }));
    const approved = runner({ navigate: followed });
    const outcome = await run(approved.tools, 'navigate', { url: 'https://example.com/go' }, 'approval');
    expect(followed.mock.calls[0]![2]).toEqual({ signal: expect.any(AbortSignal) });
    expect(outcome).toMatchObject({ ok: true, source: pageSource('https://landing.example'), data: { url: 'https://landing.example/', redirected: true } });
  });

  test('navigate-not-shown', async () => {
    const { tools } = runner({ navigate: async () => ({ status: 'not-shown' }) });
    expect(dataOf(await run(tools, 'navigate', { url: 'https://example.com/a' }, 'approval'))).toMatchObject({ navigated: false });
    const missing = runner({ navigate: async () => ({ status: 'no-tab' }) });
    expect(await run(missing.tools, 'navigate', { url: 'https://example.com/a' }, 'approval')).toEqual({ ok: false, code: 'unavailable' });
    const refused = runner({ navigate: async () => ({ status: 'refused' }) });
    expect(await run(refused.tools, 'navigate', { url: 'https://example.com/a' }, 'approval')).toEqual({ ok: false, code: 'failed' });
  });
});

describe('every tool', () => {
  test('abort-ends-tool', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const never = scriptedContents(() => new Promise(() => undefined));
    const { tools, navigate } = runner({ contentsOf: () => never.contents });
    for (const [tool, input, via] of [
      ['page_audit', {}, 'read'],
      ['page_text', {}, 'read'],
      ['click', { selector: 'a' }, 'grant'],
      ['execute_javascript', { code: '1' }, 'approval'],
      ['navigate', { url: 'https://example.com/a' }, 'grant'],
    ] as const) {
      expect(await run(tools, tool, input, via, { signal: aborted.signal })).toEqual({ ok: false, code: 'failed' });
    }
    expect(never.calls).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
    // Aborted while the script runs.
    const stop = new AbortController();
    const pending = run(tools, 'execute_javascript', { code: '1' }, 'approval', { signal: stop.signal });
    await Promise.resolve();
    stop.abort();
    expect(await pending).toEqual({ ok: false, code: 'failed' });
  });

  test('port-tools-unavailable', async () => {
    const { tools } = runner();
    for (const [tool, input] of [
      ['serp_results', { query: 'tea' }],
      ['search_intent', { query: 'tea' }],
      ['run_ai_search', { query: 'tea' }],
      ['gsc_performance', {}],
      ['mcp__srv__tool', {}],
    ] as const) {
      expect(await tools.run(tool, input, { tabId: TAB, signal: new AbortController().signal, via: 'read', expectedOrigin: null, expectedUrl: null })).toEqual({ ok: false, code: 'unavailable' });
    }
  });

  test('browser-runner-wiring', async () => {
    const page = domContents('<p>Text</p>');
    const other = domContents('<p>Other</p>', { url: 'https://example.com/guides/page?x=1' });
    const live = { ...page.contents, on: () => undefined, removeListener: () => undefined, getTitle: () => 'Guide' };
    const dead = { ...other.contents, isDestroyed: () => true, on: () => undefined, removeListener: () => undefined, getTitle: () => '' };
    const browser = {
      tabIdOf: (contents: unknown) => (contents === live || contents === dead ? TAB : null),
      getState: () => ({ activeTabId: TAB }),
      navigate: vi.fn(() => true),
      seo: { getAudit: vi.fn((): SeoAuditResponse => ({ status: 'pending', url: PAGE })) },
    };
    const tools = createBrowserPageToolRunner({ browser, webContents: { getAllWebContents: () => [dead, live] } });
    expect(dataOf(await run({ run: tools.run } as never, 'page_text', {}, 'read')).text).toBe('Text');
    expect(page.calls).toHaveLength(1);
    expect(other.calls).toHaveLength(0);
    expect(dataOf(await run({ run: tools.run } as never, 'page_audit', {}, 'read'))).toMatchObject({ status: 'pending' });
    expect(browser.seo.getAudit).toHaveBeenCalledWith(TAB);
  });

  test('agent-worlds-distinct', () => {
    expect(AGENT_PAGE_WORLD_ID).not.toBe(AGENT_JS_WORLD_ID);
    for (const id of [AGENT_PAGE_WORLD_ID, AGENT_JS_WORLD_ID]) {
      expect(NON_AGENT_WORLD_IDS).not.toContain(id);
      expect(Number.isInteger(id) && id >= 1 && id <= 536_870_911).toBe(true);
    }
  });
});

describe('the URL the model sees (whole-branch review)', () => {
  test('model-page-url-drops-user-info-and-fragment', async () => {
    const { modelPageUrl } = await import('@app/specs/agent-page-tools.spec');
    const { gscPageUrl } = await import('@app/specs/agent-search-tools.spec');
    expect(modelPageUrl('https://user:secret@example.com/a?q=1#top')).toBe('https://example.com/a?q=1');
    expect(modelPageUrl('http://example.com/')).toBe('http://example.com/');
    for (const other of ['file:///etc/passwd', 'app://app/', '', null, 5]) expect(modelPageUrl(other)).toBeNull();
    expect(gscPageUrl('https://user:secret@example.com/a#x')).toBe(modelPageUrl('https://user:secret@example.com/a#x'));
  });
});
