import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_MCP_PARTITION } from '@app/specs/agent-mcp.spec';
import type { McpFetchInit } from './http';
import type { McpManagerDeps } from './manager';
import { detectSandbox } from './sandbox';
import type { SpawnLike } from './stdio';

// The MCP manager's operating-system pieces (Phase 5 Task 10): `child_process.spawn` (always
// `shell: false`, enforced again here), the `agent-mcp` in-memory session's `fetch` and resolver,
// owner-only temporary folders, and the sandbox detection. Main only; tests pass fakes instead.

/** The part of an Electron session used for HTTP servers. */
export interface McpSessionLike {
  fetch(url: string, init: McpFetchInit): Promise<Response>;
  resolveHost(host: string): Promise<{ readonly endpoints: readonly { readonly address: string }[] }>;
}

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** `spawn`, never through a shell whatever the caller passes. */
export const nodeSpawn: SpawnLike = (command, args, options) => spawn(command, [...args], { ...options, stdio: [...options.stdio], shell: false });

/** The account's home folder from the user database (`os.userInfo()`), or `null`. */
function accountHome(): string | null {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
}

export function nodeMcpDeps(session: () => McpSessionLike): Pick<
  McpManagerDeps,
  'spawn' | 'fetch' | 'resolveHost' | 'detectSandbox' | 'isExecutable' | 'isDirectory' | 'realpath' | 'makeTempDir' | 'removeDir' | 'pathEnv' | 'homes' | 'runtimeDir' | 'tmpDir' | 'platform'
> {
  const pathEnv = process.env['PATH'] ?? '';
  return {
    spawn: nodeSpawn,
    // Looked up per request (after app ready); `agent-mcp` has no `persist:` prefix.
    fetch: (url, init) => session().fetch(url, init),
    resolveHost: async (host) => (await session().resolveHost(host)).endpoints.map((endpoint) => endpoint.address),
    detectSandbox: () =>
      detectSandbox({
        platform: process.platform,
        exists: (file) => fs.promises.access(file, fs.constants.X_OK).then(
          () => true,
          () => false,
        ),
        run: (command, args) =>
          new Promise((resolve) => {
            execFile(command, [...args], { timeout: 3_000, maxBuffer: 4096, windowsHide: true, shell: false, env: { PATH: pathEnv } }, (error, stdout) => {
              if (error && typeof (error as { code?: unknown }).code !== 'number') resolve(null);
              else resolve({ code: error ? Number((error as { code?: unknown }).code) : 0, stdout: String(stdout) });
            });
          }),
      }),
    isExecutable,
    isDirectory: (file) => fs.promises.stat(file).then(
      (stat) => stat.isDirectory(),
      () => false,
    ),
    realpath: (file) => fs.promises.realpath(file),
    makeTempDir: () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'frost-mcp-')),
    // Retried briefly: on Windows a folder that was a just-stopped process's working directory can
    // refuse deletion (`EBUSY`, `EPERM`) for a moment after the process exits.
    removeDir: (dir) => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    pathEnv,
    // Both of the user's home folders (they differ when `HOME` is set elsewhere), and the session's runtime folder.
    homes: [os.homedir(), accountHome()].filter((home): home is string => typeof home === 'string' && home.startsWith('/')),
    runtimeDir: process.env['XDG_RUNTIME_DIR'] ?? null,
    tmpDir: os.tmpdir(),
    platform: process.platform,
  };
}

export { AGENT_MCP_PARTITION };
