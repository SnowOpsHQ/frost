import { unavailable, type PortAnswer, type ProbeAgentResult, type ProbeReport, type ProbesPort } from '@app/ai-skills';
import { gscPageUrl, PROBE_TOOL_REASONS } from '@app/specs/agent-search-tools.spec';
import { PROBE_AGENTS } from '@app/specs/visibility-probes.spec';

// The `ProbesPort` over Phase 3's visibility probes (Phase 5 Task 8, the SERP wiring; acceptance
// `specs/agent-search-tools.feature.md`, Probes). Written against the merged `SerpReadApi`
// (`packages/ipc-contract/src/serp-service.ts`; `main/serp/setup.ts` sets `probes: probes.state,
// runProbes: probes.run`) and `specs/visibility-probes.schema.ts` (`ProbesState`):
// - `probes(tabId)` is read-only (the tab's last run for the page it shows now; never fetches);
// - `runProbes(tabId)` **fetches on the user's behalf** (the page once per `PROBE_AGENTS` entry,
//   each with that agent's user agent, plus robots.txt from main's cache), only for the active tab
//   showing an `http(s)` page; `true` if a run is under way. Main's broker lets the agent reach it
//   only through `run_visibility_probes` (`act`: approval, or a grant for the page's origin).
// The types are minimal structural copies; the merged `SerpReadApi` is assignable to
// `ProbesReadApiLike` (type-level test).

type Directives = { readonly general: readonly string[]; readonly agent: readonly string[] } | null;

/** One agent's row (`ProbeRowSchema`), as far as the adapter reads it. */
export interface ProbeRowLike {
  readonly agent: string;
  readonly outcome: string;
  readonly status: number | null;
  readonly hops: readonly unknown[];
  readonly finalUrl: string | null;
  readonly robots: { readonly verdict: string } | null;
  readonly metaRobots?: Directives;
  readonly noindex: boolean | null;
  readonly nofollow: boolean | null;
  readonly canonical: string | null;
  readonly wordCount: number | null;
  readonly title: string | null;
}

/** A tab's probe state (`ProbesStateSchema`), as far as the adapter reads it. */
export interface ProbesStateLike {
  readonly url: string;
  readonly status: string;
  readonly rows: readonly ProbeRowLike[];
  readonly diffs: readonly { readonly agent: string; readonly facts: readonly string[]; readonly textSimilarity: number | null }[];
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/** Phase 3's `SerpReadApi`, the members this adapter calls. */
export interface ProbesReadApiLike {
  probes(tabId: number): ProbesStateLike;
  runProbes(tabId: number): boolean;
}

const KIND = new Map<string, string>(PROBE_AGENTS.map((agent) => [agent.id, agent.kind]));
const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());

/** A probe state as the model reads it: per agent, what it was served and what differs from the browser's answer. */
export function probeReportOf(state: ProbesStateLike): ProbeReport {
  const diffs = new Map(state.diffs.map((diff) => [diff.agent, diff]));
  const agents: ProbeAgentResult[] = state.rows.map((row) => ({
    agent: row.agent,
    kind: KIND.get(row.agent) ?? 'unknown',
    outcome: row.outcome,
    status: row.status,
    redirects: row.hops.length,
    // User info never reaches the model (the page URL helper drops it, and the fragment).
    finalUrl: row.finalUrl === null ? null : gscPageUrl(row.finalUrl),
    robots: row.robots?.verdict ?? null,
    noindex: row.noindex,
    nofollow: row.nofollow,
    canonical: row.canonical,
    wordCount: row.wordCount,
    title: row.title,
    differsIn: [...(diffs.get(row.agent)?.facts ?? [])],
    textSimilarity: diffs.get(row.agent)?.textSimilarity ?? null,
  }));
  return { url: gscPageUrl(state.url) ?? '', status: state.status, startedAt: iso(state.startedAt), finishedAt: iso(state.finishedAt), agents };
}

/** `readApi` as a `ProbesPort`, or `null` without one. */
export function probesAdapter(readApi: ProbesReadApiLike | null | undefined): ProbesPort | null {
  if (!readApi) return null;
  return {
    async latest(tabId, options): Promise<PortAnswer<ProbeReport>> {
      let state: ProbesStateLike;
      try {
        state = readApi.probes(tabId);
      } catch {
        return unavailable('The visibility probes could not be read.');
      }
      options?.signal?.throwIfAborted();
      if (state.status === 'idle') return unavailable(PROBE_TOOL_REASONS.idle, 'idle');
      return { status: 'ok', data: probeReportOf(state) };
    },
    async run(tabId, options): Promise<PortAnswer<{ readonly started: boolean }>> {
      options?.signal?.throwIfAborted();
      let started = false;
      try {
        started = readApi.runProbes(tabId) === true;
      } catch {
        started = false;
      }
      return { status: 'ok', data: { started } };
    },
  };
}
