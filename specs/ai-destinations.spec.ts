/**
 * AI-engine destinations (Phase 10 Task 10; plan Decision 13; acceptance `serp-panels.feature.md`,
 * Open in an AI engine). Plain values and functions with no Zod, shared by main (which builds and
 * opens the URL: `serp.openDestination`, `apps/desktop/src/main/serp/destinations.ts`) and the
 * chrome (which offers the rows and the palette actions). The procedure's input and answer schemas
 * are `OpenDestinationInputSchema` / `OpenDestinationAnswerSchema` in `serp-service.schema.ts`.
 *
 * - **A fixed table, apart from `SEARCH_ENGINES`.** An AI engine is not a search engine frost reads
 *   back (Phase 3 cannot read its answer), so it is never the address-bar default, a saved search's
 *   engine or a key of `SEARCH_PARAM_URL_RULES`. Google AI Mode (`udm=50`) is refused by the bundled
 *   selector pack's `reject` rule, so it is never read as a result page.
 * - **The query is the SERP tab's own.** Main reads it from the tab's SERP state (`params.query`);
 *   the renderer names only the tab and a destination id, never text.
 * - **Built, never pasted.** `aiDestinationUrl` is the destination's fixed `https:` origin and path,
 *   its fixed parameters, and the query as one URL-encoded value (`URL` / `URLSearchParams`), as
 *   `openInUrl` in `open-in.spec.ts`; nothing in the query can reach the host, the path or another
 *   parameter. A lone surrogate becomes U+FFFD first (`wellFormed`, as `searchEngineUrl` does).
 * - **Only on the user's action.** The "Open in" row's buttons and the palette's actions call
 *   `serp.openDestination`; nothing opens a destination by itself. It opens as an ordinary
 *   background tab (`browser.openBackgroundTab`: the browse guards and the tab cap), so the query is
 *   sent from the user's own signed-in account (`AI_DESTINATION_NOTE`); frost reads nothing there.
 *
 * Open question 3 (plan): the URL forms are unverified by hand; the e2e never loads them.
 */
import { wellFormed } from './browser-polish.spec';
import { OPEN_IN_URL_MAX_LENGTH } from './command-palette.spec';

export interface AiSearchDestination {
  readonly id: string;
  /** frost's name for it, in labels. */
  readonly label: string;
  /** The fixed `https:` origin. */
  readonly origin: string;
  /** The fixed path. */
  readonly path: string;
  /** The parameter the query is sent as. */
  readonly queryParam: string;
  /** Fixed parameters, sent as they are. */
  readonly params: Readonly<Record<string, string>>;
}

export const AI_SEARCH_DESTINATIONS = [
  { id: 'perplexity', label: 'Perplexity', origin: 'https://www.perplexity.ai', path: '/search', queryParam: 'q', params: {} },
  { id: 'chatgpt', label: 'ChatGPT', origin: 'https://chatgpt.com', path: '/', queryParam: 'q', params: {} },
  { id: 'google-ai-mode', label: 'Google AI Mode', origin: 'https://www.google.com', path: '/search', queryParam: 'q', params: { udm: '50' } },
] as const satisfies readonly AiSearchDestination[];
export type AiDestinationId = (typeof AI_SEARCH_DESTINATIONS)[number]['id'];
export const AI_DESTINATION_IDS = AI_SEARCH_DESTINATIONS.map((destination) => destination.id) as [AiDestinationId, ...AiDestinationId[]];

/** The destination with `id`, or `undefined`. */
export function aiDestination(id: string): AiSearchDestination | undefined {
  return AI_SEARCH_DESTINATIONS.find((destination) => destination.id === id);
}

/**
 * `destination`'s URL for `query`: its fixed origin and path, the query as the one `queryParam`
 * value (then its fixed parameters). `null` when the query is blank, the result would not fit
 * `browser.openBackgroundTab` (`OPEN_IN_URL_MAX_LENGTH`), or the entry itself is malformed (its built
 * URL is not exactly its own `https:` origin and path).
 */
export function aiDestinationUrl(destination: AiSearchDestination, query: string): string | null {
  if (typeof query !== 'string' || query.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(destination.path, destination.origin);
  } catch {
    return null;
  }
  const params = new URLSearchParams();
  params.set(destination.queryParam, wellFormed(query));
  for (const [key, value] of Object.entries(destination.params)) {
    if (key === destination.queryParam) return null;
    params.set(key, value);
  }
  url.search = params.toString();
  url.hash = '';
  // Belt and braces: the fixed parts are exactly the table's.
  if (url.protocol !== 'https:' || url.origin !== destination.origin || url.pathname !== destination.path) return null;
  return url.href.length <= OPEN_IN_URL_MAX_LENGTH ? url.href : null;
}

/** The host a destination sends the query to. */
export function aiDestinationHost(destination: AiSearchDestination): string {
  return new URL(destination.origin).host;
}

/** The row's heading and a button's or palette action's label. */
export const AI_DESTINATION_ROW_LABEL = 'Open in' as const;
export function aiDestinationLabel(destination: AiSearchDestination): string {
  return `Open search in ${destination.label}`;
}

/** Stated beside the row and before a palette action runs. */
export const AI_DESTINATION_NOTE =
  'Opens as an ordinary tab, so the query is sent from your own signed-in account and lands in that engine’s history. frost does not read the answer.' as const;

/** Why main did not open a destination (`serp.openDestination`), and what the status line says. */
export const OPEN_DESTINATION_REFUSALS = ['no-search', 'no-tab'] as const;
export type OpenDestinationRefusal = (typeof OPEN_DESTINATION_REFUSALS)[number];
export const OPEN_DESTINATION_REFUSAL_MESSAGES: Readonly<Record<OpenDestinationRefusal, string>> = {
  'no-search': 'Nothing sent: this tab shows no search',
  'no-tab': 'Couldn’t open a tab',
};

/** `serp.openDestination`'s answer. */
export type OpenDestinationResult = { readonly status: 'opened'; readonly tabId: number } | { readonly status: 'refused'; readonly reason: OpenDestinationRefusal };

/** The status line for an answer (`null`: the IPC call failed). */
export function openDestinationMessage(destination: AiSearchDestination, result: OpenDestinationResult | null): string {
  if (result === null) return OPEN_DESTINATION_REFUSAL_MESSAGES['no-tab'];
  return result.status === 'opened' ? `Opened ${destination.label} in a background tab` : OPEN_DESTINATION_REFUSAL_MESSAGES[result.reason];
}
