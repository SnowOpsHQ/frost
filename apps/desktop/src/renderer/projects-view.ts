import { SEARCH_ENGINES } from '@app/specs/browser-polish.spec';
import { MAX_PROJECT_QUERIES, UNFILED_PROJECT_ID, type RetentionMode } from '@app/specs/capture-db.spec';
import { AUTO_CAPTURE_AVAILABLE, CADENCE_TEXT, CAPTURE_CADENCE_LABELS, RANK_CHECK_AVAILABLE } from '@app/specs/capture-schedule.spec';
import {
  BULK_ADD_TEXT,
  BULK_LINE_OUTCOME_LABELS,
  BULK_SEARCH_LIMITS,
  CHECK_RANKINGS_TEXT,
  DUE_TEXT,
  FAVORITE_TEXT,
  PROJECT_REFUSAL_MESSAGES,
  PROJECT_SETTINGS_TEXT,
  PROJECT_SORTS,
  PROJECT_SORT_LABELS,
  QUERY_FIELD_MAX_CHARS,
  RUN_BLOCKED_NOTE,
  RUN_BLOCK_REASON_LABELS,
  RUN_REFUSAL_MESSAGES,
  RUN_STATE_LABELS,
  SITE_INPUT_MAX_CHARS,
  TAG_EDITOR_TEXT,
  TAG_INPUT_MAX_CHARS,
  normalizeSiteDomain,
  normalizeTags,
  sortProjects,
  splitBulkSearches,
  type AddCompetitorAnswer,
  type AddPageAnswer,
  type BulkAddAnswer,
  type BulkLineOutcome,
  type BulkLocale,
  type BulkSearchesInput,
  type ProjectChangeAnswer,
  type ProjectCompetitor,
  type ProjectRefusal,
  type ProjectSite,
  type ProjectSort,
  type ProjectSummary,
  type RunState,
  type SavedSearchInput,
  type RunStateName,
  type SetSiteAnswer,
  type SetTagsAnswer,
  type StartRunAnswer,
} from '@app/specs/projects.spec';
import { CAPTURE_CADENCES, MAX_PROJECT_COMPETITORS, MAX_TAGS_PER_ENTRY, type CaptureCadence } from '@app/specs/workspace-db.spec';
import { QUICK_RENDER_PROFILES, isDefaultRenderProfile, sameRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import { SERP_DEVICES } from '@app/specs/serp.spec';
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
// Changes panel's default project; the retention section's policy form and wording (acceptance
// `retention.feature.md`, The project view); and (Phase 10 Task 7) the list's star and sort, the
// Settings view's site and competitors, the tag editor and the Bulk add form; (Task 8) "Due", Check
// rankings, the cadence menu and a blocked run's note. No React, no IPC.

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
  readonly device: string;
}

export const EMPTY_QUERY_FORM: QueryForm = { engine: SEARCH_ENGINES[0].id, query: '', country: '', language: '', device: 'desktop' };

const COUNTRY = /^[a-z]{2}$/;
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

/**
 * The search the form describes: trimmed, the country and language lowercased, blanks as `null`; or
 * what to fix (main checks it again with `SavedSearchInputSchema`, then reads its URL as Phase 3 does).
 */
export function queryFromForm(form: QueryForm): { readonly search: SavedSearchInput } | { readonly problem: string } {
  const engine = SEARCH_ENGINES.find((candidate) => candidate.id === form.engine)?.id;
  const query = form.query.trim();
  const country = form.country.trim().toLowerCase();
  const language = form.language.trim().toLowerCase();
  const device = SERP_DEVICES.find((candidate) => candidate === form.device);
  if (engine === undefined) return { problem: 'Choose a search engine.' };
  if (query === '') return { problem: 'Enter a query.' };
  const locale = localeProblem(country, language);
  if (locale !== null) return { problem: locale };
  if (device === undefined) return { problem: 'Choose a device.' };
  return { search: { engine, query, country: country === '' ? null : country, language: language === '' ? null : language, device } };
}

/** A country as the forms take it, and a language (as `SavedSearchInputSchema`). */
function localeProblem(country: string, language: string): string | null {
  if (country !== '' && !COUNTRY.test(country)) return 'A country is two letters, like “de”.';
  if (language !== '' && (!LANGUAGE.test(language) || language.length > QUERY_FIELD_MAX_CHARS.language)) return 'A language is a code like “en” or “pt-br”.';
  return null;
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

// ---- Phase 10 Task 8: Due, Check rankings, the cadence, a blocked run ---------------------------

/** "Due" beside a project in the list (its cadence says a run is due); `null` for none (Unfiled never). */
export function dueLabel(project: Pick<ProjectSummary, 'due' | 'unfiled'>): string | null {
  return project.due && !project.unfiled ? DUE_TEXT.label : null;
}

/** The Check rankings button: the saved searches only; disabled with none, or while a run is under way. */
export function checkRankingsButton(searches: number, busy: boolean): { readonly label: string; readonly disabled: boolean; readonly title: string | undefined } {
  return { label: CHECK_RANKINGS_TEXT.button, disabled: busy || searches === 0, title: searches === 0 ? CHECK_RANKINGS_TEXT.none : undefined };
}

/** The cadence menu's options, in `CAPTURE_CADENCES` order. */
export const CADENCE_OPTIONS: readonly { readonly value: CaptureCadence; readonly label: string }[] = CAPTURE_CADENCES.map((value) => ({ value, label: CAPTURE_CADENCE_LABELS[value] }));

/** The menu's value as a cadence (`null`: not one). */
export function cadenceOf(value: string): CaptureCadence | null {
  return CAPTURE_CADENCES.find((cadence) => cadence === value) ?? null;
}

/** Whether Settings shows the "Start automatically" switch: only when automatic starts are offered (never in this phase). */
export const showAutoCaptureSwitch = (): boolean => AUTO_CAPTURE_AVAILABLE;

/**
 * Whether the sheet shows "Check rankings", the list's "Due" and the Settings view's cadence section
 * (`RANK_CHECK_AVAILABLE`: `false` until the owner's L1 note, plan Decision 10). The components ask
 * this, never the flag, so their tests can inject it.
 */
export const rankCheckShown = (): boolean => RANK_CHECK_AVAILABLE;

/** The Bulk add note: names Check rankings and the cadence only when they are offered (`shown`: `rankCheckShown()`), else Capture now alone. */
export const bulkAddNote = (shown: boolean): string => (shown ? BULK_ADD_TEXT.note : BULK_ADD_TEXT.noteWithoutRankCheck);

/** What setting the cadence said (the disclosure answered Cancel: nothing changed). */
export function cadenceText(answer: ProjectChangeAnswer | null): string {
  if (answer?.status === 'refused' && answer.reason === 'declined') return CADENCE_TEXT.declined;
  return refusalText(answer) ?? CADENCE_TEXT.saved;
}

/** A run that ended `blocked`: why, and what it means (`null` for any other run). */
export function blockedRunNote(run: Pick<RunState, 'state' | 'blockedReason'>): { readonly reason: string; readonly note: string } | null {
  if (run.state !== 'blocked') return null;
  const why = run.blockedReason !== null && Object.hasOwn(RUN_BLOCK_REASON_LABELS, run.blockedReason) ? `: ${RUN_BLOCK_REASON_LABELS[run.blockedReason]}` : '.';
  return { reason: `${RUN_STATE_LABELS.blocked}${why}`, note: RUN_BLOCKED_NOTE };
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

// ---- Star and sort (Phase 10 Task 7) -------------------------------------------------------------

/** The sort menu's options, in `PROJECT_SORTS` order. */
export const PROJECT_SORT_OPTIONS: readonly { readonly value: ProjectSort; readonly label: string }[] = PROJECT_SORTS.map((value) => ({ value, label: PROJECT_SORT_LABELS[value] }));

/** The sort a menu value names (`name` for anything else). */
export function projectSortOf(value: string): ProjectSort {
  return PROJECT_SORTS.find((sort) => sort === value) ?? 'name';
}

/** The list as shown: `sortProjects` (Unfiled first, then favorites); the answer is left as it is. */
export function listedProjects<T extends Parameters<typeof sortProjects>[0][number]>(projects: readonly T[], sort: ProjectSort): T[] {
  return sortProjects(projects, sort);
}

/** The star of a project: whether it is pressed, what a press sets, and its (fixed) accessible name. */
export function favoriteButton(project: Pick<ProjectSummary, 'name' | 'favorite'>): { readonly pressed: boolean; readonly next: boolean; readonly label: string } {
  return { pressed: project.favorite, next: !project.favorite, label: FAVORITE_TEXT.label.replace('{name}', () => project.name) };
}

/** What starring (`favorite`) or unstarring said. */
export function favoriteText(answer: ProjectChangeAnswer | null, favorite: boolean): string {
  return refusalText(answer) ?? (favorite ? FAVORITE_TEXT.added : FAVORITE_TEXT.removed);
}

// ---- Settings: site and competitors (Phase 10 Task 7) --------------------------------------------

/** The site form as typed. */
export interface SiteForm {
  readonly domain: string;
  readonly subdomains: boolean;
}

/** The form showing a project's site (subdomains on when it has none, as main's default). */
export function siteFormOf(site: ProjectSite | null): SiteForm {
  return site === null ? { domain: '', subdomains: true } : { domain: site.domain, subdomains: site.subdomains };
}

const INVALID_DOMAIN = PROJECT_REFUSAL_MESSAGES['invalid-domain'];

/** A domain or address as typed, read as main reads it (`normalizeSiteDomain`; main reads it again). */
function domainOf(text: string): string | null {
  return text.length > SITE_INPUT_MAX_CHARS ? null : normalizeSiteDomain(text);
}

/** The `setSite` the form describes: its host, or `null` (empty: clear the site); or what to fix. */
export function siteFromForm(form: SiteForm): { readonly site: { readonly domain: string | null; readonly subdomains: boolean } } | { readonly problem: string } {
  if (form.domain.trim() === '') return { site: { domain: null, subdomains: form.subdomains } };
  const domain = domainOf(form.domain);
  return domain === null ? { problem: INVALID_DOMAIN } : { site: { domain, subdomains: form.subdomains } };
}

/** Whether the form shows another site than the saved one. */
export function siteFormChanged(form: SiteForm, site: ProjectSite | null): boolean {
  const domain = form.domain.trim();
  if (site === null) return domain !== '';
  return domain !== site.domain || form.subdomains !== site.subdomains;
}

/** What saving (or clearing) the site said. */
export function siteText(answer: SetSiteAnswer | null): string {
  const problem = refusalText(answer);
  if (problem !== null || answer === null || answer.status !== 'ok') return problem ?? '';
  return answer.site === null ? PROJECT_SETTINGS_TEXT.siteCleared : PROJECT_SETTINGS_TEXT.siteSaved;
}

/** Whether the project has a Settings form (Unfiled has no site or competitors). */
export const settingsAvailable = (project: Pick<ProjectSummary, 'unfiled'>): boolean => !project.unfiled;

/** A competitor as typed: its host, or what to fix. */
export function competitorFromInput(text: string): { readonly domain: string } | { readonly problem: string } {
  const domain = domainOf(text);
  return domain === null ? { problem: INVALID_DOMAIN } : { domain };
}

/** How many competitors the project has, of `MAX_PROJECT_COMPETITORS`, and whether one more fits. */
export function competitorRoom(count: number): { readonly canAdd: boolean; readonly text: string } {
  return { canAdd: count < MAX_PROJECT_COMPETITORS, text: `${count} of ${MAX_PROJECT_COMPETITORS}` };
}

/** What adding a competitor said (`competitors`: the list before; another host of one of them answers it). */
export function addCompetitorText(answer: AddCompetitorAnswer | null, competitors: readonly Pick<ProjectCompetitor, 'id'>[]): string {
  const problem = refusalText(answer);
  if (problem !== null || answer === null || answer.status !== 'added') return problem ?? '';
  return competitors.some((competitor) => competitor.id === answer.competitor.id) ? PROJECT_SETTINGS_TEXT.competitorExists : PROJECT_SETTINGS_TEXT.competitorAdded;
}

/** What removing a competitor said. */
export function removeCompetitorText(answer: ProjectChangeAnswer | null): string {
  return refusalText(answer) ?? PROJECT_SETTINGS_TEXT.competitorRemoved;
}

// ---- Tags (Phase 10 Task 7) ----------------------------------------------------------------------

/** The tag editor's input bound: `MAX_TAGS_PER_ENTRY` tags of the longest typed length, with ", " between. */
export const TAGS_TEXT_MAX_CHARS = MAX_TAGS_PER_ENTRY * (TAG_INPUT_MAX_CHARS + 2);

/** Tags as typed (comma-separated, blanks dropped), as main reads them (`normalizeTags`); or what to fix. */
export function tagsFromText(text: string): { readonly tags: string[] } | { readonly problem: string } {
  const invalid = { problem: PROJECT_REFUSAL_MESSAGES['invalid-tag'] };
  if (text.length > TAGS_TEXT_MAX_CHARS) return invalid;
  // Only white space between commas is blank; anything else is read (and maybe refused) by `normalizeTag`.
  // `normalizeTags` caps the count after repeats are dropped (`Tea, tea` is one tag).
  const tags = normalizeTags(text.split(',').filter((part) => part.trim() !== ''));
  return tags === null ? invalid : { tags };
}

/** An entry's tags as the editor shows them. */
export const tagsTextOf = (tags: readonly string[]): string => tags.join(', ');

/** The tag editor's accessible name for the entry labelled `label`. */
export const tagEditorLabel = (label: string): string => TAG_EDITOR_TEXT.label.replace('{label}', () => label);

/** What saving an entry's tags said. */
export function setTagsText(answer: SetTagsAnswer | null): string {
  return refusalText(answer) ?? TAG_EDITOR_TEXT.saved;
}

// ---- Bulk add (Phase 10 Task 7) ------------------------------------------------------------------

/** The Bulk add form as typed. */
export interface BulkForm {
  readonly text: string;
  readonly engine: string;
  readonly locales: readonly { readonly country: string; readonly language: string }[];
  readonly devices: readonly string[];
  readonly tags: string;
}

export const EMPTY_BULK_FORM: BulkForm = { text: '', engine: SEARCH_ENGINES[0].id, locales: [{ country: '', language: '' }], devices: ['desktop'], tags: '' };

/** What a valid form makes: how many queries, locales and devices, and their product. */
export interface BulkCounts {
  readonly lines: number;
  readonly locales: number;
  readonly devices: number;
  readonly searches: number;
}

/** Whether the form can take one more locale row (`BULK_SEARCH_LIMITS.maxLocales`). */
export const canAddLocale = (form: Pick<BulkForm, 'locales'>): boolean => form.locales.length < BULK_SEARCH_LIMITS.maxLocales;

/**
 * The `addSearches` the form describes (as `BulkSearchesInputSchema` takes it: the lines as main splits
 * them, a locale given twice once, the devices in `SERP_DEVICES` order, the tags normalized), with its
 * counts; or what to fix. Main checks it again and is the authority.
 */
export function bulkFromForm(form: BulkForm): ({ readonly input: BulkSearchesInput } & BulkCounts) | { readonly problem: string } {
  const tooMany = { problem: `Enter at most ${BULK_SEARCH_LIMITS.maxLines} queries at once.` };
  if (form.text.length > BULK_SEARCH_LIMITS.maxTextChars) return tooMany;
  const lines = splitBulkSearches(form.text);
  if (lines.length === 0) return { problem: 'Enter at least one query.' };
  if (lines.length > BULK_SEARCH_LIMITS.maxLines) return tooMany;
  const engine = SEARCH_ENGINES.find((candidate) => candidate.id === form.engine)?.id;
  if (engine === undefined) return { problem: 'Choose a search engine.' };
  if (form.locales.length === 0) return { problem: 'Add a country and language (or leave both empty).' };
  if (form.locales.length > BULK_SEARCH_LIMITS.maxLocales) return { problem: `At most ${BULK_SEARCH_LIMITS.maxLocales} countries and languages.` };
  const locales: BulkLocale[] = [];
  for (const row of form.locales) {
    const country = row.country.trim().toLowerCase();
    const language = row.language.trim().toLowerCase();
    const problem = localeProblem(country, language);
    if (problem !== null) return { problem };
    const locale = { country: country === '' ? null : country, language: language === '' ? null : language };
    if (!locales.some((seen) => seen.country === locale.country && seen.language === locale.language)) locales.push(locale);
  }
  const devices = SERP_DEVICES.filter((device) => form.devices.includes(device));
  if (devices.length === 0) return { problem: 'Choose at least one device.' };
  const tags = tagsFromText(form.tags);
  if ('problem' in tags) return tags;
  const input: BulkSearchesInput = { text: lines.join('\n'), engine, locales, devices, tags: tags.tags };
  return { input, lines: lines.length, locales: locales.length, devices: devices.length, searches: lines.length * locales.length * devices.length };
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What the form makes, in a line, and how many more searches the project (holding `saved`) can take. */
export function bulkSummaryText(counts: BulkCounts, saved: number): string {
  const room = Math.max(0, MAX_PROJECT_QUERIES - saved);
  const made = `${count(counts.lines, 'query', 'queries')} × ${count(counts.locales, 'locale', 'locales')} × ${count(counts.devices, 'device', 'devices')}: ${count(counts.searches, 'search', 'searches')}.`;
  return `${made} ${room === 0 ? 'The project is full.' : `The project can hold ${room} more.`}`;
}

/** One line's outcome as the dialog lists it (the query is shown as text). */
export interface BulkOutcomeRow {
  readonly query: string;
  readonly outcome: BulkLineOutcome;
  readonly text: string;
}

/** The per-line outcomes of a Bulk add, in order (none for a refusal). */
export function bulkOutcomeRows(answer: BulkAddAnswer | null): BulkOutcomeRow[] {
  if (answer === null || answer.status !== 'done') return [];
  return answer.lines.map((line) => {
    let text: string = BULK_LINE_OUTCOME_LABELS[line.outcome];
    if (line.outcome === 'added') text = `Added ${count(line.added, 'search', 'searches')}`;
    else if (line.outcome === 'limit' && line.added > 0) text = `${text} (${count(line.added, 'search', 'searches')} added first)`;
    return { query: line.query, outcome: line.outcome, text };
  });
}

/** What a Bulk add said, in a line. */
export function bulkResultText(answer: BulkAddAnswer | null): string {
  const problem = refusalText(answer);
  if (problem !== null || answer === null || answer.status !== 'done') return problem ?? '';
  const added = answer.lines.reduce((sum, line) => sum + line.added, 0);
  return `Added ${count(added, 'search', 'searches')} from ${count(answer.lines.length, 'line', 'lines')}.`;
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

/** Whether the form shows another policy than the saved one (Purge now follows the saved one). */
export function retentionFormChanged(form: RetentionForm, saved: { readonly mode: RetentionMode; readonly value: number | null }): boolean {
  if (form.mode !== saved.mode) return true;
  return form.mode !== 'forever' && form.value.trim() !== String(saved.value ?? '');
}

/** Said in place of the preview while the form is not saved. */
export const UNSAVED_POLICY_PREVIEW = 'Save the policy first: Purge now follows the saved policy.' as const;

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
      return `Purged ${purgeCountsText(answer.counts)} (≈ ${formatBytes(answer.bytes)} freed).`;
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
  const sharedFiles = usage.files.shared > 0 ? ` (${NUMBER.format(usage.files.shared)} also in another project)` : '';
  return [
    { id: 'captures', label: 'Captures', value: NUMBER.format(usage.captures) },
    { id: 'versions', label: 'Versions', value: `${NUMBER.format(usage.versions)}${shared}` },
    { id: 'screenshots', label: 'Screenshots', value: NUMBER.format(usage.screenshots) },
    { id: 'stored', label: 'Stored snapshots and diffs', value: `${formatBytes(usage.snapshotBytes)} + ${formatBytes(usage.diffBytes)}` },
    // The SERP readings kept with captures of result pages (`workspace-db.feature.md`).
    { id: 'readings', label: 'Search readings', value: formatBytes(usage.readingBytes) },
    { id: 'files', label: 'Screenshot files', value: `${plural(usage.files.count, 'file', 'files')}, ${formatBytes(usage.files.bytes)}${sharedFiles}${missing}` },
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
