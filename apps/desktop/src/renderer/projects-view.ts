// Type-only: the schema file holds Zod, which must stay out of the chrome's bundle (strict Trusted Types).
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { SEARCH_ENGINES } from '@app/specs/browser-polish.spec';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import {
  PROJECT_REFUSAL_MESSAGES,
  RUN_REFUSAL_MESSAGES,
  RUN_STATE_LABELS,
  type AddPageAnswer,
  type ProjectRefusal,
  type ProjectSummary,
  type RunState,
  type RunStateName,
  type StartRunAnswer,
} from '@app/specs/projects.spec';
import { QUICK_RENDER_PROFILES, isDefaultRenderProfile, sameRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// The Projects sheet's pure helpers (acceptance `projects.feature.md`, The sheet): the render-profile
// choice, the query form, a page address as typed, the wording of captures, runs and refusals, and the
// Changes panel's default project. No React, no IPC.

/** The render-profile choices of a project: frost's default, or one of the quick profiles. */
export const PROJECT_PROFILE_CHOICES: readonly { readonly id: string; readonly label: string; readonly profile: RenderProfile | null }[] = [
  { id: 'default', label: 'Default', profile: null },
  ...QUICK_RENDER_PROFILES.map((quick) => ({ id: quick.id, label: quick.label, profile: quick.profile })),
];

/** The choice a project's profile is (`custom` when it is none of them: set elsewhere). */
export function profileChoiceOf(profile: RenderProfile | null): string {
  if (profile === null || isDefaultRenderProfile(profile)) return 'default';
  return QUICK_RENDER_PROFILES.find((quick) => sameRenderProfile(quick.profile, profile))?.id ?? 'custom';
}

/** The profile of choice `id` (`undefined`: no such choice). */
export function profileOfChoice(id: string): RenderProfile | null | undefined {
  const choice = PROJECT_PROFILE_CHOICES.find((option) => option.id === id);
  return choice === undefined ? undefined : choice.profile;
}

/** The search engines a query can use, as the form lists them. */
export const QUERY_ENGINES = SEARCH_ENGINES.map((engine) => ({ id: engine.id, label: engine.label }));

/** The query form as typed. */
export interface QueryForm {
  readonly engine: string;
  readonly query: string;
  readonly country: string;
  readonly language: string;
  readonly location: string;
  readonly device: string;
}

export const EMPTY_QUERY_FORM: QueryForm = { engine: SEARCH_ENGINES[0].id, query: '', country: '', language: '', location: '', device: '' };

const COUNTRY = /^[a-z]{2}$/;
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

/**
 * The search the form describes: trimmed, the country and language lowercased, blanks as `null`; or
 * what to fix (main checks it again with `SearchParamsSchema`).
 */
export function queryFromForm(form: QueryForm): { readonly params: SearchParams } | { readonly problem: string } {
  const engine = SEARCH_ENGINES.find((candidate) => candidate.id === form.engine)?.id;
  const query = form.query.trim();
  const country = form.country.trim().toLowerCase();
  const language = form.language.trim().toLowerCase();
  const location = form.location.trim();
  if (engine === undefined) return { problem: 'Choose a search engine.' };
  if (query === '') return { problem: 'Enter a query.' };
  if (country !== '' && !COUNTRY.test(country)) return { problem: 'A country is two letters, like “de”.' };
  if (language !== '' && (!LANGUAGE.test(language) || language.length > 35)) return { problem: 'A language is a code like “en” or “pt-br”.' };
  const device = form.device === 'desktop' || form.device === 'mobile' ? form.device : null;
  return { params: { engine, query, country: country === '' ? null : country, language: language === '' ? null : language, location: location === '' ? null : location, device } };
}

/** A page address as typed: `http(s)` as it is, or a bare host (and path) as `https://`; `null` when neither. */
export function pageUrlFromInput(text: string): string | null {
  const value = text.trim();
  if (value === '') return null;
  const parsed = parseWebUrl(value) ?? (/^[a-z][a-z0-9+.-]*:/i.test(value) ? null : parseWebUrl(`https://${value}`));
  return parsed?.href ?? null;
}

/** When a page or query was last captured into the project. */
export function lastCaptureText(lastCapturedAt: number | null): string {
  return lastCapturedAt === null ? 'Not captured yet' : `Captured ${new Date(lastCapturedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** The latest version's change count in words (`null`: a first version, or never captured). */
export function changeCountText(changeCount: number | null, captured: boolean): string {
  if (!captured) return '';
  if (changeCount === null) return 'First version';
  if (changeCount === 0) return 'No changes';
  return changeCount === 1 ? '1 change' : `${changeCount} changes`;
}

/** Whether a run is under way. */
export const runActive = (state: RunStateName): boolean => state === 'running' || state === 'waiting-for-tab';

/** A run's progress in a line: its state, and how far it got. */
export function runProgressText(run: Pick<RunState, 'state' | 'current' | 'total' | 'omitted' | 'targets'>): string {
  const captured = run.targets.filter((target) => target.outcome === 'captured').length;
  const omitted = run.omitted > 0 ? ` (${run.omitted} more not visited: a run visits at most ${run.total})` : '';
  if (runActive(run.state)) return `${RUN_STATE_LABELS[run.state]} ${Math.max(run.current, 1)} of ${run.total}${omitted}`;
  if (run.state === 'idle') return RUN_STATE_LABELS.idle;
  return `${RUN_STATE_LABELS[run.state]}: ${captured} of ${run.total} captured${omitted}`;
}

/** A refusal in words; `null` for none. */
export function refusalText(answer: { readonly status: string } | null): string | null {
  if (answer === null) return 'Something went wrong. Try again.';
  if (answer.status !== 'refused') return null;
  const reason = (answer as { readonly reason?: unknown }).reason;
  return typeof reason === 'string' && Object.hasOwn(PROJECT_REFUSAL_MESSAGES, reason) ? PROJECT_REFUSAL_MESSAGES[reason as ProjectRefusal] : 'Something went wrong. Try again.';
}

/** Why a run did not start; `null` when it started. */
export function startRunText(answer: StartRunAnswer | null): string | null {
  if (answer === null) return 'The run could not be started. Try again.';
  return answer.status === 'refused' ? RUN_REFUSAL_MESSAGES[answer.reason] : null;
}

/** What adding a page said. */
export function addPageText(answer: AddPageAnswer | null): string {
  return refusalText(answer) ?? 'Page added.';
}

/**
 * The project the Changes panel files captures in by default: the first project listing the page
 * (Unfiled aside, as it is the default anyway), else Unfiled (`undefined`).
 */
export function defaultCaptureProject(forPage: readonly Pick<ProjectSummary, 'id'>[]): string | undefined {
  return forPage.find((project) => project.id !== UNFILED_PROJECT_ID)?.id;
}

/** Projects as the picker lists them: Unfiled first (as main answers), each once. */
export function pickerProjects(projects: readonly ProjectSummary[]): ProjectSummary[] {
  const seen = new Set<string>();
  return projects.filter((project) => !seen.has(project.id) && (seen.add(project.id), true));
}
