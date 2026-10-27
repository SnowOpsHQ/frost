import { readFile as fsReadFile } from 'node:fs/promises';
import { protocol } from 'electron';
import { APP_ALLOWED_METHODS, APP_SCHEME_PRIVILEGES } from '@app/specs/app-protocol.spec';
import { APP_SCHEME } from '@app/specs/security-policy.spec';
import { appCspHeader } from '../security/policy';
import { resolveAppRequest } from './resolve';

// Electron wiring for `specs/app-protocol.spec.ts` (acceptance: `specs/app-protocol.feature.md`).

export type ReadFile = (filePath: string) => Promise<Uint8Array>;

/** Registers `app:` as a privileged standard scheme. Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { ...APP_SCHEME_PRIVILEGES } }]);
}

/**
 * Headers on every `app://` response. The CSP is also set by the session's `onHeadersReceived`
 * listener (`registerSecurity`); repeating it here is defense in depth, not a second listener.
 */
function baseHeaders(): Record<string, string> {
  return { 'Content-Security-Policy': appCspHeader(), 'X-Content-Type-Options': 'nosniff' };
}

function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: baseHeaders() });
}

/**
 * The `app://` request handler: serves files from `root` (the built renderer) only. Anything that
 * does not resolve inside `root` — or cannot be read as a file — is an empty `404`.
 */
export function createAppProtocolHandler(root: string, readFile: ReadFile = fsReadFile): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!(APP_ALLOWED_METHODS as readonly string[]).includes(request.method)) return emptyResponse(405);
    const resolution = resolveAppRequest(request.url, root);
    if (resolution.kind !== 'file') return emptyResponse(404);
    let body: Uint8Array;
    try {
      body = await readFile(resolution.filePath);
    } catch {
      return emptyResponse(404); // missing file, directory, unreadable
    }
    const headers = { ...baseHeaders(), 'Content-Type': resolution.mimeType };
    return new Response(request.method === 'HEAD' ? null : (body as Uint8Array<ArrayBuffer>), { status: 200, headers });
  };
}

/** Serves `app://` from `root`. Call after `app.whenReady()`. */
export function handleAppProtocol(root: string): void {
  protocol.handle(APP_SCHEME, createAppProtocolHandler(root));
}
