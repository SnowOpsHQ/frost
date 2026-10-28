// The account's log redactor (acceptance `account-signin.feature.md`, "Logs carry no secret"; plan
// Global Constraint "Logs never carry secrets"). The account logs fixed messages only; as a second
// line of defence every message goes through `redact`, which replaces any desktop token, JWS, email
// or code/state/token query value that might reach it. Search Console's redactor (`../gsc/redact.ts`)
// builds on it.

const REDACTIONS: readonly RegExp[] = [
  /frost_dt_[A-Za-z0-9_-]*/g,
  /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g,
  /[^\s@"'<>]+@[^\s@"'<>]+/g,
  /\b(code|state|code_verifier|token|access_token|refresh_token)=[^&\s"']*/gi,
  /\bBearer\s+\S+/gi,
];

/** Replaces token-, snapshot-, email- and code-shaped values in `message`. */
export function redact(message: string): string {
  let out = message;
  for (const pattern of REDACTIONS) out = out.replace(pattern, '[redacted]');
  return out;
}
