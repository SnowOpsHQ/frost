import { registrableDomain } from '@app/seo-core';
import { AI_ANSWERS_RUN_REFUSAL_TEXT } from '@app/specs/ai-answers.spec';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { AiAnswersEngineView, AiAnswersRunAnswer, AiAnswersView } from '@app/specs/ai-answers.schema';
import type { AiCitation } from '@app/specs/ai-search.schema';
import { AI_SEARCH_ENGINE_LABELS, AI_SEARCH_VIA_LABELS, type AiSearchEngine, type AiSearchVia } from '@app/specs/ai-search.spec';
import { LEGAL_GATE_NOTE } from '@app/specs/data-sources.spec';
import { parseWebUrl } from '@app/specs/web-url.spec';

// The AI answers view, pure (Phase 12 Task 9; acceptance `specs/ai-answers.feature.md`, Renderer; plan Decision
// 9 and Global constraints "Untrusted text"). What the sheet shows, decided here so it is unit tested:
// - an answer is plain text in paragraphs (nothing parsed: no markup, no markdown);
// - a citation is text; only an `http(s)` one offers "Open in tab" (the address bar's path);
// - cited domains are grouped by registrable domain, and a watched domain (typed as a host or a URL)
//   is marked wherever it appears;
// - which engines may be asked comes from main's view (`available`, `usable`), never from the gate
//   constants: a gated engine is disabled with `LEGAL_GATE_NOTE`.

/** An engine in words (text labels only). */
export function engineLabel(engine: AiSearchEngine): string {
  return AI_SEARCH_ENGINE_LABELS[engine];
}

export function viaLabel(via: AiSearchVia): string {
  return AI_SEARCH_VIA_LABELS[via];
}

const pad = (value: number) => String(value).padStart(2, '0');

/** When an answer arrived, in local time (`YYYY-MM-DD HH:MM`). */
export function whenText(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** An answer's text as paragraphs of plain text (blank lines dropped). */
export function answerParagraphs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** A watched domain typed as a host or a URL: its registrable domain, or `null` (blank or not a host name). */
export function watchedDomainOf(input: string | null | undefined): string | null {
  const text = (input ?? '').trim();
  if (text === '') return null;
  const parsed = parseWebUrl(text.includes('://') ? text : `https://${text}`);
  if (parsed === null || !/^[a-z0-9.-]+$/i.test(parsed.hostname) || !parsed.hostname.includes('.')) return null;
  const domain = registrableDomain(parsed.hostname);
  return domain === '' ? null : domain;
}

export interface CitationRow {
  /** The URL as shown (any username or password left out). */
  readonly url: string;
  /** The citation's title (`''`: none; the URL stands for it). */
  readonly title: string;
  /** Its host (`''` when the URL is not `http(s)`). */
  readonly host: string;
  /** Its registrable domain (`''` likewise). */
  readonly domain: string;
  readonly watched: boolean;
  /** Whether "Open in tab" is offered: `http(s)` only, and never a URL that carries a username or password. */
  readonly openable: boolean;
}

/** `url` without its username and password (when it parses), and whether it had either. */
function withoutUserinfo(url: string): { readonly shown: string; readonly credentials: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { shown: url, credentials: false };
  }
  if (parsed.username === '' && parsed.password === '') return { shown: url, credentials: false };
  parsed.username = '';
  parsed.password = '';
  return { shown: parsed.href, credentials: true };
}

/**
 * Each citation as a row. Defence in depth (Task 8's parse already drops them): a URL with a username
 * or password is shown without them and is never openable.
 */
export function citationRows(citations: readonly AiCitation[], watched: string | null): CitationRow[] {
  return citations.map((citation) => {
    const { shown, credentials } = withoutUserinfo(citation.url);
    const parsed = parseWebUrl(citation.url);
    const host = parsed === null ? '' : parsed.hostname;
    const domain = host === '' ? '' : registrableDomain(host);
    return { url: shown, title: citation.title, host, domain, watched: watched !== null && domain === watched, openable: parsed !== null && !credentials };
  });
}

/** A count of sources in words ("1 source", "3 sources"). */
export function sourcesText(count: number): string {
  return `${count} ${count === 1 ? 'source' : 'sources'}`;
}

export interface DomainGroup {
  readonly domain: string;
  /** Citations from it. */
  readonly count: number;
  readonly watched: boolean;
}

/** The cited registrable domains, most cited first (ties: first cited first). */
export function domainGroups(citations: readonly AiCitation[], watched: string | null): DomainGroup[] {
  const counts = new Map<string, number>();
  for (const row of citationRows(citations, watched)) {
    if (row.domain === '') continue;
    counts.set(row.domain, (counts.get(row.domain) ?? 0) + 1);
  }
  const order = [...counts.keys()];
  return order
    .map((domain) => ({ domain, count: counts.get(domain)!, watched: watched !== null && domain === watched }))
    .sort((a, b) => b.count - a.count || order.indexOf(a.domain) - order.indexOf(b.domain));
}

// ---- Engines, the run and the settings -------------------------------------------------------------

const NO_API_NOTE = 'frost has no API for that AI engine in this build.';
const NO_KEY_NOTE = 'Add its key in Settings › Data sources.';
const OFF_NOTE = 'Switched off here.';

/** Why an engine cannot be asked now (`null`: it can), from main's view. */
export function engineNote(engine: AiSearchEngineViewLike): string | null {
  if (engine.provider === null) return NO_API_NOTE;
  if (!engine.available) return LEGAL_GATE_NOTE;
  if (!engine.hasKey) return NO_KEY_NOTE;
  if (engine.via === 'off') return OFF_NOTE;
  return engine.usable ? null : NO_KEY_NOTE;
}

type AiSearchEngineViewLike = Pick<AiAnswersEngineView, 'provider' | 'available' | 'hasKey' | 'via' | 'usable'>;

export interface EngineChoice {
  readonly engine: AiSearchEngine;
  readonly label: string;
  readonly disabled: boolean;
  readonly note: string | null;
}

export function engineChoices(view: AiAnswersView | null): EngineChoice[] {
  return (view?.engines ?? []).map((engine) => {
    const note = engineNote(engine);
    return { engine: engine.engine, label: engineLabel(engine.engine), disabled: !engine.usable, note: engine.usable ? null : note };
  });
}

/** Whether Ask is offered for `engine` (`''`: the default engine) and `query`, and the note beside it. */
export function askControl(view: AiAnswersView | null, engine: AiSearchEngine | '', query: string): { disabled: boolean; note: string | null } {
  if (view === null) return { disabled: true, note: null };
  const choices = engineChoices(view);
  if (engine === '') {
    if (!choices.some((choice) => !choice.disabled)) {
      const anyOpen = view.engines.some((entry) => entry.available);
      return { disabled: true, note: anyOpen ? AI_ANSWERS_RUN_REFUSAL_TEXT['none-set-up'] : LEGAL_GATE_NOTE };
    }
  } else {
    const choice = choices.find((entry) => entry.engine === engine);
    if (choice === undefined || choice.disabled) return { disabled: true, note: choice?.note ?? null };
  }
  return { disabled: query.trim() === '', note: null };
}

/** The engine a run would ask (`''`: the default if usable, else the first usable), for the confirm's words. */
export function engineToAsk(view: AiAnswersView | null, engine: AiSearchEngine | ''): AiSearchEngine | null {
  if (view === null) return null;
  if (engine !== '') return engine;
  const usable = view.engines.filter((entry) => entry.usable).map((entry) => entry.engine);
  if (view.defaultEngine !== null && usable.includes(view.defaultEngine)) return view.defaultEngine;
  return usable[0] ?? null;
}

/** Whether `via` may be chosen for `engine` in the settings: `off` always; `api` only while its gate is open. */
export function viaChoiceDisabled(engine: AiSearchEngineViewLike, via: 'api' | 'off'): boolean {
  return via === 'api' && (engine.provider === null || !engine.available);
}

/** What a run's answer says when nothing came back. */
export function runAnswerText(answer: AiAnswersRunAnswer | null): string | null {
  if (answer === null) return 'The AI search could not be run.';
  return answer.status === 'refused' ? answer.note : null;
}

/** What a setting write says when it did not work (`null`: it did). */
export function settingResultText(result: string | null): string | null {
  if (result === 'ok') return null;
  if (result === 'unavailable') return LEGAL_GATE_NOTE;
  if (result === 'no-api') return NO_API_NOTE;
  return 'The setting could not be saved.';
}

export { openInTab } from './crawl-view';
