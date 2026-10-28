/**
 * The `usage` channel: OpenTelemetry traces behind a consent gate, exported as OTLP/HTTP JSON
 * through the injected transport.
 *
 * The SDK's `TracerProvider` makes the spans (IDs, timing, parent and child); a gated processor
 * replaces the SDK's batch processor, whose queue cannot be discarded without a flush:
 * - at a span's end, nothing is kept unless `usage` is on (the span is converted to its exported
 *   form there: allowlisted attributes, scrubbed, fixed name);
 * - batches leave `exportDelayMs` after the first queued span, or at once when a batch is full;
 * - turning off empties the queue, cancels the timer and aborts the request in flight; nothing is
 *   flushed. Turning on again starts from an empty queue.
 *
 * The resource is built here from the three `RESOURCE_ATTRIBUTE_KEYS`; no resource detector runs,
 * and the exporter never reads a span's own resource.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Context, type HrTime, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { TracerProvider, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { OS_TYPE_BY_PLATFORM, SPAN_ATTRIBUTE_ALLOWLIST, TELEMETRY_LIMITS, TELEMETRY_PLATFORMS, TELEMETRY_SERVICE_NAME, type TelemetryPlatform } from '@app/specs/telemetry-privacy.spec';
import { allowedAttributes, exportedSpanName, type AllowedValue } from './attributes';
import { cap, type Scrubber } from './scrub';
import { sendOnce } from './send';
import type { Send, SpanAttributes, SpanHandle, TelemetryResource } from './types';

interface OtlpValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpKeyValue {
  key: string;
  value: OtlpValue;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number };
}

const NOOP_HANDLE: SpanHandle = { setAttributes: () => undefined };

/** The OTel `os.type` for Node's `process.platform`. */
export function osType(platform: string): string {
  return (TELEMETRY_PLATFORMS as readonly string[]).includes(platform) ? OS_TYPE_BY_PLATFORM[platform as TelemetryPlatform] : 'other';
}

/** The service's version as exported: scrubbed and capped (it comes from the app, but never trusted). */
export function serviceVersion(resource: TelemetryResource, scrub: Scrubber): string {
  return cap(scrub(String(resource.serviceVersion)), 40);
}

const hrToNanos = ([seconds, nanos]: HrTime): string => (BigInt(Math.trunc(seconds)) * 1_000_000_000n + BigInt(Math.trunc(nanos))).toString();

function otlpValue(value: AllowedValue, integer: boolean): OtlpValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'string') return { stringValue: value };
  return integer ? { intValue: String(value) } : { doubleValue: value };
}

export interface OtelChannelOptions {
  endpoint: string;
  send: Send;
  headers?: Record<string, string>;
  resource: TelemetryResource;
  scrub: Scrubber;
  /** Live consent for `usage`. */
  enabled: () => boolean;
}

export class OtelChannel {
  private readonly provider: TracerProvider;
  private readonly tracer: Tracer;
  private readonly active = new AsyncLocalStorage<Context>();
  private readonly resourceAttributes: OtlpKeyValue[];
  private readonly scopeVersion: string;
  private queue: OtlpSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort = new AbortController();
  private inFlight: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: OtelChannelOptions) {
    this.scopeVersion = serviceVersion(options.resource, options.scrub);
    const resource: Record<string, string> = {
      'service.name': TELEMETRY_SERVICE_NAME,
      'service.version': this.scopeVersion,
      'os.type': osType(options.resource.platform),
    };
    this.resourceAttributes = Object.entries(resource).map(([key, value]) => ({ key, value: { stringValue: value } }));
    const processor: SpanProcessor = {
      onStart: () => undefined,
      onEnd: (span) => this.onEnd(span),
      forceFlush: () => this.flush(),
      shutdown: () => Promise.resolve(),
    };
    // An explicit resource: the provider's default one (and any detector) is never used.
    this.provider = new TracerProvider({ resource: resourceFromAttributes(resource), spanProcessors: [processor] });
    this.tracer = this.provider.getTracer(TELEMETRY_SERVICE_NAME, this.scopeVersion);
  }

  span<T>(name: string, attributes: SpanAttributes, fn: (span: SpanHandle) => T): T {
    if (this.closed || !this.options.enabled()) return fn(NOOP_HANDLE);
    const parent = this.active.getStore() ?? ROOT_CONTEXT;
    const span = this.tracer.startSpan(name, { attributes: definedAttributes(attributes) }, parent);
    const handle: SpanHandle = { setAttributes: (more) => void span.setAttributes(definedAttributes(more)) };
    const fail = () => span.setStatus({ code: SpanStatusCode.ERROR });
    let result: T;
    try {
      result = this.active.run(trace.setSpan(parent, span), () => fn(handle));
    } catch (error) {
      fail();
      span.end();
      throw error;
    }
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (value) => {
          span.end();
          return value;
        },
        (error: unknown) => {
          fail();
          span.end();
          throw error;
        },
      ) as T;
    }
    span.end();
    return result;
  }

  setEnabled(on: boolean): void {
    if (on) return;
    // Off: drop the queue and stop at once. No flush.
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
    this.abort = new AbortController();
    this.inFlight = undefined;
  }

  async flush(): Promise<void> {
    while (this.options.enabled() && !this.closed && (this.queue.length > 0 || this.inFlight)) {
      await this.exportNext();
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.setEnabled(false);
    await this.provider.shutdown().catch(() => undefined);
  }

  private onEnd(span: ReadableSpan): void {
    if (this.closed || !this.options.enabled()) return;
    if (this.queue.length >= TELEMETRY_LIMITS.maxQueuedSpans) return;
    this.queue.push(this.toOtlp(span));
    this.schedule(this.queue.length >= TELEMETRY_LIMITS.maxExportBatch ? 0 : TELEMETRY_LIMITS.exportDelayMs);
  }

  private schedule(delayMs: number): void {
    if (this.timer && delayMs > 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.exportNext().then(() => {
        if (this.queue.length > 0) this.schedule(this.queue.length >= TELEMETRY_LIMITS.maxExportBatch ? 0 : TELEMETRY_LIMITS.exportDelayMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  /** Exports the next batch, one request at a time; resolves once it settled (or at once when one is in flight). */
  private exportNext(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.options.enabled() || this.queue.length === 0) return Promise.resolve();
    const batch = this.queue.splice(0, TELEMETRY_LIMITS.maxExportBatch);
    const body = JSON.stringify({
      resourceSpans: [{ resource: { attributes: this.resourceAttributes }, scopeSpans: [{ scope: { name: TELEMETRY_SERVICE_NAME, version: this.scopeVersion }, spans: batch }] }],
    });
    const headers = { ...this.options.headers, 'content-type': 'application/json' };
    const request: Promise<void> = sendOnce(this.options.send, this.options.endpoint, headers, body, this.abort.signal).then(() => {
      if (this.inFlight === request) this.inFlight = undefined;
    });
    this.inFlight = request;
    return request;
  }

  private toOtlp(span: ReadableSpan): OtlpSpan {
    const context = span.spanContext();
    const attributes = allowedAttributes(span.attributes, this.options.scrub).map(([key, value]) => ({ key, value: otlpValue(value, isIntegerKey(key)) }));
    return {
      traceId: context.traceId,
      spanId: context.spanId,
      ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
      name: exportedSpanName(span.name),
      // OTLP's SpanKind counts from UNSPECIFIED = 0; the API's INTERNAL is 0.
      kind: span.kind + 1,
      startTimeUnixNano: hrToNanos(span.startTime),
      endTimeUnixNano: hrToNanos(span.endTime),
      attributes,
      status: { code: span.status.code },
    };
  }
}

function isIntegerKey(key: string): boolean {
  return (SPAN_ATTRIBUTE_ALLOWLIST as Record<string, { kind: string }>)[key]?.kind === 'int';
}

function definedAttributes(attributes: SpanAttributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}
