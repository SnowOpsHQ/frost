import type { AddQueryAnswer, ProjectSummary, SavedSearchInput } from '@app/specs/projects.spec';
import { serpFiltersOf } from '@app/specs/rankings-url.spec';
import {
  TRACK_REFUSAL_MESSAGES,
  editedSearchUrl,
  editorFields,
  editorParamNames,
  editorStateOf,
  editorUnsupported,
  trackRefusalOf,
  trackableSearch,
  type EditorField,
  type EditorFieldId,
  type EditorOption,
  type EditorParamNames,
  type EditorState,
} from '@app/specs/serp-param-editor.spec';
// Types only from the schema files (their Zod must stay out of this bundle: strict Trusted Types).
import type { SerpTabState } from '@app/specs/serp-service.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import { pickerProjects, refusalText } from './projects-view';
import { serpParams } from './serp-view';

// The SERP parameter editor's view model (acceptance `serp-panels.feature.md`, Edit search; spec
// `serp-param-editor.spec.ts`): pure functions from main's `SerpTabState` to what the editor and
// "Track this search…" show. The URL is the spec's `editedSearchUrl` (closed values, the tab's own
// query re-encoded); the chrome only ever hands it to `browser.navigate`.

/** What the editor works on: the tab's search, its page URL, the parameter names and its fields. */
export interface SerpEditorModel {
  readonly params: SearchParams;
  /** The page's own URL (the state's `url`), whose filters the editor starts from. */
  readonly pageUrl: string;
  readonly names: EditorParamNames | null;
  readonly fields: readonly EditorField[];
  readonly initial: EditorState;
  /** Labels of the fields whose value on the page the editor does not offer (applying clears them). */
  readonly unsupported: readonly string[];
}

/** The editor's model for a tab's state; `null` when the state has no search parameters (not a result page). */
export function serpEditorModel(state: SerpTabState): SerpEditorModel | null {
  const params = serpParams(state.serp);
  if (params === null || state.serp.status === 'not-serp' || state.serp.status === 'disabled') return null;
  const pageUrl = state.serp.url;
  const names = editorParamNames(params.engine, state.paramNames ?? null);
  return {
    params,
    pageUrl,
    names,
    fields: editorFields(params, names),
    initial: editorStateOf(params, pageUrl, names),
    unsupported: editorUnsupported(params, pageUrl, names),
  };
}

/** One menu of the editor: its field, the chosen value and the hook tests and e2e find it by. */
export interface EditorFieldRow {
  readonly id: EditorFieldId;
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly options: readonly EditorOption[];
  readonly hint: string | null;
}

export function editorFieldRows(model: SerpEditorModel, state: EditorState): EditorFieldRow[] {
  return model.fields.map((field) => ({ id: field.id, label: field.label, testId: `serp-edit-field-${field.id}`, value: state[field.id] ?? '', options: field.options, hint: field.hint ?? null }));
}

/** What the editor says when the engine has no settings it can edit. */
export const EDITOR_NO_FIELDS = 'frost has no settings to edit for this engine.';

/**
 * The search Apply builds from: the tab's search whose canonical URL (Phase 3's `params.url`, which has
 * no port) takes the page's own port when the page is that search's scheme, host and path, so an engine
 * served on a port is edited on it (`editor-keeps-the-pages-port`); otherwise the search as it is.
 * Google's chosen domain replaces the origin anyway.
 */
function applySource(model: SerpEditorModel): SearchParams {
  try {
    const canonical = new URL(model.params.url);
    const page = new URL(model.pageUrl);
    if (page.port === '' || page.protocol !== canonical.protocol || page.hostname !== canonical.hostname || page.pathname !== canonical.pathname) return model.params;
    canonical.port = page.port;
    return { ...model.params, url: canonical.href };
  } catch {
    return model.params;
  }
}

/** Apply's URL (`null`: disabled) and, when there is none, why. */
export function editorApply(model: SerpEditorModel, state: EditorState): { readonly url: string | null; readonly problem: string | null } {
  if (model.fields.length === 0) return { url: null, problem: EDITOR_NO_FIELDS };
  const url = editedSearchUrl(applySource(model), state, model.names);
  if (url !== null) return { url, problem: null };
  if (model.fields.some((field) => field.kind === 'host') && (state.host ?? '') === '') return { url: null, problem: 'Choose a Google domain.' };
  return { url: null, problem: 'frost cannot build this search with these settings.' };
}

/** The note beside the editor when applying clears settings it does not offer; `null` when none. */
export function unsupportedNote(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  return `This page has a setting the editor does not offer (${labels.join(', ')}). Applying leaves it out.`;
}

/** "Track this search…": the saved search to add, or why there is none (frost's words). */
export function trackView(model: SerpEditorModel): { readonly search: SavedSearchInput | null; readonly reason: string | null } {
  const filters = serpFiltersOf(model.pageUrl, model.params.engine);
  const refusal = trackRefusalOf(model.params, filters);
  const search = refusal === null ? trackableSearch(model.params, filters) : null;
  if (search !== null) return { search, reason: null };
  return { search: null, reason: TRACK_REFUSAL_MESSAGES[refusal ?? 'query'] };
}

/** The projects a search can be saved to: every named project, once each (Unfiled has no rankings). */
export function trackProjectChoices(projects: readonly ProjectSummary[]): ProjectSummary[] {
  return pickerProjects(projects).filter((project) => !project.unfiled);
}

/** What saving the search answered, as one line. */
export function trackAnswerText(answer: AddQueryAnswer | null): string {
  return refusalText(answer) ?? 'Search saved to the project.';
}

// ---- Requests from the command palette ---------------------------------------------------------------

/** What the palette asks the SERP panel to open: the editor, or the project picker. */
export type SerpEditorMode = 'edit' | 'track';

let pending: { readonly tabId: number; readonly mode: SerpEditorMode } | null = null;
const listeners = new Set<() => void>();

/** Asks the SERP panel of `tabId` to open the editor or the picker (the panel may mount after this). */
export function requestSerpEditor(tabId: number, mode: SerpEditorMode): void {
  pending = { tabId, mode };
  for (const listener of [...listeners]) listener();
}

/** The request for `tabId`, taken once (`null`: none). */
export function takeSerpEditorRequest(tabId: number): SerpEditorMode | null {
  if (pending === null || pending.tabId !== tabId) return null;
  const { mode } = pending;
  pending = null;
  return mode;
}

/** Calls `listener` on every request; answers the unsubscribe. */
export function onSerpEditorRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
