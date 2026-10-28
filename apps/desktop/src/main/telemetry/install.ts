import type { TelemetryService } from '@app/ipc-contract';
import { createTelemetry, type Send, type SpanAttributes, type Telemetry } from '@app/telemetry';
import { RENDERER_ERROR_MECHANISMS, type RendererErrorInput, type RendererErrorResult, type TelemetryState } from '@app/specs/telemetry-consent.schema';
import { TELEMETRY_LIMITS, TELEMETRY_PLATFORMS, type TelemetryChannel } from '@app/specs/telemetry-privacy.spec';
import type { TelemetryConfig } from './config';
import type { ConsentStore } from './consent-store';

// Telemetry in the main process (Phase 4 Task 7; spec `telemetry-consent.schema.ts`; acceptance
// `telemetry.feature.md`, Desktop). Creates `@app/telemetry` with the consent the store read at
// startup, sends through `net.fetch`, reports main's own uncaught errors without changing how the
// process behaves on them, records one `app.start` span, and holds the quit (bounded) to shut down.
// Pure: Electron's `app`, `process` and `net.fetch` are injected (`main.ts` passes the real ones).

/** The parts of Electron's `app` used here. */
export interface TelemetryAppLike {
  readonly isPackaged: boolean;
  getVersion(): string;
  getAppPath(): string;
  whenReady(): Promise<unknown>;
  on(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/** The parts of Node's `process` used here. */
export interface TelemetryProcessLike {
  readonly platform: string;
  readonly versions: { readonly electron?: string | undefined };
  on(event: 'uncaughtExceptionMonitor', listener: (error: Error, origin: string) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown, promise: Promise<unknown>) => void): unknown;
  emitWarning(warning: string, type: string): void;
}

/** `net.fetch` (Electron's network stack: the system's proxy and certificates). */
export type TelemetryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TelemetryMainDeps {
  readonly app: TelemetryAppLike;
  readonly process: TelemetryProcessLike;
  readonly fetch: TelemetryFetch;
  /** Read already (synchronously, before any window): its consent is where telemetry starts. */
  readonly store: ConsentStore;
  readonly config: TelemetryConfig;
  /**
   * Resolves when startup is complete (the first window is open): the end of the `app.start` span.
   * Main's never rejects (a startup that does not complete leaves the span open: it is never sent);
   * one that did would end the span as an error.
   */
  readonly started: Promise<void>;
  readonly log: (message: string) => void;
  /** Milliseconds for the `app.start` span's duration (default `performance.now`). */
  readonly now?: () => number;
  /** Literal strings scrubbed from everything sent (default: the machine's host and login names). */
  readonly redact?: readonly string[];
}

/**
 * The telemetry handle for the rest of main (plan "Interfaces for other phases"): `span(name, attrs,
 * fn)` and `captureException(error, hint)` (only `SPAN_ATTRIBUTE_ALLOWLIST` keys leave; everything is
 * scrubbed and gated on consent), plus reading the consent. Consent changes only through
 * `TelemetryService.setConsent`, which also writes the store; quitting shuts it down.
 */
export type TelemetryHandle = Pick<Telemetry, 'span' | 'captureException' | 'consent' | 'configured' | 'flush'>;

export interface TelemetryMain {
  readonly telemetry: TelemetryHandle;
  /** The IPC `telemetry.*` service (`services.telemetry`). */
  readonly service: TelemetryService;
}

/**
 * Headers that replace what `net.fetch` would add on its own: Chromium's detailed `user-agent` (its
 * and Electron's build) and the user's locale in `accept-language`. Neither is sent as it is.
 */
export const TELEMETRY_REQUEST_HEADERS = { 'user-agent': 'frost-telemetry', 'accept-language': '' } as const;

/** The `Send` the package calls: one `POST` through `fetch`, with no cookies, cache or redirects. */
function netSend(app: TelemetryAppLike, fetch: TelemetryFetch): Send {
  return async (url, { headers, body, signal }) => {
    // `net.fetch` needs a ready app; an error reported earlier waits for it (or for its abort).
    await app.whenReady();
    signal.throwIfAborted();
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, ...TELEMETRY_REQUEST_HEADERS },
      body: body as BodyInit,
      signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    const answer = {
      status: response.status,
      headers: { 'retry-after': response.headers.get('retry-after'), 'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits') },
    };
    // The body is never read: release it.
    await response.body?.cancel().catch(() => undefined);
    return answer;
  };
}

/** Node's text for an unhandled rejection's reason, as its `warn` mode prints it. */
function rejectionText(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? String(reason);
  try {
    return String(reason);
  } catch {
    return 'Unhandled promise rejection';
  }
}

/** A renderer error as an `Error` whose stack is the renderer's (never main's). */
function rendererError(input: RendererErrorInput): Error {
  const error = new Error(input.message);
  error.name = input.name === '' ? 'Error' : input.name;
  error.stack = input.stack ?? `${error.name}: ${input.message}`;
  return error;
}

export function installTelemetry(deps: TelemetryMainDeps): TelemetryMain {
  const { app, process: proc, store, config, log } = deps;
  const now = deps.now ?? (() => performance.now());
  const send = netSend(app, deps.fetch);
  const telemetry = createTelemetry({
    consent: store.consent(),
    // The app's version and platform only (and the runtime for error events): no identifier.
    resource: {
      serviceVersion: app.getVersion(),
      platform: proc.platform,
      ...(proc.versions.electron ? { runtime: { name: 'electron', version: proc.versions.electron } } : {}),
    },
    otel: { endpoint: config.otelEndpoint ?? undefined, send },
    sentry: { dsn: config.sentryDsn ?? undefined, send, environment: app.isPackaged ? 'production' : 'development' },
    // Stack frames under the app's root are reported as `app:///…`.
    appRoot: app.getAppPath(),
    ...(deps.redact ? { redact: deps.redact } : {}),
  });

  // ---- Main's own uncaught errors -------------------------------------------------------------
  // An error is reported once even when Node shows it twice (a rejection raised as an exception).
  const reported = new WeakSet<object>();
  const capture = (error: unknown, mechanism: string): void => {
    if (typeof error === 'object' && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    try {
      telemetry.captureException(error, { mechanism, handled: false });
    } catch {
      // Reporting never throws into the app.
    }
  };
  // The monitor observes without handling: Electron's own uncaught-exception handler (its error
  // dialog, the process going on) runs exactly as without telemetry. An `uncaughtException`
  // listener would replace it.
  proc.on('uncaughtExceptionMonitor', (error, origin) => capture(error, origin === 'unhandledRejection' ? 'onunhandledrejection' : 'onuncaughtexception'));
  // Electron's main runs Node's `warn` mode for unhandled rejections: a warning, and the process goes
  // on. A listener silences that warning, so this one prints it the same way after reporting.
  proc.on('unhandledRejection', (reason) => {
    capture(reason, 'onunhandledrejection');
    proc.emitWarning(rejectionText(reason), 'UnhandledPromiseRejectionWarning');
  });

  // ---- One startup span -----------------------------------------------------------------------
  const startedAt = now();
  const platform = (TELEMETRY_PLATFORMS as readonly string[]).includes(proc.platform) ? proc.platform : undefined;
  const startAttributes: SpanAttributes = platform ? { platform } : {};
  telemetry
    .span('app.start', startAttributes, (span) => Promise.resolve(deps.started).then(() => span.setAttributes({ outcome: 'ok', duration_ms: Math.max(0, now() - startedAt) })))
    // A rejected `started` has ended the span as an error already; it is not an unhandled rejection.
    .catch(() => undefined);

  // ---- Quitting -------------------------------------------------------------------------------
  // With a channel on, the first `will-quit` waits for `shutdown` (flush, then drop the rest), at most
  // `shutdownTimeoutMs`, then quits again; that `will-quit` passes. With both off nothing is held.
  let quit: 'running' | 'holding' | 'done' = 'running';
  app.on('will-quit', (event) => {
    if (quit === 'done') return;
    const consent = telemetry.consent();
    const configured = telemetry.configured();
    const sending = (consent.usage && configured.usage) || (consent.errors && configured.errors);
    if (quit === 'running' && !sending) {
      quit = 'done';
      void telemetry.shutdown({ timeoutMs: 0 });
      return;
    }
    event.preventDefault();
    if (quit === 'holding') return;
    quit = 'holding';
    void telemetry.shutdown({ timeoutMs: TELEMETRY_LIMITS.shutdownTimeoutMs }).then(() => {
      quit = 'done';
      // From a task of its own: a quit from a microtask still runs inside the `will-quit` dispatch.
      setImmediate(() => app.quit());
    });
  });

  // ---- The IPC service ------------------------------------------------------------------------
  let version = 0;
  // `false` once a write failed: what is shown holds for this run only (the next start is off).
  let persisted = true;
  const state = (): TelemetryState => ({ consent: telemetry.consent(), configured: telemetry.configured(), persisted, version });
  const service: TelemetryService = {
    state,
    setConsent(channel: TelemetryChannel, on: boolean) {
      if (telemetry.consent()[channel] === on) return state();
      // The telemetry first (off stops export at once), then the file.
      telemetry.setConsent(channel, on);
      persisted = store.write(telemetry.consent());
      if (!persisted) log('telemetry: consent applied for this run only');
      version += 1;
      return state();
    },
    reportError(input: RendererErrorInput): RendererErrorResult {
      if (!telemetry.consent().errors || !telemetry.configured().errors) return 'dropped';
      telemetry.captureException(rendererError(input), { mechanism: RENDERER_ERROR_MECHANISMS[input.source], handled: false });
      return 'reported';
    },
  };

  const handle: TelemetryHandle = {
    span: (name, attributes, fn) => telemetry.span(name, attributes, fn),
    captureException: (error, hint) => telemetry.captureException(error, hint),
    consent: () => telemetry.consent(),
    configured: () => telemetry.configured(),
    flush: (options) => telemetry.flush(options),
  };
  return { telemetry: handle, service };
}
