import http from 'node:http';
import { isChatgptRedirectUri } from '@app/specs/agent-chatgpt.spec';
import { CHATGPT_E2E_SEAM_MAX_CHARS, isChatgptE2eUrl, parseChatgptE2eSeam, type ChatgptE2eSeam } from '@app/specs/agent-chatgpt-e2e.schema';
import type { ChatgptStoredState } from '@app/specs/agent-chatgpt.schema';
import { readBounded } from '../e2e-seam';
import { canonicalChatgptState, type ChatgptStore } from './store';

// The ChatGPT plan route's e2e seam, main side (plan `docs/plans/agent-chatgpt-plan.md`, Task 6;
// spec `agent-chatgpt-e2e.schema.ts`; acceptance `agent-chatgpt.feature.md`, End to end). In an
// unpackaged build started with `--frost-e2e-chatgpt=<file>` (`CHATGPT_E2E_SWITCH`), main reads the
// file once and validates it: the sign-in service gets its endpoints, the model proxy sends plan
// requests to its Responses URL, the authorize page is "opened" by `e2eBrowser` (no real browser),
// and `store: 'memory'` keeps the sign-in in `createMemoryChatgptStore`. A packaged build never
// reads it (and refuses to start with the switch at all: `PACKAGED_FORBIDDEN_SWITCHES`).

export interface ChatgptE2eSeamDeps {
  /** `app.isPackaged`. */
  readonly packaged: boolean;
  /** `app.commandLine.getSwitchValue(CHATGPT_E2E_SWITCH)` (`''` when absent). */
  readonly switchValue: string;
  /** Reads at most `maxBytes + 1` bytes of the file as UTF-8 (`null`: unreadable). Default: `node:fs`. */
  readonly readFile?: (file: string, maxBytes: number) => string | null;
  readonly log?: (line: string) => void;
}

/** The validated seam, or `null`: a packaged build, no switch, or a file that is unreadable or not a seam (logged; the real endpoints stay). */
export function chatgptE2eSeamFrom(deps: ChatgptE2eSeamDeps): ChatgptE2eSeam | null {
  if (deps.packaged || deps.switchValue === '') return null;
  const log = deps.log ?? (() => undefined);
  const seam = parseChatgptE2eSeam((deps.readFile ?? readBounded)(deps.switchValue, CHATGPT_E2E_SEAM_MAX_CHARS * 4));
  if (seam === null) {
    log('agent chatgpt: the e2e seam file is not valid; the real endpoints stay');
    return null;
  }
  log('agent chatgpt: the e2e seam is on (unpackaged build): the ChatGPT endpoints are a local fake');
  return seam;
}

/** The sign-in kept in main's memory for this run (`store: 'memory'`): never on disk, validated like the real store. */
export function createMemoryChatgptStore(): ChatgptStore {
  let text: string | null = null;
  return {
    protection: async () => 'os',
    read: async () => (text === null ? null : (JSON.parse(text) as ChatgptStoredState)),
    async write(state) {
      const canonical = canonicalChatgptState(state);
      if (canonical === null) return false;
      text = canonical;
      return true;
    },
    async clear() {
      text = null;
      return true;
    },
  };
}

/** One HTTP `GET` without following redirects: the status and the `Location` header. */
export type E2eHttpGet = (url: string) => Promise<{ readonly status: number; readonly location: string | null }>;

const httpGet: E2eHttpGet = (url) =>
  new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 10_000 }, (response) => {
      response.resume();
      const location = response.headers.location;
      resolve({ status: response.statusCode ?? 0, location: typeof location === 'string' ? location : null });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });

export interface E2eBrowserDeps {
  readonly get?: E2eHttpGet;
  readonly log?: (line: string) => void;
  /** Resolves when the visit ends (tests). */
  readonly onDone?: (ok: boolean) => void;
}

/**
 * The seam's stand-in for the system browser: `GET` the authorize URL (the fake answers its consent
 * at once with a redirect), then follow that one redirect, only to the loopback callback
 * (`http://127.0.0.1:<port>/auth/callback`). Answers `true` once the visit started; what the
 * sign-in makes of the callback is the service's. Only for loopback `http:` URLs (`isChatgptE2eUrl`);
 * main wraps it in `chatgptBrowserOpener` with the seam's authorize endpoint, so the gesture rule holds.
 */
export function e2eBrowser(deps: E2eBrowserDeps = {}): (url: string, userGesture: boolean) => boolean {
  const get = deps.get ?? httpGet;
  const log = deps.log ?? (() => undefined);
  const done = deps.onDone ?? (() => undefined);
  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!isChatgptE2eUrl(`${parsed.origin}${parsed.pathname}`)) return false;
    void (async () => {
      const consent = await get(url);
      const next = consent.status >= 300 && consent.status < 400 && consent.location !== null ? new URL(consent.location, url) : null;
      if (next === null || !isChatgptRedirectUri(`${next.origin}${next.pathname}`)) {
        log('agent chatgpt: the e2e browser was not redirected to the loopback callback');
        return false;
      }
      await get(next.href);
      return true;
    })().then(done, () => {
      log('agent chatgpt: the e2e browser could not reach the fake');
      done(false);
    });
    return true;
  };
}
