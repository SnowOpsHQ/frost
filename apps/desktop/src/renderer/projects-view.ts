// Type-only: the schema file holds Zod, which must stay out of the chrome's bundle (strict Trusted Types).
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { SEARCH_ENGINES } from '@app/specs/browser-polish.spec';
import { UNFILED_PROJECT_ID, type RetentionMode } from '@app/specs/capture-db.spec';
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
import {
  PURGE_REASON_LABELS,
  RETENTION_REFUSAL_MESSAGES,
  RETENTION_RULE_NOTES,
  RETENTION_VALUE_BOUNDS,
  formatBytes,
  plural,
  purgeCountsText,
  type CompactAnswer,
  type PurgeLogEntry,
  type PurgeNowAnswer,
  type RetentionPolicyInput,
  type RetentionPreviewAnswer,
  type RetentionRefused,
  type RetentionUsage,
} from '@app/specs/retention.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// The Projects sheet's pure helpers (acceptance `projects.feature.md`, The sheet): the render-profile
// choice, the query form, a page address as typed, the wording of captures, runs and refusals, and the
// Changes panel's default project; and the retention section's policy form and wording (acceptance
// `retention.feature.md`, The project view). No React, no IPC.

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

/** Loopback hosts a scheme-less address gets `http:` for (as the address bar: `LOOPBACK_HTTP_HOSTS`, `LOOPBACK_IPV4_PATTERN`). */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '[::1]', '0.0.0.0'];
const LOOPBACK_IPV4 = /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** A typed host with a port and no scheme (`localhost:3000/x`): not a scheme. */
const HOST_WITH_PORT = /^[^/?#:@]+:\d+(?:[/?#]|$)/;

/**
 * A page address as typed, resolved as the address bar resolves it (`main/browser/address.ts`, which
 * the chrome cannot bundle): `http(s)` as it is; a scheme-less address (`example.com/x`,
 * `localhost:3000/x`) with `http:` for a loopback host and `https:` for any other; `null` for another
 * scheme, userinfo or spaces.
 */
export function pageUrlFromInput(text: string): string | null {
  const value = text.trim();
  if (value === '' || /\s/.test(value)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme && !HOST_WITH_PORT.test(value)) return parseWebUrl(value)?.href ?? null;
  const authority = /^[^/?#]*/.exec(value)?.[0] ?? '';
  if (authority.includes('@')) return null;
  const host = authority.replace(/:\d+$/, '').toLowerCase();
  const parsed = parseWebUrl(`${LOOPBACK_HOSTS.includes(host) || LOOPBACK_IPV4.test(host) ? 'http' : 'https'}://${value}`);
  return parsed && parsed.port !== '0' ? parsed.href : null;
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

/**
 * The project the picker keeps: the current choice while it is listed, else the page's default (if
 * listed), else Unfiled (`undefined`).
 */
export function pickedProject(list: readonly Pick<ProjectSummary, 'id'>[], current: string | undefined, fallback: string | undefined): string | undefined {
  if (current === undefined || list.some((project) => project.id === current)) return current;
  return fallback !== undefined && list.some((project) => project.id === fallback) ? fallback : undefined;
}

/** Projects as the picker lists them: Unfiled first (as main answers), each once. */
export function pickerProjects(projects: readonly ProjectSummary[]): ProjectSummary[] {
  const seen = new Set<string>();
  return projects.filter((project) => !seen.has(project.id) && (seen.add(project.id), true));
}

// ---- Retention (Task 7) -------------------------------------------------------------------------

/** The policy form as typed: the mode, and N as text. */
export interface RetentionForm {
  readonly mode: RetentionMode;
  readonly value: string;
}

/** The form showing a project's policy. */
export function retentionFormOf(retention: { readonly mode: RetentionMode; readonly value: number | null }): RetentionForm {
  return { mode: retention.mode, value: retention.value === null ? '' : String(retention.value) };
}

const WHOLE = /^\d{1,9}$/;
const NUMBER = new Intl.NumberFormat('en-US');

/** The policy the form describes, or what to fix (main checks it again). */
export function retentionFromForm(form: RetentionForm): { readonly policy: RetentionPolicyInput } | { readonly problem: string } {
  if (form.mode === 'forever') return { policy: { mode: 'forever', value: null } };
  if (form.mode !== 'versions' && form.mode !== 'days') return { problem: 'Choose what to keep.' };
  const { min, max } = RETENTION_VALUE_BOUNDS[form.mode];
  const text = form.value.trim();
  const value = WHOLE.test(text) ? Number(text) : Number.NaN;
  if (!(value >= min && value <= max)) return { problem: `Enter a whole number from ${NUMBER.format(min)} to ${NUMBER.format(max)}.` };
  return { policy: { mode: form.mode, value } };
}

/** What a policy keeps, in a line. */
export const retentionNote = (mode: RetentionMode): string => RETENTION_RULE_NOTES[mode];

const retentionRefusal = (answer: RetentionRefused): string => RETENTION_REFUSAL_MESSAGES[answer.reason] ?? 'Something went wrong. Try again.';

/** The preview line: what "Purge now" would remove. */
export function previewText(answer: RetentionPreviewAnswer | null): string {
  if (answer === null) return 'The preview could not be read.';
  if (answer.status === 'refused') return retentionRefusal(answer);
  if (answer.policy.mode === 'forever') return 'Keep everything: purging removes nothing.';
  const { counts } = answer;
  if (counts.captures + counts.versions + counts.diffs + counts.screenshots === 0) return 'Purging now would remove nothing.';
  return `Purging now would remove ${purgeCountsText(counts)} (≈ ${formatBytes(answer.bytes)}).`;
}

/** What "Purge now" did. */
export function purgeNowText(answer: PurgeNowAnswer | null): string {
  if (answer === null) return 'The purge could not be run. Try again.';
  switch (answer.status) {
    case 'purged':
      return `Purged ${purgeCountsText(answer.counts)} (≈ ${formatBytes(answer.bytes)}).`;
    case 'empty':
      return 'Nothing to purge.';
    case 'changed':
      return 'The captures changed while you were asked, so nothing was deleted. Try again.';
    default:
      return retentionRefusal(answer);
  }
}

/** What "Compact database" did. */
export function compactText(answer: CompactAnswer | null): string {
  if (answer === null) return 'The database could not be compacted. Try again.';
  if (answer.status === 'refused') return retentionRefusal(answer);
  return `Compacted the change database: ${formatBytes(answer.before)} → ${formatBytes(answer.after)}.`;
}

/** The usage figures, as rows of the project view. */
export function usageRows(usage: RetentionUsage): { readonly id: string; readonly label: string; readonly value: string }[] {
  const shared = usage.sharedVersions > 0 ? ` (${NUMBER.format(usage.sharedVersions)} also in another project)` : '';
  const missing = usage.files.missing > 0 ? ` · ${NUMBER.format(usage.files.missing)} missing` : '';
  return [
    { id: 'captures', label: 'Captures', value: NUMBER.format(usage.captures) },
    { id: 'versions', label: 'Versions', value: `${NUMBER.format(usage.versions)}${shared}` },
    { id: 'screenshots', label: 'Screenshots', value: NUMBER.format(usage.screenshots) },
    { id: 'stored', label: 'Stored snapshots and diffs', value: `${formatBytes(usage.snapshotBytes)} + ${formatBytes(usage.diffBytes)}` },
    { id: 'files', label: 'Screenshot files', value: `${plural(usage.files.count, 'file', 'files')}, ${formatBytes(usage.files.bytes)}${missing}` },
    { id: 'database', label: 'Database file (all projects)', value: usage.database === null ? 'In memory this session' : formatBytes(usage.database.bytes + usage.database.walBytes) },
  ];
}

/** A purge log row's parts: when, why, and what went. */
export function purgeLogText(entry: PurgeLogEntry): { readonly when: string; readonly reason: string; readonly what: string } {
  return {
    when: new Date(entry.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    reason: PURGE_REASON_LABELS[entry.reason],
    what: `${purgeCountsText(entry.counts)} · ${formatBytes(entry.bytes)}`,
  };
}
