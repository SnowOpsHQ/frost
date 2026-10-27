import { CSP_INLINE_OVERRIDES } from '@app/specs/seo-compliance.spec';

// frost's own Content Security Policy reader (acceptance `seo-compliance.feature.md`, CSP), written
// from CSP Level 3's parsing rules: a header value is a comma-separated list of policies; a policy
// is `;`-separated directives; a directive is a name (ASCII, case-insensitive) and its source list
// (whitespace-separated tokens); a repeated directive is ignored after its first occurrence. A
// `<meta>` policy ignores `frame-ancestors`, `report-uri` and `sandbox`. Linear; header values are
// already cut by main (`RESPONSE_LIMITS`), meta values by the extractor.

export type CspSource = 'header' | 'meta';

export interface CspDirective {
  /** The directive's name, lowercased. */
  readonly name: string;
  /** Its source-list tokens as written. */
  readonly sources: readonly string[];
}

export interface CspPolicy {
  readonly source: CspSource;
  /** The policy's text as kept (trimmed). */
  readonly text: string;
  readonly directives: readonly CspDirective[];
}

const DIRECTIVE_NAME = /^[a-z0-9-]+$/;
/** Directives a `<meta>` policy cannot set (CSP3 §3.3). */
const META_IGNORED: ReadonlySet<string> = new Set(['frame-ancestors', 'report-uri', 'sandbox']);

/** One policy's text as directives (first occurrence of each name wins; unparsable names are skipped). */
export function parseCspPolicy(text: string, source: CspSource): CspPolicy {
  const directives: CspDirective[] = [];
  const seen = new Set<string>();
  for (const part of text.split(';')) {
    const tokens = part.trim().split(/[\t\n\f\r ]+/).filter((token) => token !== '');
    const name = tokens[0]?.toLowerCase();
    if (name === undefined || !DIRECTIVE_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    if (source === 'meta' && META_IGNORED.has(name)) continue;
    directives.push({ name, sources: tokens.slice(1) });
  }
  return { source, text: text.trim(), directives };
}

/** The policies of one header (or meta) value: comma-separated, empty ones dropped. */
export function parseCsp(value: string, source: CspSource): CspPolicy[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => parseCspPolicy(part, source));
}

/** The directive `name` of `policy`, if it has one. */
export function cspDirective(policy: CspPolicy, name: string): CspDirective | undefined {
  return policy.directives.find((directive) => directive.name === name);
}

/** The source list that governs scripts: `script-src`, else `default-src`; `null` when the policy does not restrict scripts. */
export function scriptSources(policy: CspPolicy): readonly string[] | null {
  return (cspDirective(policy, 'script-src') ?? cspDirective(policy, 'default-src'))?.sources ?? null;
}

const lower = (token: string): string => token.toLowerCase();

/** Whether a script source list lets inline scripts run: `'unsafe-inline'` and none of `CSP_INLINE_OVERRIDES` (a nonce, a hash, `'strict-dynamic'`). */
export function sourcesAllowInline(sources: readonly string[]): boolean {
  const tokens = sources.map(lower);
  if (!tokens.includes("'unsafe-inline'")) return false;
  return !tokens.some((token) => CSP_INLINE_OVERRIDES.some((override) => token.startsWith(`'${override}`)));
}

/**
 * Whether `policies` (all enforced together) let inline scripts run and at least one of them says
 * so explicitly (`'unsafe-inline'` in its script directive): every policy that governs scripts
 * allows them. A page with no policy at all is `csp-missing`, not this.
 */
export function allowsInlineScripts(policies: readonly CspPolicy[]): boolean {
  let explicit = false;
  for (const policy of policies) {
    const sources = scriptSources(policy);
    if (sources === null) continue;
    if (!sourcesAllowInline(sources)) return false;
    explicit = true;
  }
  return explicit;
}

/** The `frame-ancestors` source lists of the header policies (a `<meta>` policy cannot set it). */
export function frameAncestors(policies: readonly CspPolicy[]): (readonly string[])[] {
  const out: (readonly string[])[] = [];
  for (const policy of policies) {
    if (policy.source !== 'header') continue;
    const directive = cspDirective(policy, 'frame-ancestors');
    if (directive) out.push(directive.sources);
  }
  return out;
}
