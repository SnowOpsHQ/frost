import { AI_SEARCH_LIMITS as L } from '@app/specs/ai-search.spec';
import {
  AiAnswerJobSchema,
  AiAnswerParsedSchema,
  OpenAiMessageSchema,
  OpenAiResponseSchema,
  OpenAiUrlCitationSchema,
  PerplexityResponseSchema,
  type AiAnswerJobResult,
  type AiCitation,
} from '@app/specs/ai-search.schema';
import { withinDepth } from '../serp/serp-api-parse';

// An AI search provider's answer → the answer text and its citations (Phase 12 Task 8; spec
// `ai-search.spec.ts`, `ai-search.schema.ts`; plan Decision 8, Global constraints "Untrusted text",
// Threat model "Hostile vendor or AI JSON"). Pure, and run only in the SERP worker (`serp-worker.ts`,
// job kind `ai-answer`), never on Electron's main thread. Never throws.
// 1. The job is validated (`AiAnswerJobSchema`); the answer's size (`maxResponseBytes`, UTF-8) and
//    nesting (`maxDepth`, counted on the text, strings skipped) are checked **before** `JSON.parse`.
// 2. The JSON is validated with the provider's schema: only the answer text and the citation fields
//    are picked, strictly typed and capped; anything else is never read.
//    - Perplexity (Sonar): `choices[0].message.content`; citations in `citations` order (titles from
//      `search_results` by URL), else `search_results`.
//    - OpenAI Responses: each `message` output item's `output_text` parts, joined; citations from
//      their `url_citation` annotations, in order. Other items, parts and annotations are skipped.
// 3. Text is made inert data: control, format and lone-surrogate characters removed (line feeds and
//    tabs kept), cut to `maxAnswerChars` (`answerTruncated`). An empty answer is refused.
// 4. Citations: `http(s)` URLs only, without user info (serialised, at most `maxCitationUrlChars`), once each, at most
//    `maxCitations` (`citationsTotal` counts the distinct ones); titles cleaned and cut.
// Any problem is `{ ok: false }` (`invalid-answer`).

const FAILED: AiAnswerJobResult = { ok: false };

/** Control and format characters (and lone surrogates) other than line feed and tab. */
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\p{Cs}]/gu;

/** `s` cut to at most `max` UTF-16 code units, never splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = max - (/[\ud800-\udbff]/.test(s.charAt(max - 1)) ? 1 : 0);
  return s.slice(0, end);
}

/** Text as inert data: unsafe characters removed, trimmed. */
const inert = (value: string): string => value.replace(UNSAFE_TEXT, '').trim();

/** A title: one line, unsafe characters removed, cut. */
const titleOf = (value: string | null | undefined): string => (typeof value === 'string' ? cut(inert(value).replace(/\s+/g, ' '), L.maxCitationTitleChars) : '');

/** An absolute `http:` / `https:` URL in its serialised form within the cap, or `null`. */
function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.href.length > L.maxCitationUrlChars) return null;
    // A URL carrying a user name or password is dropped (Task 8 review): never shown or handed on.
    if (url.username !== '' || url.password !== '') return null;
    if (/[\u0000- \u007f- ]/.test(url.href)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Distinct `http(s)` citations, in order; the first title given for a URL wins. */
function citationsOf(entries: readonly { readonly url: unknown; readonly title?: string | null | undefined }[]): { kept: AiCitation[]; total: number } {
  const seen = new Set<string>();
  const all: AiCitation[] = [];
  for (const entry of entries) {
    const url = webUrl(entry.url);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    all.push({ url, title: titleOf(entry.title) });
  }
  return { kept: all.slice(0, L.maxCitations), total: all.length };
}

type Read = { readonly text: string; readonly sources: readonly { readonly url: unknown; readonly title?: string | null | undefined }[] } | null;

function readPerplexity(json: unknown): Read {
  const parsed = PerplexityResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  const { choices, citations, search_results: results } = parsed.data;
  const titles = new Map<string, string | null | undefined>();
  for (const result of results ?? []) if (!titles.has(result.url)) titles.set(result.url, result.title);
  const sources = citations && citations.length > 0 ? citations.map((url) => ({ url, title: titles.get(url) ?? null })) : (results ?? []).map((result) => ({ url: result.url, title: result.title }));
  return { text: choices[0]!.message.content, sources };
}

function readOpenAi(json: unknown): Read {
  const parsed = OpenAiResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  const texts: string[] = [];
  const sources: { url: unknown; title?: string | null | undefined }[] = [];
  for (const item of parsed.data.output) {
    if (item.type !== 'message') continue;
    const message = OpenAiMessageSchema.safeParse(item);
    if (!message.success) return null;
    for (const part of message.data.content) {
      if (part.type !== 'output_text') continue;
      if (typeof part.text !== 'string') return null;
      texts.push(part.text);
      for (const annotation of part.annotations ?? []) {
        if (annotation.type !== 'url_citation') continue;
        const citation = OpenAiUrlCitationSchema.safeParse(annotation);
        if (!citation.success) return null;
        sources.push({ url: citation.data.url, title: citation.data.title });
      }
    }
  }
  return { text: texts.join('\n\n'), sources };
}

const READERS = { perplexity: readPerplexity, 'openai-search': readOpenAi } as const;

/** Validates and runs one `ai-answer` job (`AiAnswerJobSchema`) in the SERP worker. Never throws. */
export function runAiAnswerJob(raw: unknown): AiAnswerJobResult {
  try {
    const job = AiAnswerJobSchema.safeParse(raw);
    if (!job.success) return FAILED;
    const { provider, body } = job.data;
    // The caps first: nothing too large or too deep reaches the parser.
    if (Buffer.byteLength(body, 'utf8') > L.maxResponseBytes || !withinDepth(body, L.maxDepth)) return FAILED;
    const json: unknown = JSON.parse(body);
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return FAILED;
    const read = READERS[provider](json);
    if (read === null) return FAILED;
    const whole = inert(read.text);
    if (whole === '') return FAILED;
    const answer = cut(whole, L.maxAnswerChars);
    const { kept, total } = citationsOf(read.sources);
    const out = AiAnswerParsedSchema.safeParse({ answer, answerTruncated: answer.length < whole.length, citations: kept, citationsTotal: total });
    return out.success ? { ok: true, answer: out.data } : FAILED;
  } catch {
    return FAILED;
  }
}
