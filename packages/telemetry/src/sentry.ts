/**
 * The `errors` channel: Sentry error events through `@sentry/core` only (the Node and Electron SDKs
 * instrument the process and add their own IPC). A minimal client: no integrations, no breadcrumbs,
 * no client reports, every `dataCollection` category off, and its own scope (never the global one).
 *
 * Consent is checked four times: before capturing, in `beforeSend` (which also rebuilds the event
 * from the allowlists), when the transport is handed an envelope, and when the queued request is
 * about to go out. Requests wait in a small queue for the next macrotask; turning `errors` off
 * empties it and aborts the request in flight, and starts a new consent epoch: an event captured
 * before is dropped wherever it is in Sentry's pipeline.
 *
 * The transport only sends `event` items that `rebuild` produced in the current epoch (Sentry skips
 * `beforeSend` for its own internal error reports); anything else in an envelope is dropped.
 */
import {
  Client,
  Scope,
  createEnvelope,
  createStackParser,
  createTransport,
  dsnFromString,
  eventFromMessage,
  eventFromUnknownInput,
  type BaseTransportOptions,
  type ClientOptions,
  type Envelope,
  type ErrorEvent,
  type Event,
  type EventHint,
  type Exception,
  type ParameterizedString,
  type SeverityLevel,
  type StackFrame,
  type Transport,
  type TransportMakeRequestResponse,
} from '@sentry/core';
import { nodeStackLineParser } from '@sentry/core/server';
import { SENTRY_ENVELOPE_ITEM_TYPES, SENTRY_EVENT_KEYS, TELEMETRY_LIMITS } from '@app/specs/telemetry-privacy.spec';
import { osType, serviceVersion } from './otel';
import { appRelativeFilename, cap, type Scrubber } from './scrub';
import { httpUrl, sendOnce } from './send';
import type { CaptureHint, Send, TelemetryResource } from './types';

const TOKEN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
/** The key in a capture's hint data that carries the consent epoch it was captured in. */
const EPOCH = 'frostConsentEpoch';
const LEVELS: readonly SeverityLevel[] = ['fatal', 'error', 'warning'];

class MinimalClient extends Client<ClientOptions> {
  constructor(options: ClientOptions) {
    super(options);
  }

  override eventFromException(exception: unknown, hint?: EventHint): PromiseLike<Event> {
    const event = eventFromUnknownInput(this, this._options.stackParser, exception, hint);
    event.level = 'error';
    return Promise.resolve(event);
  }

  override eventFromMessage(message: ParameterizedString, level: SeverityLevel = 'info', hint?: EventHint): PromiseLike<Event> {
    return Promise.resolve(eventFromMessage(this._options.stackParser, message, level, hint, false));
  }
}

interface Queued {
  url: string;
  body: string | Uint8Array;
  resolve: (response: TransportMakeRequestResponse) => void;
}

export interface SentryChannelOptions {
  dsn: string;
  send: Send;
  environment?: string;
  resource: TelemetryResource;
  appRoot: string | undefined;
  scrub: Scrubber;
  /** Live consent for `errors`. */
  enabled: () => boolean;
}

export class SentryChannel {
  private readonly client: MinimalClient;
  private readonly scope = new Scope();
  private queue: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort = new AbortController();
  private closed = false;
  /** Bumped at every turn-off: an event is only sent in the epoch it was captured in. */
  private epoch = 0;
  /** The events `rebuild` produced, and the epoch each was captured in. */
  private readonly rebuilt = new WeakMap<object, number>();

  /** A channel for `dsn`, or `undefined` when it is not an `http(s)` Sentry DSN. */
  static create(options: Omit<SentryChannelOptions, 'dsn'> & { dsn: string | undefined }): SentryChannel | undefined {
    if (!options.dsn) return undefined;
    const dsn = dsnFromString(options.dsn);
    if (!dsn || !dsn.publicKey || !dsn.projectId || !httpUrl(options.dsn)) return undefined;
    return new SentryChannel({ ...options, dsn: options.dsn });
  }

  private constructor(private readonly options: SentryChannelOptions) {
    const version = serviceVersion(options.resource, options.scrub);
    this.client = new MinimalClient({
      dsn: options.dsn,
      release: `frost@${version}`,
      environment: options.environment && TOKEN.test(options.environment) ? options.environment : 'production',
      integrations: [],
      stackParser: createStackParser(nodeStackLineParser()),
      transport: (transportOptions) => this.transport(transportOptions),
      transportOptions: { bufferSize: TELEMETRY_LIMITS.maxQueuedEvents },
      sendClientReports: false,
      attachStacktrace: false,
      maxBreadcrumbs: 0,
      beforeBreadcrumb: () => null,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        mcp: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
      beforeSend: (event, hint) => (this.sending() && hint.data?.[EPOCH] === this.epoch ? this.rebuild(event, hint, this.epoch) : null),
      beforeSendLog: () => null,
      beforeSendMetric: () => null,
    });
    this.scope.setClient(this.client);
    this.client.init();
  }

  captureException(error: unknown, hint: CaptureHint | undefined): void {
    if (!this.sending()) return;
    const mechanism = { type: hint?.mechanism && TOKEN.test(hint.mechanism) ? hint.mechanism : 'generic', handled: hint?.handled ?? true };
    try {
      this.client.captureException(error, { mechanism, data: { [EPOCH]: this.epoch } }, this.scope);
    } catch {
      // Reporting an error never throws into the app.
    }
  }

  setEnabled(on: boolean): void {
    if (on) return;
    // Off: answer every queued request without sending it, and abort the one in flight.
    this.epoch += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const item of this.queue.splice(0)) item.resolve({});
    this.abort.abort();
    this.abort = new AbortController();
  }

  /** Sends what is queued and waits (up to `timeoutMs`) for Sentry's pipeline and the requests in flight. */
  async flush(timeoutMs: number): Promise<void> {
    if (!this.sending()) return;
    this.drain();
    await Promise.resolve(this.client.flush(Math.max(1, timeoutMs))).catch(() => undefined);
  }

  /** Stops for good: drops the queue and aborts the request in flight. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.setEnabled(false);
  }

  private sending(): boolean {
    return !this.closed && this.options.enabled();
  }

  private transport(transportOptions: BaseTransportOptions): Transport {
    const inner = createTransport(transportOptions, (request) => this.enqueue(transportOptions.url, request.body));
    return {
      send: (envelope) => {
        const onlyEvents = this.sending() ? eventsOnly(envelope, (payload) => this.rebuilt.get(payload) === this.epoch) : undefined;
        return onlyEvents ? inner.send(onlyEvents) : Promise.resolve({});
      },
      flush: (timeout) => inner.flush(timeout),
    };
  }

  private enqueue(url: string, body: string | Uint8Array): Promise<TransportMakeRequestResponse> {
    if (!this.sending() || this.queue.length >= TELEMETRY_LIMITS.maxQueuedEvents) return Promise.resolve({});
    return new Promise((resolve) => {
      this.queue.push({ url, body, resolve });
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.drain();
        }, 0);
        this.timer.unref?.();
      }
    });
  }

  private drain(): void {
    for (const item of this.queue.splice(0)) {
      // Consent again, at the moment the request would go out.
      if (!this.sending()) {
        item.resolve({});
        continue;
      }
      void sendOnce(this.options.send, item.url, { 'content-type': 'application/x-sentry-envelope' }, item.body, this.abort.signal).then((outcome) => {
        if (outcome.kind !== 'answered') return item.resolve({});
        const headers = outcome.response.headers ?? {};
        item.resolve({
          statusCode: outcome.response.status,
          headers: { 'retry-after': headers['retry-after'] ?? null, 'x-sentry-rate-limits': headers['x-sentry-rate-limits'] ?? null },
        });
      });
    }
  }

  /** The event as sent: rebuilt from `SENTRY_EVENT_KEYS`, every string scrubbed and capped. */
  private rebuild(event: ErrorEvent, hint: EventHint, epoch: number): ErrorEvent {
    const { scrub, appRoot, resource } = this.options;
    const text = (value: unknown, max: number) => (typeof value === 'string' ? cap(scrub(value), max) : undefined);
    const out: ErrorEvent = { type: undefined };
    if (typeof event.event_id === 'string' && /^[0-9a-f]{32}$/.test(event.event_id)) out.event_id = event.event_id;
    if (typeof event.timestamp === 'number') out.timestamp = event.timestamp;
    out.platform = 'node';
    out.level = event.level && LEVELS.includes(event.level) ? event.level : 'error';
    if (event.release) out.release = event.release;
    if (event.environment) out.environment = event.environment;
    const message = text(typeof event.message === 'string' ? event.message : event.logentry?.message, TELEMETRY_LIMITS.maxMessageChars);
    if (message) out.message = message;

    const values = (event.exception?.values ?? []).slice(-TELEMETRY_LIMITS.maxExceptions);
    if (values.length > 0) {
      out.exception = {
        values: values.map((value): Exception => {
          const mechanismType = hint.mechanism?.type ?? value.mechanism?.type;
          const handled = hint.mechanism?.handled ?? value.mechanism?.handled;
          const frames = (value.stacktrace?.frames ?? []).slice(-TELEMETRY_LIMITS.maxFrames).map((frame) => this.frame(frame, appRoot));
          return {
            type: text(value.type ?? 'Error', TELEMETRY_LIMITS.maxTypeChars) ?? 'Error',
            value: text(value.value ?? '', TELEMETRY_LIMITS.maxMessageChars) ?? '',
            mechanism: { type: mechanismType && TOKEN.test(mechanismType) ? mechanismType : 'generic', handled: typeof handled === 'boolean' ? handled : true },
            ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
          };
        }),
      };
    }

    out.contexts = {
      os: { name: osType(resource.platform) },
      app: { app_version: serviceVersion(resource, scrub) },
      ...(resource.runtime ? { runtime: { name: cap(scrub(resource.runtime.name), 32), version: cap(scrub(resource.runtime.version), 32) } } : {}),
    };
    this.rebuilt.set(out, epoch);
    return out;
  }

  private frame(frame: StackFrame, appRoot: string | undefined): StackFrame {
    const { scrub } = this.options;
    const out: StackFrame = {};
    const filename = frame.filename ?? frame.abs_path;
    if (typeof filename === 'string') out.filename = appRelativeFilename(filename, appRoot, scrub);
    if (typeof frame.function === 'string') out.function = cap(scrub(frame.function), TELEMETRY_LIMITS.maxFunctionChars);
    if (typeof frame.module === 'string') out.module = cap(scrub(frame.module), TELEMETRY_LIMITS.maxFunctionChars);
    if (typeof frame.lineno === 'number') out.lineno = frame.lineno;
    if (typeof frame.colno === 'number') out.colno = frame.colno;
    if (typeof frame.in_app === 'boolean') out.in_app = frame.in_app;
    return out;
  }
}

/**
 * The envelope with only `SENTRY_ENVELOPE_ITEM_TYPES` items whose payload `rebuilt` accepts (each cut
 * back to `SENTRY_EVENT_KEYS`, in case anything was added after `beforeSend`) and no trace header, or
 * `undefined` when nothing is left.
 */
export function eventsOnly(envelope: Envelope, rebuilt: (payload: object) => boolean): Envelope | undefined {
  const [headers, items] = envelope;
  const kept: [{ type: string }, Record<string, unknown>][] = [];
  for (const [itemHeader, payload] of items as readonly [{ type: string }, unknown][]) {
    if (!(SENTRY_ENVELOPE_ITEM_TYPES as readonly string[]).includes(itemHeader.type)) continue;
    if (typeof payload !== 'object' || payload === null || !rebuilt(payload)) continue;
    const event: Record<string, unknown> = {};
    for (const key of SENTRY_EVENT_KEYS) if (Object.hasOwn(payload, key)) event[key] = (payload as Record<string, unknown>)[key];
    kept.push([{ type: itemHeader.type }, event]);
  }
  if (kept.length === 0) return undefined;
  const { trace: _trace, ...rest } = headers as Record<string, unknown>;
  return createEnvelope(rest as Envelope[0], kept as never) as Envelope;
}
