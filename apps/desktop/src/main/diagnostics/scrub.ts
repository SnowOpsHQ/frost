import os from 'node:os';
import { createScrubber, machineLiterals, type Scrubber } from '@app/telemetry';
import { DIAGNOSTICS_PERCENT_DECODE_ROUNDS, DIAGNOSTICS_SCRUB_RULES } from '@app/specs/diagnostics.spec';

// The diagnostics scrubber (Phase 11 Task 12; spec `diagnostics.spec.ts`, `DIAGNOSTICS_SCRUB_RULES`;
// acceptance `diagnostics.feature.md`): the line in NFKC, percent-encoded tokens checked decoded,
// then telemetry's scrubber (its `SCRUB_RULES`, then the literal names) and the stricter diagnostics pass. One line at a time: telemetry's scrubber cuts its
// input to `maxScrubInputChars`, and a ring line is far shorter.

/** A token: a run up to whitespace, a quote, a bracket, a comma or a semicolon (`DIAGNOSTICS_SCRUB_RULES`' token). */
const TOKEN = /(?<![^\s"'<>`(),;[\]{}])[^\s"'<>`(),;[\]{}]+/g;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/i;

/** `text` in Unicode NFKC (full-width `．` `／` `＠` become `.` `/` `@`), or as it is if that fails. */
function nfkc(text: string): string {
  try {
    return text.normalize('NFKC');
  } catch {
    return text;
  }
}

/** Percent-escapes decoded, at most `DIAGNOSTICS_PERCENT_DECODE_ROUNDS` rounds; a bad sequence stays as it is. */
export function percentDecode(text: string): string {
  let out = text;
  for (let round = 0; round < DIAGNOSTICS_PERCENT_DECODE_ROUNDS; round++) {
    const next = out.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Telemetry's scrubber with `literals`, then `DIAGNOSTICS_SCRUB_RULES` in order, on the line in NFKC.
 * Before that, every token holding a percent-escape is decoded (and normalised) on the side: if the
 * scrubber would change the decoded token, the whole token is `[redacted]` (an encoded URL, address
 * or path the patterns cannot read). Never throws on a string.
 */
export function createDiagnosticsScrubber(literals: readonly string[]): Scrubber {
  const telemetry = createScrubber({ literals });
  const core = (text: string): string => {
    let out = telemetry(text);
    for (const rule of DIAGNOSTICS_SCRUB_RULES) out = out.replace(rule.pattern, rule.replacement);
    return out;
  };
  return (text) => {
    const line = nfkc(text).replace(TOKEN, (token) => {
      if (!PERCENT_ESCAPE.test(token)) return token;
      const decoded = nfkc(percentDecode(token));
      return decoded !== token && core(decoded) !== decoded ? '[redacted]' : token;
    });
    return core(line);
  };
}

/**
 * The names a report must never hold as text: the machine's host and login names
 * (`machineLiterals`) and the folders that would name the user or this profile (home, temp, the
 * app's paths), each also with `/` for `\` and with doubled backslashes (as JSON writes them). The
 * patterns catch these paths anyway; the literals also catch them where a pattern would not (a path
 * cut short, a name inside a word). Every lookup is guarded: none throws.
 */
export function diagnosticsLiterals(paths: readonly (() => string | undefined)[]): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    out.add(value);
    out.add(value.replace(/\\/g, '/'));
    out.add(value.replace(/\\/g, '\\\\'));
  };
  try {
    for (const name of machineLiterals()) add(name);
  } catch {
    // No names: the patterns still run.
  }
  for (const read of [() => os.homedir(), () => os.tmpdir(), ...paths]) {
    try {
      add(read());
    } catch {
      // That folder is unknown here.
    }
  }
  return [...out];
}
