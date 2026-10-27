import { ROBOTS_PARSE_LIMITS } from '@app/specs/seo-indexability.spec';

// frost's robots.txt parser and matcher (spec `seo-indexability.spec.ts`; acceptance
// `seo-indexability.feature.md`, robots.txt). Written from the Robots Exclusion Protocol (RFC 9309):
// - lines end at CR, LF or CRLF; a leading byte order mark is dropped; `#` starts a comment;
// - a record is `key: value`, the key case-insensitive (`user-agent`, `allow`, `disallow`,
//   `sitemap`; other keys are ignored);
// - a group is one or more `user-agent` lines and the rules after them; only a rule (`allow` /
//   `disallow`) ends a group's agents, so a `user-agent` line after a rule starts the next group,
//   while `sitemap` lines and keys frost does not read (`crawl-delay` …) between agents keep them
//   in one group; rules before any group are ignored; `sitemap` lines belong to no group;
// - a `user-agent` value's product token is its leading run of letters, `-` and `_` (`*` alone is
//   every crawler; `*foo` names none), compared case-insensitively;
// - a crawler follows every group naming its token, merged; else every `*` group, merged; else
//   no group (everything allowed). An empty group still counts (it allows everything);
// - a rule's path is matched against the URL's path and query, both percent-normalised: a
//   percent-encoded unreserved character is decoded, other escapes are uppercased, and characters
//   outside printable ASCII are UTF-8 percent-encoded. `*` matches any run of characters, a final
//   `$` anchors the end; the most specific (longest) matching rule wins, Allow on a tie;
//   `/robots.txt` itself is always allowed. An empty `Disallow:` / `Allow:` is no rule.
// Linear in the text: one pass over it, and each rule is matched with `indexOf` per wildcard segment.

export interface RobotsRule {
  readonly allow: boolean;
  /** The path as written (trimmed). */
  readonly raw: string;
  /** Normalised for matching (a leading `/` added when it starts with neither `/` nor `*`). */
  readonly pattern: string;
  /** 1-based line number. */
  readonly line: number;
}

export interface RobotsGroup {
  /** The `user-agent` values as written (trimmed). */
  readonly agents: readonly string[];
  /** Their product tokens, lowercased (`*` for every crawler, `''` for a value with none). */
  readonly tokens: readonly string[];
  /** The line of its first `user-agent`. */
  readonly line: number;
  readonly rules: readonly RobotsRule[];
}

export interface RobotsSitemap {
  readonly raw: string;
  readonly line: number;
}

export interface RobotsFile {
  readonly groups: readonly RobotsGroup[];
  readonly ruleCount: number;
  /** The first `maxSitemaps` `Sitemap:` values; `sitemapTotal` counts them all. */
  readonly sitemaps: readonly RobotsSitemap[];
  readonly sitemapTotal: number;
  readonly lineCount: number;
}

export interface RobotsParseLimits {
  readonly maxLineChars: number;
  readonly maxSitemaps: number;
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const HEX = /^[0-9A-Fa-f]{2}$/;

function hex(byte: number): string {
  return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * robots.txt bytes as text without losing a byte: valid UTF-8 decodes to its characters; any byte
 * that is not part of a valid UTF-8 sequence (a Latin-1 file, an overlong form, a surrogate, a cut
 * sequence) becomes its percent-encoding `%XX`, so a Latin-1 `Disallow: /caf\xE9` matches the URL
 * path `/caf%E9` as a crawler comparing bytes would. A byte order mark is kept (the parser drops it).
 * Linear.
 */
export function decodeRobotsBytes(bytes: Uint8Array): string {
  const out: string[] = [];
  const n = bytes.length;
  let i = 0;
  const continuation = (at: number): boolean => at < n && (bytes[at]! & 0xc0) === 0x80;
  while (i < n) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      out.push(String.fromCharCode(b0));
      i += 1;
      continue;
    }
    let length = 0;
    let codePoint = 0;
    let min = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) [length, codePoint, min] = [2, b0 & 0x1f, 0x80];
    else if (b0 >= 0xe0 && b0 <= 0xef) [length, codePoint, min] = [3, b0 & 0x0f, 0x800];
    else if (b0 >= 0xf0 && b0 <= 0xf4) [length, codePoint, min] = [4, b0 & 0x07, 0x10000];
    let valid = length > 0;
    for (let k = 1; valid && k < length; k++) {
      if (!continuation(i + k)) valid = false;
      else codePoint = (codePoint << 6) | (bytes[i + k]! & 0x3f);
    }
    if (valid && (codePoint < min || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))) valid = false;
    if (!valid) {
      out.push(hex(b0));
      i += 1;
      continue;
    }
    out.push(String.fromCodePoint(codePoint));
    i += length;
  }
  return out.join('');
}

/** `codePoint` as UTF-8, percent-encoded (a lone surrogate as U+FFFD). */
function encodeCodePoint(codePoint: number): string {
  const cp = codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint;
  if (cp < 0x80) return hex(cp);
  if (cp < 0x800) return hex(0xc0 | (cp >> 6)) + hex(0x80 | (cp & 0x3f));
  if (cp < 0x10000) return hex(0xe0 | (cp >> 12)) + hex(0x80 | ((cp >> 6) & 0x3f)) + hex(0x80 | (cp & 0x3f));
  return hex(0xf0 | (cp >> 18)) + hex(0x80 | ((cp >> 12) & 0x3f)) + hex(0x80 | ((cp >> 6) & 0x3f)) + hex(0x80 | (cp & 0x3f));
}

/**
 * `value` percent-normalised (RFC 9309 §2.2.2): `%xx` of an unreserved character decoded, other
 * escapes uppercased, characters outside printable ASCII (and space) UTF-8 percent-encoded.
 * `*` and `$` are kept as they are. Linear.
 */
export function normaliseRobotsPath(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x25 && HEX.test(value.slice(i + 1, i + 3))) {
      const byte = parseInt(value.slice(i + 1, i + 3), 16);
      const char = String.fromCharCode(byte);
      out += UNRESERVED.test(char) ? char : hex(byte);
      i += 2;
    } else if (code <= 0x20 || code >= 0x7f) {
      const codePoint = value.codePointAt(i)!;
      if (codePoint > 0xffff) i += 1;
      out += encodeCodePoint(codePoint);
    } else {
      out += value[i];
    }
  }
  return out;
}

/** A `user-agent` value's product token, lowercased: `*`, or its leading letters, `-` and `_` (`''` when none). */
export function productToken(value: string): string {
  if (/^\*\s*$/.test(value)) return '*';
  if (value.startsWith('*')) return '';
  return (/^[A-Za-z_-]+/.exec(value)?.[0] ?? '').toLowerCase();
}

/** Parses robots.txt `text` (RFC 9309; see the top of this file). Never throws. */
export function parseRobotsTxt(text: string, limits: RobotsParseLimits = ROBOTS_PARSE_LIMITS): RobotsFile {
  const groups: { agents: string[]; tokens: string[]; line: number; rules: RobotsRule[] }[] = [];
  const sitemaps: RobotsSitemap[] = [];
  let sitemapTotal = 0;
  let ruleCount = 0;
  /** Whether the current group has taken a rule (a `user-agent` line then starts a new group). */
  let inRules = true;
  let lineNumber = 0;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let start = 0;
  while (start <= source.length) {
    // The end of this line: the first CR or LF.
    let end = start;
    while (end < source.length) {
      const c = source.charCodeAt(end);
      if (c === 0x0a || c === 0x0d) break;
      end++;
    }
    lineNumber++;
    if (end - start <= limits.maxLineChars) handle(source.slice(start, end), lineNumber);
    if (end >= source.length) break;
    start = source.charCodeAt(end) === 0x0d && source.charCodeAt(end + 1) === 0x0a ? end + 2 : end + 1;
  }

  function handle(rawLine: string, line: number): void {
    const hash = rawLine.indexOf('#');
    const content = (hash < 0 ? rawLine : rawLine.slice(0, hash)).trim();
    if (content === '') return;
    const colon = content.indexOf(':');
    if (colon < 0) return;
    const key = content.slice(0, colon).trim().toLowerCase();
    const value = content.slice(colon + 1).trim();
    switch (key) {
      case 'user-agent': {
        if (inRules || groups.length === 0) {
          groups.push({ agents: [], tokens: [], line, rules: [] });
          inRules = false;
        }
        const group = groups[groups.length - 1]!;
        group.agents.push(value);
        group.tokens.push(productToken(value));
        return;
      }
      case 'allow':
      case 'disallow': {
        if (groups.length === 0) return;
        inRules = true;
        if (value === '') return;
        const pattern = normaliseRobotsPath(value.startsWith('/') || value.startsWith('*') ? value : `/${value}`);
        groups[groups.length - 1]!.rules.push({ allow: key === 'allow', raw: value, pattern, line });
        ruleCount++;
        return;
      }
      case 'sitemap':
        if (value === '') return;
        sitemapTotal++;
        if (sitemaps.length < limits.maxSitemaps) sitemaps.push({ raw: value, line });
        return;
      default:
        return;
    }
  }

  return { groups, ruleCount, sitemaps, sitemapTotal, lineCount: lineNumber };
}

/** Whether normalised `pattern` (`*` wildcards, a final `$` anchor) matches normalised `path` from its start. */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  if (!body.includes('*')) return anchored ? path === body : path.startsWith(body);
  const parts = body.split('*');
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  let at = first.length;
  const last = parts.length - 1;
  for (let i = 1; i < last; i++) {
    const part = parts[i]!;
    if (part === '') continue;
    const found = path.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  const tail = parts[last]!;
  if (!anchored) return tail === '' || path.indexOf(tail, at) >= 0;
  // Anchored: the last segment must end the path, after everything matched so far.
  return path.length - tail.length >= at && path.endsWith(tail);
}

export interface RobotsMatch {
  /** The groups the crawler follows (its own, else `*`; empty: none applies). */
  readonly groups: readonly RobotsGroup[];
  /** The groups are the `*` ones (the crawler has none of its own). */
  readonly fallback: boolean;
  /** The most specific matching rule, `null` when none matches (allowed). */
  readonly rule: RobotsRule | null;
  readonly allowed: boolean;
}

/** The groups `agent` (a product token or `*`) follows: its own (merged), else the `*` ones. */
export function groupsFor(file: RobotsFile, agent: string): { groups: RobotsGroup[]; fallback: boolean } {
  const token = agent === '*' ? '*' : productToken(agent);
  if (token !== '*') {
    const own = file.groups.filter((group) => group.tokens.includes(token));
    if (own.length > 0) return { groups: own, fallback: false };
  }
  return { groups: file.groups.filter((group) => group.tokens.includes('*')), fallback: token !== '*' };
}

/** The URL's path and query as robots.txt rules see it (normalised), `/` for an empty path. */
export function robotsPathOf(url: URL): string {
  return normaliseRobotsPath(`${url.pathname || '/'}${url.search}`);
}

/** Whether `agent` may crawl `path` (normalised, `robotsPathOf`) under `file`, and why. */
export function matchRobots(file: RobotsFile, agent: string, path: string): RobotsMatch {
  const { groups, fallback } = groupsFor(file, agent);
  if (path === '/robots.txt') return { groups, fallback, rule: null, allowed: true };
  let best: RobotsRule | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (best !== null && (rule.pattern.length < best.pattern.length || (rule.pattern.length === best.pattern.length && (best.allow || !rule.allow)))) continue;
      if (robotsPatternMatches(rule.pattern, path)) best = rule;
    }
  }
  return { groups, fallback, rule: best, allowed: best === null || best.allow };
}
