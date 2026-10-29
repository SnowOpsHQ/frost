import {
  RENDERER_ERROR_LIMITS,
  RENDERER_ERROR_RATE_LIMIT,
  type RendererErrorInput,
  type RendererErrorSource,
} from '@app/specs/telemetry-consent.spec';
import { ipc } from './ipc';

// The chrome's own uncaught errors → `telemetry.reportError` (Phase 4 Task 7; spec
// `telemetry-consent.schema.ts`; acceptance `telemetry.feature.md`, Desktop, Renderer). Main decides:
// it scrubs the report and drops it unless `errors` is on. Here an error is only turned into plain
// text cut to `RENDERER_ERROR_LIMITS`, and at most `RENDERER_ERROR_RATE_LIMIT.maxReports` leave per
// window of time. Reporting never throws and never reports its own failure.

/** The parts of `window` used here. */
export interface ErrorEventSource {
  addEventListener(type: 'error' | 'unhandledrejection', listener: (event: unknown) => void): void;
  removeEventListener(type: 'error' | 'unhandledrejection', listener: (event: unknown) => void): void;
}

export interface RendererErrorReportingOptions {
  readonly target: ErrorEventSource;
  readonly report: (input: RendererErrorInput) => Promise<unknown>;
  /** Milliseconds (`performance.now` by default). */
  readonly now?: () => number;
}

/** `text` cut to at most `max` UTF-16 units, never ending inside a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** A property read that never throws (a hostile getter, a revoked proxy). */
function read(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '';
  }
}

/** What is reported for `value` (an `Error`, or anything a promise was rejected with). */
export function rendererErrorInput(source: RendererErrorSource, value: unknown): RendererErrorInput {
  const message = read(value, 'message');
  const name = read(value, 'name');
  const stack = read(value, 'stack');
  const isErrorLike = typeof message === 'string';
  return {
    source,
    name: cut(typeof name === 'string' && name !== '' && isErrorLike ? name : 'Error', RENDERER_ERROR_LIMITS.maxNameChars),
    message: cut(isErrorLike ? message : typeof value === 'object' && value !== null ? '' : text(value), RENDERER_ERROR_LIMITS.maxMessageChars),
    stack: isErrorLike && typeof stack === 'string' ? cut(stack, RENDERER_ERROR_LIMITS.maxStackChars) : null,
  };
}

/** Listens for `target`'s uncaught errors and rejections; answers a function that stops listening. */
export function installRendererErrorReporting(options: RendererErrorReportingOptions): () => void {
  const now = options.now ?? (() => performance.now());
  let windowStart = Number.NEGATIVE_INFINITY;
  let sent = 0;

  const send = (input: RendererErrorInput): void => {
    const at = now();
    if (at - windowStart >= RENDERER_ERROR_RATE_LIMIT.windowMs || at < windowStart) {
      windowStart = at;
      sent = 0;
    }
    if (sent >= RENDERER_ERROR_RATE_LIMIT.maxReports) return;
    sent += 1;
    try {
      void options.report(input).catch(() => undefined);
    } catch {
      // A failed report is not itself an error to report.
    }
  };

  const onError = (event: unknown): void => {
    const error = read(event, 'error');
    // Without an error object (a script error), the event's message.
    send(rendererErrorInput('error', typeof error === 'object' && error !== null ? error : { message: text(read(event, 'message') ?? '') }));
  };
  const onRejection = (event: unknown): void => send(rendererErrorInput('unhandledrejection', read(event, 'reason')));

  options.target.addEventListener('error', onError);
  options.target.addEventListener('unhandledrejection', onRejection);
  return () => {
    options.target.removeEventListener('error', onError);
    options.target.removeEventListener('unhandledrejection', onRejection);
  };
}

// The chrome page itself (not in unit tests, which run without a window).
if (typeof window !== 'undefined') {
  installRendererErrorReporting({ target: window as unknown as ErrorEventSource, report: (input) => ipc.telemetry.reportError.mutate(input) });
}
