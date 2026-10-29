import { MCP_LIMITS, type McpErrorCode } from '@app/specs/agent-mcp.spec';
import { McpFailure, type JsonRpcOutgoing, type McpTransport } from './client';

// The stdio transport (Phase 5 Task 10; acceptance `specs/agent-mcp.feature.md`, Command servers):
// one child process, started without a shell, speaking newline-delimited JSON-RPC on its stdin and
// stdout. What it writes is bounded: a line longer than `MCP_LIMITS.maxMessageBytes` (or that much
// output with no line break) ends the connection (`too-large`); a line that isn't JSON is skipped.
// Its stderr is drained and dropped (frost never shows a server's own text), apart from its first
// bytes, kept only to tell a sandbox launcher's refusal from the server's own exit.
//
// On POSIX the child leads its own process group, so stopping it signals everything it started:
// `SIGTERM` to the group (even once the leader itself has exited: what it left behind is still in
// the group), then `SIGKILL` after `stopGraceMs`; `killNow` sends `SIGKILL` at once (app quit).
//
// Writes are bounded too (Task 10 review): more than `maxQueuedWriteBytes` waiting on its stdin, or
// a stdin that stays full for `maxWriteStallMs`, ends the connection (`too-large`), so a server that
// stops reading can't make main buffer without end.

/** What `child_process.spawn` answers (the part used; tests pass fakes). */
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdin: {
    write(chunk: string): boolean;
    end(): void;
    on(event: 'error' | 'drain', listener: (error?: unknown) => void): unknown;
    readonly writableLength?: number;
  } | null;
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  /** fd 3, when asked for (bubblewrap's status pipe). */
  readonly stdio?: readonly unknown[];
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdio: readonly ('pipe' | 'ignore')[];
  readonly shell: false;
  readonly windowsHide: true;
  readonly detached: boolean;
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildLike;

export interface StdioTransportDeps {
  readonly spawn: SpawnLike;
  /** The program to run (the sandbox launcher, or the command itself) and its arguments. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** Read bubblewrap's `--json-status-fd 3`: the sandbox is up once it reports `child-pid`. */
  readonly statusFd?: boolean;
  /** `process.platform` (POSIX: a process group of its own). */
  readonly platform?: NodeJS.Platform;
  /** Signals a process group (`process.kill(-pid, signal)`); tests pass a fake. */
  readonly killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export interface StdioTransport extends McpTransport {
  /** `SIGKILL` to the process group, synchronously (app quit). */
  killNow(): void;
  /** Whether the sandbox reported it was set up (bubblewrap's status pipe; `true` without one). */
  sandboxReady(): boolean;
  /** The first bytes of stderr (a launcher's own refusal starts with its name); never shown. */
  stderrHead(): string;
}

const STDERR_HEAD_BYTES = 512;
const MAX_STATUS_BYTES = 64 * 1024;

export function createStdioTransport(deps: StdioTransportDeps): StdioTransport {
  const platform = deps.platform ?? process.platform;
  const posix = platform !== 'win32';
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const killGroup = deps.killGroup ?? ((pid: number, signal: NodeJS.Signals) => process.kill(-pid, signal));
  const messageListeners: ((message: unknown) => void)[] = [];
  const closeListeners: ((code: McpErrorCode) => void)[] = [];
  let closedWith: McpErrorCode | null = null;
  let exited = false;
  let buffer: Buffer[] = [];
  let buffered = 0;
  let stderr = '';
  let status = '';
  let sandboxUp = deps.statusFd !== true;
  /** When stdin last reported full (`write` answered `false`), until it drains. */
  let stall: unknown = null;

  const child = deps.spawn(deps.command, deps.args, {
    cwd: deps.cwd,
    env: { ...deps.env },
    stdio: deps.statusFd === true ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: posix,
  });

  /** Signals the process group on POSIX (whether or not the leader has exited), else the child while it runs. */
  const signal = (sig: NodeJS.Signals) => {
    if (posix && typeof child.pid === 'number') {
      try {
        killGroup(child.pid, sig);
        return;
      } catch {
        // No such group any more (ESRCH): try the child itself below.
      }
    }
    if (exited) return;
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  };

  const end = (code: McpErrorCode) => {
    if (closedWith !== null) return;
    closedWith = code;
    buffer = [];
    buffered = 0;
    if (stall !== null) clearTimer(stall);
    stall = null;
    for (const listener of closeListeners) listener(code);
    signal('SIGTERM');
    const timer = setTimer(() => signal('SIGKILL'), MCP_LIMITS.stopGraceMs);
    (timer as { unref?: () => void } | null)?.unref?.();
  };

  const deliverLine = (line: Buffer) => {
    let text = line.toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    for (const listener of messageListeners) listener(value);
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    if (closedWith !== null) return;
    let start = 0;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, index);
      if (buffered + piece.length > MCP_LIMITS.maxMessageBytes) {
        end('too-large');
        return;
      }
      buffer.push(piece);
      const line = Buffer.concat(buffer);
      buffer = [];
      buffered = 0;
      start = index + 1;
      deliverLine(line);
      if (closedWith !== null) return;
    }
    const rest = chunk.subarray(start);
    if (buffered + rest.length > MCP_LIMITS.maxMessageBytes) {
      end('too-large');
      return;
    }
    if (rest.length > 0) {
      buffer.push(rest);
      buffered += rest.length;
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_HEAD_BYTES) stderr += chunk.subarray(0, STDERR_HEAD_BYTES - stderr.length).toString('utf8');
  });
  const statusPipe = deps.statusFd === true ? (child.stdio?.[3] as { on?: (event: 'data', listener: (chunk: Buffer) => void) => unknown } | undefined) : undefined;
  statusPipe?.on?.('data', (chunk: Buffer) => {
    if (status.length > MAX_STATUS_BYTES) return;
    status += chunk.toString('utf8');
    // bubblewrap writes one JSON object per line; `child-pid` means the sandbox is set up.
    if (!sandboxUp && /"child-pid"\s*:\s*\d+/.test(status)) sandboxUp = true;
  });
  child.stdin?.on('error', () => end('exited'));
  child.stdin?.on('drain', () => {
    if (stall !== null) clearTimer(stall);
    stall = null;
  });
  child.on('error', (error) => {
    exited = true;
    end(error.code === 'ENOENT' ? 'not-found' : 'spawn-failed');
  });
  child.on('exit', () => {
    exited = true;
    end('exited');
  });

  return {
    async send(message: JsonRpcOutgoing) {
      if (closedWith !== null) throw new McpFailure(closedWith);
      const text = JSON.stringify(message);
      if (Buffer.byteLength(text, 'utf8') > MCP_LIMITS.maxMessageBytes) throw new McpFailure('too-large');
      if (child.stdin === null) throw new McpFailure('spawn-failed');
      if ((child.stdin.writableLength ?? 0) + text.length > MCP_LIMITS.maxQueuedWriteBytes) {
        end('too-large');
        throw new McpFailure('too-large');
      }
      let flowing: boolean;
      try {
        flowing = child.stdin.write(`${text}\n`);
      } catch {
        throw new McpFailure('exited');
      }
      // A full stdin that never drains: the server stopped reading.
      if (!flowing && stall === null) stall = setTimer(() => end('too-large'), MCP_LIMITS.maxWriteStallMs);
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onClose(listener) {
      if (closedWith !== null) listener(closedWith);
      else closeListeners.push(listener);
    },
    async close(code: McpErrorCode = 'exited') {
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      end(code);
    },
    killNow() {
      if (closedWith === null) {
        closedWith = 'exited';
        for (const listener of closeListeners) listener('exited');
      }
      signal('SIGKILL');
    },
    sandboxReady: () => sandboxUp,
    stderrHead: () => stderr,
  };
}
