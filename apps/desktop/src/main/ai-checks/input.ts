import { createHash } from 'node:crypto';
import { modelPageUrl } from '@app/specs/agent-page-tools.spec';
import { isGscReadablePage } from '@app/specs/agent-search-tools.spec';
import { AI_CHECK_EXTRACT_TAGS, AI_CHECK_LIMITS as L, AI_CHECK_TASK } from '@app/specs/ai-checks.spec';
import { AiCheckInputSchema, type AiCheckInput } from '@app/specs/ai-checks.schema';
import type { ServedState } from '@app/specs/seo-javascript.schema';
import { parseWebUrl } from '@app/specs/web-url.spec';
import type { ServedHtml, ServedHow } from '../seo/served';

// An AI check's input (Phase 9 Task 10, Decision 16; acceptance `specs/ai-checks.feature.md`, Input).
// It is read only from the served HTML the audit already fetched for the tab, without cookies or
// credentials (what an anonymous visitor is sent), with `served.peek` under the audit's own key: the
// tab's user agent and scripting (`servedInput` in `main/index.ts`). Never `served.get`: an AI check
// never causes a fetch; a miss is `served-pending`. Never the rendered page (what the user sees,
// possibly signed in), and never `audit.pageType` (computed from the rendered snapshot):
// `buildAiCheckInput` takes a ready served state and the URL, nothing else.
//
// On top, a guard: a page whose anonymous version doesn't look like its public form is skipped
// (`not-anonymous`): the fetch failed or wasn't 2xx, its final URL is another page (a sign-in
// redirect), the snapshot is partial (or the body cut short), or the served HTML is `noindex`. Only
// public hosts are checked (`isGscReadablePage`, `not-public`).

/** A served state with the fetch and the snapshot. */
export type ReadyServedState = Extract<ServedState, { status: 'ready' }>;

/** The tab's page as a check reads it: its document, its URL, and the audit's served key. */
export interface AiCheckPage {
  readonly contentsId: number;
  readonly url: string;
  readonly userAgent: string | null;
  readonly scripting: boolean;
}

export type AiCheckRead =
  | { readonly status: 'skip'; readonly reason: 'not-public' | 'not-anonymous' | 'served-pending' }
  | {
      readonly status: 'ready';
      /** The page's key (the tab's URL without its fragment or userinfo): where the answer is kept. */
      readonly url: string;
      readonly input: AiCheckInput;
      /** What `check.start.input` carries: the task and the wrapped extract. */
      readonly message: string;
      /** sha-256 of `message` (lowercase hex): the cache's key beside `url`. */
      readonly inputHash: string;
    };

/** `url` without its fragment, if it is an `http(s)` URL. */
function withoutFragment(url: string): string | null {
  const parsed = parseWebUrl(url);
  if (!parsed) return null;
  parsed.hash = '';
  return parsed.href;
}

/** Whether a robots meta of the served HTML says `noindex` (or `none`), for any crawler it names. */
function servedNoindex(served: ReadyServedState): boolean {
  return served.snapshot.metaRobots.some((meta) => meta.content.split(/[\s,]+/).some((token) => token === 'noindex' || token === 'none'));
}

/**
 * Decision 16's guard for `pageUrl` over its served state: `null` when the served page looks like the
 * page's public form, else why not.
 */
export function anonymousGuard(state: ServedState | undefined, pageUrl: string): 'served-pending' | 'not-anonymous' | null {
  if (state === undefined || state.status === 'pending') return 'served-pending';
  if (state.status !== 'ready') return 'not-anonymous';
  const { fetch, snapshot } = state;
  if (fetch.status < 200 || fetch.status >= 300) return 'not-anonymous';
  const page = withoutFragment(pageUrl);
  if (page === null || withoutFragment(fetch.finalUrl) !== page || withoutFragment(fetch.url) !== page) return 'not-anonymous';
  if (snapshot.partial || fetch.truncated) return 'not-anonymous';
  if (servedNoindex(state)) return 'not-anonymous';
  return null;
}

/** `value` cut to `max` UTF-16 units, never splitting a surrogate pair. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** A JSON-LD `@type` value an extract may carry: a short name or IRI, never prose. */
const TYPE = /^[A-Za-z0-9:/._#-]+$/;

/** The JSON-LD `@type` values of the served snapshot's blocks (top level and `@graph`), first ones first, deduplicated. */
function jsonLdTypes(served: ReadyServedState): string[] {
  const types: string[] = [];
  const add = (value: unknown): void => {
    for (const type of Array.isArray(value) ? value : [value]) {
      if (types.length >= L.maxJsonLdTypes) return;
      if (typeof type === 'string' && type.length <= L.maxTypeChars && TYPE.test(type) && !types.includes(type)) types.push(type);
    }
  };
  for (const block of served.snapshot.jsonLd) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      continue;
    }
    const entities = Array.isArray(parsed) ? parsed : [parsed];
    for (const entity of entities) {
      if (entity === null || typeof entity !== 'object') continue;
      const record = entity as Record<string, unknown>;
      if (Object.hasOwn(record, '@type')) add(record['@type']);
      const graph = Object.hasOwn(record, '@graph') ? record['@graph'] : undefined;
      if (Array.isArray(graph)) for (const item of graph) if (item !== null && typeof item === 'object' && Object.hasOwn(item, '@type')) add((item as Record<string, unknown>)['@type']);
    }
  }
  return types;
}

/**
 * The page extract of `served` for the page at `url`: the URL, and from the served HTML only its
 * language, titles, meta descriptions, headings, JSON-LD types, word count and lead text. Its type
 * has no rendered or page-type field (Decision 16).
 */
export function buildAiCheckInput(served: ReadyServedState, url: string): AiCheckInput {
  const { snapshot } = served;
  return AiCheckInputSchema.parse({
    url: cut(modelPageUrl(url) ?? served.fetch.url, L.maxUrlChars),
    lang: snapshot.lang,
    titles: snapshot.titles.map((title) => title.text),
    descriptions: snapshot.metaDescriptions.map((description) => description.text),
    headings: snapshot.headings.slice(0, L.maxHeadings).map((heading) => ({ level: heading.level, text: heading.text })),
    jsonLdTypes: jsonLdTypes(served),
    wordCount: snapshot.wordCount,
    leadText: cut(snapshot.leadText ?? '', L.maxLeadChars),
  });
}

/**
 * The text `check.start.input` carries for `input`: the task, then the extract as JSON between the
 * untrusted-data tags, every `<` escaped so the page's text can never close them.
 */
export function aiCheckMessage(input: AiCheckInput): string {
  const json = JSON.stringify(input).replace(/</g, '\\u003c');
  return `${AI_CHECK_TASK}\n\n${AI_CHECK_EXTRACT_TAGS.open}\n${json}\n${AI_CHECK_EXTRACT_TAGS.close}`;
}

/**
 * `input` made to fit `AI_CHECK_LIMITS.maxInputChars` once wrapped: headings past the first eight go
 * first, then the lead text shrinks, then the other headings, then the extra titles and descriptions.
 * `null` if even the smallest extract does not fit (a URL and titles that long are not a page frost checks).
 */
export function fitAiCheckInput(input: AiCheckInput): { readonly input: AiCheckInput; readonly message: string } | null {
  let current = input;
  for (let step = 0; step < 64; step++) {
    const message = aiCheckMessage(current);
    const excess = message.length - L.maxInputChars;
    if (excess <= 0) return { input: current, message };
    if (current.headings.length > 8) current = { ...current, headings: current.headings.slice(0, Math.max(8, current.headings.length - Math.ceil(excess / 64))) };
    // Each character dropped from the lead text shortens the message by at least one.
    else if (current.leadText.length > 1_000) current = { ...current, leadText: cut(current.leadText, Math.max(1_000, current.leadText.length - excess)) };
    else if (current.headings.length > 0) current = { ...current, headings: current.headings.slice(0, -1) };
    else if (current.leadText.length > 0) current = { ...current, leadText: cut(current.leadText, Math.max(0, current.leadText.length - excess)) };
    else if (current.descriptions.length > 1) current = { ...current, descriptions: current.descriptions.slice(0, 1) };
    else if (current.titles.length > 1) current = { ...current, titles: current.titles.slice(0, 1) };
    else if (current.jsonLdTypes.length > 0) current = { ...current, jsonLdTypes: [] };
    else return null;
  }
  return null;
}

/** sha-256 of `message`, lowercase hex. */
export function aiCheckInputHash(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

/**
 * Reads the check's input for `page`: only `served.peek` (`null` served: nothing fetched yet, so
 * `served-pending`), with the audit's key, then the guard, then the extract.
 */
export function readAiCheckInput(served: Pick<ServedHtml, 'peek'> | null, page: AiCheckPage): AiCheckRead {
  const key = modelPageUrl(page.url);
  if (key === null || !isGscReadablePage(page.url) || key.length > L.maxUrlChars) return { status: 'skip', reason: 'not-public' };
  const how: ServedHow = { scripting: page.scripting };
  const state = served === null ? undefined : served.peek(page.contentsId, page.url, page.userAgent, how);
  const skip = anonymousGuard(state, page.url);
  if (skip !== null || state === undefined || state.status !== 'ready') return { status: 'skip', reason: skip ?? 'not-anonymous' };
  const fitted = fitAiCheckInput(buildAiCheckInput(state, page.url));
  if (fitted === null) return { status: 'skip', reason: 'not-anonymous' };
  return { status: 'ready', url: key, input: fitted.input, message: fitted.message, inputHash: aiCheckInputHash(fitted.message) };
}
