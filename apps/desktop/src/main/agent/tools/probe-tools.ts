import type { PortAnswer, ProbeReport, ProbesPort } from '@app/ai-skills';
import { isPublicPage } from '@app/specs/agent-approvals.spec';
import { gscPageUrl, PROBE_TOOL_LIMITS as P, PROBE_TOOL_REASONS, PROBE_TOOL_SOURCE, SEARCH_TOOL_LIMITS } from '@app/specs/agent-search-tools.spec';
import type { ToolErrorCode } from '@app/specs/agent-tools.spec';
import type { ToolRunContext, ToolRunOutcome } from '../approvals';
import { cleanText, fitBudget } from './search-tools';

// `visibility_probes` and `run_visibility_probes` (Phase 5 Task 8, the SERP wiring; spec
// `specs/agent-search-tools.spec.ts`, Visibility probes; acceptance
// `specs/agent-search-tools.feature.md`, Probes) over Phase 3's probes (`ProbesPort`).
// - Both are page tools (`PAGE_TOOLS`): the runner's page check first (the tab still shows the
//   expected page; an approved run exactly the approved page), and a report for another page is not
//   handed on.
// - `visibility_probes` (read) only reads the last run; it never starts one.
// - `run_visibility_probes` (act: the broker asked the user, or a standing grant for the page's
//   origin covered it; never `via: 'read'`) starts a run, then waits for it (polling the read side,
//   at most `PROBE_TOOL_LIMITS.waitMs`) and answers what each agent was served. Stop ends only the
//   wait: Phase 3's run has no stop, so a run already started finishes.
// - Bounded against amplification (security review): only a public page is probed (the broker
//   answers a private one as the call arrives; this refuses it again), at most `maxRunsPerTurn` run
//   per page in one turn (the broker's `turn` token), and none for the same tab and page within
//   `cooldownMs`; a call past either reads the last report (`reused: true`) and fetches nothing.
// Every answer is bounded (`SEARCH_TOOL_LIMITS.budgetChars`; strings cut, directives capped).

export interface ProbePageCheck {
  /** Whether a report's `url` is the page expected. */
  matches(url: unknown): boolean;
}

export interface ProbeToolDeps {
  readonly port: ProbesPort | null;
  /** The runner's page check: the expectation, or why the call acts on nothing. */
  readonly page: (context: ToolRunContext) => ProbePageCheck | ToolErrorCode;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly now?: () => number;
}

const fail = (code: ToolErrorCode): ToolRunOutcome => ({ ok: false, code });
const ok = (data: unknown): ToolRunOutcome => ({ ok: true, data, source: PROBE_TOOL_SOURCE });

/** A report as the model reads it: bounded strings, totals kept. */
function bounded(report: ProbeReport) {
  const text = (value: unknown, max: number) => cleanText(value, max);
  return fitBudget(
    {
      url: text(report.url, P.maxUrlChars),
      status: text(report.status, 32),
      startedAt: text(report.startedAt, 64),
      finishedAt: text(report.finishedAt, 64),
      agents: report.agents.map((agent) => ({
        agent: text(agent.agent, 64),
        kind: text(agent.kind, 32),
        outcome: text(agent.outcome, 64),
        status: agent.status,
        redirects: agent.redirects,
        finalUrl: text(agent.finalUrl, P.maxUrlChars),
        robots: text(agent.robots, 32),
        noindex: agent.noindex,
        nofollow: agent.nofollow,
        canonical: text(agent.canonical, P.maxUrlChars),
        wordCount: agent.wordCount,
        title: text(agent.title, P.maxTitleChars),
        differsIn: agent.differsIn.slice(0, P.maxDirectives).map((fact) => text(fact, 32)),
        textSimilarity: agent.textSimilarity,
      })),
      agentsTotal: report.agents.length,
    },
    'agents',
  );
}

export function createProbeTools(deps: ProbeToolDeps) {
  /** The pages each turn has probed (by the broker's turn token). */
  const runsByTurn = new WeakMap<object, Map<string, number>>();
  /** When each tab page was last probed (insertion order: oldest first), for the cooldown. */
  const lastRun = new Map<string, number>();
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;

  /** Waits `ms`, or until `signal` aborts (`false` then). */
  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      const onAbort = () => {
        clearTimer(timer);
        resolve(false);
      };
      const timer = setTimer(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });

  /** The last run as an outcome: the report if it is the expected page's, else why there is none. */
  const answerOf = (answer: PortAnswer<ProbeReport>, check: ProbePageCheck): ToolRunOutcome => {
    if (answer.status === 'unavailable') {
      const reason = cleanText(answer.reason, SEARCH_TOOL_LIMITS.maxReasonChars) || 'This data source gave no reason.';
      return ok({ unavailable: reason, ...(typeof answer.state === 'string' ? { state: answer.state } : {}) });
    }
    if (answer.status !== 'ok' || typeof answer.data !== 'object' || answer.data === null || !Array.isArray(answer.data.agents)) return fail('failed');
    if (!check.matches(answer.data.url)) return ok({ unavailable: PROBE_TOOL_REASONS.otherPage });
    return ok(bounded(answer.data));
  };

  const read = async (port: ProbesPort, context: ToolRunContext, check: ProbePageCheck): Promise<ToolRunOutcome> => {
    try {
      return answerOf(await port.latest(context.tabId, { signal: context.signal, tabId: context.tabId }), check);
    } catch {
      return fail('failed');
    }
  };

  return {
    async run(toolName: 'visibility_probes' | 'run_visibility_probes', context: ToolRunContext): Promise<ToolRunOutcome> {
      if (context.signal.aborted) return fail('failed');
      const port = deps.port;
      if (port === null) return fail('unavailable');
      // Fetching is acting: only the user's approval or a standing grant runs it.
      if (toolName === 'run_visibility_probes' && context.via === 'read') return fail('not-allowed');
      const check = deps.page(context);
      if (typeof check === 'string') return fail(check);
      if (toolName === 'visibility_probes') return read(port, context, check);

      // Only a public page is fetched (the broker already answers a private one without asking).
      const page = gscPageUrl(context.expectedUrl);
      if (page === null || !isPublicPage(page)) return ok({ unavailable: PROBE_TOOL_REASONS.privatePage });
      const key = `${context.tabId} ${page}`;
      const turnRuns = context.turn === undefined ? null : (runsByTurn.get(context.turn) ?? new Map<string, number>());
      if (context.turn !== undefined && turnRuns !== null) runsByTurn.set(context.turn, turnRuns);
      const previous = lastRun.get(key);
      const capped = turnRuns !== null && (turnRuns.get(key) ?? 0) >= P.maxRunsPerTurn;
      if (capped || (previous !== undefined && now() - previous < P.cooldownMs)) {
        // Nothing is fetched again: the last report, if there is one for this page.
        const last = await read(port, context, check);
        if (last.ok && typeof last.data === 'object' && last.data !== null && !('unavailable' in last.data)) return ok({ reused: true, ...(last.data as Record<string, unknown>) });
        return ok({ reused: true, unavailable: PROBE_TOOL_REASONS.cooldown });
      }
      // Counted before the call (a second call can't slip in while this one awaits).
      turnRuns?.set(key, (turnRuns.get(key) ?? 0) + 1);
      lastRun.delete(key);
      lastRun.set(key, now());
      while (lastRun.size > P.maxTracked) lastRun.delete(lastRun.keys().next().value!);
      const forget = () => {
        turnRuns?.set(key, Math.max(0, (turnRuns.get(key) ?? 1) - 1));
        if (previous === undefined) lastRun.delete(key);
        else lastRun.set(key, previous);
      };

      let started: PortAnswer<{ readonly started: boolean }>;
      try {
        started = await port.run(context.tabId, { signal: context.signal, tabId: context.tabId });
      } catch {
        forget();
        return fail('failed');
      }
      if (started.status !== 'ok' || started.data.started !== true) forget();
      if (context.signal.aborted) return fail('failed');
      if (started.status === 'unavailable') return answerOf(started, check);
      if (started.status !== 'ok' || started.data.started !== true) return ok({ started: false, unavailable: PROBE_TOOL_REASONS.notActive });
      // Wait for the run (it fetches several times), then answer what it found, or how far it got.
      const deadline = now() + P.waitMs;
      let last: ToolRunOutcome = fail('failed');
      for (;;) {
        last = await read(port, context, check);
        const status = last.ok && typeof last.data === 'object' && last.data !== null ? (last.data as { status?: unknown }).status : null;
        if (status !== 'running' || now() >= deadline) break;
        if (!(await pause(P.pollMs, context.signal))) return fail('failed');
      }
      return last.ok ? ok({ started: true, ...(last.data as Record<string, unknown>) }) : last;
    },
  };
}
