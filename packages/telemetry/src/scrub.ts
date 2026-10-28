/**
 * Scrubbing (spec: `SCRUB_RULES`, `MIN_LITERAL_REDACTION_CHARS`, `APP_FRAME_PREFIX`). Every string
 * that leaves goes through a scrubber; stack frame files go through `appRelativeFilename` first.
 */
import os from 'node:os';
import { APP_FRAME_PREFIX, LITERAL_REDACTION, MIN_LITERAL_REDACTION_CHARS, SCRUB_RULES } from '@app/specs/telemetry-privacy.spec';

export type Scrubber = (text: string) => string;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A scrubber: `SCRUB_RULES` in order, then the literal names (longest first, case-insensitive).
 * The literals come last so a pattern still sees, say, a whole address before a name inside it goes.
 */
export function createScrubber({ literals }: { literals: readonly string[] }): Scrubber {
  const names = [...new Set(literals.map((name) => name.trim()))].filter((name) => name.length >= MIN_LITERAL_REDACTION_CHARS).sort((a, b) => b.length - a.length);
  const literal = names.length > 0 ? new RegExp(names.map(escapeRegExp).join('|'), 'gi') : undefined;
  return (text) => {
    let out = text;
    for (const rule of SCRUB_RULES) out = out.replace(rule.pattern, rule.replacement);
    if (literal) out = out.replace(literal, LITERAL_REDACTION);
    return out;
  };
}

/** The machine's host name and the user's login name: redacted wherever they appear by default. */
export function machineLiterals(): string[] {
  const names: string[] = [];
  try {
    names.push(os.hostname());
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
  return Array.from(text).slice(0, max).join('');
}

const toSlashes = (path: string) => path.replace(/\\+/g, '/');
const trimSlashes = (path: string) => path.replace(/^\/+/, '');

/**
 * A stack frame's file, safe to send (`APP_FRAME_PREFIX` in the spec):
 * - in `node_modules` → its path from the last `node_modules/`;
 * - in an `app.asar`, under `appRoot`, or an `app://` URL → `app:///` + its path in the app;
 * - Node's internals (`node:…`) and pseudo-files (`<anonymous>`) → kept;
 * - another URL → `[url]`; another file → its base name.
 * What is kept is scrubbed too (a base name can hold an ID).
 */
export function appRelativeFilename(filename: string, appRoot: string | undefined, scrub: Scrubber = defaultScrubber): string {
  if (filename === '') return '';
  if (/^node:/.test(filename)) return scrub(filename);
  if (/^<[^>]*>$/.test(filename)) return filename;

  let path = filename;
  if (/^file:\/\//i.test(path)) {
    path = decodeURIComponentSafe(path.replace(/^file:\/\/(?:localhost)?/i, '')).replace(/^\/([A-Za-z]:)/, '$1');
  } else if (/^app:\/\//i.test(path)) {
    const inApp = path.replace(/^app:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
    return APP_FRAME_PREFIX + scrub(trimSlashes(inApp));
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return '[url]';
  }
  path = toSlashes(path).replace(/[?#].*$/, '');

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
