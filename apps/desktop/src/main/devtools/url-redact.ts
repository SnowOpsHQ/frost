import { EXPORT_REDACT_NAME_FRAGMENTS, EXPORT_REDACT_VALUE_PATTERNS, EXPORT_REDACTED_QUERY_PARAMS, REDACTED_VALUE } from '@app/specs/devtools.spec';

// The network export's URL redaction (Phase 11 Task 4, Decision 5; spec `devtools.spec.ts`,
// `EXPORT_URL_PLACES`; acceptance `devtools.feature.md`, URL redaction). One function,
// `redactExportUrl`, runs over every URL an export carries. Best effort, by design:
// - user info (`user:password@`) and the fragment (`#access_token=…`) are dropped;
// - a query parameter named on `EXPORT_REDACTED_QUERY_PARAMS`, or whose lower-cased name contains an
//   `EXPORT_REDACT_NAME_FRAGMENTS` part, has its value replaced by `REDACTED_VALUE` whatever its length;
// - any value (or a bare query part) that after percent-decoding matches
//   `EXPORT_REDACT_VALUE_PATTERNS` (email-shaped, a long opaque run, JWT-shaped) is replaced too.
// A secret under an unknown name or in a path segment is not caught; the file says so
// (`EXPORT_URLS_REDACTED_NOTE`). Pure: no Electron, no state.

const DENYLIST: ReadonlySet<string> = new Set(EXPORT_REDACTED_QUERY_PARAMS);
const PATTERNS: readonly RegExp[] = Object.values(EXPORT_REDACT_VALUE_PATTERNS);
/** The schemes whose URLs an export writes (redacted); any other is written as `REDACTED_VALUE`. */
const SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);
/** Percent-decoding rounds (a double-encoded `%2540` is still an `@`); each stops early once stable. */
const DECODE_ROUNDS = 5;
/** How deep a value is searched for nested parameters (`?next=/cb?token=…`). */
const MAX_NESTING = 4;

/** `raw` percent-decoded (with `+` as a space), up to `DECODE_ROUNDS` times; undecodable parts stay as they are. */
export function decodeQueryPart(raw: string): string {
  let value = raw.replace(/\+/g, ' ');
  for (let i = 0; i < DECODE_ROUNDS; i++) {
    let next: string;
    try {
      next = decodeURIComponent(value);
    } catch {
      // A stray `%`: decode what can be decoded.
      next = value.replace(/(%[0-9a-f]{2})+/gi, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return run;
        }
      });
    }
    if (next === value) break;
    value = next;
  }
  return value;
}

/**
 * Whether a parameter of this (raw) name is always redacted. The name is compared whole, without
 * trailing `[…]` brackets (`token[]`, `token%5B%5D`), and by each bracket's content (`data[sid]`).
 */
function sensitiveName(rawName: string): boolean {
  const name = decodeQueryPart(rawName).trim().toLowerCase();
  if (name === '') return false;
  const candidates = [name, name.replace(/(\[[^\]]*\])+$/, '').trim(), ...[...name.matchAll(/\[([^\]]*)\]/g)].map((m) => (m[1] ?? '').trim())];
  return candidates.some((candidate) => candidate !== '' && (DENYLIST.has(candidate) || EXPORT_REDACT_NAME_FRAGMENTS.some((part) => candidate.includes(part))));
}

/** Whether a (raw) value looks like a secret or personal data after decoding. */
function sensitiveValue(rawValue: string): boolean {
  const values = [rawValue, decodeQueryPart(rawValue)];
  return values.some((value) => PATTERNS.some((pattern) => pattern.test(value)));
}

/**
 * Whether a (raw) value carries nested parameters that are sensitive: once decoded, a value holding
 * `?`, `&`, `;` or `=` (`next=/cb?token=…`, `next=%2Fcb%3Fcode%3D…`, `a=1?token=…`) has its
 * `name=value` pieces checked by the same name and value rules, recursively (`MAX_NESTING`).
 */
function nestedSensitive(rawValue: string, depth = 0): boolean {
  if (depth >= MAX_NESTING) return false;
  const decoded = decodeQueryPart(rawValue);
  if (!/[?&;=]/.test(decoded)) return false;
  for (const piece of decoded.split(/[?&;]/)) {
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    if (eq < 0) {
      if (sensitiveValue(piece)) return true;
      continue;
    }
    const name = piece.slice(0, eq);
    const value = piece.slice(eq + 1);
    if (sensitiveValue(name)) return true;
    if (value === '') continue;
    if (sensitiveName(name) || sensitiveValue(value) || nestedSensitive(value, depth + 1)) return true;
  }
  return false;
}

/** One `name=value` (or bare) query part, redacted. */
function redactPart(part: string): string {
  const eq = part.indexOf('=');
  if (eq < 0) return part !== '' && (sensitiveValue(part) || nestedSensitive(part)) ? REDACTED_VALUE : part;
  const name = part.slice(0, eq);
  const value = part.slice(eq + 1);
  if (value === '') return part;
  if (sensitiveName(name) || sensitiveValue(value) || sensitiveValue(name) || nestedSensitive(value)) return `${sensitiveValue(name) ? REDACTED_VALUE : name}=${REDACTED_VALUE}`;
  return part;
}

/**
 * `url` (resolved against `base` when relative) as an export writes it: user info and fragment
 * dropped, sensitive query values `REDACTED_VALUE`, the rest as it was (the path untouched). A URL
 * that cannot be read, or of a scheme other than `http(s)` / `ws(s)`, is `REDACTED_VALUE` whole.
 */
export function redactExportUrl(url: string, base?: string): string {
  let parsed: URL;
  try {
    parsed = base === undefined ? new URL(url) : new URL(url, base);
  } catch {
    return REDACTED_VALUE;
  }
  if (!SCHEMES.has(parsed.protocol)) return REDACTED_VALUE;
  // `search` keeps the query as written (no re-encoding), `?` included. Parts split on `&` and `;`.
  const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
  const redacted = query === '' ? '' : query.split(/([&;])/).map((piece, i) => (i % 2 === 1 ? piece : redactPart(piece))).join('');
  // Path matrix parameters (`/a;jsessionid=…`) follow the same name and value rules; the path's
  // segments themselves are never redacted (the documented gap).
  const path = parsed.pathname.replace(/;([^/;]*)/g, (_all, part: string) => `;${redactPart(part)}`);
  return `${parsed.protocol}//${parsed.host}${path}${redacted !== '' ? `?${redacted}` : ''}`;
}

/**
 * A `link` header value with each `<…>` URL redacted (resolved against `base`); an unclosed `<…` (the
 * value was cut at `maxHeaderValueChars`) runs to the end of the value, and so does the text after a
 * stray `>` (outside any `<…>`). A value with no `<` that reads as an absolute URL is redacted as one.
 */
export function redactLinkHeader(value: string, base: string): string {
  if (!value.includes('<')) {
    try {
      new URL(value.trim());
      return redactExportUrl(value.trim());
    } catch {
      // Not a URL: scanned below for a stray `>`.
    }
  }
  let out = '';
  let at = 0;
  while (at < value.length) {
    const open = value.indexOf('<', at);
    const close = value.indexOf('>', at);
    if (close >= 0 && (open < 0 || close < open)) {
      // A stray `>`: whatever follows is not trusted to be ordinary link parameters.
      const rest = value.slice(close + 1);
      return `${out}${value.slice(at, close + 1)}${rest.trim() === '' ? rest : redactExportUrl(rest.trim(), base)}`;
    }
    if (open < 0) return out + value.slice(at);
    out += value.slice(at, open);
    const end = value.indexOf('>', open + 1);
    if (end < 0) return `${out}<${redactExportUrl(value.slice(open + 1).trim(), base)}`;
    out += `<${redactExportUrl(value.slice(open + 1, end).trim(), base)}>`;
    at = end + 1;
  }
  return out;
}

/** The HAR `queryString` of an (already redacted) URL: each part's decoded name and value, in order. */
export function queryStringOf(url: string): { name: string; value: string }[] {
  const at = url.indexOf('?');
  if (at < 0) return [];
  const query = url.slice(at + 1).split('#')[0] ?? '';
  if (query === '') return [];
  return query.split(/[&;]/).map((part) => {
    const eq = part.indexOf('=');
    return eq < 0 ? { name: decodeQueryPart(part), value: '' } : { name: decodeQueryPart(part.slice(0, eq)), value: decodeQueryPart(part.slice(eq + 1)) };
  });
}
