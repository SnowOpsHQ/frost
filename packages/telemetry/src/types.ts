/**
 * The public types of `@app/telemetry` (spec: `specs/telemetry-privacy.spec.ts`).
 */
import type { SPAN_ATTRIBUTE_ALLOWLIST, SpanAttributeKey, TelemetryChannel, TelemetryConsent } from '@app/specs/telemetry-privacy.spec';

/** What the host's transport is asked to send. `signal` aborts when the channel is turned off (or the request times out). */
export interface SendRequest {
  headers: Record<string, string>;
  body: string | Uint8Array;
  signal: AbortSignal;
}

/** What the transport answers. `headers` (lower-case names) lets Sentry honour `retry-after` and `x-sentry-rate-limits`. */
export interface SendResponse {
  status: number;
  headers?: Record<string, string | null | undefined>;
}

/** The injected transport: main passes a wrapper over `net.fetch` (POST, `credentials: 'omit'`). */
export type Send = (url: string, request: SendRequest) => Promise<SendResponse>;

export interface TelemetryResource {
  /** frost's version (`app.getVersion()`). */
  serviceVersion: string;
  /** Node's `process.platform`. */
  platform: string;
  /** The runtime Sentry reports (e.g. `{ name: 'electron', version: process.versions.electron }`). */
  runtime?: { name: string; version: string };
}

export interface TelemetryOptions {
  /** Consent at start (main reads its consent store first). Defaults to `DEFAULT_CONSENT`: both off. */
  consent?: TelemetryConsent;
  resource: TelemetryResource;
  /** The `usage` channel: an OTLP/HTTP traces endpoint (`…/v1/traces`). Without an `http(s)` endpoint the channel is a no-op. */
  otel?: { endpoint?: string | undefined; send: Send; headers?: Record<string, string> };
  /** The `errors` channel: a Sentry DSN. Without a valid DSN the channel is a no-op. */
  sentry?: { dsn?: string | undefined; send: Send; environment?: string };
  /** The app's root directory (`app.getAppPath()`): stack frames under it are reported relative to it. */
  appRoot?: string;
  /** Strings replaced wherever they appear. Defaults to the machine's host name and the user's login name. */
  redact?: readonly string[];
}

/** A value allowed for an allowlisted key (checked again at export: a value that does not pass its rule is dropped). */
type AttributeValue<K extends SpanAttributeKey> = (typeof SPAN_ATTRIBUTE_ALLOWLIST)[K] extends { kind: 'boolean' }
  ? boolean
  : (typeof SPAN_ATTRIBUTE_ALLOWLIST)[K] extends { kind: 'int' | 'number' }
    ? number
    : string;

export type SpanAttributes = { [K in SpanAttributeKey]?: AttributeValue<K> };

/** Handed to a span's function, to add attributes known only once the work is done. */
export interface SpanHandle {
  setAttributes(attributes: SpanAttributes): void;
}

export interface CaptureHint {
  /** How the error was caught (`onuncaughtexception`, `onunhandledrejection`, `renderer` …): a lower-case token. */
  mechanism?: string;
  /** Whether the app handled it. Defaults to `true`. */
  handled?: boolean;
}

export interface Telemetry {
  /** Runs `fn` in a span named `name` (a fixed identifier, `SPAN_NAME_PATTERN`) and returns its result; a throw or rejection marks the span an error and is rethrown. */
  span<T>(name: string, attributes: SpanAttributes, fn: (span: SpanHandle) => T): T;
  /** Reports an error when `errors` is on (scrubbed); otherwise does nothing. Never throws. */
  captureException(error: unknown, hint?: CaptureHint): void;
  /** Turns a channel on or off. Off discards that channel's queue and aborts its request in flight, without a flush. */
  setConsent(channel: TelemetryChannel, on: boolean): void;
  /** The current consent (a copy). */
  consent(): TelemetryConsent;
  /** Whether this build has an endpoint (or DSN) for each channel. */
  configured(): Record<TelemetryChannel, boolean>;
  /** Sends what is queued on the channels that are on. Never rejects. */
  flush(): Promise<void>;
  /** Flushes the channels that are on, then stops both; later calls do nothing. Never rejects. */
  shutdown(): Promise<void>;
}
