import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

// Fakes for the browse-class registry's tests (spec `browser-chrome.feature.md`, Session
// classification). A session here has every part a browse-class installer or consumer touches:
// the webRequest events (one listener per event, as in Electron: a new registration replaces it,
// `null` removes it), the permission handlers, `protocol.handle`, `will-download`, the cookie store
// and the clearing calls. `electron-fake.ts`'s `FakeSession` keeps the older, narrower shape its
// own tests rely on, so it is left as it is.

type Listener = (...args: unknown[]) => unknown;

export const WEB_REQUEST_EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred',
] as const;
export type WebRequestEvent = (typeof WEB_REQUEST_EVENTS)[number];

export class RichSession extends EventEmitter {
  constructor(readonly label: string) {
    super();
  }

  /** Each webRequest event's current listener (`null`: removed). */
  readonly requestListeners = new Map<WebRequestEvent, { filter: unknown; listener: Listener } | null>();
  readonly webRequest = Object.fromEntries(
    WEB_REQUEST_EVENTS.map((event) => [
      event,
      vi.fn((filterOrListener: unknown, maybeListener?: unknown) => {
        const listener = typeof maybeListener === 'function' ? maybeListener : typeof filterOrListener === 'function' ? filterOrListener : null;
        const filter = typeof maybeListener === 'function' ? filterOrListener : undefined;
        this.requestListeners.set(event, listener ? { filter, listener: listener as Listener } : null);
      }),
    ]),
  ) as Record<WebRequestEvent, ReturnType<typeof vi.fn>>;

  /** Whether `event` has a listener now. */
  has(event: WebRequestEvent): boolean {
    return (this.requestListeners.get(event) ?? null) !== null;
  }

  /** How many times `event` was registered with a listener (not removals). */
  registrations(event: WebRequestEvent): number {
    return this.webRequest[event].mock.calls.filter((args: unknown[]) => args.some((a) => typeof a === 'function')).length;
  }

  /** Runs `event`'s listener (as Electron would) and answers what it called back with. */
  fire(event: WebRequestEvent, details: Record<string, unknown>): unknown {
    const entry = this.requestListeners.get(event);
    if (!entry) return 'no listener';
    let answer: unknown = 'no answer';
    entry.listener(details, (response: unknown) => (answer = response));
    return answer;
  }

  setPermissionRequestHandler = vi.fn();
  setPermissionCheckHandler = vi.fn();
  setDevicePermissionHandler = vi.fn();
  readonly protocol = { handle: vi.fn() };
  readonly cookies = { get: vi.fn(async (_filter: { url: string }) => [{ name: `${this.label}-cookie`, value: 'v' }]) };
  clearData = vi.fn(async (_options: unknown) => {});
  clearStorageData = vi.fn(async () => {});
  clearCache = vi.fn(async () => {});
  getUserAgent = vi.fn(() => 'Mozilla/5.0 frost-test');
  setSpellCheckerLanguages = vi.fn((_languages: string[]) => {});
  setSpellCheckerEnabled = vi.fn((_enable: boolean) => {});
}

const partitions = new Map<string, RichSession>();

/** `session.fromPartition`: one RichSession per partition name, for the life of the test file. */
export function richPartition(partition: string): RichSession {
  let found = partitions.get(partition);
  if (!found) {
    found = new RichSession(partition);
    partitions.set(partition, found);
  }
  return found;
}

/** `electron-fake`'s module with `session` swapped for RichSessions (the default session one too). */
export async function richElectron(): Promise<Record<string, unknown>> {
  const fake = (await import('../../../test/electron-fake')).electronFake();
  partitions.clear();
  const session = { defaultSession: new RichSession('default'), fromPartition: vi.fn(richPartition) };
  return { ...fake, session, default: { ...fake.default, session } };
}
