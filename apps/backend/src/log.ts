import type { BetterAuthOptions } from 'better-auth';

// better-auth's logger, made safe to keep on: extra arguments (error objects, which can carry a
// failed query's parameters or a Postgres `detail` with the row's values) are dropped, and the
// message keeps only its first line with addresses and token-like strings masked.

type Logger = NonNullable<BetterAuthOptions['logger']>;
export type LogSink = (line: string) => void;

const EMAIL = /[^\s@<>"']+@[^\s@<>"']+/g;
/** Long runs of token/hash alphabets (base64, hex, scrypt `salt:key`). */
const TOKEN_LIKE = /[A-Za-z0-9+/=_\-.:$]{24,}/g;
const MAX_CHARS = 200;

export function redactLogMessage(message: unknown): string {
  const first = (typeof message === 'string' ? message : '').split('\n', 1)[0] ?? '';
  return first.replace(EMAIL, '<email>').replace(TOKEN_LIKE, '<redacted>').slice(0, MAX_CHARS);
}

export function createRedactingLogger(sink: LogSink = (line) => console.error(line)): Logger {
  return {
    level: 'warn',
    log: (level, message) => sink(`[better-auth] ${level}: ${redactLogMessage(message)}`),
  };
}
