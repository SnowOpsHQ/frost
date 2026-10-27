import { LEGACY_META_REFERRER, REFERRER_POLICIES, type ReferrerPolicyValue } from '@app/specs/seo-compliance.spec';

// Reading the security headers (acceptance `seo-compliance.feature.md`, Headers): HSTS (RFC 6797),
// X-Frame-Options (RFC 7034), X-Content-Type-Options (Fetch) and the referrer policy (Referrer
// Policy, W3C), the way browsers read them. Each reader is linear and never throws.

export interface Hsts {
  /** `max-age` in seconds (capped at `Number.MAX_SAFE_INTEGER`). */
  readonly maxAge: number;
  readonly includeSubDomains: boolean;
  readonly preload: boolean;
}

/**
 * One `Strict-Transport-Security` value: `;`-separated directives, names case-insensitive, a value
 * after `=` (optionally quoted). `null` when browsers would ignore it: no `max-age`, one that is not
 * digits, or any directive given twice (RFC 6797 §6.1).
 */
export function parseHsts(value: string): Hsts | null {
  const seen = new Set<string>();
  let maxAge: number | null = null;
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    const name = (eq < 0 ? trimmed : trimmed.slice(0, eq)).trim().toLowerCase();
    if (seen.has(name)) return null;
    seen.add(name);
    if (name !== 'max-age') continue;
    let raw = eq < 0 ? '' : trimmed.slice(eq + 1).trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    if (!/^\d+$/.test(raw)) return null;
    maxAge = Math.min(Number(raw), Number.MAX_SAFE_INTEGER);
  }
  return maxAge === null ? null : { maxAge, includeSubDomains: seen.has('includesubdomains'), preload: seen.has('preload') };
}

/** `seconds` as frost says it: "1 year", "180 days", "1 hour" … (whole units, the largest that fits). */
export function formatDuration(seconds: number): string {
  const units: [number, string][] = [
    [31_536_000, 'year'],
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n.toLocaleString('en-US')} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/**
 * Whether `X-Frame-Options` values protect the page: every comma-separated token (of every value)
 * is `DENY` or `SAMEORIGIN` (case-insensitive), and they agree. `ALLOW-FROM` is obsolete and ignored
 * by current browsers.
 */
export function frameOptionsProtect(values: readonly string[]): boolean {
  const tokens = values.flatMap((value) => value.split(',')).map((token) => token.trim().toLowerCase()).filter((token) => token !== '');
  if (tokens.length === 0) return false;
  const first = tokens[0]!;
  return (first === 'deny' || first === 'sameorigin') && tokens.every((token) => token === first);
}

/** Whether the first `X-Content-Type-Options` value is `nosniff` (its first comma-separated token, case-insensitive). */
export function isNosniff(values: readonly string[]): boolean {
  const first = values[0];
  return first !== undefined && first.split(',')[0]!.trim().toLowerCase() === 'nosniff';
}

const POLICIES: ReadonlySet<string> = new Set(REFERRER_POLICIES);

/** The policy `Referrer-Policy` values set: the last known token of all of them (comma-separated), else `null`. */
export function headerReferrerPolicy(values: readonly string[]): ReferrerPolicyValue | null {
  let policy: ReferrerPolicyValue | null = null;
  for (const value of values) {
    for (const token of value.split(',')) {
      const name = token.trim().toLowerCase();
      if (POLICIES.has(name)) policy = name as ReferrerPolicyValue;
    }
  }
  return policy;
}

/** The policy a `<meta name="referrer">` sets (a known value or a legacy one), else `null`. */
export function metaReferrerPolicy(content: string | null): ReferrerPolicyValue | null {
  if (content === null) return null;
  const name = content.trim().toLowerCase();
  if (POLICIES.has(name)) return name as ReferrerPolicyValue;
  return Object.hasOwn(LEGACY_META_REFERRER, name) ? LEGACY_META_REFERRER[name]! : null;
}
