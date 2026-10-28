// Spec: specs/account-state.schema.ts (LOOPBACK_CALLBACK_PATH, LOOPBACK_DONE_PATH, LOOPBACK_HOST,
// LOOPBACK_RESPONSE_HEADERS, LOOPBACK_DONE_LINGER_MS), specs/account-api.schema.ts (LOOPBACK_REDIRECT_PATTERN,
// LOOPBACK_PORT_RANGE; "the desktop's loopback callback must answer Referrer-Policy: no-referrer …")
// Acceptance: specs/account-signin.feature.md (Loopback listener) · plan Global Constraint "The loopback listener"
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LOOPBACK_PORT_RANGE, LOOPBACK_REDIRECT_PATTERN } from '@app/specs/account-api.schema';
import { LOOPBACK_DONE_PATH, LOOPBACK_RESPONSE_HEADERS } from '@app/specs/account-state.schema';
import { startLoopback, type Loopback, type LoopbackCallback } from '../loopback';

const STATE = 'state-0123456789abcdef-ABCDEF';
const CODE = 'code-0123456789abcdefghijklmnopqrstuvwxyzABCD';

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A plain GET (no redirect following), optionally with another `Host` or method. */
function get(port: number, path: string, options: { host?: string; method?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { Host: options.host ?? `127.0.0.1:${port}`, Connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Whether something accepts TCP connections on `port`. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const callbackPath = (query: Record<string, string> | string) => `/callback?${typeof query === 'string' ? query : new URLSearchParams(query).toString()}`;

function expectFixedHeaders(answer: Answer): void {
  for (const [name, value] of Object.entries(LOOPBACK_RESPONSE_HEADERS)) expect(answer.headers[name.toLowerCase()], name).toBe(value);
  expect(answer.headers['set-cookie']).toBeUndefined();
}

const open: Loopback[] = [];
async function start(overrides: Partial<Parameters<typeof startLoopback>[0]> = {}) {
  const callbacks: LoopbackCallback[] = [];
  const onTimeout = vi.fn();
  const loopback = await startLoopback({ state: STATE, onCallback: (cb) => callbacks.push(cb), onTimeout, ...overrides });
  open.push(loopback);
  return { loopback, callbacks, onTimeout };
}

afterEach(async () => {
  for (const loopback of open.splice(0)) {
    loopback.close();
    await loopback.closed;
  }
});

describe('loopback listener', () => {
  test('loopback-binds-loopback-unprivileged-port', async () => {
    const { loopback } = await start();
    expect(loopback.port).toBeGreaterThanOrEqual(LOOPBACK_PORT_RANGE.min);
    expect(loopback.port).toBeLessThanOrEqual(LOOPBACK_PORT_RANGE.max);
    expect(loopback.redirectUri).toBe(`http://127.0.0.1:${loopback.port}/callback`);
    expect(loopback.redirectUri).toMatch(LOOPBACK_REDIRECT_PATTERN);
    expect(loopback.address).toBe('127.0.0.1');
  });

  test('loopback-404-elsewhere', async () => {
    const { loopback, callbacks } = await start();
    const valid = callbackPath({ code: CODE, state: STATE });
    for (const [path, method] of [
      ['/', 'GET'],
      ['/callback/', 'GET'],
      ['/CALLBACK?state=x', 'GET'],
      ['/favicon.ico', 'GET'],
      [LOOPBACK_DONE_PATH, 'GET'],
      [valid, 'POST'],
      [valid, 'HEAD'],
      [valid, 'PUT'],
    ] as const) {
      const answer = await get(loopback.port, path, { method });
      expect(answer.status, `${method} ${path}`).toBe(404);
      expectFixedHeaders(answer);
    }
    for (const host of ['localhost:' + loopback.port, 'evil.example.com', '127.0.0.1', `127.0.0.1:${loopback.port + 1}`]) {
      const answer = await get(loopback.port, valid, { host });
      expect(answer.status, host).toBe(400);
      expectFixedHeaders(answer);
    }
    expect(callbacks).toEqual([]);
    // Still waiting: the right callback is accepted.
    expect((await get(loopback.port, valid)).status).toBe(303);
    expect(callbacks).toHaveLength(1);
  });

  test('loopback-wrong-state-400-keeps-waiting', async () => {
    const { loopback, callbacks } = await start();
    const queries: (Record<string, string> | string)[] = [
      { code: CODE },
      { code: CODE, state: 'wrong-state-0123456789' },
      { code: CODE, state: STATE.slice(0, -1) },
      { code: CODE, state: `${STATE}x` },
      `code=${CODE}&state=${STATE}&state=${STATE}`,
      `code=${CODE}&code=${CODE}&state=${STATE}`,
      { state: STATE },
      { code: '', state: STATE },
    ];
    for (const query of queries) {
      const answer = await get(loopback.port, callbackPath(query));
      expect(answer.status, JSON.stringify(query)).toBe(400);
      expectFixedHeaders(answer);
      expect(answer.body).not.toContain(STATE);
      expect(answer.body).not.toContain(CODE);
    }
    expect(callbacks).toEqual([]);
    expect((await get(loopback.port, callbackPath({ code: CODE, state: STATE }))).status).toBe(303);
    expect(callbacks.map((cb) => cb.code)).toEqual([CODE]);
  });

  test('loopback-303-to-done-without-code', async () => {
    const { loopback, callbacks } = await start();
    const answer = await get(loopback.port, callbackPath({ code: CODE, state: STATE, scope: 'x' }));
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe(LOOPBACK_DONE_PATH);
    expectFixedHeaders(answer);
    expect(answer.body).toBe('');
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({ code: CODE, error: null });
    expect(callbacks[0]?.params.get('scope')).toBe('x');
    expect(callbacks[0]?.params.has('state')).toBe(false);
  });

  test('loopback-done-page-is-fixed', async () => {
    const { loopback } = await start();
    const marker = '<script>alert(1)</script>';
    await get(loopback.port, callbackPath({ code: CODE, state: STATE, error_description: marker }));
    const done = await get(loopback.port, `${LOOPBACK_DONE_PATH}?code=${encodeURIComponent(marker)}`);
    expect(done.status).toBe(200);
    expectFixedHeaders(done);
    expect(done.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(done.body).toMatch(/^<!doctype html>/i);
    expect(done.body).toContain('frost');
    for (const value of [CODE, STATE, marker, 'alert']) expect(done.body).not.toContain(value);
    // No subresource of any kind, no script, no style sheet, no link.
    expect(done.body).not.toMatch(/<(script|img|link|style|iframe|object|embed|form|meta http-equiv)\b/i);
    expect(done.body).not.toMatch(/\b(src|href|style)=/i);
  });

  test('loopback-closes-after-success', async () => {
    const { loopback, callbacks } = await start();
    expect((await get(loopback.port, callbackPath({ code: CODE, state: STATE }))).status).toBe(303);
    // Before /done is served, the callback is no longer accepted (nor handed over again).
    expect((await get(loopback.port, callbackPath({ code: CODE, state: STATE }))).status).toBe(404);
    expect(callbacks).toHaveLength(1);
    expect((await get(loopback.port, LOOPBACK_DONE_PATH)).status).toBe(200);
    await loopback.closed;
    expect(await listening(loopback.port)).toBe(false);
    expect(callbacks).toHaveLength(1);
  });

  test('loopback-closes-without-done', async () => {
    const { loopback } = await start({ doneLingerMs: 30 });
    expect((await get(loopback.port, callbackPath({ code: CODE, state: STATE }))).status).toBe(303);
    // The browser never asks for /done: the listener still closes.
    await loopback.closed;
    expect(await listening(loopback.port)).toBe(false);
  });

  test('loopback-oauth-error-is-a-callback', async () => {
    const { loopback, callbacks } = await start();
    const answer = await get(loopback.port, callbackPath({ error: 'access_denied', state: STATE }));
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe(LOOPBACK_DONE_PATH);
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({ code: null, error: 'access_denied' });
  });

  test('loopback-times-out', async () => {
    const { loopback, callbacks, onTimeout } = await start({ timeoutMs: 40 });
    expect((await get(loopback.port, callbackPath({ code: CODE, state: 'wrong-state-0123456789' }))).status).toBe(400);
    await loopback.closed;
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(await listening(loopback.port)).toBe(false);
    expect(callbacks).toEqual([]);
    loopback.close();
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  test('loopback-cancel-closes', async () => {
    const { loopback, callbacks, onTimeout } = await start({ timeoutMs: 40 });
    loopback.close();
    await loopback.closed;
    expect(await listening(loopback.port)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onTimeout).not.toHaveBeenCalled();
    expect(callbacks).toEqual([]);
  });
});
