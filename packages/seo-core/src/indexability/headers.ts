// Reading the response headers main kept (acceptance `seo-indexability.feature.md`, Headers):
// `X-Robots-Tag` directives and HTTP `Link` header values (RFC 8288). Both scanners are linear and
// bounded by their caps; header values are already cut by main (`RESPONSE_LIMITS`).

/** Directives that carry a value after a colon (`max-snippet: 20`), so `name:` before them is not a crawler. */
const VALUED_DIRECTIVES = new Set(['unavailable_after', 'max-snippet', 'max-image-preview', 'max-video-preview']);

export interface XRobotsTag {
  /** The crawler it is addressed to (lowercased, `googlebot: noindex`), `null` for every crawler. */
  readonly agent: string | null;
  /** Its directives, lowercased, each without a value (`max-snippet: 20` is `max-snippet`). */
  readonly directives: readonly string[];
  /** The header value as kept. */
  readonly value: string;
}

/**
 * One `X-Robots-Tag` value: optionally `<crawler>:` first (unless that name is a directive that
 * takes a value), then comma-separated directives.
 */
export function parseXRobotsTag(value: string): XRobotsTag {
  let agent: string | null = null;
  let rest = value;
  const prefixed = /^\s*([A-Za-z0-9_.-]+)\s*:(.*)$/s.exec(value);
  if (prefixed && !VALUED_DIRECTIVES.has(prefixed[1]!.toLowerCase())) {
    agent = prefixed[1]!.toLowerCase();
    rest = prefixed[2]!;
  }
  const directives = rest
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .map((part) => {
      const colon = part.indexOf(':');
      return (colon < 0 ? part : part.slice(0, colon)).trim();
    })
    .filter((part) => part !== '');
  return { agent, directives, value };
}

export interface LinkValue {
  /** The URI reference between `<` and `>`, trimmed. */
  readonly target: string;
  /** `rel` tokens, lowercased. */
  readonly rel: readonly string[];
  /** The `hreflang` parameter as written (trimmed), `null` when absent. */
  readonly hreflang: string | null;
}

/**
 * The link values of one `Link` header value (RFC 8288: `<target>; rel="…"; hreflang=…`, comma
 * separated; quoted strings may hold commas and semicolons), at most `max`. Each parameter's first
 * occurrence counts. One pass.
 */
export function parseLinkHeader(value: string, max: number): LinkValue[] {
  const out: LinkValue[] = [];
  const n = value.length;
  let i = 0;
  const skipSpace = () => {
    while (i < n && (value[i] === ' ' || value[i] === '\t')) i++;
  };
  while (i < n && out.length < max) {
    skipSpace();
    if (value[i] === ',') {
      i++;
      continue;
    }
    if (value[i] !== '<') {
      // Not a link value: skip to the next comma.
      const comma = value.indexOf(',', i);
      i = comma < 0 ? n : comma + 1;
      continue;
    }
    const close = value.indexOf('>', i + 1);
    if (close < 0) break;
    const target = value.slice(i + 1, close).trim();
    i = close + 1;
    const params = new Map<string, string>();
    while (i < n) {
      skipSpace();
      if (value[i] === ',') {
        i++;
        break;
      }
      if (value[i] !== ';') {
        i++;
        continue;
      }
      i++;
      skipSpace();
      let name = '';
      while (i < n && !'=;,'.includes(value[i]!) && value[i] !== ' ' && value[i] !== '\t') name += value[i++];
      skipSpace();
      let param = '';
      if (value[i] === '=') {
        i++;
        skipSpace();
        if (value[i] === '"') {
          i++;
          while (i < n && value[i] !== '"') {
            if (value[i] === '\\' && i + 1 < n) i++;
            param += value[i++];
          }
          i++;
        } else {
          while (i < n && value[i] !== ';' && value[i] !== ',') param += value[i++];
          param = param.trim();
        }
      }
      const key = name.toLowerCase();
      if (key !== '' && !params.has(key)) params.set(key, param);
    }
    const rel = (params.get('rel') ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token !== '');
    const hreflang = params.has('hreflang') ? params.get('hreflang')!.trim() : null;
    out.push({ target, rel, hreflang });
  }
  return out;
}
