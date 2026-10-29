/**
 * Scrubbing (spec: `SCRUB_RULES`, `MIN_LITERAL_REDACTION_CHARS`, `MIN_UNBOUNDED_LITERAL_CHARS`,
 * `APP_FRAME_PREFIX`, `TELEMETRY_LIMITS.maxScrubInputChars`). Every string that leaves goes through a
 * scrubber; stack frame files go through `appRelativeFilename` first.
 */
import os from 'node:os';
import { APP_FRAME_PREFIX, LITERAL_REDACTION, MIN_LITERAL_REDACTION_CHARS, MIN_UNBOUNDED_LITERAL_CHARS, SCRUB_RULES, TELEMETRY_LIMITS } from '@app/specs/telemetry-privacy.spec';

export type Scrubber = (text: string) => string;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a token ends: the partial token left at a cut is dropped back to the last of these. */
const SEPARATOR = /[\s"'<>`,;()[\]{}]/;

/**
 * A scrubber: the text cut to `maxScrubInputChars` (so every pattern runs on bounded text), then
 * `SCRUB_RULES` in order, then the literal names (longest first, case-insensitive; a short one only
 * as a whole word). The literals come last so a pattern still sees, say, a whole address before a
 * name inside it goes. The caller caps the result to its own limit.
 */
export function createScrubber({ literals }: { literals: readonly string[] }): Scrubber {
  const names = [...new Set(literals.map((name) => name.trim()))].filter((name) => name.length >= MIN_LITERAL_REDACTION_CHARS).sort((a, b) => b.length - a.length);
  const anywhere = names.filter((name) => name.length >= MIN_UNBOUNDED_LITERAL_CHARS).map(escapeRegExp);
  const wholeWord = names.filter((name) => name.length < MIN_UNBOUNDED_LITERAL_CHARS).map(escapeRegExp);
  const alternatives = [...(anywhere.length > 0 ? [anywhere.join('|')] : []), ...(wholeWord.length > 0 ? [`(?<![\\p{L}\\p{N}])(?:${wholeWord.join('|')})(?![\\p{L}\\p{N}])`] : [])];
  const literal = alternatives.length > 0 ? new RegExp(alternatives.join('|'), 'giu') : undefined;
  return (text) => {
    let out = precap(text);
    for (const rule of SCRUB_RULES) out = out.replace(rule.pattern, rule.replacement);
    if (literal) out = out.replace(literal, LITERAL_REDACTION);
    return out;
  };
}

/** `text` cut to `maxScrubInputChars`, without the token the cut went through (it may be half a secret). */
function precap(text: string): string {
  const max = TELEMETRY_LIMITS.maxScrubInputChars;
  if (text.length <= max) return text;
  const head = cap(text, max);
  for (let i = head.length - 1; i >= 0; i -= 1) {
    if (SEPARATOR.test(head[i]!)) return head.slice(0, i + 1);
  }
  return head;
}

/**
 * The machine's host name (and its first label: `Alices-Laptop.local` is also `Alices-Laptop`) and
 * the user's login name: redacted wherever they appear by default.
 */
export function machineLiterals(): string[] {
  const names: string[] = [];
  try {
    const hostname = os.hostname();
    names.push(hostname);
    const firstLabel = hostname.split('.')[0];
    if (firstLabel && firstLabel !== hostname) names.push(firstLabel);
  } catch {
    // No host name: nothing to redact.
  }
  try {
    names.push(os.userInfo().username);
  } catch {
    // No passwd entry (a container): nothing to redact.
  }
  return names;
}

const defaultScrubber = createScrubber({ literals: [] });

/** Cuts `text` to `max` characters (by code point, so a surrogate pair is never split). */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  for (let count = 0; count < max && end < text.length; count += 1) {
    const unit = text.charCodeAt(end);
    const pair = unit >= 0xd800 && unit <= 0xdbff && end + 1 < text.length && (text.charCodeAt(end + 1) & 0xfc00) === 0xdc00;
    end += pair ? 2 : 1;
  }
  return text.slice(0, end);
}

/** `path` without its query and fragment (`?…`, `#…`). */
function withoutQuery(path: string): string {
  const query = path.search(/[?#]/);
  return query === -1 ? path : path.slice(0, query);
}

const toSlashes = (path: string) => path.replace(/\\+/g, '/');
const trimSlashes = (path: string) => path.replace(/^\/+/, '');

/**
 * A stack frame's file, safe to send (`APP_FRAME_PREFIX` in the spec):
 * - in `node_modules` → its path from the last `node_modules/`;
 * - in an `app.asar`, under `appRoot`, or an `app://` URL → `app:///` + its path in the app;
 * - Node's internals (`node:…`) and pseudo-files (`<anonymous>`) → kept;
 * - another URL → `[url]`; another file → its base name.
 * What is kept is scrubbed too (a base name can hold an ID), and capped to `maxFilenameChars`.
 */
export function appRelativeFilename(filename: string, appRoot: string | undefined, scrub: Scrubber = defaultScrubber): string {
  return cap(relativeFilename(cap(filename, TELEMETRY_LIMITS.maxScrubInputChars), appRoot, scrub), TELEMETRY_LIMITS.maxFilenameChars);
}

function relativeFilename(filename: string, appRoot: string | undefined, scrub: Scrubber): string {
  if (filename === '') return '';
  if (/^node:/.test(filename)) return scrub(filename);
  if (/^<[^>]*>$/.test(filename)) return scrub(filename);

  let path = filename;
  if (/^file:\/\//i.test(path)) {
    path = decodeURIComponentSafe(path.replace(/^file:\/\/(?:localhost)?/i, '')).replace(/^\/([A-Za-z]:)/, '$1');
  } else if (/^app:\/\//i.test(path)) {
    const inApp = withoutQuery(path.replace(/^app:\/\/[^/]*/i, ''));
    return APP_FRAME_PREFIX + scrub(trimSlashes(inApp));
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return '[url]';
  }
  path = withoutQuery(toSlashes(path));

  const modules = path.lastIndexOf('/node_modules/');
  if (modules !== -1) return scrub(path.slice(modules + 1));
  const asar = path.indexOf('/app.asar/');
  if (asar !== -1) return APP_FRAME_PREFIX + scrub(path.slice(asar + '/app.asar/'.length));
  if (appRoot) {
    const root = toSlashes(appRoot).replace(/\/+$/, '');
    if (root.length > 0 && path.startsWith(`${root}/`)) return APP_FRAME_PREFIX + scrub(trimSlashes(path.slice(root.length)));
  }
  const base = path.slice(path.lastIndexOf('/') + 1);
  return scrub(base);
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
