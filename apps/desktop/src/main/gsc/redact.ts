import { redact } from '../account/redact';

// Search Console's log (acceptance `gsc.feature.md`, Decisions, "Logs carry no secret"; plan Global
// Constraint "Logs never carry secrets"). The modules log fixed messages only; as a second line of
// defence every message goes through the account's redactor, Google's token shapes, and every token,
// code, verifier, `state` and client secret seen in this run.

const GOOGLE_REDACTIONS: readonly RegExp[] = [
  // Access tokens, refresh tokens and authorization codes as Google issues them.
  /\bya29\.[A-Za-z0-9._~+/-]*/g,
  /\b1\/\/[A-Za-z0-9._~+/-]*/g,
  /\b4\/[A-Za-z0-9._~+/-]*/g,
  /\b(client_secret|code_challenge)=[^&\s"']*/gi,
];

/** `redact` (`../account/redact.ts`) plus Google's token shapes. */
export function redactGsc(message: string): string {
  let out = redact(message);
  for (const pattern of GOOGLE_REDACTIONS) out = out.replace(pattern, '[redacted]');
  return out;
}

export interface RedactingLog {
  /** Writes `message` to the sink, scrubbed. */
  readonly log: (message: string) => void;
  /** Values (of at least 6 characters) scrubbed from every later message: the latest 64 (codes, access tokens, nonces). */
  readonly remember: (...values: string[]) => void;
  /**
   * Long-lived values (the client secret, refresh tokens) scrubbed for the whole run, outside the cap
   * of `remember` (a run sees only a handful of them).
   */
  readonly pin: (...values: string[]) => void;
}

export function createRedactingLog(sink: (message: string) => void): RedactingLog {
  const known = new Set<string>();
  const pinned = new Set<string>();
  return {
    remember: (...values) => {
      for (const value of values) if (value.length >= 6) known.add(value);
      while (known.size > 64) known.delete(known.values().next().value as string);
    },
    pin: (...values) => {
      for (const value of values) if (value.length >= 6) pinned.add(value);
    },
    log: (message) => {
      let out = message;
      for (const secret of pinned) out = out.split(secret).join('[redacted]');
      for (const secret of known) out = out.split(secret).join('[redacted]');
      try {
        sink(redactGsc(out));
      } catch {
        // A log that fails never fails the call that logged.
      }
    },
  };
}
