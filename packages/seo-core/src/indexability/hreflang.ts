import { HREFLANG_X_DEFAULT, ISO_3166_1_ALPHA_2, ISO_639_1 } from '@app/specs/seo-indexability.spec';

// hreflang codes (spec `seo-indexability.spec.ts`, `ISO_639_1`, `ISO_3166_1_ALPHA_2`; acceptance
// `seo-indexability.feature.md`, hreflang): `x-default`, or language[-script][-region], from frost's
// own tables, case-insensitive.

const LANGUAGES: ReadonlySet<string> = new Set(ISO_639_1);
const REGIONS: ReadonlySet<string> = new Set(ISO_3166_1_ALPHA_2);

export interface HreflangCode {
  readonly language: string;
  readonly script: string | null;
  readonly region: string | null;
}

/** `value` read as an hreflang code: `'x-default'`, its parts, or `null` when invalid. */
export function parseHreflangCode(value: string): HreflangCode | 'x-default' | null {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === HREFLANG_X_DEFAULT) return 'x-default';
  if (trimmed.length > 16) return null;
  const parts = trimmed.split('-');
  const language = parts.shift()!.toLowerCase();
  if (!LANGUAGES.has(language)) return null;
  let script: string | null = null;
  let region: string | null = null;
  if (parts.length > 0 && /^[A-Za-z]{4}$/.test(parts[0]!)) script = parts.shift()!;
  if (parts.length > 0) {
    const candidate = parts.shift()!.toUpperCase();
    if (!REGIONS.has(candidate)) return null;
    region = candidate;
  }
  if (parts.length > 0) return null;
  return { language, script, region };
}

/** Whether `value` is a valid hreflang value. */
export function isValidHreflang(value: string): boolean {
  return parseHreflangCode(value) !== null;
}
