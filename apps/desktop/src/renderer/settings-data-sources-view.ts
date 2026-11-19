// Type-only from the Zod schema (its schemas must stay out of this bundle: strict Trusted Types).
import type { DataSerpProviderView, DataSetKeyResult, DataSetSerpProviderResult, DataSourcesSetKeyInput, DataSourcesView, DataUsageView } from '@app/specs/data-sources.schema';
import {
  DATA_AI_SEARCH_PROVIDERS,
  DATA_PROVIDER_LABELS,
  DATA_SERP_PROVIDERS,
  DATA_SOURCES_SETTINGS_TEXT as TEXT,
  DATA_SPEND_NOTE,
  LEGAL_GATE_NOTE,
  type DataProvider,
  type DataProviderPurpose,
  type DataSerpProvider,
} from '@app/specs/data-sources.spec';

// Settings › Data sources as a view model (Phase 12 Task 2; acceptance `data-sources.feature.md`,
// Settings › Data sources). Pure: main's three views (`dataSources.status`, `.usage`,
// `.serpProvider`) become the rows, notes and select the section shows. Every decision comes from
// main: a row is live only when main says `available` (its legal gate) and keys are protected
// (`os`); the select lists main's `choices` only. Nothing here ever holds a key. A provider whose
// legal gate is closed is one compact line (UI polish round 2): its name and `LEGAL_GATE_NOTE`, no
// fields; its key state and Clear only while a key (or part of one) is set, its counts only if any.

export type DataSourceField = 'key' | 'login' | 'password';

export interface DataSourceFieldView {
  readonly id: DataSourceField;
  readonly label: string;
}

export interface DataSourceRowView {
  readonly provider: DataProvider;
  /** A text label only (L7: no logo or icon). */
  readonly label: string;
  readonly hasKey: boolean;
  /** Its legal gate is open (main's `available`); else the row is one compact line with no fields. */
  readonly available: boolean;
  /** Some but not all of its slots are set (DataForSEO's login or password alone). */
  readonly partial: boolean;
  /** "Key set" / "No key"; `null` on an unavailable row with nothing set. */
  readonly keyState: string | null;
  /** The password fields (DataForSEO: login and password); none on an unavailable row. */
  readonly fields: readonly DataSourceFieldView[];
  /** Whether the fields and Save are disabled. */
  readonly disabled: boolean;
  /** Why they are (`LEGAL_GATE_NOTE`, or the keychain's), else `null`. */
  readonly reason: string | null;
  /** Clear is offered whenever a key, or part of one, is set (gated or not: clearing is never gated). */
  readonly canClear: boolean;
  /** "This month: N · Last month: M"; `null` on an unavailable row that sent none. */
  readonly usage: string | null;
  readonly notes: readonly string[];
}

export interface DataSourcesGroupView {
  readonly purpose: DataProviderPurpose;
  readonly label: string;
  readonly rows: readonly DataSourceRowView[];
}

export interface SerpChoiceView {
  readonly options: readonly { readonly value: DataSerpProvider; readonly label: string }[];
  /** The selected vendor, or `''` (none). */
  readonly value: DataSerpProvider | '';
  readonly disabled: boolean;
  /** The first, unselectable option while none is chosen, else `null`. */
  readonly placeholder: string | null;
  /** Why there is nothing to choose, else `null`. */
  readonly note: string | null;
}

export interface DataSourcesSectionView {
  readonly intro: string;
  readonly spendNote: string;
  readonly groups: readonly DataSourcesGroupView[];
  readonly serp: SerpChoiceView;
}

const GROUPS: readonly { readonly purpose: DataProviderPurpose; readonly providers: readonly DataProvider[] }[] = [
  { purpose: 'serp', providers: DATA_SERP_PROVIDERS },
  { purpose: 'ai-search', providers: DATA_AI_SEARCH_PROVIDERS },
];

const KEY_FIELDS: readonly DataSourceFieldView[] = [{ id: 'key', label: TEXT.keyLabel }];
const LOGIN_FIELDS: readonly DataSourceFieldView[] = [
  { id: 'login', label: TEXT.loginLabel },
  { id: 'password', label: TEXT.passwordLabel },
];

const NOTES: Readonly<Partial<Record<DataProvider, readonly string[]>>> = {
  dataforseo: [TEXT.dataForSeoBoth],
  'openai-search': [TEXT.openAiSeparateKey],
};

function row(provider: DataProvider, status: DataSourcesView, usage: DataUsageView): DataSourceRowView {
  const { hasKey, partial, available } = status.providers[provider];
  const reason = !available ? LEGAL_GATE_NOTE : status.protection !== 'os' ? TEXT.protection[status.protection] : null;
  const counts = usage.providers[provider];
  const set = hasKey || partial;
  return {
    provider,
    label: DATA_PROVIDER_LABELS[provider],
    hasKey,
    available,
    partial,
    keyState: available || set ? (hasKey ? TEXT.keySet : TEXT.noKey) : null,
    fields: !available ? [] : provider === 'dataforseo' ? LOGIN_FIELDS : KEY_FIELDS,
    disabled: reason !== null,
    reason,
    canClear: set,
    usage: available || counts.thisMonth > 0 || counts.lastMonth > 0 ? TEXT.usage(counts.thisMonth, counts.lastMonth) : null,
    // The field notes are about entering a key: an unavailable row keeps only the partial one.
    notes: [...(partial ? [TEXT.partial] : []), ...(available ? (NOTES[provider] ?? []) : [])],
  };
}

function serpChoice(serp: DataSerpProviderView): SerpChoiceView {
  const options = serp.choices.map((value) => ({ value, label: DATA_PROVIDER_LABELS[value] }));
  const value = serp.provider !== null && serp.choices.includes(serp.provider) ? serp.provider : '';
  if (options.length === 0) return { options, value: '', disabled: true, placeholder: null, note: TEXT.serpProviderNone };
  return { options, value, disabled: false, placeholder: value === '' ? TEXT.serpProviderPlaceholder : null, note: null };
}

/** The section for main's views. */
export function dataSourcesSection(status: DataSourcesView, usage: DataUsageView, serp: DataSerpProviderView): DataSourcesSectionView {
  return {
    intro: TEXT.intro,
    spendNote: DATA_SPEND_NOTE,
    groups: GROUPS.map(({ purpose, providers }) => ({ purpose, label: TEXT.groups[purpose], rows: providers.map((provider) => row(provider, status, usage)) })),
    serp: serpChoice(serp),
  };
}

/**
 * The `dataSources.setKey` input for what was pasted into `provider`'s fields, or `null` when
 * nothing was (every field blank). DataForSEO sends whichever of login and password were pasted.
 */
export function setKeyInput(provider: DataProvider, values: Readonly<Partial<Record<DataSourceField, string>>>): DataSourcesSetKeyInput | null {
  const pasted = (field: DataSourceField): string | undefined => {
    const value = values[field];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  if (provider === 'dataforseo') {
    const login = pasted('login');
    const password = pasted('password');
    if (login === undefined && password === undefined) return null;
    return { provider, ...(login !== undefined ? { login } : {}), ...(password !== undefined ? { password } : {}) };
  }
  const key = pasted('key');
  return key === undefined ? null : { provider, key };
}

/** What Save says for main's answer (never the key). */
export function setKeyMessage(result: DataSetKeyResult): string {
  return TEXT.setKeyResults[result] ?? TEXT.setKeyResults.failed;
}

/**
 * What Save says once main answered `result` for `input` and its view was read again (`hasKey`
 * after): a DataForSEO half stored while the row still has no key asks for the other half.
 */
export function saveMessage(input: DataSourcesSetKeyInput, result: DataSetKeyResult, hasKeyAfter: boolean): string {
  if (result === 'stored' && !hasKeyAfter && input.provider === 'dataforseo') {
    if (input.login !== undefined && input.password === undefined) return TEXT.savedAddOther.password;
    if (input.password !== undefined && input.login === undefined) return TEXT.savedAddOther.login;
  }
  return setKeyMessage(result);
}

/** What the select says for main's answer (`null` once stored). */
export function setSerpProviderMessage(result: DataSetSerpProviderResult): string | null {
  return result === 'stored' ? null : (TEXT.setSerpProviderResults[result] ?? TEXT.setSerpProviderResults.failed);
}
