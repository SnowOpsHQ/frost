import { formatWithOptions } from 'node:util';
import { DIAGNOSTICS_LIMITS, DIAGNOSTICS_LOG_RING, type DiagnosticsLogLevel } from '@app/specs/diagnostics.spec';

// The ring of main's own warnings and errors (Phase 11 Task 12; spec `diagnostics.spec.ts`,
// `DIAGNOSTICS_LOG_RING`; acceptance `diagnostics.feature.md`, Report). `installLogRing` wraps a
// console's `warn` and `error` (every main logger in frost calls them): the original prints exactly
// what it printed before, then the call's text is cut, split into lines, scrubbed and only then kept.
// The raw text is never stored. Only main's own `console` is wrapped: page console messages (the
// devtools drawer's per-tab log) never come here, and the agent utility process and the SEO worker
// threads write to their own stdout and stderr, not through this `console`.
//
// It never throws into the caller, never records a warning raised while it handles one (no
// recursion), and does bounded synchronous work per call (no I/O, no waiting).

export interface LogRingLine {
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly level: DiagnosticsLogLevel;
  /** Scrubbed, at most `maxLineChars`. */
  readonly text: string;
}

export interface LogRing {
  /** Adds one console call's arguments (formatted, cut, split, scrubbed). Never throws. */
  add(level: DiagnosticsLogLevel, args: readonly unknown[]): void;
  /** The kept lines, oldest first. */
  lines(): readonly LogRingLine[];
}

export interface LogRingOptions {
  readonly scrub: (text: string) => string;
  readonly now?: () => number;
  readonly limits?: { readonly maxLines: number; readonly maxLineChars: number };
}

/** Where a token ends: a cut goes back to the last of these so no half token is scrubbed as a whole one. */
const SEPARATOR = /[\s"'<>`,;()[\]{}]/;

/** `text` cut to `max` characters, back to the last separator when it had to be cut (by code point). */
export function cutAtSeparator(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = capChars(text, max);
  for (let i = head.length - 1; i >= 0; i -= 1) {
    if (SEPARATOR.test(head[i]!)) {
      head = head.slice(0, i + 1);
      break;
    }
    if (i === 0) head = '';
  }
  return head;
}

/** `text` cut to `max` characters, never splitting a surrogate pair. */
function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && (text.charCodeAt(max - 1) & 0xfc00) === 0xd800 ? max - 1 : max;
  return text.slice(0, end);
}

const INSPECT = {
  colors: false,
  depth: DIAGNOSTICS_LIMITS.maxInspectDepth,
  maxArrayLength: DIAGNOSTICS_LIMITS.maxInspectArrayLength,
  maxStringLength: DIAGNOSTICS_LIMITS.maxInspectStringChars,
  breakLength: Infinity,
  compact: 3,
  getters: false,
  showProxy: false,
  customInspect: false,
} as const;

/**
 * Where `util.inspect` cut a string inside an object (`'…'... 14 more characters`): the token the
 * cut went through is dropped with the marker (it may be half a secret no pattern would know).
 */
const INSPECT_CUT = /(?<![^\s"'`<>,;()[\]{}])[^\s"'`<>,;()[\]{}]*(['"`])\.\.\. \d+ more characters?/g;

/** A string property of an Error, read safely. */
function errorPart(error: Error, key: 'name' | 'message' | 'stack'): string {
  try {
    const value: unknown = error[key];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * An Error argument as `name: message`, its stack frames, and its cause as `cause: name: message`
 * (an Error cause only): never its own properties (`body`, `response` …), which can carry free text.
 */
export function formatError(error: Error): string {
  const head = `${errorPart(error, 'name') || 'Error'}: ${errorPart(error, 'message')}`;
  const frames = errorPart(error, 'stack')
    .split('\n')
    .filter((line) => /^\s+at /.test(line));
  let cause: unknown;
  try {
    cause = error.cause;
  } catch {
    cause = undefined;
  }
  const causeLine = cause instanceof Error ? [`  cause: ${errorPart(cause, 'name') || 'Error'}: ${errorPart(cause, 'message')}`] : [];
  return [head, ...frames, ...causeLine].join('\n');
}

/** One console call's text, at most `maxMessageChars` (each string argument cut before it is formatted). */
export function formatConsoleArgs(args: readonly unknown[]): string {
  const max = DIAGNOSTICS_LIMITS.maxMessageChars;
  let text: string;
  try {
    const bounded = args.slice(0, 32).map((arg) => (typeof arg === 'string' ? cutAtSeparator(arg, max) : arg instanceof Error ? cutAtSeparator(formatError(arg), max) : arg));
    text = formatWithOptions(INSPECT, ...bounded).replace(INSPECT_CUT, '$1... [cut]');
  } catch {
    text = '[unprintable]';
  }
  return cutAtSeparator(text, max);
}

export function createLogRing(options: LogRingOptions): LogRing {
  const limits = options.limits ?? DIAGNOSTICS_LOG_RING;
  const now = options.now ?? Date.now;
  // A circular buffer of at most `maxLines`.
  const buffer: LogRingLine[] = [];
  let start = 0;
  const push = (line: LogRingLine) => {
    if (buffer.length < limits.maxLines) buffer.push(line);
    else {
      buffer[start] = line;
      start = (start + 1) % limits.maxLines;
    }
  };
  return {
    add(level, args) {
      try {
        const at = now();
        const text = formatConsoleArgs(args);
        for (const raw of text.split(/\r\n|[\n\r\u2028\u2029]/)) {
          if (raw.trim() === '') continue;
          const scrubbed = capChars(options.scrub(raw).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trimEnd(), limits.maxLineChars);
          if (scrubbed.trim() !== '') push({ at, level, text: scrubbed });
        }
      } catch {
        // The ring never fails a caller's log call.
      }
    },
    lines() {
      return [...buffer.slice(start), ...buffer.slice(0, start)];
    },
  };
}

/** The console methods the ring wraps (`log`, `info` and `debug` are left alone). */
export interface WrappableConsole {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Wraps `target.warn` and `target.error`: each still prints exactly as before, then the ring records
 * the call. A call made while the ring is recording another (a warning raised inside it) prints only.
 * Answers the undo (tests). Installing over an already wrapped console wraps it once more; main
 * installs once (`installMainLogRing`).
 */
export function installLogRing(target: WrappableConsole, ring: LogRing): () => void {
  const originals = { warn: target.warn, error: target.error };
  let recording = false;
  const wrap = (level: DiagnosticsLogLevel) =>
    function diagnosticsLogRing(this: unknown, ...args: unknown[]): void {
      try {
        originals[level].apply(this === undefined ? target : this, args);
      } finally {
        if (!recording) {
          recording = true;
          try {
            ring.add(level, args);
          } catch {
            // Never into the caller.
          } finally {
            recording = false;
          }
        }
      }
    };
  target.warn = wrap('warn');
  target.error = wrap('error');
  return () => {
    target.warn = originals.warn;
    target.error = originals.error;
  };
}
