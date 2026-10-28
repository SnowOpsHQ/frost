import { createApp, type AppDeps } from '../app';
import { openMemoryDatabase, type DatabaseHandle } from '../db/client';
import { migrate } from '../db/migrate';
import { createMemoryTransport, type MemoryTransport } from '../email';

export const BASE_URL = 'http://127.0.0.1:8787';
export const TEST_SECRET = 'test-secret-0123456789-abcdefghijklmnop';

export interface TestBackend {
  readonly app: ReturnType<typeof createApp>;
  readonly email: MemoryTransport;
  readonly database: DatabaseHandle;
  /** `app.request` against the configured base URL, with a same-origin `Origin` on writes. */
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** A backend on a fresh in-memory PGlite with every migration applied and a memory email transport. */
export async function createTestBackend(overrides: Partial<Pick<AppDeps, 'verifyBearer'>> = {}): Promise<TestBackend> {
  const database = await openMemoryDatabase();
  await migrate(database.db);
  const email = createMemoryTransport();
  const app = createApp({
    db: database.db,
    auth: { secret: TEST_SECRET, baseURL: BASE_URL },
    email,
    ...overrides,
  });
  return {
    app,
    email,
    database,
    request(path, init = {}) {
      const headers = new Headers(init.headers);
      const method = (init.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && !headers.has('origin')) headers.set('origin', BASE_URL);
      return Promise.resolve(app.request(new URL(path, BASE_URL).toString(), { ...init, headers }));
    },
    close: () => database.close(),
  };
}

export function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

/** The `Cookie` header a browser would send back after `res` (expired/cleared cookies dropped). */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .filter((line) => !/max-age=0\b/i.test(line))
    .map((line) => line.split(';', 1)[0] ?? '')
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
    .join('; ');
}

/** The first http(s) URL in a message body. */
export function linkIn(text: string): string {
  const match = /https?:\/\/[^\s"'<>]+/.exec(text);
  if (!match) throw new Error('no link in message');
  return match[0];
}
