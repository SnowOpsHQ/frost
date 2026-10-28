import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOOPBACK_PORT_RANGE } from '@app/specs/account-api.schema';
import {
  LOOPBACK_CALLBACK_PATH,
  LOOPBACK_DONE_LINGER_MS,
  LOOPBACK_DONE_PATH,
  LOOPBACK_HOST,
  LOOPBACK_RESPONSE_HEADERS,
  SIGN_IN_TIMEOUT_MS,
} from '@app/specs/account-state.schema';

// The loopback redirect listener (RFC 8252 §7.3; spec `account-state.schema.ts`, `LOOPBACK_*`;
// acceptance `account-signin.feature.md`, Loopback listener; plan Global Constraint "The loopback
// listener"). Generic: the account sign-in and Search Console's OAuth (Task 8) each start one per
// pending request with that request's `state`, and get the redirect's `code` (or OAuth `error`) once.
//
// - Binds `LOOPBACK_HOST` only, on a random port in `LOOPBACK_PORT_RANGE`; requires
//   `Host: 127.0.0.1:<port>` (a DNS-rebound name is refused).
// - Serves only `GET LOOPBACK_CALLBACK_PATH` while waiting; everything else is 404. A missing, wrong
//   or repeated `state` (compared in constant time), a repeated `code`/`error`, or neither, is 400 and
//   the request keeps waiting.
// - The first valid callback is answered 303 to `LOOPBACK_DONE_PATH` (code-free), handed over, and from
//   then on only that fixed page is served, once; the listener closes when it has been (or after
//   `LOOPBACK_DONE_LINGER_MS`). It also closes on `close()` and after `timeoutMs` without a callback.
// - Every answer carries `LOOPBACK_RESPONSE_HEADERS`, loads no subresource, and never reflects a
//   request value. Nothing is logged here.

/** What the browser's redirect carried (its `state` already checked and removed). */
export interface LoopbackCallback {
  /** The authorization code, or `null` when the redirect carried an `error` instead. */
  readonly code: string | null;
  /** The OAuth `error` (`access_denied` …), or `null`. */
  readonly error: string | null;
  /** The other query parameters (`scope` …), without `state`. */
  readonly params: URLSearchParams;
}

export interface StartLoopbackOptions {
  /** The pending request's `state`: the only one accepted. */
  readonly state: string;
  /** Called once, with the first valid callback. */
  readonly onCallback: (callback: LoopbackCallback) => void;
  /** Called once if no valid callback arrived within `timeoutMs` (the listener is closed by then). */
  readonly onTimeout?: () => void;
  /** Defaults to `SIGN_IN_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Defaults to `LOOPBACK_DONE_LINGER_MS`. */
  readonly doneLingerMs?: number;
}

export interface Loopback {
  readonly address: string;
  readonly port: number;
  /** `http://127.0.0.1:<port>/callback` (`LOOPBACK_REDIRECT_PATTERN`). */
  readonly redirectUri: string;
  /** Stops listening at once (cancel); reports nothing. Idempotent. */
  close(): void;
  /** Resolves once the listener is closed, for whatever reason. */
  readonly closed: Promise<void>;
}

/** The page the browser lands on: fixed text, no subresource, no script, no value from the request. */
const DONE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>frost</title></head>' +
  '<body><h1>You can close this tab</h1><p>Go back to frost to finish.</p></body></html>';

const MAX_CODE_CHARS = 2048;
const MAX_ERROR_CHARS = 256;
const PORT_ATTEMPTS = 5;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Starts a listener for one pending request. Rejects when no port in range could be bound. */
export async function startLoopback(options: StartLoopbackOptions): Promise<Loopback> {
  const expectedState = digest(options.state);
  let phase: 'waiting' | 'done' | 'closed' = 'waiting';
  let port = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let linger: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const send = (res: ServerResponse, status: number, body = '', extra: Record<string, string> = {}): void => {
    res.writeHead(status, {
      ...LOOPBACK_RESPONSE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      Connection: 'close',
      ...extra,
    });
    res.end(body);
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers.host !== `${LOOPBACK_HOST}:${port}`) return send(res, 400, 'Bad request');
    const raw = req.url ?? '';
    const queryAt = raw.indexOf('?');
    const path = queryAt < 0 ? raw : raw.slice(0, queryAt);
    if (req.method !== 'GET') return send(res, 404, 'Not found');
    if (phase === 'done' && path === LOOPBACK_DONE_PATH) {
      res.once('finish', finish);
      return send(res, 200, DONE_HTML, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (phase !== 'waiting' || path !== LOOPBACK_CALLBACK_PATH) return send(res, 404, 'Not found');

    const params = new URLSearchParams(queryAt < 0 ? '' : raw.slice(queryAt + 1));
    const states = params.getAll('state');
    const codes = params.getAll('code');
    const errors = params.getAll('error');
    const stateOk = states.length === 1 && timingSafeEqual(digest(states[0] ?? ''), expectedState);
    if (!stateOk || codes.length > 1 || errors.length > 1) return send(res, 400, 'Bad request');
    const error = errors[0] || null;
    const code = error === null ? codes[0] || null : null;
    if ((code === null && error === null) || (code?.length ?? 0) > MAX_CODE_CHARS || (error?.length ?? 0) > MAX_ERROR_CHARS) {
      return send(res, 400, 'Bad request');
    }

    phase = 'done';
    clearTimeout(timer);
    linger = setTimeout(finish, options.doneLingerMs ?? LOOPBACK_DONE_LINGER_MS);
    linger.unref();
    send(res, 303, '', { Location: LOOPBACK_DONE_PATH });
    params.delete('state');
    params.delete('code');
    params.delete('error');
    try {
      options.onCallback({ code, error, params });
    } catch {
      // The caller's problem; the listener's answer is already sent.
    }
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      res.destroy();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  server.on('clientError', (_error, socket) => socket.destroy());

  function finish(): void {
    if (phase === 'closed') return;
    phase = 'closed';
    clearTimeout(timer);
    clearTimeout(linger);
    server.close(() => resolveClosed());
    server.closeAllConnections();
  }

  for (let attempt = 0; ; attempt++) {
    port = await listen(server);
    if (port >= LOOPBACK_PORT_RANGE.min && port <= LOOPBACK_PORT_RANGE.max) break;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (attempt + 1 >= PORT_ATTEMPTS) throw new Error('loopback: no unprivileged port');
  }

  timer = setTimeout(() => {
    if (phase !== 'waiting') return;
    finish();
    options.onTimeout?.();
  }, options.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  timer.unref();

  return {
    address: LOOPBACK_HOST,
    port,
    redirectUri: `http://${LOOPBACK_HOST}:${port}${LOOPBACK_CALLBACK_PATH}`,
    close: finish,
    closed,
  };
}
